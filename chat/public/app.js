"use strict";

// Link formats (everything after # stays in the browser):
//   /chat/#k=<secret>                 standalone chat
//   /chat/#r=<roomId>&k=<password>    chat for an Element Call room
// Keys are derived with HKDF from the secret (salted with the room ID), so the
// relay only ever sees an opaque room tag and AES-GCM ciphertext.

const MAX_TEXT = 4000;
const MAX_NAME = 40;
const PAD_TO = 256;
const MAX_SKEW_MS = 5 * 60_000;
// Per-tab session storage, shared with the Element Call pages (same origin).
// Cleared when the tab is closed.
const NAME_KEY = "interpartes-chat-name";

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Room secrets are 24 bytes (192 bits, 32 characters); message IDs need only 16.
function randomSecret(bytes = 24) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(buf) {
  return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");
}

async function deriveKeys(secret, roomId) {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
    "deriveBits",
    "deriveKey",
  ]);
  const salt = enc.encode("interpartes-chat-v1|" + (roomId || ""));
  const tagBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("room-tag") },
    base,
    256,
  );
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("message-key") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { tag: hex(tagBits), key, safety: await safetyCode(base, salt) };
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

async function seal(key, obj) {
  const body = enc.encode(JSON.stringify(obj));
  // Pad so ciphertext length only reveals a rough size bucket.
  const padded = new Uint8Array(Math.ceil((body.length + 4) / PAD_TO) * PAD_TO);
  new DataView(padded.buffer).setUint32(0, body.length);
  padded.set(body, 4);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, padded));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}

async function open(key, data) {
  const raw = unb64(data);
  const pt = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(0, 12) }, key, raw.subarray(12)),
  );
  const len = new DataView(pt.buffer).getUint32(0);
  if (len > pt.length - 4) throw new Error("bad padding");
  return JSON.parse(dec.decode(pt.subarray(4, 4 + len)));
}

function parseHash() {
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

let ws = null;
let keys = null;
let myName = "";
let myId = null;
let closedByUser = false;
let retry = 0;
const names = new Map();
const seen = new Set();

function peerName(id) {
  return names.get(id) || "Someone";
}

async function sendObj(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(await seal(keys.key, { ...obj, id: randomSecret(16), ts: Date.now() }));
  return true;
}

async function onFrame(msg) {
  if (msg.t === "ready") {
    myId = msg.id;
    retry = 0;
    setStatus(msg.n === 1 ? "Connected · only you here" : `Connected · ${msg.n} here`, true);
    await sendObj({ k: "hi", n: myName });
    return;
  }
  if (msg.t === "j") {
    setStatus(`Connected · ${msg.n} here`, true);
    await sendObj({ k: "hi", n: myName });
    return;
  }
  if (msg.t === "l") {
    setStatus(msg.n === 1 ? "Connected · only you here" : `Connected · ${msg.n} here`, true);
    if (names.has(msg.f)) notice(`${peerName(msg.f)} left`);
    names.delete(msg.f);
    return;
  }
  if (msg.t === "slow") {
    notice("Slow down: message not sent");
    return;
  }
  if (msg.t !== "m" || typeof msg.d !== "string") return;

  let m;
  try {
    m = await open(keys.key, msg.d);
  } catch {
    return; // not for this key, or tampered with
  }
  if (typeof m.id !== "string" || seen.has(m.id)) return;
  if (typeof m.ts !== "number" || Math.abs(Date.now() - m.ts) > MAX_SKEW_MS) return;
  seen.add(m.id);

  if (m.k === "hi") {
    const n = cleanName(m.n) || "Someone";
    const known = names.has(msg.f);
    names.set(msg.f, n);
    if (!known) notice(`${n} joined`);
  } else if (m.k === "msg" && typeof m.x === "string") {
    const n = cleanName(m.n) || peerName(msg.f);
    names.set(msg.f, n);
    addLine("theirs", [
      ["who", n],
      ["when", clock(m.ts)],
      ["text", m.x.slice(0, MAX_TEXT)],
    ]);
    if (parseHash().embedded) {
      window.parent.postMessage({ interpartesChat: "unread" }, location.origin);
    }
  }
}

function connect() {
  setStatus("Connecting…", false);
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/chat/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ join: keys.tag }));
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
    names.clear();
    if (closedByUser) return;
    if (ev.code === 4003) {
      setStatus("This chat is full", false);
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** retry++);
    setStatus("Disconnected · reconnecting…", false);
    setTimeout(connect, delay);
  };
}

async function start(secret, roomId) {
  keys = await deriveKeys(secret, roomId);
  $("safety").textContent = keys.safety;
  showScreen("chat");
  notice("Messages are end-to-end encrypted and never stored. You only see messages sent while you're here.");
  connect();
  $("text").focus();
}

$("send").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("text");
  const x = input.value.trim().slice(0, MAX_TEXT);
  if (!x) return;
  if (parseHash().embedded) {
    // Follow name changes made in the call's settings.
    myName = (await callDisplayName()) || myName;
  }
  if (!(await sendObj({ k: "msg", n: myName, x }))) {
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
  ws?.close();
  log.replaceChildren();
  if (parseHash().embedded) {
    window.parent.postMessage({ interpartesChat: "close" }, location.origin);
  } else {
    location.replace("/");
  }
});

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(location.href);
  $("copy").textContent = "Copied";
  setTimeout(() => ($("copy").textContent = "Copy link"), 1500);
});

// ---------- Entry ----------

$("name").value = sessionStorage.getItem(NAME_KEY) || "";

$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  myName = cleanName($("name").value);
  if (!myName) return;
  sessionStorage.setItem(NAME_KEY, myName);
  let { secret, roomId } = parseHash();
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
  const { secret, roomId, embedded } = parseHash();
  document.body.classList.toggle("embedded", embedded);
  $("join-title").textContent = secret ? "Join chat" : "Start new chat";
  $("join-go").textContent = secret ? "Join" : "Start";
  $("copy").hidden = embedded;

  // A name known for this browser session (the call's display name, or one
  // typed earlier in this tab) lets you go straight into a chat link.
  const profileName = await callDisplayName();
  const saved = cleanName(sessionStorage.getItem(NAME_KEY));
  const known = embedded ? profileName || saved : saved || profileName;
  if (secret && known) {
    myName = known;
    sessionStorage.setItem(NAME_KEY, known);
    start(secret, roomId).catch(() => notice("Could not start the chat"));
    return;
  }
  if (known && !$("name").value) $("name").value = known;
  showScreen("join");
  $("name").focus();
})();
