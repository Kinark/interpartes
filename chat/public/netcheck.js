"use strict";

// Quick connection check, run when the site loads (see guard.js) and before
// a call or chat starts. It never blocks anyone: the result is shown to the
// person, and a short list of findings (never the address itself) is sent,
// sealed with the room key like every other room message, to the others in
// the room so they know who might be listened to by a third party.
//
// What it checks, all in this browser and against this server only:
//   - Address echo: this server tells the browser which address it sees,
//     encrypted to a throwaway key the browser just made (/chat/netcheck),
//     so the address never travels back in readable form.
//   - That address against public lists of VPN, Tor exit and hosting /
//     cloud ranges, downloaded from this server (iplists.txt) and searched
//     here; nobody else is asked about it.
//   - Proxy headers this server received with the request.
//   - WebRTC: the addresses the browser itself would offer for a direct
//     connection. A public one that differs from the echoed address means
//     the traffic goes through a VPN or proxy while the real address leaks.
//   - Code inside the page that isn't from this site (browser add-ons,
//     injected scripts) and remote-controlled (automated) browsers.
// A VPN, proxy or hosting address is a risk here, not protection: another
// company then carries the call and can see who talks, when and how much.
(function () {
  if (window.IPNC) return;
  const TIMEOUT_MS = 4000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const LABELS = {
    vpn: "connects through a VPN service",
    tor: "connects through Tor",
    datacenter: "connects from a server or cloud host, not a home or mobile network",
    proxy: "connects through a proxy",
    "webrtc-leak": "shows two different internet addresses (a VPN or proxy that leaks)",
    "page-tampered": "has browser add-ons or other outside code running inside this page",
    automation: "uses a remote-controlled (automated) browser",
    unchecked: "could not be checked",
  };

  function b64(bytes) {
    return btoa(String.fromCharCode(...bytes));
  }
  function unb64(s) {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  }
  function withTimeout(p, ms, fallback) {
    return Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);
  }

  function v4(s) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s || "");
    if (!m) return null;
    const p = m.slice(1).map(Number);
    if (p.some((x) => x > 255)) return null;
    return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
  }
  function plainIp(s) {
    return String(s || "").replace(/^::ffff:/i, "").replace(/^\[|\]$/g, "");
  }
  function isPrivate(ip) {
    const n = v4(ip);
    if (n !== null) {
      const a = n >>> 24;
      const b = (n >>> 16) & 255;
      return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) ||
        (a === 169 && b === 254) || (a === 100 && b >= 64 && b < 128) || a >= 224;
    }
    const l = ip.toLowerCase();
    return l === "::1" || l.startsWith("fe80:") || l.startsWith("fc") || l.startsWith("fd") || !l.includes(":");
  }

  async function echo() {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const pub = b64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    const r = await fetch("/chat/netcheck", {
      method: "POST",
      body: JSON.stringify({ pub }),
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    if (!r.ok) throw new Error("netcheck " + r.status);
    const res = await r.json();
    const theirs = await crypto.subtle.importKey("raw", unb64(res.pub), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: theirs }, pair.privateKey, 256);
    const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: enc.encode("interpartes-netcheck-v1"), info: enc.encode("echo") },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(res.iv) }, key, unb64(res.ct));
    const out = JSON.parse(dec.decode(pt).trim());
    return { ip: plainIp(out.ip), proxied: !!out.proxied };
  }

  async function lists(ip) {
    const n = v4(ip);
    if (n === null) return [];
    const r = await fetch("/chat/iplists.txt", { referrerPolicy: "no-referrer" });
    if (!r.ok) throw new Error("lists " + r.status);
    const found = new Set();
    let name = "";
    for (const line of (await r.text()).split("\n")) {
      if (line.startsWith("# ")) {
        name = line.slice(2).trim();
        continue;
      }
      if (!name || found.has(name)) continue;
      const [addr, len = "32"] = line.split("/");
      const start = v4(addr);
      if (start === null) continue;
      const bits = Number(len);
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      if (((n & mask) >>> 0) === ((start & mask) >>> 0)) found.add(name);
    }
    return [...found].filter((x) => x in LABELS);
  }

  async function webrtcAddresses() {
    if (typeof RTCPeerConnection !== "function") return [];
    const pc = new RTCPeerConnection({ iceServers: [] });
    const ips = new Set();
    try {
      pc.createDataChannel("x");
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((done) => {
        const t = setTimeout(done, 1500);
        pc.onicecandidate = (e) => {
          if (!e.candidate) {
            clearTimeout(t);
            done();
            return;
          }
          const a = e.candidate.address || e.candidate.candidate.split(" ")[4];
          if (a && !a.endsWith(".local")) ips.add(plainIp(a));
        };
      });
    } finally {
      pc.close();
    }
    return [...ips];
  }

  function pageTampered() {
    const foreign = (u) => {
      const url = new URL(u, location.href);
      if (/^(chrome|moz|safari|safari-web)-extension:$/.test(url.protocol)) return true;
      return /^https?:$/.test(url.protocol) && url.origin !== location.origin;
    };
    for (const s of document.scripts) if (s.src && foreign(s.src)) return true;
    for (const e of performance.getEntriesByType("resource")) {
      if (e.initiatorType === "script" && foreign(e.name)) return true;
    }
    return false;
  }

  async function run() {
    const risks = new Set();
    if (navigator.webdriver) risks.add("automation");
    try {
      if (pageTampered()) risks.add("page-tampered");
    } catch {}
    const [e, rtc] = await Promise.all([
      withTimeout(echo().catch(() => null), TIMEOUT_MS, null),
      withTimeout(webrtcAddresses().catch(() => []), TIMEOUT_MS, []),
    ]);
    if (!e) {
      risks.add("unchecked");
      return [...risks];
    }
    if (e.proxied) risks.add("proxy");
    // Same address family only: dual-stack devices normally have both.
    const v4Echo = v4(e.ip) !== null;
    if (rtc.some((a) => (v4(a) !== null) === v4Echo && !isPrivate(a) && a !== e.ip)) risks.add("webrtc-leak");
    const listed = await withTimeout(lists(e.ip).catch(() => null), TIMEOUT_MS, null);
    if (listed === null) risks.add("unchecked");
    else for (const x of listed) risks.add(x);
    return [...risks];
  }

  // Findings received from someone else: keep only known codes.
  function clean(risks) {
    if (!Array.isArray(risks)) return [];
    return [...new Set(risks.filter((x) => typeof x === "string" && x in LABELS))];
  }

  // Inside the call's chat panel the call page has already checked.
  let parentResult = null;
  try {
    if (window.parent !== window && window.parent.location.origin === location.origin) parentResult = window.parent.IPNC?.result;
  } catch {}

  window.IPNC = Object.freeze({
    result: parentResult || run().catch(() => ["unchecked"]),
    clean,
    describe: (code) => LABELS[code] || "",
  });
})();
