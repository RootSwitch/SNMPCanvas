# SNMPCanvas - Basic SNMP Monitoring

> A lightweight, container-based SNMP monitor for home labs: poll your
> devices over SNMPv2c/v3, keep the history in SQLite, and view it in a
> dependency-free web UI. Nothing else.

SNMPCanvas exists for one job: **see how your devices are doing, and look
back in time when something was weird.** It polls network devices (and Linux
hosts) on a lazy interval, stores interface rates and CPU/memory/filesystem
gauges, and draws the graphs. It shares its visual language with
[CrossCanvas](https://github.com/RootSwitch/CrossCanvas) but is its own
project — it has a backend, a database, and credentials to protect, which is
exactly the complexity CrossCanvas refuses to have.

## What it deliberately is not

No auto-discovery, no topology, no alerting, no automation, no agents, no
plugin marketplace. If you outgrow SNMPCanvas, LibreNMS is excellent — this
project is for everyone who doesn't want to run LibreNMS to graph six
switches.

## Features

- **Devices list** — up/down status (SNMP reachability), uptime, last poll.
- **Device page** — CPU / memory / filesystem / temperature cards (when the
  device exposes them), then every tracked interface with live in/out rates,
  errors, and discards.
- **History graphs** — click any interface or resource card: traffic
  (avg + max), errors/discards, and a link-status strip, from 1 hour to 90
  days, rendered as hand-rolled SVG that follows the app theme.
- **Add-device flow** — enter address + credentials, SNMPCanvas verifies with
  a GET, walks the standard tables, and shows you what it found; you choose
  what gets tracked. No MIB files involved — everything is hardcoded numeric
  OIDs from IF-MIB, HOST-RESOURCES-MIB, and a small extensible vendor map
  (Cisco CPU/memory ships in v1; see `server/oids.js`).
- **SNMPv2c and v3** — v3 auth MD5/SHA-1/SHA-256/SHA-512, privacy DES/AES-128
  and both AES-256 variants (Blumenthal and Reeder/Cisco — if one fails with
  a decryption error, try the other; devices disagree about this).
- **Interface export** — check the **Export** box on any interface and its
  latest stats are written to `snmp-status.json` after every poll (atomic
  write), for external dashboards to ingest. Schema below.
- **Tunable data volume** — global polling interval (default 30 seconds,
  per-device override) and a global retention window (default 90 days,
  pruned nightly). Longer intervals and shorter retention keep the
  database small; at the 30 s default expect roughly 2,900 samples per
  tracked entity per day.
- **Single shared password** for the UI (scrypt-hashed), session cookie,
  login rate limiting.
- **9 themes** carried over from CrossCanvas's palette family.

## Quick start (Docker)

```yaml
# docker-compose.yml
services:
  snmpcanvas:
    build: .        # or a published image once available
    ports: ["9161:9161"]
    volumes: ["./data:/data:z"]   # :z = SELinux label; no-op elsewhere
    environment:
      - TZ=America/New_York
    restart: unless-stopped
```

```
mkdir -p data && sudo chown 1000:1000 data   # container runs as uid 1000
docker compose up -d
```

Open `http://host:9161`, set the admin password on the first-run page, and
add a device. That's the whole install. (Default port 9161 — "161" for SNMP —
deliberately avoids the usual home-lab tenants like UptimeKuma on 3001 and
CrossCanvas/PingCanvas on 8080/8443.)

### HTTPS

Run the included script once on the docker host, then restart:

```
./tools/gen-cert.sh 192.168.1.50 nas.lan    # your host's IPs / names
docker compose restart
```

It writes a self-signed cert to `data/certs/server.crt` + `server.key`; the
server detects the pair at startup and switches to HTTPS on the same port
(session cookies become `Secure` automatically). Prefer a real certificate?
Drop your own PEM pair at those two paths (or point `TLS_CERT`/`TLS_KEY`
elsewhere) — nothing else changes. Delete the files to fall back to HTTP.

