"use strict";

// Link formats (everything after # stays in the browser):
//   /chat/#k=<secret>                 standalone chat
//   /chat/#k=<secret>&a=1             standalone Amnesia chat (see AMNESIA_KEEP)
//   /chat/#r=<roomId>&k=<password>    chat for an Element Call room
// The secret authenticates a fresh ECDH group key exchange (see kx.js), so the
// relay only ever sees an opaque room tag and AES-GCM ciphertext, and a link
// found later can't decrypt anything recorded earlier.

const MAX_TEXT = 4000;
const t = IPI18N.t;
const MAX_NAME = 40;
// Amnesia rooms: only each person's last few messages stay on screen; older
// ones are removed from the page. The mode is part of the key derivation
// (see cryptoRoomId), so a link with the flag removed opens a different room
// instead of the same one without the limit.
const AMNESIA_KEEP = 5;
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
  const roomId = p.get("r");
  return {
    secret: p.get("k"),
    roomId,
    embedded: p.get("e") === "1",
    // Call chats are always regular chats.
    amnesia: !roomId && p.get("a") === "1",
  };
}

// Chat-only rooms (not a call's side chat): anyone in them can close the
// room for everyone.
const CHAT_ONLY = !LINK.roomId && !LINK.embedded;

function cryptoRoomId(roomId, amnesia) {
  return roomId || (amnesia ? "amnesia" : "");
}

function linkParams(secret, amnesia) {
  return new URLSearchParams(amnesia ? { k: secret, a: "1" } : { k: secret });
}

function cleanName(s) {
  return String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME);
}

function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---------- UI ----------

const log = $("log");

function addLine(kind, parts, sender) {
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
  if (sender) forgetOld(sender, li);
  if (atBottom || kind === "mine") log.scrollTop = log.scrollHeight;
}

// Amnesia: keep each person's last AMNESIA_KEEP messages, remove the rest
// from the page (the text only ever lived in these elements).
const kept = new Map(); // sender ("me" or relay id) -> [li, ...]
function forgetOld(sender, li) {
  if (!LINK.amnesia) return;
  const list = kept.get(sender) || [];
  list.push(li);
  kept.set(sender, list);
  while (list.length > AMNESIA_KEEP) {
    const old = list.shift();
    for (const s of old.querySelectorAll(".text")) s.textContent = "";
    old.remove();
  }
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
  return names.get(id) || t("someone");
}

// Connection check findings (netcheck.js): yours and everyone else's, shown
// in a warning that stays at the top of the chat while any exist.
const risks = new Map();
let myRisk = [];

function showRisks() {
  const box = $("risks");
  const lines = myRisk.map((r) => t("you") + ": " + IPNC.describe(r));
  for (const [id, rs] of risks) for (const r of rs) lines.push(`${peerName(id)}: ${IPNC.describe(r)}`);
  box.hidden = !lines.length;
  $("risk-list").replaceChildren(...lines.map((l) => Object.assign(document.createElement("li"), { textContent: l })));
}

function onStatus(s) {
  if (roomClosed) return;
  if (s.full) return setStatus(t("full"), false);
  if (!s.connected) return setStatus(t("disconnected"), false);
  if (!s.keyed) return setStatus(t("securing"), false);
  setStatus(s.n === 1 ? t("alone") : t("nHere", { n: s.n }), true);
}

function onMessage(from, m) {
  if (typeof m.x !== "string" || typeof m.ts !== "number") return;
  const n = cleanName(m.n) || peerName(from);
  names.set(from, n);
  addLine(
    "theirs",
    [
      ["who", n],
      ["when", clock(m.ts)],
      ["text", m.x.slice(0, MAX_TEXT)],
    ],
    from,
  );
  if (EMBEDDED) {
    window.parent.postMessage({ interpartesChat: "unread" }, location.origin);
  }
}

// Watermark: small, faint, closely spaced diagonal lines of "ANONYMOUS CHAT"
// over the whole chat, so any screenshot or recording of it says it was
// private. Drawn on a canvas and set as a data: background (allowed by the
// CSP), never sent anywhere. The element is rotated by CSS, so the tile
// itself stays horizontal and seamless.
function startWatermark() {
  const el = $("watermark");
  const draw = () => {
    const ratio = window.devicePixelRatio || 1;
    const sep = "   ·   ";
    const phrase = t("wm.anon") + sep;
    const font = "600 10px Inter, system-ui, sans-serif";
    const rowH = 22;
    const c = document.createElement("canvas");
    const g0 = c.getContext("2d");
    g0.font = font;
    const w = Math.ceil(g0.measureText(phrase).width);
    const h = rowH * 2;
    c.width = w * ratio;
    c.height = h * ratio;
    const g = c.getContext("2d");
    g.scale(ratio, ratio);
    g.font = font;
    g.textBaseline = "middle";
    g.fillStyle = "#fff";
    // Two rows per tile, the second shifted by half a phrase (brick pattern).
    g.fillText(phrase, 0, rowH / 2);
    g.fillText(phrase, -w / 2, rowH * 1.5);
    g.fillText(phrase, w / 2, rowH * 1.5);
    el.style.backgroundImage = `url(${c.toDataURL("image/png")})`;
    el.style.backgroundSize = `${w}px ${h}px`;
  };
  draw();
  el.hidden = false;
}

