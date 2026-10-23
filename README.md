# interpartes — Element Call (standalone)

https://interpartes.lo.fi — self-contained MatrixRTC site, federation disabled.

This repository is the complete, deployed configuration (minus secrets), so
anyone can check what the server does. See **[Verify](#verify)** below, or the
plain-language summary at https://interpartes.lo.fi/chat/privacy.html.

| Container            | Role                                  | Route via caddy             |
|----------------------|---------------------------------------|-----------------------------|
| interpartes          | Element Call web app                  | `/` (fallback)              |
| interpartes-synapse  | Matrix homeserver                     | `/_matrix`, `/_synapse/client`, `/.well-known/matrix` |
| interpartes-db       | Postgres for Synapse (in RAM)         | internal only               |
| interpartes-livekit  | LiveKit SFU                           | `/livekit/sfu` (+ 7881/tcp, 7882/udp direct) |
| interpartes-jwt      | lk-jwt-service (MatrixRTC auth)       | `/livekit/jwt`              |
| interpartes-janitor  | deletes ended calls + their accounts  | internal only               |
| interpartes-chat     | encrypted text chat relay (Deno)      | `/chat`                     |

## Files
- `compose.yaml` — every service, with images pinned by digest
- `config/homeserver.yaml` — Synapse config (secrets are read from files)
- `config/index.html` — Element Call's release `index.html` + two script tags and the guest-only CSS
- `config/nginx.conf`, `config/security-headers.conf` — static serving and the Content-Security-Policy
- `config/janitor.py` — cleanup service (see below)
- `config/livekit.yaml`, `config/element-call.json`, `config/synapse.log.config`
- `chat/` — chat relay, chat page, `inject.js` (UI additions, safety code) and `guard.js` (link hardening)
- `verify/verify.mjs` — checks the live site against this repository

Not in the repository (server only): `.env` (domain, public IP, Postgres
password, LiveKit key/secret, janitor password) and `data/synapse/` (signing
key and `secrets/` with the registration, macaroon and form secrets).
`.env.example` lists the variables.

## TLS
Not issued by Caddy. A manually provided Let's Encrypt certificate is stored
in the Caddy stack's data directory. Replace the files, then `docker restart caddy`.

## Firewall
LiveKit media needs 7881/tcp and 7882/udp open in the host and cloud firewalls.

## Guest-only UI
`config/nginx.conf` replaces the image's default nginx config (mounted over
`/etc/nginx/conf.d/default.conf`). It redirects `/login` and `/register` to `/`
and serves `config/index.html`, which adds CSS that hides the login/register
links and the "Log in" user-menu item. Synapse registration must stay enabled because guest
accounts are created through it. To undo: remove the nginx.conf mount and run
`docker compose up -d interpartes`.

## Privacy hardening
- **Content-Security-Policy on every page** (`config/security-headers.conf`,
  and `chat/server.ts` for `/chat`): the browser may only load code from
  this site and only connect to this site. Analytics, crash reporting and
  bug-report uploads built into Element Call cannot reach any other server,
  even if switched on. Background blur uses the model bundled in the release.
- **Link hardening** (`chat/public/guard.js`, first script in `index.html`):
  Element Call reads options from the link. `guard.js` removes the ones that
  could disable encryption or point reporting or the homeserver elsewhere
  (`enableE2EE`, `perParticipantE2EE`, `homeserver`, `posthog*`,
  `rageshakeSubmitUrl`, `sentry*`) before the app starts.
- **Safety code**: calls and chats show a 12-digit code derived (HKDF) from the
  key in the link. A call and its side chat show the same code. If everyone
  reads out the same digits, everyone holds the same key. A call link without
  a password shows a red "not end-to-end encrypted" warning instead.
- **Forward secrecy for calls and chats** (`chat/public/kx.js`): every browser
  makes a throwaway ECDH (P-256) key pair when it joins. The member with the
  lowest random id picks a random group key and sends it to each member,
  encrypted with an ECDH-derived key; a new one is made whenever someone joins
  or leaves. All of this goes through the chat relay, sealed with a key
  derived from the link secret, so the server can't read or inject it. The
  media/message key is HKDF(group key + link secret): it takes both, so the
  server can't hand out its own key (safety code still holds), and a link
  found later can't decrypt recorded traffic (the ECDH and group keys only
  ever exist in memory). For calls, `guard.js` wraps `window.Worker` and
  replaces the password key Element Call gives LiveKit's E2EE worker with
  these keys; until the first one arrives the worker has no key and sends
  nothing.