If you mount a different host directory at `/data` (say `/srv/noc-data`),
the certs belong in *that* directory's `certs/` subfolder — tell the script
with `CERT_DIR=/srv/noc-data/certs ./tools/gen-cert.sh ...`. Two symptoms of
a cert the server can't use, both leaving the site on plain HTTP (browsers
then show TLS record-length errors when you try https): the pair isn't at
`<data>/certs/server.crt`+`server.key`, or it isn't readable by uid 1000 —
`docker compose logs snmpcanvas | grep -i tls` names the problem, and
`sudo chown -R 1000:1000 <data>/certs` fixes the second.

### Running without Docker

Node 20+: `npm install && npm start` (listens on `:9161`, data in `./data`).

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `9161` | HTTP/HTTPS listen port |
| `SNMPCANVAS_DATA` | `/data` | Directory for the SQLite db, certs, and default export file |
| `TLS_CERT` / `TLS_KEY` | `$DATA/certs/server.crt|key` | PEM cert/key pair; HTTPS turns on when both exist |
| `ADMIN_PASSWORD` | – | Pre-set the UI password (otherwise first-run setup page) |
| `SNMPCANVAS_SECRET` | – | If set, SNMP credentials are AES-256-GCM encrypted at rest |
| `POLL_CONCURRENCY` | `4` | Max devices polled simultaneously |
| `COOKIE_SECURE` | auto | `Secure` cookies: on with HTTPS, off with HTTP; set to override |
| `TZ` | UTC | Timezone for the nightly prune and log timestamps |

Polling interval, retention days, and the export path are set in the UI
(Settings) and stored in the database.

## Security notes, honestly

- SNMP credentials are stored in the SQLite database so the poller can use
  them. Without `SNMPCANVAS_SECRET` they are stored as-is — protect the
  `/data` volume. With it, they're encrypted with a key derived from your
  secret (lose the secret, re-enter the credentials).
- The web UI has one shared password and is meant for a trusted network
  segment; put a reverse proxy with TLS (and extra auth if you like) in
  front for anything beyond that.
- SNMP polls leave the container as outbound UDP/161 through Docker's NAT,
  so devices see the **Docker host's** IP. If your devices ACL SNMP by
  source address, allow the host IP — or run the container with
  `network_mode: host` / a macvlan.

## snmp-status.json

Every poll cycle, all exported interfaces across all devices are written
atomically to one file (default `/data/snmp-status.json`):

```json
{
  "schemaVersion": 1,
  "generator": "snmpcanvas/0.1.0",
  "generatedAt": "2026-07-16T14:05:03Z",
  "interfaces": [
    {
      "id": "core-sw1:eth0",
      "code": "K7Q2",
      "device": { "name": "core-sw1", "host": "10.0.0.2", "status": "up" },
      "ifIndex": 1,
      "name": "eth0",
      "alias": "uplink to fw",
      "speedBps": 1000000000,
      "adminStatus": "up",
      "operStatus": "up",
      "sampledAt": "2026-07-16T14:05:01Z",
      "inBps": 12345678.9,
      "outBps": 234567.1,
      "inErrorsPerSec": 0,
      "outErrorsPerSec": 0,
      "inDiscardsPerSec": 0,
      "outDiscardsPerSec": 0
    }
  ]
}
```

Rates are `null` when unknown (first poll after add/reboot, device down);
metadata is retained while a device is down so a dashboard can grey the tile
out instead of losing it.

`code` is a short stable key for consumers that don't want to type the full
`id`: 4+ characters derived from `md5(deviceName:ifName)` (confusable
characters excluded, lengthened only on hash collision), minted once and
stored with the interface. It survives un-export/re-export, rediscovery, and
even deleting and re-adding the device (same device and interface names →
same code). Each interface's code is shown in the UI on the device page.

Because the export path defaults to `/data/snmp-status.json` and `/data` is a
bind mount, the file lands **on the docker host** at `./data/snmp-status.json`
— another container on the same host (a PingCanvas-style dashboard, say) can
bind-mount that same directory read-only and ingest it directly. To write it
somewhere else on the host, add a second volume (e.g.
`- /srv/dashboards:/export`) and set Settings → export path to
`/export/snmp-status.json`.