// Ends the chat on this screen: messages are wiped, only a notice remains.
let roomClosed = false;
function showClosed(text) {
  roomClosed = true;
  kx = null;
  log.replaceChildren();
  kept.clear();
  $("send").hidden = true;
  $("close-all").hidden = true;
  $("copy").hidden = true;
  setStatus(t("roomClosed"), false);
  notice(text);
}

async function start(secret, roomId) {
  const amnesia = LINK.amnesia;
  const cryptoRoom = cryptoRoomId(roomId, amnesia);
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveBits"]);
  $("safety").textContent = await safetyCode(base, enc.encode("interpartes-chat-v1|" + cryptoRoom));
  shareLink = `${location.origin}/chat/#${linkParams(secret, amnesia)}`;
  // Keep the key out of the address bar and history; "Copy link" still has it.
  history.replaceState(null, "", "/chat/");
  showScreen("chat");
  startWatermark();
  notice(t("intro"));
  if (amnesia) notice(t("amnesiaIntro", { n: AMNESIA_KEEP }));
  kx = IPKX.session({
    secret,
    roomId: cryptoRoom,
    scope: "chat",
    closable: CHAT_ONLY,
    meta: { n: myName, risk: null },
    onStatus,
    onMessage,
    onClosed(by) {
      showClosed(by && names.has(by) ? t("closedBy", { n: peerName(by) }) : t("closedAlready"));
    },
    onPeer(id, meta, isUpdate) {
      const n = cleanName(meta?.n) || t("someone");
      names.set(id, n);
      if (!isUpdate) notice(t("joined", { n }));
      const r = IPNC.clean(meta?.risk);
      if (r.length) risks.set(id, r);
      else risks.delete(id);
      showRisks();
    },
    onLeave(id) {
      if (!closedByUser && names.has(id)) notice(t("left", { n: peerName(id) }));
      names.delete(id);
      if (risks.delete(id)) showRisks();
    },
  });
  IPNC.result.then((r) => {
    myRisk = r;
    kx?.setMeta({ n: myName, risk: r });
    showRisks();
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
    notice(t("notSent"));
    return;
  }
  input.value = "";
  addLine(
    "mine",
    [
      ["who", myName],
      ["when", clock(Date.now())],
      ["text", x],
    ],
    "me",
  );
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

$("close-all").addEventListener("click", () => {
  if (!kx || !confirm(t("closeAllConfirm"))) return;
  if (!kx.closeForEveryone()) {
    notice(t("notSent"));
    return;
  }
  closedByUser = true;
  showClosed(t("closedByYou"));
});

$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(shareLink);
  $("copy").textContent = t("copied");
  setTimeout(() => ($("copy").textContent = t("copyLink")), 1500);
});

// ---------- Entry ----------

$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  myName = cleanName($("name").value);
  if (!myName) return;
  let { secret, roomId } = LINK;
  if (!secret) {
    secret = randomSecret();
    history.replaceState(null, "", `#${linkParams(secret, LINK.amnesia)}`);
  }
  start(secret, roomId).catch(() => notice(t("startFail")));
});

// In a call, use the same display name as the call: read it from the guest's
// own Matrix profile (same origin, so Element Call's login is available).
async function callDisplayName() {
  try {
    // guard.js keeps Element Call's login in the tab's sessionStorage (shared
    // with this same-origin iframe), not in localStorage.
    const s = JSON.parse(sessionStorage.getItem("matrix-auth-store") || "null");
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
  document.documentElement.lang = IPI18N.lang;
  document.title = t("pageTitle");
  IPI18N.apply();
  $("join-title").textContent = LINK.amnesia
    ? secret
      ? t("joinAmnesia")
      : t("startAmnesia")
    : secret
      ? t("joinChat")
      : t("startChat");
  $("join-go").textContent = secret ? t("join") : t("start");
  $("copy").hidden = embedded;
  $("close-all").hidden = !CHAT_ONLY;
  $("amnesia-tag").hidden = !LINK.amnesia;
  $("amnesia-hint").hidden = !LINK.amnesia;
  if (LINK.amnesia) $("amnesia-hint").textContent = t("amnesiaHint", { n: AMNESIA_KEEP });

  // Nicknames are never remembered. Two exceptions, both for the current
  // step only: inside a call the chat uses the call's display name, and the
  // home page's "Chat" button hands over the nickname just typed (deleted
  // here on read).
  const handoff = cleanName(sessionStorage.getItem(HANDOFF_KEY));
  sessionStorage.removeItem(HANDOFF_KEY);
  const known = embedded ? await callDisplayName() : handoff;
  if (secret && known) {
    myName = known;
    start(secret, roomId).catch(() => notice(t("startFail")));
    return;
  }
  showScreen("join");
  $("name").focus();
})();
