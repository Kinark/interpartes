"use strict";

// Link formats (everything after # stays in the browser):
//   /chat/#k=<secret>                 standalone chat
//   /chat/#r=<roomId>&k=<password>    chat for an Element Call room
// The secret authenticates a fresh ECDH group key exchange (see kx.js), so the
// relay only ever sees an opaque room tag and AES-GCM ciphertext, and a link
// found later can't decrypt anything recorded earlier.

const MAX_TEXT = 4000;
const MAX_NAME = 40;
// One-shot nickname from the home page's "Chat" button (see inject.js).
const HANDOFF_KEY = "interpartes-chat-handoff";

// Read once: the address bar is cleared when the chat starts.
const LINK = parseHashOnce();
const EMBEDDED = LINK.embedded;
const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// Room secrets are 24 bytes (192 bits, 32 characters); message IDs need only 16.
function randomSecret(bytes = 24) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Short code everyone in a room can compare out loud. Same derivation as the
// call's code in inject.js (secret = call password, salt = call room ID), so
// a call and its chat show the same digits. Matching codes mean everyone
// holds the same key, i.e. nobody was handed a different link.
async function safetyCode(base, salt) {
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("safety-code") },
      base,
      64,
    ),
  );
  let n = 0n;
  for (const b of bits.subarray(0, 5)) n = (n << 8n) | BigInt(b);
  const d = (n % 1_000_000_000_000n).toString().padStart(12, "0");
  return d.match(/.{3}/g).join(" ");
}

function parseHashOnce() {
  const p = new URLSearchParams(location.hash.slice(1));
  return {
    secret: p.get("k"),
    roomId: p.get("r"),
    embedded: p.get("e") === "1",
  };
}

function cleanName(s) {
  return String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME);
}

function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---------- UI ----------

const log = $("log");

function addLine(kind, parts) {
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const li = document.createElement("li");
  li.className = kind;
  for (const [cls, text] of parts) {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    li.append(span);
  }
  log.append(li);
  if (atBottom || kind === "mine") log.scrollTop = log.scrollHeight;
}

function notice(text) {
  addLine("notice", [["text", text]]);
}

function setStatus(text, ok) {
  const s = $("status");
  s.textContent = text;
  s.className = ok ? "ok" : "";
}

function showScreen(id) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id;
}

// ---------- Chat session ----------

let kx = null;
let myName = "";
let shareLink = "";
let closedByUser = false;
const names = new Map();

function peerName(id) {
  return names.get(id) || "Someone";
}

function onStatus(s) {
  if (s.full) return setStatus("This chat is full", false);
  if (!s.connected) return setStatus("Disconnected · reconnecting…", false);
  if (!s.keyed) return setStatus("Securing…", false);
  setStatus(s.n === 1 ? "Connected · only you here" : `Connected · ${s.n} here`, true);
}

function onMessage(from, m) {
  if (typeof m.x !== "string" || typeof m.ts !== "number") return;
  const n = cleanName(m.n) || peerName(from);
  names.set(from, n);
  addLine("theirs", [
    ["who", n],
    ["when", clock(m.ts)],
    ["text", m.x.slice(0, MAX_TEXT)],
  ]);
  if (EMBEDDED) {
    window.parent.postMessage({ interpartesChat: "unread" }, location.origin);
  }
}

async function start(secret, roomId) {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveBits"]);
  $("safety").textContent = await safetyCode(base, enc.encode("interpartes-chat-v1|" + (roomId || "")));
  shareLink = `${location.origin}/chat/#${new URLSearchParams({ k: secret })}`;
  // Keep the key out of the address bar and history; "Copy link" still has it.
  history.replaceState(null, "", "/chat/");
  showScreen("chat");
  notice(
    "Messages are end-to-end encrypted with fresh keys that only exist while you're here, and never stored. You only see messages sent while you're here.",
  );
  kx = IPKX.session({
    secret,
    roomId,
    scope: "chat",
    meta: { n: myName },
    onStatus,
    onMessage,
    onPeer(id, meta) {
      const n = cleanName(meta?.n) || "Someone";
      names.set(id, n);
      notice(`${n} joined`);
    },
    onLeave(id) {
      if (!closedByUser && names.has(id)) notice(`${peerName(id)} left`);
      names.delete(id);
    },
  });
  $("text").focus();
}

$("send").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("text");
  const x = input.value.trim().slice(0, MAX_TEXT);
  if (!x) return;
  if (EMBEDDED) {
    // Follow name changes made in the call's settings.
    myName = (await callDisplayName()) || myName;
  }
  if (!(await kx?.send({ n: myName, x, ts: Date.now() }))) {
    notice("Not connected: message not sent");
    return;
  }
  input.value = "";
  addLine("mine", [
    ["who", myName],
    ["when", clock(Date.now())],
    ["text", x],
  ]);
});

$("text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("send").requestSubmit();
  }
});

$("leave").addEventListener("click", () => {
  closedByUser = true;
  kx?.close();
  log.replaceChildren();
  if (EMBEDDED) {
    window.parent.postMessage({ interpartesChat: "close" }, location.origin);
  } else {
    location.replace("/");
  }
});

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(shareLink);
  $("copy").textContent = "Copied";
  setTimeout(() => ($("copy").textContent = "Copy link"), 1500);
});

// ---------- Entry ----------

$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  myName = cleanName($("name").value);
  if (!myName) return;
  let { secret, roomId } = LINK;
  if (!secret) {
    secret = randomSecret();
    history.replaceState(null, "", `#${new URLSearchParams({ k: secret })}`);
  }
  start(secret, roomId).catch(() => notice("Could not start the chat"));
});

// In a call, use the same display name as the call: read it from the guest's
// own Matrix profile (same origin, so Element Call's login is available).
async function callDisplayName() {
  try {
    const s = JSON.parse(localStorage.getItem("matrix-auth-store") || "null");
    if (!s?.user_id || !s?.access_token) return "";
    const r = await fetch(`/_matrix/client/v3/profile/${encodeURIComponent(s.user_id)}/displayname`, {
      headers: { Authorization: `Bearer ${s.access_token}` },
      referrerPolicy: "no-referrer",
    });
    if (!r.ok) return "";
    return cleanName((await r.json()).displayname);
  } catch {
    return "";
  }
}

(async function init() {
  const { secret, roomId, embedded } = LINK;
  document.body.classList.toggle("embedded", embedded);
  $("join-title").textContent = secret ? "Join chat" : "Start new chat";
  $("join-go").textContent = secret ? "Join" : "Start";
  $("copy").hidden = embedded;

  // Nicknames are never remembered. Two exceptions, both for the current
  // step only: inside a call the chat uses the call's display name, and the
  // home page's "Chat" button hands over the nickname just typed (deleted
  // here on read).
  const handoff = cleanName(sessionStorage.getItem(HANDOFF_KEY));
  sessionStorage.removeItem(HANDOFF_KEY);
  const known = embedded ? await callDisplayName() : handoff;
  if (secret && known) {
    myName = known;
    start(secret, roomId).catch(() => notice("Could not start the chat"));
    return;
  }
  showScreen("join");
  $("name").focus();
})();