- **Proxy logs**: Caddy's proxy warnings and handler errors (written for all
  sites) are logged without IP, port or request headers (global log options set
  by labels on `interpartes-chat`).

## Verify
```
node verify/verify.mjs            # Node 18+, no dependencies
```
It downloads every file the site serves and checks:
1. all Element Call files match the SHA-256 list Element publishes with the
   GitHub release (version taken from `compose.yaml`);
2. `index.html` is the release file plus only the documented additions;
3. `config.json` and every `/chat` file match this repository byte for byte;
4. the Content-Security-Policy headers are the published ones, and only allow
   connections to this server.

What it can't prove: the server-side containers (Synapse, LiveKit, chat relay)
can't be inspected from outside. Their images are pinned by digest in
`compose.yaml`, but you are trusting the operator to run them. That is why
the end-to-end encryption and safety code matter: they hold even if the server
is not honest.

## Privacy: nothing is kept
- **No logs**: every interpartes container uses Docker's `none` log driver
  (`docker logs` shows nothing). Synapse logging goes to a null handler and
  Postgres only logs panics. Caddy's access log for this site is discarded
  (`caddy.log.output: discard`).
- **No IPs**: Synapse has `x_forwarded: false`, so it only sees Caddy's
  address. The janitor still empties `user_ips` and `user_daily_visits`.
- **Database in RAM**: Postgres data lives on a tmpfs (1 GB). Restarting
  `interpartes-db` (or the stack, or the server) wipes all accounts and rooms.
  Synapse is restarted along with it (`depends_on.restart`).
- **interpartes-janitor** (`config/janitor.py`) runs every 10 s with the
  `janitor` admin account (password in `.env`, recreated on a fresh DB):
  - call room with no live call member for 30 s → purged, plus a SQL sweep of
    every table with that `room_id`
  - its members, once they're in no other room → erased (deactivate with
    erase, then a SQL sweep of every table naming the user)
  - rooms where a call never started and guests who never joined a room →
    removed after 30 min
  - finished background jobs, old registration sessions (user agent) and old
    cache-invalidation rows → removed
  Tunable with env vars: `INTERVAL`, `ENDED_GRACE`, `LOBBY_GRACE`, `AUTH_GRACE`.
- Synapse: presence, user directory, media repo, URL previews and metrics off;
  rooms forgotten on leave; message retention at most 1 day.

On disk only: config files, the Synapse signing key, `.env` and the TLS cert.
In the browser: nothing lasting. `guard.js` (first script, before Element Call)
replaces `window.localStorage` with the tab's `sessionStorage` and hides
`window.indexedDB`, so the guest login, `room-shared-key-*` call passwords and
the Matrix sync/crypto stores live only in memory and in this tab (each tab is
its own guest). Tab storage is cleared whenever the home page loads, i.e. after
every call. On load it also deletes any real localStorage/IndexedDB data left
by earlier versions. Element Call's "Your call has ended / How did it
go?" screen is never shown: `guard.js` hides it and goes straight to the home
page.

No profile menu: `inject.js` hides the "Profile" item in each video tile's
"…" (and right-click) menu, matched by its icon so it works in every
language.

No room names: `inject.js` hides Element Call's "Name of call" field and fills
it with 24 random hex characters for every call, so the server and the link
only ever see a random name.

## Chat (`/chat`)
`chat/server.ts` is a tiny WebSocket relay; `chat/public/` is the web page.
- **Chat-only rooms**: the home page (restyled by `inject.js` to "New Room / [Nickname] / Call · Chat · Amnesia", centered) has a "Chat" button next to "Call".
  It uses the same nickname but creates no call (and no Matrix room or
  account): it opens `/chat/#k=<secret>`. The creator joins straight away;
  people opening the link enter a display name. Nicknames are never
  remembered: every call and chat asks again (the "Chat" button hands the
  typed nickname to the chat page once, which deletes it on read). Also reachable directly
  at https://interpartes.lo.fi/chat/.
- **In a call**: a Chat button next to "End call" opens a side panel whose
  chat is keyed by the call's own `roomId` + `password`, so everyone in the
  call (and only people with the call link) shares it. It joins automatically
  with the call's display name (read from the guest's own Matrix profile, and
  re-read on each message so renames in call settings carry over).
