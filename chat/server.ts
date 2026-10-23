// Relay for end-to-end encrypted chat rooms. It never sees plaintext, room
// names or keys: clients join with an opaque tag derived from the room key
// and exchange ciphertext. Nothing is stored or logged; a room exists only
// while someone is connected to it.

const PORT = 8080;
const STATIC_DIR = "/app/public";
const MAX_FRAME = 24_000; // base64 ciphertext; ~16 KB of payload
const MAX_PEERS_PER_ROOM = 100;
const MAX_ROOMS = 2_000;
const MAX_CONNECTIONS = 5_000;
const RATE_PER_SEC = 5;
const RATE_BURST = 20;
const JOIN_TIMEOUT_MS = 10_000;

const TAG_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

interface Peer {
  id: string;
  ws: WebSocket;
  tokens: number;
  last: number;
}

const rooms = new Map<string, Map<string, Peer>>();
let connections = 0;

function randomId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room: Map<string, Peer>, except: string, msg: unknown): void {
  const s = JSON.stringify(msg);
  for (const p of room.values()) {
    if (p.id !== except && p.ws.readyState === WebSocket.OPEN) p.ws.send(s);
  }
}

function allow(p: Peer): boolean {
  const now = Date.now();
  p.tokens = Math.min(RATE_BURST, p.tokens + ((now - p.last) / 1000) * RATE_PER_SEC);
  p.last = now;
  if (p.tokens < 1) return false;
  p.tokens -= 1;
  return true;
}

function handleSocket(ws: WebSocket): void {
  connections++;
  let tag: string | null = null;
  let peer: Peer | null = null;

  const joinTimer = setTimeout(() => {
    if (!peer) ws.close(4000, "join timeout");
  }, JOIN_TIMEOUT_MS);

  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string" || ev.data.length > MAX_FRAME) {
      ws.close(4001, "bad frame");
      return;
    }
    if (!peer) {
      let join: unknown;
      try {
        join = JSON.parse(ev.data);
      } catch {
        ws.close(4001, "bad join");
        return;
      }
      const t = (join as { join?: unknown })?.join;
      if (typeof t !== "string" || !TAG_RE.test(t)) {
        ws.close(4001, "bad join");
        return;
      }
      let room = rooms.get(t);
      if (!room) {
        if (rooms.size >= MAX_ROOMS) {
          ws.close(4003, "server full");
          return;
        }
        room = new Map();
        rooms.set(t, room);
      }
      if (room.size >= MAX_PEERS_PER_ROOM) {
        ws.close(4003, "room full");
        return;
      }
      clearTimeout(joinTimer);
      tag = t;
      peer = { id: randomId(), ws, tokens: RATE_BURST, last: Date.now() };
      room.set(peer.id, peer);
      send(ws, { t: "ready", id: peer.id, n: room.size });
      broadcast(room, peer.id, { t: "j", f: peer.id, n: room.size });
      return;
    }
    if (!B64_RE.test(ev.data)) {
      ws.close(4001, "bad frame");
      return;
    }
    if (!allow(peer)) {
      send(ws, { t: "slow" });
      return;
    }
    const room = rooms.get(tag!);
    if (room) broadcast(room, peer.id, { t: "m", f: peer.id, d: ev.data });
  };

  const cleanup = () => {
    clearTimeout(joinTimer);
    if (peer && tag) {
      const room = rooms.get(tag);
      if (room?.delete(peer.id)) {
        if (room.size === 0) rooms.delete(tag);
        else broadcast(room, peer.id, { t: "l", f: peer.id, n: room.size });
      }
    }
    peer = null;
    tag = null;
  };
  ws.onclose = () => {
    connections--;
    cleanup();
  };
  ws.onerror = () => cleanup();
}

// Connection check (see netcheck.js). The browser sends a throwaway ECDH
// public key; the reply is the address this server sees, encrypted to that
// key, so it never appears in plaintext in any response, cache or proxy
// along the way. The server necessarily receives the address to answer at
// all (every server does); it is not logged or stored, only echoed back.
const enc = new TextEncoder();
const PUB_RE = /^[A-Za-z0-9+/]{87}=$/; // 65-byte uncompressed P-256 point

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function clientIp(req: Request, info: Deno.ServeHandlerInfo): string {
  // Caddy sets X-Forwarded-For to the visitor's address (last entry).
  const xff = req.headers.get("x-forwarded-for")?.split(",").pop()?.trim();
  if (xff) return xff;
  const a = info.remoteAddr as Deno.NetAddr;
  return a.hostname;
}

async function netcheck(req: Request, info: Deno.ServeHandlerInfo): Promise<Response> {
  const headers = { ...SECURITY_HEADERS, "Content-Type": "application/json" };
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers });
  const origin = req.headers.get("origin");
  if (!origin || new URL(origin).host !== req.headers.get("host")) {
    return new Response("Forbidden", { status: 403, headers });
  }
  let pub: string;
  try {
    const body = await req.text();
    if (body.length > 200) throw new Error();
    pub = JSON.parse(body).pub;
    if (typeof pub !== "string" || !PUB_RE.test(pub)) throw new Error();
  } catch {
    return new Response("Bad request", { status: 400, headers });
  }
  try {
    const theirs = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(pub), (c) => c.charCodeAt(0)),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]) as CryptoKeyPair;
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: theirs }, pair.privateKey, 256);
    const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: enc.encode("interpartes-netcheck-v1"), info: enc.encode("echo") },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    // Hints that the request passed through a proxy that announces itself.
    const proxied = ["via", "forwarded", "x-proxy-id", "x-bluecoat-via", "proxy-connection"].some((h) => req.headers.has(h));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = enc.encode(JSON.stringify({ ip: clientIp(req, info), proxied, ts: Date.now() }).padEnd(96));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
    const mine = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    return new Response(JSON.stringify({ pub: b64(mine), iv: b64(iv), ct: b64(ct) }), { headers });
  } catch {
    return new Response("Bad request", { status: 400, headers });
  }
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
    "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "Cache-Control": "no-store",
};

const files = new Map<string, string>();
for (const name of ["index.html", "app.js", "style.css", "inject.js", "guard.js", "kx.js", "netcheck.js", "iplists.txt", "privacy.html"]) {
  files.set(name, Deno.readTextFileSync(`${STATIC_DIR}/${name}`));
}

function serveStatic(name: string): Response {
  const body = files.get(name);
  if (!body) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
  const ext = name.split(".").pop()!;
  return new Response(body, { headers: { ...SECURITY_HEADERS, "Content-Type": TYPES[ext] } });
}

Deno.serve({ port: PORT, hostname: "0.0.0.0", onListen: () => {} }, (req, info) => {
  const url = new URL(req.url);
  // Caddy strips the /chat prefix.
  const path = url.pathname.replace(/^\/chat/, "") || "/";

  if (path === "/netcheck") return netcheck(req, info);
  if (path === "/ws") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const origin = req.headers.get("origin");
    if (!origin || new URL(origin).host !== req.headers.get("host")) {
      return new Response("Forbidden", { status: 403 });
    }
    if (connections >= MAX_CONNECTIONS) return new Response("Busy", { status: 503 });
    const { socket, response } = Deno.upgradeWebSocket(req, { idleTimeout: 60 });
    handleSocket(socket);
    return response;
  }
  if (path === "/" || path === "/index.html") return serveStatic("index.html");
  if (path === "/healthz") return new Response("ok");
  return serveStatic(path.slice(1));
});
