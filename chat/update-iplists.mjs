#!/usr/bin/env node
// Rebuilds chat/public/iplists.txt, the address lists the browser checks its
// own IP against (see netcheck.js). The browser can only talk to this server
// (connect-src 'self'), so the lists are served from here and the check runs
// in the browser: nobody is asked about the visitor's address.
//
//   node chat/update-iplists.mjs
//
// Sources (IPv4 only):
//   vpn         https://github.com/X4BNet/lists_vpn  (known VPN providers)
//   tor         https://check.torproject.org/torbulkexitlist  (Tor exits)
//   datacenter  https://github.com/X4BNet/lists_vpn  (hosting / cloud ranges)

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "public", "iplists.txt");
const SOURCES = [
  ["vpn", "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt"],
  ["tor", "https://check.torproject.org/torbulkexitlist"],
  ["datacenter", "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt"],
];
const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/\d{1,2})?$/;

const parts = await Promise.all(
  SOURCES.map(async ([name, url]) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const lines = (await r.text())
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => V4.test(l));
    if (lines.length < 100) throw new Error(`${url}: only ${lines.length} entries`);
    return `# ${name}\n${[...new Set(lines)].join("\n")}\n`;
  }),
);
writeFileSync(OUT, `# generated ${new Date().toISOString().slice(0, 10)} by chat/update-iplists.mjs\n` + parts.join(""));
console.log(`wrote ${OUT}`);
