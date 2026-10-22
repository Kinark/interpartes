"""Deletes every trace of a call once nobody is left in it.

A room is "ended" when none of its call-membership state events is live
(non-empty content and not past its expiry). Rooms that held a call are
purged ENDED_GRACE seconds after the last membership change; rooms that never
held a call (someone sat in the lobby) are purged LOBBY_GRACE seconds after
creation. Members left with no rooms are then erased, as are guest accounts
that never joined anything within LOBBY_GRACE.

Synapse's purge/deactivate APIs leave rows behind (users, user_ips, stream
tables, ...), so each purge/erase is followed by a SQL sweep over every table
that references the room or user. Registration UI-auth sessions (which hold a
user agent) are dropped after AUTH_GRACE seconds.
"""

import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

import psycopg2
import yaml

BASE = os.environ.get("SYNAPSE_URL", "http://interpartes-synapse:8008")
SERVER = os.environ["SERVER_NAME"]
ADMIN = os.environ.get("JANITOR_USER", "janitor")
ADMIN_ID = f"@{ADMIN}:{SERVER}"
PASSWORD = os.environ["JANITOR_PASSWORD"]
INTERVAL = int(os.environ.get("INTERVAL", "10"))
ENDED_GRACE = int(os.environ.get("ENDED_GRACE", "30"))
LOBBY_GRACE = int(os.environ.get("LOBBY_GRACE", "1800"))
AUTH_GRACE = int(os.environ.get("AUTH_GRACE", "120"))
# A live member whose client stopped refreshing (tab closed before the
# delayed leave could be sent) counts as gone after this long.
STALE_MS = int(os.environ.get("STALE_HOURS", "6")) * 3_600_000
CALL_TYPES = (
    "org.matrix.msc3401.call.member",
    "org.matrix.msc4143.rtc.member",
    "m.rtc.member",
)

with open("/data/homeserver.yaml") as f:
    _hs = yaml.safe_load(f)
if "registration_shared_secret_path" in _hs:
    with open(_hs["registration_shared_secret_path"]) as f:
        SHARED_SECRET = f.read().strip()
else:
    SHARED_SECRET = _hs["registration_shared_secret"]

token = None


def req(method, path, body=None, auth=True):
    headers = {"Content-Type": "application/json"}
    if auth:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.load(resp)


def q(s):
    return urllib.parse.quote(s, safe="")


def login():
    global token
    try:
        token = req(
            "POST",
            "/_matrix/client/v3/login",
            {
                "type": "m.login.password",
                "identifier": {"type": "m.id.user", "user": ADMIN},
                "password": PASSWORD,
            },
            auth=False,
        )["access_token"]
        return
    except urllib.error.HTTPError as e:
        if e.code != 403:
            raise
    # Fresh (in-memory) database: create the admin via the shared secret.
    nonce = req("GET", "/_synapse/admin/v1/register", auth=False)["nonce"]
    mac = hmac.new(SHARED_SECRET.encode(), digestmod=hashlib.sha1)
    mac.update(
        b"\x00".join([nonce.encode(), ADMIN.encode(), PASSWORD.encode(), b"admin"])
    )
    token = req(
        "POST",
        "/_synapse/admin/v1/register",
        {
            "nonce": nonce,
            "username": ADMIN,
            "password": PASSWORD,
            "admin": True,
            "mac": mac.hexdigest(),
        },
        auth=False,
    )["access_token"]


def db():
    return psycopg2.connect(
        host=os.environ.get("DB_HOST", "interpartes-db"),
        user="synapse",
        dbname="synapse",
        password=os.environ["POSTGRES_PASSWORD"],
    )


def sweep(values, cols, skip_room_tables=False):
    conn = db()
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute(
        """select c.table_name, c.column_name from information_schema.columns c
           join information_schema.tables t
             on t.table_schema = c.table_schema and t.table_name = c.table_name
           where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
             and c.column_name = any(%s)
             and c.data_type in ('text', 'character varying')
             and (not %s or not exists (
               select 1 from information_schema.columns r
               where r.table_schema = 'public' and r.table_name = c.table_name
                 and r.column_name = 'room_id'))""",
        (list(cols), skip_room_tables),
    )
    for table, col in cur.fetchall():
        try:
            cur.execute(f'delete from "{table}" where "{col}" = any(%s)', (values,))
        except psycopg2.Error:
            pass
    conn.close()


