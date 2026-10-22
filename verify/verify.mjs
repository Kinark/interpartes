#!/usr/bin/env node
// Checks that https://interpartes.lo.fi serves exactly the code in this
// repository plus the official Element Call release, so you don't have to
// take the operator's word for it.
//
//   node verify/verify.mjs [https://interpartes.lo.fi]
//
// Needs Node 18+ and nothing else. It checks:
//   1. every Element Call file (JS, WASM, CSS, ...) matches the hashes that
//      Element publishes with the GitHub release;
//   2. index.html is the release's index.html plus only the additions in
//      config/index.html (two script tags and the guest-only CSS);
//   3. config.json, and every /chat file, match this repository byte for byte;
//   4. the Content-Security-Policy headers are the ones in this repository,
//      so the browser refuses to send data anywhere but this server.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = (process.argv[2] || "https://interpartes.lo.fi").replace(/\/$/, "");
const local = (p) => readFileSync(join(ROOT, p));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

let failures = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};

async function get(path, base = SITE) {
  const r = await fetch(base + path, { redirect: "follow", cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return { body: Buffer.from(await r.arrayBuffer()), headers: r.headers };
}

const version = /element-call:v([0-9.]+)@/.exec(local("compose.yaml").toString())?.[1];
if (!version) throw new Error("Element Call version not found in compose.yaml");
console.log(`Checking ${SITE} against Element Call v${version} and this repository\n`);

// 1. Element Call release files
console.log("Element Call release files");
const rel = `https://github.com/element-hq/element-call/releases/download/v${version}`;
const list = (await get(`/element-call-${version}.sha256`, rel)).body.toString();
const upstream = new Map();
for (const line of list.trim().split("\n")) {
  const [hash, file] = line.trim().split(/\s+/);
  const path = file.replace(/^element-call-[^/]+\//, "");
  if (path.includes("/") || path === "index.html" || path === "favicon.png") upstream.set(path, hash);
}
let checked = 0;
const files = [...upstream].filter(([p]) => !p.endsWith(".map") && p !== "index.html");
for (let i = 0; i < files.length; i += 8) {
  await Promise.all(
    files.slice(i, i + 8).map(async ([path, hash]) => {
      const { body } = await get("/" + path);
      if (sha256(body) === hash) checked++;
      else bad(`${path} differs from the release`);
    }),
  );
}
if (checked === files.length) ok(`${checked} files match the release hashes`);

// 2. index.html = release + known additions
console.log("index.html");
const served = (await get("/")).body.toString();
const ours = local("config/index.html").toString();
if (served === ours) ok("matches config/index.html");
else bad("differs from config/index.html");
const ADDED = [
  '<script src="/chat/guard.js"></script>',
  '<style>a[href^="/login"],a[href^="/register"],[data-testid="usermenu_login"],p:has(> a[href^="/login"]),p:has(> a[href^="/register"]),div:has(> a[href^="/register"]){display:none!important}</style><script defer src="/chat/inject.js"></script>',
];
let stripped = served;
for (const a of ADDED) stripped = stripped.replace(a, "");
if (sha256(Buffer.from(stripped)) === upstream.get("index.html")) {
  ok("is the release's index.html plus only guard.js, inject.js and the guest-only CSS");
} else bad("contains changes beyond the documented additions");

// 3. Configuration and chat files
console.log("Configuration and chat");
const cfg = JSON.parse((await get("/config.json")).body.toString());
const cfgOurs = JSON.parse(local("config/element-call.json").toString());
if (JSON.stringify(cfg) === JSON.stringify(cfgOurs)) ok("config.json matches config/element-call.json");
else bad("config.json differs from config/element-call.json");
for (const k of ["posthog", "sentry", "rageshake", "opentelemetry"]) {
  if (k in cfg) bad(`config.json enables ${k}`);
}
for (const f of ["index.html", "app.js", "style.css", "inject.js", "guard.js", "privacy.html"]) {
  const { body } = await get(`/chat/${f === "index.html" ? "" : f}`);
  if (body.equals(local(`chat/public/${f}`))) ok(`/chat/${f} matches chat/public/${f}`);
  else bad(`/chat/${f} differs from chat/public/${f}`);
}

// 4. Security headers
console.log("Security headers");
const confCsp = /Content-Security-Policy "([^"]+)"/.exec(local("config/security-headers.conf").toString())[1];
const chatCsp = /"Content-Security-Policy":\s*((?:"[^"]*"\s*\+?\s*)+)/
  .exec(local("chat/server.ts").toString())[1]
  .match(/"([^"]*)"/g)
  .map((s) => s.slice(1, -1))
  .join("");
const checks = [
  ["/", confCsp],
  ["/assets/" + files.find(([p]) => /^assets\/index-.*\.js$/.test(p))[0].slice(7), confCsp],
  ["/room/", confCsp],
  ["/chat/", chatCsp],
];
for (const [path, want] of checks) {
  const got = (await get(path)).headers.get("content-security-policy");
  if (got === want) ok(`${path} Content-Security-Policy is the published one`);
  else bad(`${path} Content-Security-Policy differs: ${got}`);
}
const connect = /connect-src ([^;]+)/.exec(confCsp)[1].trim().split(/\s+/);
const host = new URL(SITE).host;
const foreign = connect.filter((s) => !["'self'", "data:", "blob:", `wss://${host}`].includes(s));
if (foreign.length) bad(`connect-src allows other servers: ${foreign.join(" ")}`);
else ok("browsers may only connect to this server (connect-src)");

console.log(
  failures
    ? `\n${failures} check(s) FAILED: the site does not match this repository.`
    : "\nAll checks passed: your browser receives exactly the published code.",
);
process.exit(failures ? 1 : 0);
