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
})();