- The key never leaves the browser (it's after `#`), and the chat removes it
  from the address bar and history once open ("Copy link" still has it;
  reloading means opening the link again). Messages are AES-256-GCM with the
  forward-secret group key (see above), padded to 256-byte buckets. The relay only
  sees an opaque room tag and ciphertext, keeps nothing on disk or in logs, and
  forgets a room the moment its last socket closes. No history: you see only
  messages sent while you're connected.
- **Amnesia rooms**: a third home page button, "Amnesia", opens a chat-only
  room (`/chat/#k=<secret>&a=1`) where each browser keeps only the last 5
  messages of each person on screen and removes older ones. The flag is mixed
  into the key derivation (room id `amnesia`), so removing it from the link
  opens a different, empty room rather than the same room without the limit.
  This is enforced by the participants' browsers, so a modified client could
  keep more.
- **Close for all**: in chat-only rooms (regular and Amnesia, not a call's
  side chat) anyone can end the room for everyone. The relay tells the
  others who closed it, disconnects everyone, wipes their screens, and
  refuses that room tag for 24 h (kept in memory only, gone on restart), so
  the link stops working. Rooms opt in when they're created
  (`{join, closable: true}`); the call key exchange never does.
- **Watermark**: every chat (chat-only and in-call) is overlaid with faint,
  closely spaced diagonal lines of small "ANONYMOUS CHAT" text, in the
  viewer's language, so any screenshot or recording of a chat says it was
  private. It is drawn in the browser and never sent anywhere.
- Limits: text only, 4000 chars, 5 msg/s per person, 100 people per room;
  only same-origin WebSocket connections accepted.
- Loaded into Element Call by `config/index.html` (`/chat/inject.js`); it
  hooks the in-call buttons by their `data-testid`s, so an Element Call update
  that renames them will hide the Chat button until `inject.js` is adjusted.
- Container is read-only, no capabilities, Deno allowed only to listen on
  :8080 and read `/app`.

## Connection check
`chat/public/netcheck.js` runs as soon as any page loads (from `guard.js` on
Element Call, directly on `/chat`). It never blocks; findings are shown on the
home page and, as codes only (never the address), put in each member's sealed
key exchange message (`meta.risk` in `kx.js`), so everyone else in the call or
chat sees a warning that stays up while that person is there.
- **Encrypted address echo**: `POST /chat/netcheck` with a throwaway P-256
  public key; the server answers the address it sees (Caddy's
  `X-Forwarded-For`) plus whether proxy headers arrived, AES-GCM encrypted to
  an ECDH/HKDF key. Nothing is logged or stored. The server still receives the
  address to reply, like any server.
- **Lists**: the address is matched in the browser against
  `chat/public/iplists.txt` (X4BNet VPN + datacenter ranges, Tor exit list),
  served from this site because the CSP forbids other servers. Refresh with
  `node chat/update-iplists.mjs`.
- **WebRTC leak**: public ICE host/srflx addresses that differ from the echoed
  one (same IP family) mean a leaking VPN or proxy.
- **Page integrity**: scripts from other origins, extension resources and
  `navigator.webdriver`.
- VPN, proxy, Tor and hosting addresses count as a risk, not protection.
  Failing checks report "could not be checked". All steps time out after 4 s.

## Updating Element Call
The CSP allows Element Call's two inline scripts by hash, and
`config/index.html` is a copy of the release's `index.html`. After changing
the version in `compose.yaml`: take the new release's `index.html`, re-add the
`guard.js` tag after `<meta charset="UTF-8">` and the guest-only `<style>` +
`inject.js` tag before `</head>`, update the two `sha256-` hashes in
`config/security-headers.conf` if the inline scripts changed, deploy, then run
`node verify/verify.mjs` and start a test call (open the browser console and
check for "Refused to" CSP errors).

## Leaving a call without pressing "End call"
LiveKit sends participant webhooks to `interpartes-jwt` (`config/livekit.yaml`)
and the jwt service re-checks the SFU every 15 s, so a closed tab ends that
person's membership in well under a minute. `config/element-call.json` keeps
Element Call's delayed-leave timers at 20 s. As a last resort the janitor
treats a membership older than `STALE_HOURS` (6) without refresh as gone.
