# SNMPCanvas - Basic SNMP Monitoring

> A lightweight, self-hostable SNMP monitor for home labs and small
> networks: poll your devices over SNMPv2c/v3, keep the history in SQLite,
> and browse it in a dependency-light web UI.

SNMPCanvas polls interface traffic, CPU, memory, storage, temperatures, and
fans on an interval you choose, keeps a configurable window of history, and
draws the graphs.

It is part of the Canvas family:
[**CrossCanvas**](https://github.com/RootSwitch/CrossCanvas) draws your
network, [**PingCanvas**](https://github.com/RootSwitch/PingCanvas) turns
those diagrams into a live reachability wall, and SNMPCanvas adds the
performance history - including an export file PingCanvas reads directly,
overlaying live values onto board labels and connections (schema below).
[**AlertCanvas**](https://github.com/RootSwitch/AlertCanvas) reads the same
export and turns it into raise/clear notifications (email, ntfy, syslog),
[**SyslogCanvas**](https://github.com/RootSwitch/SyslogCanvas) collects
syslog and SNMP traps from the same gear, and
[**LaunchCanvas**](https://github.com/RootSwitch/LaunchCanvas) is the
suite's front door - one login for every app, a tile launcher, and the
suite's quickstart docs.

**Install the whole suite in one command:** the [canvas-suite](https://github.com/RootSwitch/canvas-suite) repo is the family's landing page, with one-shot install scripts for the full six-app stack or a Pi-class PingCanvas + AlertCanvas pair.

Unlike CrossCanvas and PingCanvas, SNMPCanvas has a backend: polling needs
a process that outlives a browser tab, and history needs somewhere to live. The family's
small-footprint ethos carries over all the same - one container, one SQLite
file, two runtime dependencies, and a frontend that is still plain
HTML/CSS/JS with no build step.

![Four SNMPCanvas themes, four views: a 21-device fleet on Classic, a core switch's CPU and temperature cards above its interface table on Ember, a day of traffic on that switch's WAN uplink on Blueprint, and the add-device wizard listing what it just discovered on Glacier](docs/hero-quadrants.png)

## How it works

```
your devices ──SNMP (UDP/161)──► SNMPCanvas ──► SQLite ──► web UI & graphs
   (v2c/v3)                          │
                                     └──► snmp-status.json ──► dashboards
```

One Node process does everything: an in-process scheduler polls each device
on its interval, counter deltas become rates, samples land in SQLite, and
the same process serves the UI. Interfaces you mark for **export** are also
written to a small JSON status file every cycle, for other tools to read.

## Features

- **Devices list** - up/down status, CPU, busiest interface, uptime, last
  poll; sortable by any column.
- **Device page** - CPU / memory / filesystem / temperature / fan cards
  (when the device exposes them), then every interface with live in/out
  rates, errors, and discards. A filter box and per-interface Track/Export
  toggles keep big switches manageable.
- **Pickable summary columns** - a Columns button on the device list adds
  down-port counts, worst interface errors/s, sensor health, UPS charge and
  runtime, or sysLocation to the fleet table (per-browser preference; the
  default layout is unchanged). Absent data shows as N/A, never as a guess.
- **History graphs** - click any interface or resource card: traffic
  (average + peak), errors/discards and a link-status strip, from 1 hour to
  90 days. Charts are hand-drawn SVG that follows the app theme, with an
  optional link-speed scale for honest utilization reading. Ranges of a day
  or more are served from an hourly rollup, so a 90-day graph stays fast on
  a Raspberry Pi. Advertised speeds are treated as claims: an interface that
  measurably exceeds its claim (virtio and Hyper-V NICs advertise fiction)
  is marked `unrated` - utilization and its alerts go quiet instead of lying
  - and a per-interface speed override restores them with the honest number.
- **Add-device flow** - enter an address and credentials; SNMPCanvas
  verifies with a GET, walks the standard tables, and shows you everything
  it found so you choose what gets tracked. No MIB files involved -
  everything is well-known numeric OIDs (see `server/oids.js`).
- **Bulk add** - paste a list of addresses (one set of credentials), and
  each is probed and added with its default sensor selection - the fast way
  to onboard a whole fleet. **From file** pulls the addresses out of a
  CrossCanvas board (`.xcanvas`) or a CSV with an IP column - e.g. the
  board a setup-script `--scan` seeded - so a drawn network becomes a
  polled one without a spreadsheet detour.
- **SNMPv2c and v3** - v3 auth MD5/SHA-1/SHA-256/SHA-512, privacy
  DES/AES-128 and both AES-256 key-localization variants (Blumenthal and
  Reeder/Cisco - devices vary, and the wizard offers both).
- **Interface export** - check the **Export** box on any interface and its
  latest stats are written atomically to `snmp-status.json` after every
  poll, with short stable per-interface codes for easy mapping.
- **Tunable data volume** - a global polling interval (default 30 seconds,
  per-device override) and retention window (default 90 days, pruned
  nightly). At the defaults, expect roughly 2,900 samples per tracked
  entity per day.
- **Single shared password** for the UI (scrypt-hashed), sessions, login
  rate limiting, and one-click database backups from the Settings page.
- **Inventory export** - download the monitored fleet as a CSV that
  [CrossCanvas](https://github.com/RootSwitch/CrossCanvas) imports directly
  (File -> Import inventory), so devices SNMPCanvas already discovered can seed
  a diagram - and a device with an IP is monitoring-ready in PingCanvas at once.
- **30 themes** - Classic plus 29 shared with CrossCanvas's palette family,
  grouped the same way (Paper / Warm / Cool / Night / Screen).

## Small on purpose

SNMPCanvas is intentionally a store of SNMP data with a clear window onto
it: polling, history, graphs, and the export file. Auto-discovery, topology,
alerting, and automation aren't on the roadmap - they are jobs for tools
built around them, and the pieces here are shaped to sit alongside those
tools rather than replace them (reachability alerting pairs naturally with
an uptime monitor; the wall display is PingCanvas's whole job). Keeping the
moving parts few is a design choice - and if you want it to become something
bigger, the license makes forking genuinely easy.

## Quick start (Docker)

> **Installed via the [canvas-suite](https://github.com/RootSwitch/canvas-suite)
> script?** Skip this section - your data already lives under
> `/srv/canvas-suite`, the override file and secrets (SNMPCANVAS_SECRET,
> SUITE_SECRET) are already written, and the app is running. Sign in through LaunchCanvas
> (the setup script prints its admin password once, and stores it in
> `/opt/canvas-suite/launchcanvas/docker-compose.override.yml`); this app has no
> login of its own until you set an optional fallback password in Settings.
> **On Windows?** Skip the `chown` steps (Docker Desktop handles ownership);
> set env vars PowerShell-style (`$env:NAME = 'value'; npm start`); and
> `tools/gen-cert.sh` needs Git Bash or WSL - or drop your own PEM pair at
> the cert paths.

```yaml
# docker-compose.yml
services:
  snmpcanvas:
    build: .        # or a published image once available
    ports: ["9161:9161"]
    volumes: ["./data:/data:z"]   # :z = SELinux label; harmless elsewhere
    environment:
      - TZ=Etc/UTC                # your timezone: prune schedule + log stamps
    restart: unless-stopped
```

```
mkdir -p data && sudo chown 1000:1000 data   # container runs as uid 1000
docker compose up -d
```

Open `http://host:9161`, set the admin password on the first-run page, and
add a device. That's the whole install. (The default port is a nod to SNMP's
UDP/161, picked to coexist quietly with common home-lab neighbors like
Uptime Kuma on 3001 and the rest of the suite:
PingCanvas (which also serves the CrossCanvas editor) on 8080/8443, SNMPCanvas on 9161, SyslogCanvas on 9514 web + 514/162 udp, AlertCanvas on 9162, and LaunchCanvas on 9160.)

Two first-run notes: the setup page belongs to whoever reaches the port
first, so on anything but a trusted segment either set `ADMIN_PASSWORD` in
the compose file or claim the page immediately after `up -d`. And the
add-device form defaults to SNMPv2c, which is a cleartext protocol - see
Security posture below.

### HTTPS

Run the included script once on the docker host, then restart:

```
./tools/gen-cert.sh 192.168.1.50 nas.lan    # your host's IPs / names
docker compose restart
```

It writes a self-signed cert to `data/certs/server.crt` + `server.key`; the
server detects the pair at startup and switches to HTTPS on the same port
(session cookies become `Secure` automatically). Prefer a real certificate?
Place your own PEM pair at those two paths (or point `TLS_CERT`/`TLS_KEY`
elsewhere) - nothing else changes. Delete the files to fall back to HTTP.

If you mount a different host directory at `/data` (say `/srv/canvas-suite`),
the certs belong in *that* directory's `certs/` subfolder - tell the script
with `CERT_DIR=/srv/canvas-suite/certs ./tools/gen-cert.sh ...`. And if HTTPS
doesn't come up after a restart, the server stayed on HTTP because it
couldn't use the cert - `docker compose logs snmpcanvas | grep -i tls` names
the cause, which is almost always one of two things: the pair isn't at
`<data>/certs/server.crt` + `server.key`, or it isn't readable by uid 1000
(`sudo chown -R 1000:1000 <data>/certs` fixes that one).

### Customizing the deployment

Put host-specific settings (volume paths, environment variables, ports) in a
`docker-compose.override.yml` next to the compose file - Docker Compose
merges it automatically, and it's gitignored so updates never conflict with
your edits:

```yaml
# docker-compose.override.yml (example)
services:
  snmpcanvas:
    volumes:
      - /srv/canvas-suite:/data:z        # replaces ./data (same container path)
    environment:
      - TZ=America/Chicago
```

### Updating an existing install

```
git pull
sudo docker compose up -d --build
```

`up -d --build` rebuilds the image and recreates the container only when
something changed; the data directory is a bind mount, so devices, history,
and settings ride through every update (schema migrations run automatically
on first boot). Old image layers accumulate over time - an occasional
`sudo docker image prune -f` tidies them up.

### Your own theme

Twenty-nine themes ship in the picker. If none of them is your organisation's
colours, add a thirtieth without touching the app: drop a `theme.json` in the
data directory and it appears at the top of the list.

Start from whichever shipped theme is closest, rather than from a blank file:

```
node tools/export-theme.js nocturne > data/theme.json
node tools/check-theme.js
```

Then edit the hex values. It is a flat object of the same fifteen `--se-*`
variables the built-in themes use, and **you only need the ones you want to
change** - anything you leave out inherits Classic, so a three-line file is
valid:

```json
{
  "label": "Acme",
  "vars": { "--se-panel": "#101820", "--se-accent": "#e8734a" }
}
```

Because `data/` is a bind mount, **no rebuild is involved**. Edit the file,
refresh the browser, and it is there. Delete the file and the entry disappears.
Values must be hex; anything else is refused and logged rather than applied.

Running the whole suite? Point every app's data mount at one shared directory
(`canvas-suite-setup.sh` already does) and a single `theme.json` themes all of
them at once.

**`tools/check-theme.js` also audits readability**, because fifteen variables
include `--se-up`, `--se-down` and `--se-warn`, and these apps get left open on
a wall: a palette where healthy and failed do not separate at a glance is a
different kind of problem from one that is merely ugly. It checks text contrast
against WCAG AA and flags state colours too close in hue or too washed out to
read as a state at all.

It reports; it never refuses. Some of the shipped themes would warn too - they
were designed for the CrossCanvas editor first, with monitoring layered on
later, and a few exist mostly because they are fun. Amber in particular puts
`up` and `down` only 36 degrees apart, which is the point of a monochrome CRT
look and is worth knowing before you put it on a wall.

### Running without Docker

Node 20+: `npm install && npm start` (listens on `:9161`, data in `./data`).

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `9161` | HTTP/HTTPS listen port |
| `SNMPCANVAS_DATA` | `/data` | Directory for the SQLite db, certs, and default export file |
| `TLS_CERT` / `TLS_KEY` | `$DATA/certs/server.crt` / `.key` | PEM cert/key pair; HTTPS turns on when both exist |
| `TRUST_PROXY` | - | `1` = honor `X-Forwarded-For` for the login limiter. Only set this when the app's own port is unreachable except through your proxy: the header is trusted on **every** connection, so a client that can reach the port directly can forge it and evade the limiter |
| `ADMIN_PASSWORD` | - | Pre-set the UI password (otherwise first-run setup page) |
| `SNMPCANVAS_SECRET` | - | If set, SNMP credentials are AES-256-GCM encrypted at rest |
| `SUITE_SECRET` | - | Opt-in suite single sign-on: accept signed login tokens from the [LaunchCanvas](https://github.com/RootSwitch/LaunchCanvas) portal (same value across the suite; see its README for the security model) |
| `POLL_CONCURRENCY` | `16` | Max devices polled simultaneously. **Also settable in Settings** - the variable is an override, and when set the UI field goes read-only and says so. Slots spend their time waiting on UDP, not working, so raising this is cheap; at most half are ever given to devices already down, so unreachable kit cannot starve the rest |
| `COOKIE_SECURE` | auto | `Secure` cookies: on with HTTPS, off with HTTP; set to override |
| `TZ` | UTC | Timezone for the nightly prune and log timestamps |

Polling interval, retention days, and the export path are set in the UI
(Settings) and stored in the database.

## How many devices can one instance handle?

Measured, not estimated - on a **Raspberry Pi 3B+** (4x1.4GHz, 1GB RAM,
Debian 13) polling a synthetic fleet over real network, at the default 30s
interval with every interface tracked and exported:

| Fleet | Result |
|---|---|
| 400 devices, 4800 tracked entities, 40 of them unreachable | Full rate, ~8200 samples/min, **68% of one core**, 113MB RSS |

The loop is single-threaded, so **one core is the ceiling** regardless of how
many the machine has. A Pi 3B+ is therefore roughly a 400-500 device box at
30s; anything x86 has enormous headroom (the same fleet costs a desktop Xeon
about 4% of a core).

Disk is the other ceiling, and it is worth doing the multiplication before you
commit to a retention window: history runs roughly **17MB per tracked entity
per 90 days**, which is fine for a homelab and is not fine by default at fleet
scale. The 4,800-entity fleet in the table above is about **80GB** at 90 days;
a hundred 48-port switches with every port tracked is roughly **700MB a day**.
Retention is per-instance, so the levers are the retention setting, the poll
interval, and untracking ports you do not care about - an access switch's 48
edge ports are usually 48 entities you will never open a graph for. Graph speed
is not affected either way (long ranges are served from an hourly rollup), so
this is purely a question of what the volume can hold.

**How fast your devices answer matters as much as how many there are.** The
figures above were measured against agents replying in well under a
millisecond - an estate made entirely of switches with real CPUs behind their
SNMP agent. Real fleets are not that: a PDU is answering from a
microcontroller, and a BMC is famously the slowest thing in the rack. Measured
on one 100-device fleet, varying only how long agents took to reply:

| slowest agent | samples/min | CPU | keeping up? |
|---|---|---|---|
| instant | 9,180 | 44% | yes |
| 300ms | 7,400 | 45% | yes |
| 1000ms | 3,560 | 46% | **no** |
| 1000ms, `POLL_CONCURRENCY=64` | 9,280 | 64% | yes |

Throughput fell 61% while **CPU never moved** - the loop was waiting, not
working. Which is why the answer is not a bigger machine: raising
`POLL_CONCURRENCY` restored full rate on the slow fleet, because a slot spends
its time blocked on a socket rather than burning a core.

So there is no single "how many devices" number, and anyone who gives you one
is quoting their own gear. If Settings or the log says the poll loop is behind,
raise `POLL_CONCURRENCY` until it stops - that warning exists so this is
something you can watch rather than guess at.

**Fewer, denser devices are cheaper.** At an equal entity count, 100 devices of
~52 entities cost about **40% less CPU per entity** than 400 devices of ~12,
because per-device overhead - session setup, the liveness GET, timeout handling
- amortises across ports. A switch stack presenting as a single agent is
materially cheaper to poll than the same switches standing alone.

**Unreachable devices are the thing that actually costs you.** A device that
answers occupies a slot for ~50ms; one that does not occupies it for a full
timeout, ~10s - about 200x more. Two things keep that from hurting: at most
half of `POLL_CONCURRENCY` is ever handed to devices already marked down, so
they cannot starve the ones that are answering, and the loop refills a freed
slot immediately rather than waiting for the next scheduling tick. Down
devices are simply re-checked less often the more of them there are.

### The nightly prune, and why the file does not shrink

History older than the retention setting is deleted nightly at 03:30, one
entity at a time, yielding the event loop between each so polling keeps
running throughout. Measured on a Pi 3B+ pruning 13.9 million rows: **about 6
minutes**, of which only **62 seconds is the deleting** (4800 deletes, median
5ms, 95th percentile 21ms) and the closing checkpoint is under 200ms. The rest
is the loop deliberately handing time back to polling. A handful of deletes -
14 of 4800 - took over half a second, and the web UI pauses briefly when they
do. Polling continues and no device is falsely marked down, so a wall driven
off the export stays correct; it is the interface that gets choppy.

Two things make it worse, both avoidable: pruning a lot at once (the first
prune after *lowering* retention is by far the most expensive), and pruning
immediately after a large bulk write, while much of the database is still
sitting in the write-ahead log. The same 13.9M rows took 15 minutes rather
than 6 when pruned directly after being inserted.

**Lowering retention will not give you disk space back on its own.** SQLite
keeps the freed pages inside the database file and reuses them for new
samples, so the file stays at its high-water mark - a 648MB file can hold
20MB of live data and never shrink. That is normal and self-correcting: the
space is reused rather than leaked. If you actually need the space returned to
the filesystem, stop SNMPCanvas and run a one-off compaction:

```sh
sqlite3 /path/to/snmpcanvas.db 'VACUUM;'
```

`VACUUM` rewrites the whole database and needs free space roughly equal to the
current file size while it runs. It is not run automatically, because doing so
unprompted on a large database would block for a long time.

### The export file is rewritten whole, so put it on a RAM disk

`snmp-status.json` is not appended to - every write regenerates the entire
file, coalesced to at most one write per second. That keeps consumers simple
(any web server can serve it, and you can `cat` it to debug), but it means the
bytes written scale with the size of the file rather than with how much
actually changed. Measured on a 400-device, 20,800-entity fleet with an 11MB
export, it was **83-97% of everything the app wrote to disk** - several times
the time-series database itself. Skipping unchanged writes would not help
much: interface counters differ on essentially every poll, so the file is
genuinely different nearly every time.

At homelab sizes this is a non-issue (a 20-device board exports ~130KB and
writes well under a gigabyte a day). It matters on **flash media at scale** -
that same 11MB export is roughly 80GB of writes per day, which is real wear on
a Raspberry Pi's SD card.

The file is pure derived state, regenerated within seconds of a restart, so it
does not need to survive a reboot. Point it at a RAM disk and the writes stop
touching storage entirely. Measured effect: bytes reaching the card fell from
69MB/min to 14MB/min, and what remains is the database - the part you do want
durable. Size it at roughly **0.55KB per exported entity**.

Running directly (Settings, or the `export_path` setting):

```
/dev/shm/snmp-status.json
```

Under Docker it needs a **named volume backed by tmpfs**, shared by whichever
container serves the file. The `tmpfs:` service key does NOT work here - that
gives each container its own private one, so the consumer would mount an empty
directory and see nothing:

```yaml
services:
  snmpcanvas:
    volumes:
      - status:/status
  pingcanvas-web:
    volumes:
      - status:/usr/share/nginx/html/status:ro

volumes:
  status:
    driver_opts:
      type: tmpfs
      device: tmpfs
      o: size=64m
```

Then set the path once in **Settings** to `/status/snmp-status.json`; it is
stored in the database, so it survives restarts and upgrades. There is
deliberately no environment variable for it - the path has to agree with a
mount that only the operator knows about.

Size the volume for the export plus one temporary copy: the write goes to a
temp file in the same directory and is renamed over the target, so the peak is
about twice the file size. The 64m above is not a tight fit - at 0.55KB per
entity it holds roughly **58,000 exported entities**, which is far more than a
single instance can poll in the first place. This knob will not be what limits
you.

If the loop ever cannot keep up it says so - a warning in the log and on the
Settings page - rather than silently recording history at a longer interval
than the one configured.

## Security posture

SNMPCanvas is a networked app with a small, deliberate threat model:

- **SNMPv1/v2c has no encryption and no real authentication**: the
  community string travels in cleartext in every packet, and so does
  everything it returns. Use v3 with authPriv where the device supports it,
  restrict SNMP by source address on the device, and keep polling traffic
  on a trusted VLAN. Never expose the poller or the monitored agents to the
  internet.
- SNMP credentials are stored in the SQLite database because the poller
  sends them on every cycle. By default the protection is filesystem
  permissions on the `/data` volume; set `SNMPCANVAS_SECRET` and they are
  AES-256-GCM encrypted with a key derived from your secret instead (lose
  the secret, re-enter the credentials). The same applies to **database
  backups** downloaded from Settings: without `SNMPCANVAS_SECRET`, the
  `.db` file carries every community string and v3 key in the clear -
  treat it accordingly.
- The web UI has one shared password and is designed for a trusted network
  segment; a reverse proxy adds TLS termination and extra auth cleanly if
  you want to go further. The first-run setup page belongs to whoever
  reaches it first - claim it promptly or pre-set `ADMIN_PASSWORD`. (In an
  SSO suite this is closed automatically: with `SUITE_SECRET` set, the
  setup page can only be completed by someone already signed in through
  LaunchCanvas, so a stray direct visitor can't claim the account.)
- With `SUITE_SECRET` set, a signed token minted by the
  [LaunchCanvas](https://github.com/RootSwitch/LaunchCanvas) portal also
  signs you in (verified per request, no local session minted). Anyone
  holding that secret can mint valid tokens, so treat it like the other
  suite secrets; the LaunchCanvas README documents the full model,
  including revocation and the host-wide cookie caveat. Unset, the token
  path is inert.
- SNMP polls leave the container as outbound UDP/161 through Docker's NAT,
  so devices see the **docker host's** IP. If your devices restrict SNMP by
  source address, allow the host IP - or run the container with
  `network_mode: host` or a macvlan.

## Moving or restoring the database

Everything - devices, credentials, history, interface codes - lives in one
SQLite file, `snmpcanvas.db` in the data volume. To move an instance to another
machine (or restore a backup):

- **Shut down first, then copy.** On `docker compose down`, SNMPCanvas
  checkpoints the write-ahead log back into the main file, so a clean stop
  leaves `snmpcanvas.db` self-contained - copy just that one file. If you can't
  be sure it stopped cleanly (a `docker kill`, a power loss), copy all three of
  `snmpcanvas.db`, `snmpcanvas.db-wal`, `snmpcanvas.db-shm` together and let
  SQLite merge them on open. The **Download database backup** button in Settings
  sidesteps this entirely - it writes a consistent snapshot regardless of
  running state.
- **Carry `SNMPCANVAS_SECRET` with the file.** If the source instance encrypts
  credentials (the secret is set), the community strings and v3 keys are only
  decryptable with that same secret - set the identical `SNMPCANVAS_SECRET` on
  the target, or polling fails on every device (the raw ciphertext gets handed
  to SNMP). A database with **no** secret carries its credentials in cleartext,
  so treat the file like a password store when moving it.
- **The admin password travels too** (its hash is in the file), so the target
  logs in with the source's password and skips the first-run setup page.

**Turning on encryption for an existing database - no rebuild needed.** Setting
`SNMPCANVAS_SECRET` does not retroactively encrypt credentials already stored in
cleartext (encryption happens when a credential is written, not at startup). But
you don't have to start over: set the secret, then **re-save each device's
credentials** (Edit device -> **Change credentials** -> enter them -> Save, e.g.
when you change a community off `public`). That write encrypts them. Re-saving
credentials leaves the interface `code`s untouched, so any PingCanvas board bound
to those codes keeps working - no board changes, no history lost.

## snmp-status.json

Every poll cycle, everything marked **Export** is written atomically to one
file (default `/data/snmp-status.json`). Interfaces go to `interfaces[]`;
every other exported sensor - CPU, memory, disk, temperature, fan, power,
utilization, amps/volts meters, status flags, plus per-device uptime (Edit
dialog) - goes to `metrics[]` as a code plus a short pre-formatted
`display` string, so a consumer like PingCanvas can stay a dumb
"code -> text" swapper. A `devices[]` roster lists every device
contributing anything to the feed, with its up/down status. Two siblings
consume the file today: PingCanvas overlays the values onto boards, and
[AlertCanvas](https://github.com/RootSwitch/AlertCanvas) holds them
against thresholds and sends raise/clear notifications (it runs on port
9162, next door to this app's 9161):

```json
{
  "schemaVersion": 3,
  "devices": [ { "name": "compute-01", "host": "10.0.0.7", "status": "up" } ],
  "interfaces": [ ... ],
  "metrics": [
    { "code": "H4TN", "kind": "cpu", "host": "compute-01",
      "display": "CPU 45%", "value": 45, "unit": "%", "status": "ok",
      "sampledAt": "2026-07-17T01:10:42Z" }
  ]
}
```

`kind:"cpu"` (`ok` under 85%, `warn` to 94%, `crit` at 95%+) and
`kind:"battery"` (`ok`, `warn`/`crit` as charge drops) carry a coloring
`status`; every other kind is display-only, so a wall shows the number without
screaming about it. The status field is forward-safe either way: today's kiosk
colors a device frame from CPU status and ignores the rest until a coloring
gate opens. Unavailable values keep their entry with `display: "--"`. Export checkboxes live in the interface table (interfaces),
the **Sensors** dialog (everything else), and the device **Edit** dialog
(uptime); each exported item shows its code chip in the UI, already wrapped
in braces and copied to the clipboard on click.

On a PingCanvas board, wrap the code in braces - `{K7Q2}` - in a device
label line or a connection annotation. Braces are required on labels and
optional on annotations, so the braced form always works; text around the
token is the board author's own (`Rx {K7Q2}` renders as `Rx ▼56M ▲32M`).

**The wall copy.** The full file is a complete inventory - sysNames, host
addresses, interface names and aliases, for every monitored device whether or
not it is drawn anywhere - and a kiosk wall serves its feed unauthenticated
by design. So a second file, `snmp-status.wall.json`, is written beside it
(path in **Settings**, `off` to disable): the same interfaces and metrics
stripped to codes and values, with `devices[]` dropped entirely. `{code}`
bindings resolve identically against either file; only annotations keyed by
`Device:ifName` or `Device:alias` need the full one. Serve the wall copy,
keep the full feed where only AlertCanvas's file mount can read it - the
suite's setup script wires exactly that.

`interfaces[]` in schema v4 (shown indented here for reading - the real file is
**minified**, since it is rewritten in full on every poll and indentation was
31% of it; pipe it through `jq .` to inspect one by eye):

```json
{
  "schemaVersion": 4,
  "generator": "snmpcanvas/1.0.0",
  "generatedAt": "2026-07-16T14:05:03Z",
  "devices": [
    { "name": "core-sw1", "host": "10.0.0.2", "status": "up" }
  ],
  "interfaces": [
    {
      "code": "K7Q2",
      "device": "core-sw1",
      "ifIndex": 1,
      "name": "eth0",
      "alias": "uplink to fw",
      "speedBps": 1000000000,
      "adminStatus": "up",
      "operStatus": "up",
      "sampledAt": 1784980801,
      "inBps": 12345678,
      "outBps": 234567,
      "inErrorsPerSec": 0.033,
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

`code` is a short, stable key for consumers that don't want to type the full
`id` - and interfaces, sensors, and uptime all mint the same kind of code:
4+ characters (uppercase, confusables like 0/O and 1/I excluded) derived
from `md5(deviceName:entityName)`, lengthened only on hash collision, minted
once and stored. A code survives un-export/re-export, rediscovery, and even
deleting and re-adding a device - the same device and entity names produce
the same code. Every code shows as a clickable chip in the UI.

Because the export path defaults to `/data/snmp-status.json` and `/data` is
a bind mount, the file lands **on the docker host** - another container on
the same host (a PingCanvas deployment, say) can bind-mount that directory
read-only and ingest it directly. To write it somewhere else, add a second
volume (e.g. `- /srv/dashboards:/export`) and set Settings → export path to
`/export/snmp-status.json`.

## How discovery works (and how to extend it)

At add time SNMPCanvas GETs the system group, then walks:

- `ifTable`/`ifXTable` - interfaces, with 64-bit counters when available
  (per-interface fallback to 32-bit with a sanity clamp, and a heads-up
  warning on fast links that only offer 32-bit counters),
- `hrProcessorLoad` and `hrStorageTable` (HOST-RESOURCES-MIB) - CPU, RAM,
  and fixed disks on Linux, Windows, and many appliances,
- **temperature and fan sensors** - LM-SENSORS-MIB (lmsensors on
  Linux/Proxmox; TrueNAS exposes per-drive temps this way), the standard
  ENTITY-SENSOR-MIB, vendor health OIDs (Cisco ENVMON, MikroTik), and the
  ASRock Rack BMC sensor table - IPMI controllers make great SNMP devices
  in their own right, reading fan tachometers and temperatures straight
  off the hardware even when the host OS can't. Junk readings (unconnected
  headers, 0 °C placeholders, "Not Available" rows) and redundant per-core
  sensors are listed but left untracked by default,
- the **vendor map** in [`server/oids.js`](server/oids.js), matched by
  `sysObjectID` prefix - vendor CPU/memory OIDs for network devices that
  don't speak HOST-RESOURCES. Cisco (`CISCO-PROCESS-MIB`,
  `CISCO-MEMORY-POOL-MIB`) is included, and adding a vendor is one data
  entry. PRs with tested entries are very welcome.

Devices that expose none of the CPU/memory tables simply don't show those
cards - interfaces still work fully.

### Custom sensors via snmpd `extend`

Anything a shell command can print becomes a sensor. On the monitored host,
add `extend` directives to `/etc/snmp/snmpd.conf` whose **names pick the
kind by prefix** - `temp-` (°C), `fan-` (RPM), `power-` (watts), `util-`
(percent), `batt-` (battery charge %), `runtime-` (seconds remaining) - and
whose output is a single number:

```
extend temp-GPU   /usr/bin/nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits
extend power-GPU  /usr/bin/nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits
extend util-GPU   /usr/bin/nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits
```

Restart snmpd, rediscover the device, and the outputs appear as sensor
cards with history. This is the doorway for data SNMP can't see natively:
NVIDIA GPUs (no hwmon - AMD GPUs surface through lm-sensors automatically),
USB UPSes, anything scriptable. The command runs under the *agent's*
account on the monitored host - SNMPCanvas only ever reads the published
number. (NVIDIA note: `fan.speed` reports percent, not RPM - name it
`util-GPU-Fan`, not `fan-`.)

**Keep the command fast - cache anything that reaches off the box.** The agent
runs it on *every poll*, and the reply cannot leave until it returns. A script
that curls an inverter's API or walks a Modbus register for 400ms turns that
host into a 400ms device, and one poll slot is held for the whole of it. That
is the same arithmetic as an unreachable device, just smaller: capacity is
slot-seconds, so response time multiplies straight into it.

Decouple the fetch from the read. A cron job or systemd timer writes the value
to a file, and `extend` only reads it:

```
* * * * *  /usr/local/bin/read-inverter.sh > /run/solar.txt
```
```
extend power-Solar  /bin/cat /run/solar.txt
```

The poll stays sub-millisecond and the data is as fresh as the timer. Local
commands that already return instantly - `upsc`, `nvidia-smi`, reading
`/sys` - need none of this.

A USB UPS via [NUT](https://networkupstools.org/) is the canonical battery
example - `upsc` already prints bare numbers:

```
extend batt-UPS1    /usr/bin/upsc ups battery.charge
extend runtime-UPS1 /usr/bin/upsc ups battery.runtime
extend util-UPS1-Load /usr/bin/upsc ups ups.load
```

Battery cards alarm LOW (red at 20% and below), runtime displays humanize
(`Runtime 1h 0m`), and exported battery metrics carry an ok/warn/crit
`status` - forward-safe under the kiosk contract, which ignores status on
non-CPU kinds until a coloring gate opens.

If a device renumbers its `ifIndex`es (some do, after reboots or module
changes), affected interfaces are flagged **stale** in the UI; use
**Rediscover** on the device page to reconcile - new entities are added,
vanished ones stop being polled but keep their history. On Cisco,
`snmp-server ifindex persist` avoids the situation entirely.

### The `poller` block

Every export carries whether this instance is keeping up:

```json
"poller": { "behind": false, "overdueDevices": 0, "worstLateS": 0, "concurrency": 16 }
```

`behind` is true when reachable devices have missed a full poll interval (down
devices are excluded - they are deprioritised on purpose). AlertCanvas raises a
**warning** on it out of the box, because the failure mode is that nothing
looks wrong: graphs keep drawing, just coarser than configured. The field is
always present, so a consumer can tell "keeping up" from "too old to say".

### Schema v4

`schemaVersion` is **4**. Three fields changed shape, purely to stop paying for
the same bytes on every rewrite:

| v3 | v4 | why |
|---|---|---|
| `device: { name, host, status }` on every interface | `device: "core-sw1"` | `devices[]` has listed name/host/status since v3, so a 48-port switch serialised the same host and status 48 times. Join `devices[]` on the name if you need them. |
| `id: "core-sw1:eth0"` | *(gone)* | it was exactly `device + ":" + name` - two adjacent fields already said it |
| `sampledAt: "2026-07-16T14:05:01Z"` | `sampledAt: 1784980801` | epoch seconds; nothing renders it to a human |

Measured on a real 400-interface export, v4 plus minifying and rate rounding
took the file from 696 to 361 bytes per interface - **48% smaller**.

PingCanvas and AlertCanvas accept **either** schema, so the suite's apps can be
upgraded in any order. If you consume this file yourself, the v3 shape keeps
working against older SNMPCanvas releases; read `schemaVersion` if you need to
branch.

Those interfaces also carry `"stale": true` in `interfaces[]`, and this is
worth handling rather than ignoring. The index is *reused*, so the entry keeps
the **old** `name` while the counters belong to whatever occupies that index
**now** - a wall tile or an alert rule bound to `Gi0/1` can quietly report a
different port's traffic, looking perfectly healthy while doing it. History
under that name likewise splices two physical ports together with no
discontinuity marker.

The field is **omitted entirely when false**, not emitted as `false`: on a
large fleet a `"stale": false` on every row adds hundreds of KB to a file that
is rewritten in full on every poll. Treat absence as "not stale".

## Troubleshooting

### A poll times out and nothing says why

**A timeout can be masking a socket-level error**, and on a large fleet that is
indistinguishable from a slow device.

`net-snmp` 3.26.3 has a bug in its session error path:

```js
Session.prototype.onError = function (error) { this.emit (error); };
```

The Error object is passed as the *event name* instead of `emit("error",
error)`. That handler is the only one registered for the session socket, so
every socket-level failure is emitted under a nonsense event name and vanishes:
`session.on('error', ...)` can never see it, and because it is not an `'error'`
event it does not throw either. It silently does nothing, and the request that
was in flight simply runs out its five-second timeout.

Failures that disappear this way include:

* `EACCES` binding a privileged source port
* `EHOSTUNREACH` or `ENETUNREACH` reported back by an ICMP error
* `EMFILE` when the poller runs out of file descriptors

**Nothing in SNMPCanvas can recover these** - the event is unobservable to any
caller - so the practical advice is diagnostic. If timeouts appear across *many
hosts at once*, suspect a socket-level cause rather than the devices, and check
descriptor limits first (`ulimit -n`, or the container's `LimitNOFILE`).
Descriptor exhaustion is the one that scales with fleet size and therefore the
one most likely to look like "the network got slow".

A one-line fix upstream would surface all of them.

### A device sends responses that cannot be decoded

Logged as `[snmp] session error from <host>`, rate limited to one line per host
per 30 seconds. That poll fails; everything else keeps running.

Usually a firmware bug, or a v3 key or protocol mismatch producing a response
that fails to authenticate rather than a clean error. Reproduce the handling
locally with:

```
MOCK_GARBAGE=1 MOCK_PORT=16199 node tools/mock-agent.js
```

Before this was guarded, one such response terminated the whole process. See
`tools/check-decode-crash.js`, which asserts both that an unguarded session dies
and that a guarded one survives.

## Development

```
npm install
npm run mock-agent    # fake SNMP device on udp/16100 (v2c "public", v3 "labuser")
npm start             # UI on http://localhost:9161
```

Add `127.0.0.1:16100` as a device and you have moving graphs without any
hardware.

### Project layout

| Path | Purpose |
|---|---|
| `server/server.js` | HTTP entry point: static files + API dispatch (plain `node:http`) |
| `server/api.js` | All `/api/*` handlers |
| `server/oids.js` | Every OID used, plus the vendor map - the file to extend |
| `server/snmp.js` | net-snmp wrapper (v2c/v3 sessions, walks, Counter64 handling) |
| `server/discover.js` | Add-device probe and table walks |
| `server/poller.js` | Tick scheduler, rate math, up/down, nightly prune |
| `server/exporter.js` | `snmp-status.json` writer |
| `server/db.js` / `auth.js` | SQLite schema and migrations; scrypt password + sessions |
| `public/` | The whole frontend: vanilla HTML/CSS/JS, no build step |
| `tools/mock-agent.js` | Fake device for development |

Runtime dependencies:
[`net-snmp`](https://www.npmjs.com/package/net-snmp) and
[`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3) - the
complete list, by design.

## Contributing

Bug reports are welcome via Issues, and **tested vendor-map entries are
especially useful**: if your device's CPU, memory, or temperature OIDs
aren't discovered, an issue with a sanitized `snmpwalk` (or a one-entry PR
against `server/oids.js`) is what makes support for it happen. Small,
self-contained fixes are welcome as pull requests too.

For larger features - alerting, discovery, rollups, and the like - I'd
rather you fork than open a big PR. SNMPCanvas is deliberately small, the
whole backend is a handful of readable files, and The Unlicense means you owe nobody
anything. Build the monitor you want.

## Credits

SNMPCanvas stands on two excellent MIT-licensed libraries:

- [**net-snmp**](https://github.com/markabrahams/node-net-snmp) by Mark
  Abrahams, Stephen Vickers, and contributors - the pure-JavaScript SNMP
  engine behind every poll, walk, and v3 handshake (its agent support powers
  `tools/mock-agent.js` too).
- [**better-sqlite3**](https://github.com/WiseLibs/better-sqlite3) by Joshua
  Wise and contributors - the synchronous SQLite bindings that keep the
  storage layer a single dependency, wrapping the public-domain
  [SQLite](https://sqlite.org) library itself.

The visual language is borrowed from
[CrossCanvas](https://github.com/RootSwitch/CrossCanvas), SNMPCanvas's
sister project.

## License

[The Unlicense](LICENSE) - public domain, same as CrossCanvas, PingCanvas,
SyslogCanvas, AlertCanvas, and LaunchCanvas. Use it, fork it, ship it at work, no attribution required.
(Dependencies keep their own MIT licenses in `node_modules/` when you
install or ship an image.)
