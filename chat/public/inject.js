"use strict";

// Loaded into Element Call. Adds a "Chat" button to the in-call controls that
// opens /chat in a side panel, keyed by the call's roomId + password (both
// taken from the URL fragment, so nothing new is sent to the server).
(function main() {
  // Strings come from i18n.js (loaded by guard.js); wait for it.
  if (!window.IPI18N) {
    window.addEventListener("ip-i18n-loaded", main, { once: true });
    return;
  }
  const t = window.IPI18N.t;
  const ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8.4l-3.7 3.2A1 1 0 0 1 3 20.4V6a2 2 0 0 1 2-2Zm1 2v12.2L7.6 16H20V6H5Zm2 3h10v2H7V9Zm0 3h7v2H7v-2Z"/></svg>';
  const STYLE = `
    #ip-chat-panel{position:fixed;top:0;right:0;bottom:0;width:min(380px,100vw);z-index:1000;
      background:#1b1f24;border-left:1px solid #2c3239;box-shadow:-8px 0 24px rgba(0,0,0,.4);
      display:flex;flex-direction:column}
    #ip-chat-panel[hidden]{display:none}
    #ip-chat-panel header{display:flex;align-items:center;justify-content:space-between;
      padding:10px 12px;border-bottom:1px solid #2c3239;color:#ebeef2;font:600 15px system-ui,sans-serif}
    #ip-chat-panel header button{background:none;border:0;color:#ebeef2;font-size:20px;cursor:pointer;line-height:1}
    #ip-chat-panel iframe{flex:1;border:0;width:100%}
    #ip-chat-btn[aria-checked="true"]{outline:2px solid #0dbd8b;outline-offset:2px}
    #ip-chat-btn .ip-dot{position:absolute;top:6px;right:6px;width:9px;height:9px;border-radius:50%;background:#0dbd8b}
  `;

  function callParams() {
    const h = location.hash;
    const i = h.indexOf("?");
    if (!location.pathname.startsWith("/room") || i === -1) return null;
    const p = new URLSearchParams(h.slice(i));
    const roomId = p.get("roomId");
    const password = p.get("password");
    return roomId && password ? { roomId, password } : null;
  }

  let panel = null;
  let frame = null;
  let current = null;

  function ensurePanel() {
    if (panel) return;
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.append(style);
    panel = document.createElement("aside");
    panel.id = "ip-chat-panel";
    panel.hidden = true;
    const header = document.createElement("header");
    const title = document.createElement("span");
    title.textContent = t("chat");
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", t("closeChat"));
    close.textContent = "×";
    close.onclick = () => toggle(false);
    header.append(title, close);
    panel.append(header);
    document.body.append(panel);
  }

  function chatUrl(c) {
    const p = new URLSearchParams({ r: c.roomId, k: c.password, e: "1" });
    return `/chat/#${p.toString()}`;
  }

  function toggle(open) {
    const c = callParams();
    if (!c) return;
    ensurePanel();
    const key = c.roomId + "|" + c.password;
    if (open && (!frame || current !== key)) {
      frame?.remove();
      frame = document.createElement("iframe");
      frame.title = t("encryptedChat");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.src = chatUrl(c);
      panel.append(frame);
      current = key;
    }
    panel.hidden = !open;
    const btn = document.getElementById("ip-chat-btn");
    if (btn) {
      btn.setAttribute("aria-checked", String(open));
      if (open) btn.querySelector(".ip-dot")?.remove();
    }
  }

  function closeChat() {
    frame?.remove();
    frame = null;
    current = null;
    if (panel) panel.hidden = true;
  }

  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || e.source !== frame?.contentWindow) return;
    if (e.data?.interpartesChat === "close") closeChat();
    if (e.data?.interpartesChat === "unread" && panel?.hidden) {
      const btn = document.getElementById("ip-chat-btn");
      if (btn && !btn.querySelector(".ip-dot")) {
        const dot = document.createElement("span");
        dot.className = "ip-dot";
        btn.append(dot);
      }
    }
  });

  function addButton() {
    const leave = document.querySelector("[data-testid=incall_leave]");
    if (!leave || !callParams()) return;
    if (document.getElementById("ip-chat-btn")) return;
    const ref = document.querySelector("[data-testid=incall_screenshare]") || leave;
    const btn = document.createElement("button");
    btn.id = "ip-chat-btn";
    btn.type = "button";
    btn.className = ref.className.replace(/_shareScreen_\S+/, "");
    btn.dataset.kind = "secondary";
    btn.dataset.size = ref.dataset.size || "lg";
    btn.setAttribute("role", "switch");
    btn.setAttribute("aria-checked", String(!!panel && !panel.hidden));
    btn.setAttribute("aria-label", t("chat"));
    btn.title = t("chat");
    btn.style.position = "relative";
    btn.innerHTML = ICON;
    btn.onclick = (e) => {
      e.stopPropagation();
      toggle(!panel || panel.hidden);
    };
    leave.before(btn);
  }

  // Home page layout:   New Room
  //                      [Nickname]
  //                    <Call>  <Chat>
  // Done with CSS over Element Call's own form so its logic stays intact.
  // There is no room name: Element Call's field is hidden and filled with a
  // random value (see fillRoomName), so no name ever reaches the server.
  const HOME_STYLE = `
    main:has([data-testid=home_go]){flex:1;display:flex;flex-direction:column;
      align-items:center;justify-content:center;padding-block:24px}
    main:has([data-testid=home_go]) h1{text-align:center;margin:0 0 24px}
    form:has([data-testid=home_go]){display:grid;grid-template-columns:1fr 1fr;
      column-gap:12px;row-gap:24px;width:min(360px,calc(100vw - 32px));align-items:center}
    form:has([data-testid=home_go]) > *{margin:0!important}
    form:has([data-testid=home_go]) > div:has([data-testid=home_callName]):not(:has([data-testid=home_go])),
    form:has([data-testid=home_go]) div:has(> [data-testid=home_callName]){display:none!important}
    /* Logged-in layout (a guest login left over from another tab's call):
       the buttons share a row with the hidden field, and recent calls are
       listed below. */
    form:has([data-testid=home_go]) > div:has(> [data-testid=home_go]){grid-column:1/-1;display:flex;
      justify-content:center;gap:12px}
    main:has([data-testid=home_go]) [class*=_callList_]{display:none!important}
    form:has([data-testid=home_go]) > :has([data-testid=home_displayName]){grid-column:1/-1}
    form:has([data-testid=home_go]) > p{display:none}
    form button[data-testid=home_go][type=submit],form #ip-chatonly-btn{width:auto!important;min-width:0!important;padding-inline:28px!important}
    form button[data-testid=home_go][type=submit]{justify-self:end}
    form #ip-chatonly-btn{justify-self:start}
  `;

  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;

  // React controls these inputs: set via the native setter + input event.
  function setInput(el, v) {
    setValue.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function fillRoomName(fresh) {
    const el = document.querySelector("[data-testid=home_callName]");
    if (!el || (el.value && !fresh)) return;
    const b = crypto.getRandomValues(new Uint8Array(12));
    setInput(el, Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
  }

  // A new random name for every call (capture phase: runs before React reads
  // the form).
  document.addEventListener(
    "submit",
    (e) => {
      if (e.target.querySelector?.("[data-testid=home_callName]")) fillRoomName(true);
    },
    true,
  );

  // Rename React-rendered text in place (same text node), so React's own
  // later updates such as "Loading…" still show. Element Call translates its
  // labels itself, so the text to replace is whatever it first showed, in
  // whichever language.
  const firstSeen = new Map();
  function relabel(el, name, to) {
    for (const n of el?.childNodes || []) {
      if (n.nodeType !== Node.TEXT_NODE || !n.nodeValue.trim()) continue;
      if (!firstSeen.has(name) && n.nodeValue !== to) firstSeen.set(name, n.nodeValue);
      if (n.nodeValue === firstSeen.get(name)) n.nodeValue = to;
    }
  }

  function homeLayout() {
    if (!document.getElementById("ip-home-style")) {
      const style = document.createElement("style");
      style.id = "ip-home-style";
      style.textContent = HOME_STYLE;
      document.head.append(style);
    }
    const go = document.querySelector("[data-testid=home_go]");
    if (!go) return;
    relabel(go.closest("main")?.querySelector("h1"), "title", t("newRoom"));
    relabel(go, "go", t("call"));
    fillRoomName(false);
    const nick = document.querySelector("[data-testid=home_displayName]");
    if (nick && nick.placeholder !== t("nickname")) {
      nick.placeholder = t("nickname");
      relabel(nick.labels?.[0], "nick", t("nickname"));
    }
  }

  // Home page: a "Chat" button beside "Call" that starts a text-only room
  // with the same nickname, without creating a call.
  function addChatOnlyButton() {
    const go = document.querySelector("[data-testid=home_go]");
    if (!go || document.getElementById("ip-chatonly-btn")) return;
    const btn = document.createElement("button");
    btn.id = "ip-chatonly-btn";
    btn.type = "button";
    btn.className = go.className;
    btn.dataset.kind = "primary";
    btn.dataset.size = go.dataset.size || "lg";
    btn.textContent = t("chat");
    btn.onclick = (e) => {
      e.preventDefault();
      const nameInput = document.querySelector("[data-testid=home_displayName]");
      // Same validation as "Call": a nickname is required for guests.
      if (nameInput && !nameInput.value.trim()) {
        nameInput.reportValidity?.();
        nameInput.focus();
        return;
      }
      const secretBytes = crypto.getRandomValues(new Uint8Array(24));
      const secret = btoa(String.fromCharCode(...secretBytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const p = new URLSearchParams({ k: secret });
      // Handed to the chat page once; it deletes it as soon as it reads it.
      if (nameInput?.value.trim()) {
        sessionStorage.setItem("interpartes-chat-handoff", nameInput.value.trim().slice(0, 40));
      }
      location.assign(`/chat/#${p}`);
    };
    go.after(btn);
  }

  // Connection check (netcheck.js, started by guard.js). The home page shows
  // the result under the buttons; it never stops anyone from continuing, but
  // says that the others in the room will be told.
  const NC_STYLE = `
    #ip-netcheck{grid-column:1/-1;margin:0;padding:10px 12px;border-radius:8px;
      font:14px/1.4 system-ui,sans-serif;background:rgba(127,127,127,.12)}
    #ip-netcheck.wait{justify-self:center;width:fit-content;background:none;color:#8d97a5;font-size:13px}
    #ip-netcheck.wait::before{content:"";display:inline-block;width:10px;height:10px;margin-right:8px;
      border-radius:50%;border:2px solid currentColor;border-right-color:transparent;vertical-align:-1px;
      animation:ip-spin .8s linear infinite}
    /* Safe: a pill that fits its text. It pops in, draws its check mark,
       glints once, and opens to list what was checked. */
    #ip-netcheck.ok{justify-self:center;width:fit-content;max-width:100%;padding:0;background:none;
      display:flex;flex-direction:column;align-items:center;
      border-radius:999px;animation:ip-pop .45s cubic-bezier(.2,1.4,.4,1) both}
    #ip-netcheck .ip-safe{position:relative;overflow:hidden;display:inline-flex;align-items:center;gap:8px;
      padding:7px 14px 7px 10px;border-radius:999px;border:1px solid rgba(13,189,139,.4);
      background:rgba(13,189,139,.12);color:#0dbd8b;font:600 14px system-ui,sans-serif;cursor:pointer;
      transition:background .2s,border-color .2s,transform .15s,box-shadow .2s}
    #ip-netcheck .ip-safe:hover{background:rgba(13,189,139,.18);border-color:rgba(13,189,139,.7);
      box-shadow:0 0 0 4px rgba(13,189,139,.12)}
    #ip-netcheck .ip-safe:active{transform:scale(.96)}
    #ip-netcheck .ip-safe:focus-visible{outline:2px solid #0dbd8b;outline-offset:2px}
    #ip-netcheck .ip-safe::after{content:"";position:absolute;inset:0;pointer-events:none;
      background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.28) 50%,transparent 70%);
      transform:translateX(-120%);animation:ip-glint 1.1s .55s ease-out both}
    #ip-netcheck .ip-safe svg{flex:none;transition:transform .3s}
    #ip-netcheck .ip-safe:hover svg{transform:rotate(-8deg) scale(1.1)}
    #ip-netcheck .ip-safe .ip-check{stroke-dasharray:14;stroke-dashoffset:14;animation:ip-draw .4s .3s ease-out forwards}
    /* Summary line: pale mint, with a slow shine (a deeper mint core
       inside a lighter halo) passing through, and a faint breathing glow. */
    #ip-netcheck .ip-safe-list li.ip-sub{color:transparent;font-weight:600;letter-spacing:.01em;
      background:linear-gradient(90deg,#e1fff6 0 38%,#f2fffb 45%,#b2ffe8 50%,#f2fffb 55%,#e1fff6 62% 100%) 100% 0/300% 100%;
      -webkit-background-clip:text;background-clip:text;
      animation:ip-aurora 9s ease-in-out infinite,ip-breathe 7s ease-in-out infinite}
    @keyframes ip-aurora{to{background-position:0 0}}
    @keyframes ip-breathe{0%,100%{filter:drop-shadow(0 0 0 rgba(178,255,232,0))}
      50%{filter:drop-shadow(0 0 3px rgba(178,255,232,.3))}}
    #ip-netcheck .ip-safe-list li.ip-sub::before{content:none}
    #ip-netcheck .ip-safe .ip-chev{font-size:10px;opacity:.7;transition:transform .25s}
    #ip-netcheck .ip-safe[aria-expanded=true] .ip-chev{transform:rotate(180deg)}
    /* Opening: the box grows, then the lines fade in top to bottom.
       Closing: the lines fade out bottom to top first, and the box only
       starts shrinking (slowly at first) once they're nearly gone, so no
       line is ever cut off while still visible. */
    #ip-netcheck .ip-safe-list{display:grid;grid-template-rows:0fr;
      transition:grid-template-rows .6s cubic-bezier(.55,0,.75,.2) .18s}
    #ip-netcheck .ip-safe-list > ul{overflow:hidden;margin:0;padding:0 6px;list-style:none;text-align:center;
      color:#8d97a5;font-size:12.5px;line-height:1.5;transition:padding-top .6s cubic-bezier(.55,0,.75,.2) .18s}
    #ip-netcheck.open .ip-safe-list{grid-template-rows:1fr;transition:grid-template-rows .55s cubic-bezier(.2,.7,.3,1)}
    #ip-netcheck.open .ip-safe-list > ul{padding-top:8px;transition:padding-top .55s cubic-bezier(.2,.7,.3,1)}
    #ip-netcheck .ip-safe-list li{opacity:0;transform:translateY(-4px);transition:opacity .16s ease-in,transform .16s ease-in}
    #ip-netcheck .ip-safe-list li:nth-child(4){transition-delay:.04s}
    #ip-netcheck .ip-safe-list li:nth-child(3){transition-delay:.08s}
    #ip-netcheck .ip-safe-list li:nth-child(2){transition-delay:.12s}
    #ip-netcheck .ip-safe-list li:nth-child(1){transition-delay:.16s}
    #ip-netcheck.open .ip-safe-list li{opacity:1;transform:none;transition:opacity .3s ease-out,transform .3s ease-out}
    #ip-netcheck.open .ip-safe-list li:nth-child(1){transition-delay:.12s}
    #ip-netcheck.open .ip-safe-list li:nth-child(2){transition-delay:.18s}
    #ip-netcheck.open .ip-safe-list li:nth-child(3){transition-delay:.24s}
    #ip-netcheck.open .ip-safe-list li:nth-child(4){transition-delay:.3s}
    #ip-netcheck.open .ip-safe-list li:nth-child(5){transition-delay:.36s}
    #ip-netcheck .ip-safe-list li::before{content:"✓";color:#0dbd8b;margin-right:6px}
    #ip-netcheck.bad{animation:ip-pop .35s ease-out both}
    @keyframes ip-pop{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:none}}
    @keyframes ip-draw{to{stroke-dashoffset:0}}
    @keyframes ip-glint{to{transform:translateX(120%)}}
    @keyframes ip-spin{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion:reduce){
      #ip-netcheck,#ip-netcheck *,#ip-netcheck *::after,#ip-netcheck::before{animation:none!important;transition:none!important}
      #ip-netcheck .ip-safe .ip-check{stroke-dashoffset:0}
    }
    #ip-netcheck.bad{background:#a3121e;color:#fff}
    #ip-netcheck ul{margin:6px 0;padding-left:18px}
    #ip-netcheck a{color:inherit}
    #ip-risks{position:fixed;top:44px;left:50%;transform:translateX(-50%);z-index:999;
      max-width:min(560px,calc(100vw - 24px));padding:6px 12px;border-radius:10px;
      background:#a3121e;color:#fff;font:500 13px/1.4 system-ui,sans-serif}
    #ip-risks ul{margin:2px 0 0;padding-left:18px}
    #ip-risks a{color:#fff}
  `;

  function ncStyle() {
    if (document.getElementById("ip-nc-style")) return;
    const style = document.createElement("style");
    style.id = "ip-nc-style";
    style.textContent = NC_STYLE;
    document.head.append(style);
  }

  function infoLink() {
    return Object.assign(document.createElement("a"), {
      href: "/chat/privacy.html#connection-check",
      target: "_blank",
      rel: "noopener",
      textContent: t("whatThisMeans"),
    });
  }

  const SHIELD =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Z" fill="currentColor" fill-opacity=".15"/>' +
    '<path class="ip-check" d="m8.5 12.2 2.4 2.4 4.6-4.8"/></svg>';

  function safeBadge(box) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ip-safe";
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = SHIELD;
    btn.append(Object.assign(document.createElement("span"), { textContent: t("safe") }), Object.assign(document.createElement("span"), { className: "ip-chev", textContent: "▾", ariaHidden: "true" }));
    btn.title = t("safeDetails");
    const list = document.createElement("div");
    list.className = "ip-safe-list";
    const ul = document.createElement("ul");
    ul.append(Object.assign(document.createElement("li"), { className: "ip-sub", textContent: t("safeSub") }));
    for (const k of ["ok.network", "ok.leak", "ok.page", "ok.private"]) {
      ul.append(Object.assign(document.createElement("li"), { textContent: t(k) }));
    }
    list.append(ul);
    btn.onclick = (e) => {
      e.preventDefault();
      const open = !box.classList.contains("open");
      box.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", String(open));
    };
    box.replaceChildren(btn, list);
  }

  let homeRisk = null; // null until the check has finished
  function showHomeCheck() {
    const go = document.querySelector("[data-testid=home_go]");
    const form = go?.closest("form");
    if (!form) return;
    ncStyle();
    let box = document.getElementById("ip-netcheck");
    if (!box) {
      box = document.createElement("div");
      box.id = "ip-netcheck";
      box.setAttribute("role", "status");
      form.append(box);
    }
    const state = homeRisk === null ? "wait" : homeRisk.length ? "bad" : "ok";
    if (box.dataset.state === state) return;
    box.dataset.state = state;
    box.className = state;
    if (state === "wait") {
      box.textContent = t("checking");
    } else if (state === "ok") {
      safeBadge(box);
    } else {
      const ul = document.createElement("ul");
      for (const r of homeRisk) ul.append(Object.assign(document.createElement("li"), { textContent: window.IPNC.describe(r) }));
      box.replaceChildren(t("riskTitle"), ul, t("riskContinue") + " ", infoLink());
    }
  }
  function waitForCheck() {
    window.IPNC?.result.then((r) => {
      homeRisk = r;
      showHomeCheck();
      showCallRisks();
    });
  }
  if (window.IPNC) waitForCheck();
  else window.addEventListener("ip-netcheck-loaded", waitForCheck, { once: true });

  // In a call: a warning that stays on screen while anyone in the call
  // (including you) has a finding.
  function showCallRisks() {
    let box = document.getElementById("ip-risks");
    const inCall = location.pathname.startsWith("/room") && document.querySelector("[data-testid=incall_leave]");
    const lines = [];
    if (inCall) {
      for (const r of homeRisk || []) lines.push(t("you") + ": " + window.IPNC.describe(r));
      for (const risks of window.IPCallRisks?.values() || []) {
        for (const r of risks) lines.push(t("someoneInCall") + ": " + window.IPNC.describe(r));
      }
    }
    if (!lines.length) {
      box?.remove();
      return;
    }
    const key = lines.join("\n");
    if (box?.dataset.key === key) return;
    ncStyle();
    if (!box) {
      box = document.createElement("div");
      box.id = "ip-risks";
      box.setAttribute("role", "alert");
      document.body.append(box);
    }
    box.dataset.key = key;
    const ul = document.createElement("ul");
    for (const l of lines) ul.append(Object.assign(document.createElement("li"), { textContent: l }));
    box.replaceChildren(t("warnBar") + " ", infoLink(), ul);
  }
  window.addEventListener("ip-call-risks", showCallRisks);

  function sync() {
    if (location.pathname === "/") {
      homeLayout();
      addChatOnlyButton();
      showHomeCheck();
    }
    showCallRisks();
    if (!callParams() || !document.querySelector("[data-testid=incall_leave]")) {
      // Left the call (or a different page): drop the chat with it.
      if (frame) closeChat();
      return;
    }
    addButton();
  }

  // In a call: show the safety code (same digits as the call's chat; see
  // safetyCode in app.js). If the link carries no call password, the call
  // would not be end-to-end encrypted, so say so instead.
  const SAFETY_STYLE = `
    #ip-safety{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:999;
      padding:4px 12px;border-radius:999px;background:rgba(27,31,36,.85);color:#8d97a5;
      font:500 13px system-ui,sans-serif;white-space:nowrap;pointer-events:auto}
    #ip-safety b{color:#ebeef2;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.03em}
    #ip-safety a{color:#0dbd8b;text-decoration:none;margin-left:4px}
    #ip-safety.bad{background:#a3121e;color:#fff}
  `;
  let safetyFor = null;

  async function safetyCode(secret, roomId) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveBits"]);
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: enc.encode("interpartes-chat-v1|" + roomId),
          info: enc.encode("safety-code"),
        },
        base,
        64,
      ),
    );
    let n = 0n;
    for (const b of bits.subarray(0, 5)) n = (n << 8n) | BigInt(b);
    return (n % 1_000_000_000_000n).toString().padStart(12, "0").match(/.{3}/g).join(" ");
  }

  function showSafety() {
    let badge = document.getElementById("ip-safety");
    const inCall = location.pathname.startsWith("/room") && document.querySelector("[data-testid=incall_leave]");
    if (!inCall) {
      badge?.remove();
      safetyFor = null;
      return;
    }
    const c = callParams();
    const key = c ? c.roomId + "|" + c.password : "none";
    if (badge && safetyFor === key) return;
    safetyFor = key;
    if (!document.getElementById("ip-safety-style")) {
      const style = document.createElement("style");
      style.id = "ip-safety-style";
      style.textContent = SAFETY_STYLE;
      document.head.append(style);
    }
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "ip-safety";
      document.body.append(badge);
    }
    if (!c) {
      badge.className = "bad";
      badge.textContent = t("noPassword");
      return;
    }
    badge.className = "";
    badge.title = t("safetyTitle");
    safetyCode(c.password, c.roomId).then((code) => {
      if (safetyFor !== key) return;
      const how = Object.assign(document.createElement("a"), {
        href: "/chat/privacy.html",
        target: "_blank",
        rel: "noopener",
        textContent: "?",
        title: t("safetyHow"),
      });
      badge.replaceChildren(t("safetyCode") + " ", Object.assign(document.createElement("b"), { textContent: code }), " ", how);
    });
  }

  new MutationObserver(() => {
    sync();
    showSafety();
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("hashchange", () => {
    sync();
    showSafety();
  });
})();
