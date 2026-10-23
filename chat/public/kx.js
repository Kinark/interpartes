"use strict";

// Group key agreement with forward secrecy, used by both calls and chats.
//
// Everyone in a room holds the link secret. Every message here is sealed with
// a key derived from it, so the server (which never sees the secret) can
// neither read nor inject anything. On top of that, each browser makes a
// throwaway ECDH key pair when it joins. One member (the "leader", lowest
// random id) picks a fresh random group key and sends it to each member,
// encrypted for that member with an ECDH-derived key. A new group key is
// made whenever someone joins or leaves.
//
// The key actually used for media / messages mixes the group key with the
// link secret, so it takes both to decrypt: the link alone can't unlock
// recorded traffic (forward secrecy: the ECDH keys and group keys exist only
// in memory and are gone when the tab closes), and the server can't hand out
// its own group key because it can't seal messages without the link secret.
(function () {
  const PAD_TO = 256;
  const MAX_SKEW_MS = 5 * 60_000;
  const RING = 16;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function b64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function hex(buf) {
    return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");
  }
  function rand(n) {
    return crypto.getRandomValues(new Uint8Array(n));
  }
  function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }

  async function hkdf(ikm, salt, info, bits = 256) {
    const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(
      await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode(salt), info: enc.encode(info) }, base, bits),
    );
  }
  async function aesKey(raw) {
    return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  // Padded AES-GCM, so lengths only reveal a rough size bucket.
  async function seal(key, obj, aad = "") {
    const body = enc.encode(JSON.stringify(obj));
    const padded = new Uint8Array(Math.ceil((body.length + 4) / PAD_TO) * PAD_TO);
    new DataView(padded.buffer).setUint32(0, body.length);
    padded.set(body, 4);
    const iv = rand(12);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, padded),
    );
    return b64(concat(iv, ct));
  }
  async function open(key, data, aad = "") {
    const raw = unb64(data);
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: enc.encode(aad) },
        key,
        raw.subarray(12),
      ),
    );
    const len = new DataView(pt.buffer).getUint32(0);
    if (len > pt.length - 4) throw new Error("bad padding");
    return JSON.parse(dec.decode(pt.subarray(4, 4 + len)));
  }

  // opts: secret, roomId, scope ("call" | "chat"), meta (sent to others),
  // onKey(index, bytes) for every new 32-byte key, onMessage(relayId, obj),
  // onPeer(relayId, meta, isUpdate), onLeave(relayId), onStatus({ connected, n, keyed }),
  // closable (any member may close the room for everyone; chat-only rooms),
  // onClosed(relayId of whoever closed it, or null if not known)
  function session(opts) {
    const scope = opts.scope;
    const secret = opts.secret;
    const roomId = opts.roomId || "";
    const salt = `interpartes-kx-v1|${scope}|${roomId}`;
    const me = hex(rand(16));
    let ws = null;
    let closed = false;
    let retry = 0;
    let relayN = 0;
    let lastIdx = 0;
    let currentIdx = -1;
    let rekeyTimer = null;
    let rekeyWaitSince = 0;
    const peers = new Map(); // relayId -> { id, pub: CryptoKey, raw }
    const wrapKeys = new Map(); // peer id + pub -> AES key
    const groupKeys = new Map(); // index -> AES key (chat messages)
    const seen = new Set();
    const pendingKeyMsgs = [];
    let closedBy = null;

    const ready = (async () => {
      const s = enc.encode(secret);
      const tag = hex(await hkdf(s, salt, "room-tag"));
      const auth = await aesKey(await hkdf(s, salt, "auth"));
      const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
      const pubRaw = b64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
      return { tag, auth, pair, pubRaw };
    })();

    function status() {
      opts.onStatus?.({ connected: ws?.readyState === WebSocket.OPEN && relayN > 0, n: relayN, keyed: currentIdx >= 0 });
    }

    async function sendOuter(obj) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      const { auth } = await ready;
      ws.send(await seal(auth, { ...obj, n: b64(rand(12)), ts: Date.now() }, "outer"));
      return true;
    }

    async function sendPub() {
      const { pubRaw } = await ready;
      await sendOuter({ k: "pub", id: me, pub: pubRaw, meta: opts.meta });
    }

    function isLeader() {
      for (const p of peers.values()) if (p.id < me) return false;
      return true;
    }

    async function wrapKeyFor(peer) {
      const cacheKey = peer.id + peer.raw;
      let k = wrapKeys.get(cacheKey);
      if (k) return k;
      const { pair } = await ready;
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer.pub }, pair.privateKey, 256));
      const ids = [me, peer.id].sort().join("|");
      k = await aesKey(await hkdf(shared, salt + "|" + ids, "wrap"));
      shared.fill(0);
      wrapKeys.set(cacheKey, k);
      return k;
    }

    async function apply(idx, groupKey) {
      // Final key needs both the fresh group key and the link secret.
      const bytes = await hkdf(concat(groupKey, enc.encode(secret)), salt, "group-key|" + idx);
      groupKey.fill(0);
      lastIdx = idx;
      currentIdx = idx;
      if (scope === "chat") groupKeys.set(idx, await aesKey(bytes));
      await opts.onKey?.(idx, bytes);
      bytes.fill(0);
      status();
    }

    function scheduleRekey() {
      clearTimeout(rekeyTimer);
      rekeyTimer = setTimeout(rekey, 250);
    }

    async function rekey() {
      if (closed || !isLeader()) return;
      // Wait (briefly) until every connected member has introduced itself.
      if (peers.size + 1 < relayN) {
        if (!rekeyWaitSince) rekeyWaitSince = Date.now();
        if (Date.now() - rekeyWaitSince < 2500) {
          rekeyTimer = setTimeout(rekey, 300);
          return;
        }
      }
      rekeyWaitSince = 0;
      const idx = (lastIdx % (RING - 1)) + 1;
      const groupKey = rand(32);
      const w = {};
      for (const p of peers.values()) {
        const k = await wrapKeyFor(p);
        w[p.id] = await seal(k, { g: b64(groupKey) }, "wrap|" + idx + "|" + me);
      }
      if (peers.size && !(await sendOuter({ k: "key", id: me, i: idx, w }))) return;
      await apply(idx, groupKey);
    }

    async function onKeyMsg(m) {
      const mine = m.w?.[me];
      if (typeof mine !== "string" || !Number.isInteger(m.i) || m.i < 1 || m.i >= RING) return true;
      const from = [...peers.values()].find((p) => p.id === m.id);
      if (!from) return false; // their introduction hasn't arrived yet
      // Only the leader's keys count (if it's us, we send our own instead).
      if (me < from.id || [...peers.values()].some((p) => p.id < from.id)) return true;
      try {
        const k = await wrapKeyFor(from);
        const { g } = await open(k, mine, "wrap|" + m.i + "|" + m.id);
        await apply(m.i, unb64(g));
      } catch {}
      return true;
    }

    async function onFrame(msg) {
      if (msg.t === "x") {
        // The relay closes every socket right after this (code 4004).
        closedBy = typeof msg.f === "string" ? msg.f : null;
        return;
      }
      if (msg.t === "ready" || msg.t === "j" || msg.t === "l") {
        relayN = msg.n;
        if (msg.t === "ready") {
          retry = 0;
          await sendPub();
          if (msg.n === 1) scheduleRekey();
        } else if (msg.t === "j") {
          await sendPub();
        } else if (peers.has(msg.f)) {
          peers.delete(msg.f);
          opts.onLeave?.(msg.f);
          if (isLeader()) scheduleRekey();
        }
        status();
        return;
      }
      if (msg.t !== "m" || typeof msg.d !== "string") return;
      const { auth } = await ready;
      let m;
      try {
        m = await open(auth, msg.d, "outer");
      } catch {
        return;
      }
      if (typeof m.n !== "string" || seen.has(m.n)) return;
      if (typeof m.ts !== "number" || Math.abs(Date.now() - m.ts) > MAX_SKEW_MS) return;
      seen.add(m.n);

      if (m.k === "pub" && typeof m.id === "string" && /^[0-9a-f]{32}$/.test(m.id) && typeof m.pub === "string") {
        const old = peers.get(msg.f);
        if (old?.raw === m.pub) {
          // Same member, new details (e.g. its connection check finished).
          if (JSON.stringify(m.meta) !== old.meta) {
            old.meta = JSON.stringify(m.meta);
            opts.onPeer?.(msg.f, m.meta, true);
          }
          return;
        }
        let pub;
        try {
          pub = await crypto.subtle.importKey("raw", unb64(m.pub), { name: "ECDH", namedCurve: "P-256" }, false, []);
        } catch {
          return;
        }
        peers.set(msg.f, { id: m.id, pub, raw: m.pub, meta: JSON.stringify(m.meta) });
        opts.onPeer?.(msg.f, m.meta, !!old);
        for (let i = pendingKeyMsgs.length - 1; i >= 0; i--) {
          if (await onKeyMsg(pendingKeyMsgs[i])) pendingKeyMsgs.splice(i, 1);
        }
        if (isLeader()) scheduleRekey();
      } else if (m.k === "key") {
        if (!(await onKeyMsg(m))) pendingKeyMsgs.push(m);
      } else if (m.k === "msg" && typeof m.c === "string" && groupKeys.has(m.i)) {
        try {
          opts.onMessage?.(msg.f, await open(groupKeys.get(m.i), m.c, "msg|" + m.i));
        } catch {}
      }
    }

    async function connect() {
      const { tag } = await ready;
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/chat/ws`);
      ws.onopen = () => ws.send(JSON.stringify(opts.closable ? { join: tag, closable: true } : { join: tag }));
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        onFrame(msg).catch(() => {});
      };
      ws.onclose = (ev) => {
        if (ev.code === 4004 && !closed) {
          // Room closed for everyone: by someone here just now, or earlier.
          const by = closedBy;
          shutdown();
          opts.onClosed?.(by);
          return;
        }
        for (const id of peers.keys()) opts.onLeave?.(id);
        peers.clear();
        relayN = 0;
        status();
        if (closed) return;
        if (ev.code === 4003) {
          opts.onStatus?.({ full: true });
          return;
        }
        setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
      };
    }
    function shutdown() {
      closed = true;
      clearTimeout(rekeyTimer);
      ws?.close();
      peers.clear();
      groupKeys.clear();
      wrapKeys.clear();
    }

    connect();

    return {
      // Chat only: send an object sealed with the current group key.
      async send(obj) {
        if (currentIdx < 0) return false;
        const c = await seal(groupKeys.get(currentIdx), obj, "msg|" + currentIdx);
        return sendOuter({ k: "msg", i: currentIdx, c });
      },
      // Updates what the others see; sent again right away.
      setMeta(meta) {
        opts.meta = meta;
        if (relayN > 0) sendPub().catch(() => {});
      },
      close: shutdown,
      // Closable rooms only: ends the room for everyone (the relay
      // disconnects all members and refuses the room from then on).
      closeForEveryone() {
        if (!opts.closable || !ws || ws.readyState !== WebSocket.OPEN) return false;
        ws.send('{"t":"close"}');
        shutdown();
        return true;
      },
    };
  }

  window.IPKX = Object.freeze({ session });
})();
