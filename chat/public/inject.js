"use strict";

// Loaded into Element Call. Adds a "Chat" button to the in-call controls that
// opens /chat in a side panel, keyed by the call's roomId + password (both
// taken from the URL fragment, so nothing new is sent to the server).
(function () {
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
    title.textContent = "Chat";
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close chat");
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
      frame.title = "Encrypted chat";
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
    btn.setAttribute("aria-label", "Chat");
    btn.title = "Chat";
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
    form:has([data-testid=home_go]) > div:has([data-testid=home_callName]):not(:has([data-testid=home_go])){display:none!important}
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
  // later updates such as "Loading…" still show.
  function relabel(el, from, to) {
    for (const n of el?.childNodes || []) {
      if (n.nodeType === Node.TEXT_NODE && n.nodeValue === from) n.nodeValue = to;
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
    relabel(go.closest("main")?.querySelector("h1"), "Start new call", "New Room");
    relabel(go, "Go", "Call");
    fillRoomName(false);
    const nick = document.querySelector("[data-testid=home_displayName]");
    if (nick && nick.placeholder !== "Nickname") {
      nick.placeholder = "Nickname";
      relabel(nick.labels?.[0], "Display name", "Nickname");
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
    btn.textContent = "Chat";
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
      if (nameInput?.value.trim()) {
        sessionStorage.setItem(NAME_KEY, nameInput.value.trim().slice(0, 40));
      }
      location.assign(`/chat/#${p}`);
    };
    go.after(btn);
  }

  // Share one display name per browser tab session between Element Call's
  // guest name fields and the chat.
  const NAME_KEY = "interpartes-chat-name";
  const NAME_FIELDS = "[data-testid=home_displayName], [data-testid=joincall_displayName]";

  function rememberName(el) {
    if (el.dataset.ipName) return;
    el.dataset.ipName = "1";
    const saved = sessionStorage.getItem(NAME_KEY);
    if (saved && !el.value) setInput(el, saved);
    el.addEventListener("input", () => {
      const v = el.value.trim().slice(0, 40);
      if (v) sessionStorage.setItem(NAME_KEY, v);
    });
  }

  function sync() {
    for (const el of document.querySelectorAll(NAME_FIELDS)) rememberName(el);
    if (location.pathname === "/") {
      homeLayout();
      addChatOnlyButton();
    }
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
      badge.textContent = "Warning: this call link has no password, so the call is NOT end-to-end encrypted";
      return;
    }
    badge.className = "";
    badge.title =
      "Compare this code with everyone in the call. If you all see the same digits, you all share the same encryption key.";
    safetyCode(c.password, c.roomId).then((code) => {
      if (safetyFor !== key) return;
      const how = Object.assign(document.createElement("a"), {
        href: "/chat/privacy.html",
        target: "_blank",
        rel: "noopener",
        textContent: "?",
        title: "What this means and how to check it",
      });
      badge.replaceChildren("Safety code ", Object.assign(document.createElement("b"), { textContent: code }), " ", how);
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