## How discovery works (and how to extend it)

At add time SNMPCanvas GETs the system group, then walks:

- `ifTable`/`ifXTable` — interfaces, 64-bit counters when available
  (per-interface fallback to 32-bit with a sanity clamp; you'll get a
  warning on fast links that only offer 32-bit counters),
- `hrProcessorLoad` and `hrStorageTable` (HOST-RESOURCES-MIB) — CPU, RAM,
  and fixed disks on Linux/Windows/appliances,
- **temperature sensors** — LM-SENSORS-MIB (lmsensors on Linux/Proxmox;
  TrueNAS exposes per-drive temps this way), the standard ENTITY-SENSOR-MIB,
  and vendor health OIDs (Cisco ENVMON, MikroTik). lmsensors junk readings
  (unconnected headers, 0 °C placeholders) and redundant per-core sensors are
  listed but untracked by default,
- the **vendor map** in [`server/oids.js`](server/oids.js), matched by
  `sysObjectID` prefix — vendor CPU/memory OIDs for network devices that
  don't speak HOST-RESOURCES. Cisco (`CISCO-PROCESS-MIB`,
  `CISCO-MEMORY-POOL-MIB`) is included; adding a vendor is one data entry
  with a `style` of `walk-gauge-pct`, `scalar-gauge-pct`, or
  `used-free-pools`. PRs with tested entries are very welcome.

Devices that expose none of the CPU/memory tables simply don't show the
cards — interfaces still work, which is the primary use case.

If a device renumbers its `ifIndex`es (some do, after reboots or module
changes), affected interfaces are flagged **stale** in the UI; use
**Rediscover** on the device page to reconcile (new entities are added,
vanished ones stop being polled but keep their history). On Cisco,
`snmp-server ifindex persist` avoids the problem entirely.

## Development

```
npm install
npm run mock-agent    # fake SNMP device on udp/16100 (v2c "public", v3 "labuser")
npm start             # UI on http://localhost:8080
```

Add `127.0.0.1:16100` as a device and you have moving graphs without any
hardware.

### Project layout

| Path | Purpose |
|---|---|
| `server/server.js` | HTTP entry point: static files + API dispatch (plain `node:http`) |
| `server/api.js` | All `/api/*` handlers |
| `server/oids.js` | Every OID used, plus the vendor map — the file to extend |
| `server/snmp.js` | net-snmp wrapper (v2c/v3 sessions, walks, Counter64→BigInt) |
| `server/discover.js` | Add-device probe and table walks |
| `server/poller.js` | Tick scheduler, rate math, up/down, nightly prune |
| `server/exporter.js` | `snmp-status.json` writer |
| `server/db.js` / `auth.js` | SQLite schema; scrypt password + sessions |
| `public/` | The whole frontend: vanilla HTML/CSS/JS, no build step |
| `tools/mock-agent.js` | Fake device for development |

Runtime dependencies: [`net-snmp`](https://www.npmjs.com/package/net-snmp)
and [`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3). That's
the complete list, and keeping it that short is a feature.

## Credits

SNMPCanvas stands on two excellent MIT-licensed libraries:

- [**net-snmp**](https://github.com/markabrahams/node-net-snmp) by Mark
  Abrahams, Stephen Vickers, and contributors — the pure-JavaScript SNMP
  engine behind every poll, walk, and v3 handshake (its mock-agent support
  powers `tools/mock-agent.js` too).
- [**better-sqlite3**](https://github.com/WiseLibs/better-sqlite3) by Joshua
  Wise and contributors — the synchronous SQLite bindings that keep the
  storage layer a single dependency, wrapping the public-domain
  [SQLite](https://sqlite.org) library itself.

The visual language is borrowed from
[CrossCanvas](https://github.com/RootSwitch/CrossCanvas), SNMPCanvas's
sister project.

## License

[The Unlicense](LICENSE) — public domain. Use it, fork it, ship it at work,
no attribution required. Dependencies keep their own (MIT) licenses in
`node_modules/` when you install or ship an image.