def sweep_leftovers():
    """Registration UI-auth sessions keep the client IP and user agent;
    the rest is bookkeeping that still names users and rooms."""
    conn = db()
    conn.autocommit = True
    cur = conn.cursor()
    cutoff = int(time.time() * 1000) - AUTH_GRACE * 1000
    for table in ("ui_auth_sessions_ips", "ui_auth_sessions_credentials"):
        cur.execute(
            f'delete from "{table}" where session_id in '
            "(select session_id from ui_auth_sessions where creation_time < %s)",
            (cutoff,),
        )
    cur.execute("delete from ui_auth_sessions where creation_time < %s", (cutoff,))
    # Activity history nobody needs.
    cur.execute("delete from user_ips")
    cur.execute("delete from user_daily_visits")
    # Finished background jobs keep room/user IDs in their params.
    cur.execute("delete from scheduled_tasks where status in ('complete', 'failed')")
    # Cache-invalidation stream rows carry IDs too; Synapse only needs
    # recent ones for live replication between its own processes.
    cur.execute(
        "delete from cache_invalidation_stream_by_instance where invalidation_ts < %s",
        (int(time.time() * 1000) - 60_000,),
    )
    conn.close()


def all_rooms():
    rooms, frm = [], 0
    while True:
        r = req("GET", f"/_synapse/admin/v1/rooms?limit=500&from={frm}")
        rooms += r["rooms"]
        if "next_batch" not in r:
            return rooms
        frm = r["next_batch"]


def all_users():
    users, frm = [], "0"
    while True:
        r = req(
            "GET", f"/_synapse/admin/v2/users?limit=500&from={frm}&deactivated=true"
        )
        users += r["users"]
        if "next_token" not in r:
            return users
        frm = r["next_token"]


def room_status(room_id, now_ms):
    """Returns (active, last_activity_ms, ever_had_call)."""
    state = req("GET", f"/_synapse/admin/v1/rooms/{q(room_id)}/state")["state"]
    created = next(
        (e["origin_server_ts"] for e in state if e["type"] == "m.room.create"), now_ms
    )
    last, ever, active = created, False, False
    for e in state:
        if e["type"] not in CALL_TYPES:
            continue
        ever = True
        ts = e["origin_server_ts"]
        last = max(last, ts)
        c = e.get("content") or {}
        if not c:
            continue
        expires = c.get("expires")
        start = c.get("created_ts", ts)
        if (expires is None or start + expires > now_ms) and ts > now_ms - STALE_MS:
            active = True
    return active, last, ever


def purge_room(room_id):
    d = req(
        "DELETE",
        f"/_synapse/admin/v2/rooms/{q(room_id)}",
        {"purge": True, "block": False},
    )
    for _ in range(60):
        s = req("GET", f"/_synapse/admin/v2/rooms/delete_status/{d['delete_id']}")[
            "status"
        ]
        if s in ("complete", "failed"):
            break
        time.sleep(1)
    sweep([room_id], ["room_id"])


def erase_user(user_id):
    try:
        req("DELETE", f"/_synapse/admin/v1/users/{q(user_id)}/media")
    except urllib.error.HTTPError:
        pass
    try:
        req("POST", f"/_synapse/admin/v1/deactivate/{q(user_id)}", {"erase": True})
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
    localpart = user_id[1:].split(":", 1)[0]
    # Room-scoped rows (events, memberships) go when their room is purged.
    sweep(
        [user_id, localpart], ["user_id", "full_user_id", "name"], skip_room_tables=True
    )


def joined_rooms(user_id):
    return req("GET", f"/_synapse/admin/v1/users/{q(user_id)}/joined_rooms")[
        "joined_rooms"
    ]


def tick():
    now_ms = int(time.time() * 1000)
    rooms_done = users_done = 0
    candidates = set()

    for room in all_rooms():
        rid = room["room_id"]
        active, last, ever = room_status(rid, now_ms)
        grace = ENDED_GRACE if ever else LOBBY_GRACE
        if active or now_ms - last < grace * 1000:
            continue
        members = req("GET", f"/_synapse/admin/v1/rooms/{q(rid)}/members")["members"]
        purge_room(rid)
        candidates.update(members)
        rooms_done += 1

    for u in all_users():
        uid = u["name"]
        if uid == ADMIN_ID or u.get("admin"):
            continue
        created = u.get("creation_ts") or 0
        if created < 10**12:
            created *= 1000
        if (
            uid not in candidates
            and not u.get("deactivated")
            and now_ms - created < LOBBY_GRACE * 1000
        ):
            continue
        if not joined_rooms(uid):
            erase_user(uid)
            users_done += 1

    sweep_leftovers()

    if rooms_done or users_done:
        print(f"cleanup: {rooms_done} room(s), {users_done} account(s)", flush=True)


def main():
    while True:
        try:
            if token is None:
                login()
            tick()
            open("/tmp/janitor.ok", "w").close()
        except urllib.error.HTTPError as e:
            if e.code == 401:
                globals()["token"] = None
            print(f"error: HTTP {e.code}", flush=True)
        except Exception as e:  # keep running; Synapse may be restarting
            print(f"error: {type(e).__name__}", flush=True)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
