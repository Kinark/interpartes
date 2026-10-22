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
