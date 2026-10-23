"use strict";

// Loaded by index.html before Element Call starts. Element Call reads options
// from the link (after #?), and some of them weaken privacy: a crafted link
// could turn off call encryption or send analytics, crash reports or debug
// logs to another server. Strip those before the app reads them, so every
// call here is end-to-end encrypted and talks only to this server.
(function () {
  const BLOCKED = [
    "enableE2EE",
    "perParticipantE2EE",
    "homeserver",
    "posthogApiHost",
    "posthogApiKey",
    "posthogUserId",
    "rageshakeSubmitUrl",
    "sentryDsn",
    "sentryEnvironment",
  ];
  function clean(query) {
    const p = new URLSearchParams(query);
    let changed = false;
    for (const k of [...p.keys()]) {
      if (BLOCKED.includes(k)) {
        p.delete(k);
        changed = true;
      }
    }
    return changed ? p.toString() : null;
  }
  function scrub() {
    const url = new URL(location.href);
    let changed = false;
    const search = clean(url.search);
    if (search !== null) {
      url.search = search;
      changed = true;
    }
    const h = url.hash;
    const i = h.indexOf("?");
    if (i !== -1) {
      const q = clean(h.slice(i + 1));
      if (q !== null) {
        url.hash = h.slice(0, i + 1) + q;
        changed = true;
      }
    }
    if (changed) history.replaceState(history.state, "", url.toString());
  }
  scrub();
  // A link opened in a tab already on this site only changes the hash (no
  // reload). These listeners are registered before Element Call's, so they
  // run first.
  window.addEventListener("hashchange", scrub);
  window.addEventListener("popstate", scrub);

  // No session survives a call. Element Call is given no lasting storage:
  // its "localStorage" is this tab's sessionStorage, and it gets no IndexedDB,
  // so the Matrix client keeps everything in memory. The guest login, call
  // passwords and nickname therefore live only in this tab, are never shared
  // with other tabs, and are wiped when a call ends or the home page loads.
  // Anything older versions of this page left behind is deleted too.
  const real = { local: window.localStorage, idb: window.indexedDB };
  try {
    real.local.clear();
    real.idb.databases?.().then((dbs) => {
      for (const d of dbs) if (d.name) real.idb.deleteDatabase(d.name);
    });
  } catch {}
  Object.defineProperty(window, "localStorage", { configurable: true, get: () => sessionStorage });
  Object.defineProperty(window, "indexedDB", { configurable: true, get: () => undefined });
  function forget() {
    sessionStorage.clear();
  }
  if (location.pathname === "/") forget();

  // Leaving a call must end the session. Element Call either shows its
  // "Your call has ended. How did it go?" screen or moves to its home page
  // inside the app, still signed in (profile badge, no nickname field). In
  // every case: wipe the tab and load a fresh home page. Also if a signed-in
  // home page ever shows up for any other reason.
  const style = document.createElement("style");
  style.textContent =
    "#root:has([class*=_callEndedContent_]),#root:has([data-testid=usermenu_open]):not(:has([data-testid=incall_leave])){visibility:hidden}";
  document.head.append(style);
  const startedInRoom = location.pathname.startsWith("/room");
  let resetting = false;
  function reset() {
    if (resetting) return;
    resetting = true;
    forget();
    location.replace("/");
  }
  function check() {
    if (resetting) return;
    if (document.querySelector("[class*=_callEndedContent_]")) return reset();
    if (startedInRoom && !location.pathname.startsWith("/room")) return reset();
    if (location.pathname === "/" && document.querySelector("[data-testid=usermenu_open]")) return reset();
  }
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function (...args) {
      const r = orig.apply(this, args);
      check();
      return r;
    };
  }
  window.addEventListener("popstate", check);
  new MutationObserver(check).observe(document.documentElement, { childList: true, subtree: true });

  // Forward secrecy for calls. Element Call encrypts media in a LiveKit
  // worker with a key taken from the link's password. We intercept the
  // messages it sends that worker: its link-derived key is dropped, and the
  // worker gets keys from an ECDH exchange between the participants instead
  // (kx.js), authenticated by that same password. Media therefore needs both
  // the link and keys that only exist in the participants' memory during the
  // call. Until the first exchanged key arrives, the worker has no key and
  // sends nothing (it never falls back to unencrypted media).
  // Connection check (netcheck.js): starts as the site loads. Its findings
  // go to the others in the call with this member's key exchange message,
  // and theirs come back the same way (shown by inject.js).
  const i18nScript = document.createElement("script");
  i18nScript.src = "/chat/i18n.js";
  i18nScript.onload = () => window.dispatchEvent(new CustomEvent("ip-i18n-loaded"));
  document.head.append(i18nScript);
  const ncScript = document.createElement("script");
  ncScript.src = "/chat/netcheck.js";
  ncScript.onload = () => window.dispatchEvent(new CustomEvent("ip-netcheck-loaded"));
  document.head.append(ncScript);
  const peerRisks = new Map(); // relay id -> finding codes
  window.IPCallRisks = peerRisks;
  function risksChanged() {
    window.dispatchEvent(new CustomEvent("ip-call-risks"));
  }

  const kxScript = document.createElement("script");
  kxScript.src = "/chat/kx.js";
  kxScript.onload = () => workers.size && startCallKx();
  document.head.append(kxScript);

  const NativeWorker = window.Worker;
  const workers = new Set();
  let callKx = null;
  let callKey = null; // { idx, key }

  function callParams() {
    const h = location.hash;
    const i = h.indexOf("?");
    if (i === -1) return null;
    const p = new URLSearchParams(h.slice(i));
    const roomId = p.get("roomId");
    const password = p.get("password");
    return roomId && password ? { roomId, password } : null;
  }

  function postKey(w) {
    if (!callKey) return;
    NativeWorker.prototype.postMessage.call(w, {
      kind: "setKey",
      data: { participantIdentity: undefined, isPublisher: true, key: callKey.key, keyIndex: callKey.idx, updateCurrentKeyIndex: true },
    });
  }

  function startCallKx() {
    if (callKx) return;
    const c = callParams();
    if (!c || !window.IPKX) return;
    callKx = window.IPKX.session({
      secret: c.password,
      roomId: c.roomId,
      scope: "call",
      meta: { risk: null },
      onPeer(id, meta) {
        const r = window.IPNC?.clean(meta?.risk) || [];
        if (r.length) peerRisks.set(id, r);
        else peerRisks.delete(id);
        risksChanged();
      },
      onLeave(id) {
        if (peerRisks.delete(id)) risksChanged();
      },
      async onKey(idx, bytes) {
        const key = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveBits", "deriveKey"]);
        callKey = { idx, key };
        for (const w of workers) postKey(w);
        window.dispatchEvent(new CustomEvent("ip-call-keyed"));
      },
    });
    const kx = callKx;
    const share = () => window.IPNC?.result.then((risk) => callKx === kx && kx.setMeta({ risk }));
    if (window.IPNC) share();
    else window.addEventListener("ip-netcheck-loaded", share, { once: true });
  }

  window.Worker = class extends NativeWorker {
    postMessage(msg, ...rest) {
      const kind = msg?.kind;
      if (kind === "init" && msg.data?.keyProviderOptions?.sharedKey) {
        // LiveKit's E2EE worker for a shared-key (password) call.
        this.ipE2EE = true;
        workers.add(this);
        super.postMessage(msg, ...rest);
        startCallKx();
        postKey(this);
        return;
      }
      if (this.ipE2EE && (kind === "setKey" || kind === "ratchetRequest")) return;
      super.postMessage(msg, ...rest);
    }
    terminate() {
      workers.delete(this);
      super.terminate();
    }
  };
})();
