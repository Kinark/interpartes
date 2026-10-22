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

  // Nothing about a visit stays in the browser once it's over: no guest
  // login, nickname, call passwords, Matrix cache or Element Call's local
  // debug logs. Wiped when a call ends, when the tab is closed or leaves the
  // site, and whenever the home page loads. Skipped while another tab is in a
  // call (it shares the guest login, and deleting its databases would wait
  // for it to close). Tabs that are not in a call don't block it.
  const TAB = "ip-tab:" + crypto.randomUUID();
  const DATABASES = [
    "matrix-js-sdk:element-call-sync",
    "matrix-js-sdk::matrix-sdk-crypto",
    "matrix-js-sdk::matrix-sdk-crypto-meta",
    "logs-element-call",
  ];
  function othersOpen() {
    const now = Date.now();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith("ip-tab:") && k !== TAB && now - Number(localStorage.getItem(k)) < 5000) return true;
    }
    return false;
  }
  function forget(keepTab) {
    // sessionStorage dies with the tab anyway; keeping it on reload lets the
    // nickname be filled in again.
    if (!keepTab) sessionStorage.clear();
    if (othersOpen()) return;
    localStorage.clear();
    // Requested before Element Call opens them, so its opens wait for these.
    for (const name of DATABASES) indexedDB.deleteDatabase(name);
    indexedDB.databases?.().then((dbs) => {
      for (const d of dbs) if (d.name) indexedDB.deleteDatabase(d.name);
    });
  }
  function beat() {
    try {
      if (location.pathname.startsWith("/room")) localStorage.setItem(TAB, String(Date.now()));
      else localStorage.removeItem(TAB);
    } catch {}
  }
  if (location.pathname === "/") forget();
  beat();
  setInterval(beat, 2000);
  window.addEventListener("pagehide", () => {
    localStorage.removeItem(TAB);
    forget(true);
  });

  // Skip Element Call's "Your call has ended. How did it go?" screen: forget
  // the visit and go straight back to the home page.
  const style = document.createElement("style");
  style.textContent = "#root:has([class*=_callEndedContent_]){visibility:hidden}";
  document.head.append(style);
  let ended = false;
  new MutationObserver(() => {
    if (ended || !document.querySelector("[class*=_callEndedContent_]")) return;
    ended = true;
    forget();
    location.replace("/");
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
