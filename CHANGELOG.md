# Changelog

## Unreleased (since 1.0.0)

- **The retention setting now states its consequence, not just its policy.**
  Under the History Retention input, Settings shows what the window actually
  holds: database size on disk, how many days of history it currently spans
  (the number you otherwise reverse-engineer by scrolling a chart back until
  it goes blank), the measured growth per day, and what the configured window
  will level off at - so changing the number shows what it buys before you
  commit to it. The projection scales the real file, so it includes indexes,
  the hourly rollup and WAL overhead without pretending to model them. Under
  an hour of data, it says so instead of projecting noise. There is no hidden
  row cap behind this - retention is time-based only, which is honest for
  SNMP: the write rate is deterministic (entities x polls per day), unlike
  syslog where a row cap guards against log floods.

- **Visible, adjustable auto-refresh - and refreshing stops stealing your
  scroll.** The device list (and device detail page) refresh interval is
  now a dropdown in the page head: 30s (the previous, undocumented
  behavior, still the default), 1m, 5m, or off - a per-browser preference.
  Two behaviors fixed alongside: a refresh now preserves your horizontal
  and vertical scroll position, so reading the far columns of a wide table
  no longer snaps you back to the left edge every 30 seconds, and a
  refresh never fires while the Columns panel is open mid-choice.

- **Device identity: OS, Hardware, Cores and RAM columns.** Discovery (and
  Rediscover) now collect a device's static identity: a per-family OS
  summary distilled from the agent's own description ("Linux 6.17.2-1-pve
  (Proxmox)", "Windows Server 2022 (build 20348)", "pfSense 2.8.1 (FreeBSD
  15.0-CURRENT)", "TrueNAS 13.0-U6.8", "RouterOS 7.20.6" - the RouterOS
  version comes from MikroTik's private OID, since sysDescr only carries
  the model); a hardware model from the vendor's own identity OIDs
  (MikroTik, APC UPS with SKU, APC PDU, UniFi, QNAP), ENTITY-MIB where
  populated (Dell-style), the CPU model on plain hosts ("Intel(R) N150" -
  with the junk strings agents actually emit filtered out: Windows'
  "Unknown Processor Type", FreeBSD's floating-point guess), or the CPU
  buried in TrueNAS's sysDescr; logical core count from hrProcessorTable;
  and total RAM from hrMemorySize. Existing fleets backfill automatically:
  a few seconds after startup, devices missing identity get a lightweight
  fetch one at a time - no re-adding, no clicking Rediscover 27 times.
  Every rule traces to a real device string from the operator's fleet and
  walk archive, and every absence renders as N/A, never a guess.
- **Wide layout no longer stretches graphs.** The entity history page keeps
  the centered width even in wide mode - a chart carries a fixed point
  budget, so full-bleed width was a Mega Graph, not more data. Tables
  (device list, interface list) stay wide, where width means columns.

- **Wide layout, and four more pickable columns.** A `Wide layout` toggle in
  the Columns panel lets the table spend the whole window width - the
  centered layout stays the default (the homelab look is deliberate; a
  27-device fleet fills a 1080p pane exactly as before). New columns, all
  honest reductions over data already polled: **Vendor** (the matched
  profile key, full name on hover), **Temp** (a preference ladder, not a
  max: a CPU or system/board sensor represents the device even when an NVMe
  runs hotter; max is only the fallback, and the tooltip names the chosen
  sensor), **Fullest FS** (a pick, never a sum, so ZFS-style nested
  namespaces cannot double-count shared pool space), and **Memory** (used %
  as the agent reports it, with the caveat in the tooltip: many Linux
  agents count cache, where high is healthy - trust trends over the
  absolute number). All new columns start hidden; absence renders as N/A,
  never a guess.

- **Column picker on the device list, plus five new summary columns.** A
  `Columns` button on the Devices page chooses what the fleet table shows -
  a per-browser preference (like the sort), defaulting to exactly the
  historical layout. New pickable columns, all read-side over data already
  polled: **Down ports** (operationally down while administratively up -
  ports someone shut on purpose are not counted), **Errors/s** (worst
  tracked interface, in + out), **Health** (worst case over the device's
  binary status sensors - one alarm turns the cell red; devices exposing no
  sensors show N/A, never a fake ok), **UPS** (charge and estimated
  runtime), and **Location** (sysLocation). Every new column is honest
  about absence: blank or N/A means the device does not report it. The
  Top-usage percentage also now uses the EFFECTIVE speed from the
  speed-trust work, so an unrated virtio NIC shows raw bps with no
  fictional percentage in the fleet table too. Covered by
  `tools/check-columns.js` in `npm test`.

- **Speed trust: advertised interface speeds are claims, and fictional claims
  stop lying to you.** Virtual NICs (virtio, Hyper-V netvsc) advertise link
  speeds with no relationship to what their host-local datapath carries, which
  produced two defects with one root cause: utilization alerts at 133-153%
  during replication windows, and - worse, and invisible - the sanity clamp
  discarding any sample above 2x the fictional speed, so the FASTEST traffic
  never reached the graphs. Now a measured rate exceeding the advertised speed
  beyond timing jitter (>1.10x, 64-bit counters only - a 32-bit rate can
  itself be wrap garbage and cannot convict) marks the interface's speed
  **untrusted**, permanently and visibly (an `unrated` badge): utilization
  shows `-` instead of a fiction, the clamp falls back to an absolute physical
  ceiling so real bursts survive, and the export feed carries
  `speedBps: null` - which switches AlertCanvas's utilization rules off for
  that interface with no AlertCanvas change at all. A **per-interface speed
  override** (interface page - "Set actual speed") is the operator's honest
  number: it outranks both the claim and the verdict, restores utilization
  and its alerts, and is never second-guessed. "Trust advertised" hands the
  claim a fresh chance; the poller re-convicts if traffic disproves it again,
  and a *changed* advertised speed (a genuine renegotiation) also earns fresh
  trust automatically. Covered by `tools/check-speed-trust.js` in `npm test`.

- **Device-uptime metrics carry `sampledAt` as epoch seconds, like everything else
  in the feed.** Schema v4 moved every `sampledAt` from an ISO string to epoch
  seconds, but the device-uptime entry is built by hand rather than mapped from a
  sample row, and it was missed - so two entries in the same `metrics[]` array
  carried different types in one field. Nothing reads `sampledAt`, which is exactly
  how it survived the whole migration: a consumer that later started reading it
  would have got `NaN` from `sampledAt * 1000` on uptime rows alone, and found out
  months afterwards on one tile.

  `tools/check-export.js` could not have caught this, for two independent reasons
  worth recording. It asserted the type on `metrics[0]` only, and uptime rows are
  pushed after the mapped ones, so an index-0 check structurally cannot reach them.
  And the fixture exported no uptime metric, so there was nothing to reach in the
  first place. It now exports one and checks EVERY metric, requiring at least one
  real epoch value so the check cannot pass on a feed where nothing was ever
  stamped. Confirmed by planting the old behaviour back and watching it fail by
  name.

- **Bring your own theme, without a rebuild.** A `theme.json` in the data
  directory adds a thirtieth entry to the picker, above the twenty-nine shipped
  ones. Same fifteen `--se-*` variables, hex only, and partial files are fine -
  anything left out inherits Classic, so changing two colours takes a two-line
  file. Because the data directory is a bind mount, editing it is a browser
  refresh rather than a rebuild; delete the file and the entry goes away. Point
  several apps at one shared data directory and a single file themes all of them.

  The shipped themes were deliberately left alone: they are duplicated across
  six repos, the style guide and the demo, so every addition is drift - which is
  exactly why a user's palette should not join that set. `tools/export-theme.js`
  prints any shipped theme as a starting file so nobody has to learn the format
  from documentation.

  `tools/check-theme.js` validates a file before you restart anything, and calls
  the same loader the server calls, so it cannot accept what the app would
  reject. It also audits readability: text contrast against WCAG AA, plus hue
  separation and saturation on `--se-up`/`--se-down`/`--se-warn`, because a
  palette where healthy and failed do not separate at a glance is a different
  problem from one that is merely ugly. It reports and never refuses.

  The endpoint serving it is deliberately public. The login page is themed too,
  and gating this would leave the first page every user sees stuck on Classic
  while their palette waited behind a session. The loader rebuilds the theme
  from validated values rather than passing the file through, so unknown keys
  and non-hex values never reach a browser.

- **The container healthcheck no longer leaks zombies onto the host.** The
  image runs `node` as PID 1, and Node does not reap processes it did not
  spawn - so the HEALTHCHECK's `wget` left an `ssl_client` behind on every
  HTTPS probe and nothing collected it. One a minute, indefinitely. A zombie
  still holds a process slot against the `nproc` limit of the HOST uid the
  container runs as (1000), so after roughly a day that user could no longer
  fork: its SSH logins failed with "Server refused to start a shell/command"
  while root connected fine, and only a reboot cleared it. The symptom points
  nowhere near a monitoring app, which is why it went unexplained for a while.
  `docker-compose.yml` now sets `init: true`, putting tini at PID 1 to reap
  orphans. No image rebuild needed - `docker compose up -d` recreates the
  container with the init in place, and that also clears the existing zombies.

- **Passwords hash and verify off the event loop.** `crypto.scryptSync` in
  `server/auth.js` serialised concurrent logins into one unbroken stall (8 at
  once measured ~218ms in which nothing polls - the loop this froze is also
  the poll loop), while each single call sat under per-call blocking
  thresholds - the burst is the cost, so a blocking sweep cannot see it. Now
  the async `crypto.scrypt`, awaited in the setup, login and password-change
  handlers; the server waits for the `ADMIN_PASSWORD` seed before listening.
  The stored hash format is unchanged - `tools/check-auth.js` (new, in
  `npm test`) proves a hash minted by the old synchronous code still verifies.

- **Tests for the things that broke.** `npm test` now runs three checks that
  live in the repo instead of in somebody's scratch directory:
  `tools/check-export.js` asserts the snmp-status.json contract PingCanvas and
  AlertCanvas read (a change here breaks a different repo, silently - a kiosk
  whose annotations stop binding still draws a perfect board with no numbers on
  it); `tools/check-history.js` covers bucketing and the rollup;
  `tools/check-concurrency.js` proves a Settings change reaches the live poll
  loop and that `POLL_CONCURRENCY` still overrides it. `tools/mock-agent.js`
  gained `MOCK_EVIL=1`, which serves markup, a quote breakout and a spreadsheet
  formula as sysName/ifName/ifAlias - a mode on the existing agent rather than a
  second copy of it, since a divergent copy would stop testing the real thing.

- **Backup download no longer freezes the app.** `/api/backup` copied the
  database with a synchronous `VACUUM INTO`, which better-sqlite3 runs on the
  event loop: measured on a 400MB database that was **3.0 seconds during which
  nothing polled and no page was answered**, scaling at roughly 7.6s per GB. It
  now uses SQLite's incremental backup, which steps through the file a batch of
  pages at a time and yields between batches - worst single stall **0.4s**, and
  faster overall. Verified against a 250MB database being written to throughout:
  one clean pass, no restart, `integrity_check ok`. Only one backup runs at a
  time now, so two clicks cannot put two full copies of the database on the data
  volume at once.

- **History graphs were never server-side bucketed.** The bucketing expression
  `(ts / @b) * @b` is integer division only when `@b` is an integer, and
  better-sqlite3 binds every JavaScript number as SQLite REAL - a BigInt is the
  only way to bind an integer. Bound as a number the expression returned `ts`
  unchanged, every row landed in its own group, `GROUP BY` grouped nothing and
  the `maxPoints` limit did nothing at all. The endpoint had been returning one
  point per raw sample: **259,200 points and ~18 MB for a 90-day range instead
  of ~430 points and 30 KB**. It went unnoticed because the chart still drew
  correctly - just from 600x more data than it needed, with the whole query
  blocking the poll loop and every other user's page while it ran. Now bound as
  a BigInt, with `tools/check-history.js` to keep it honest.
- **90-day graphs no longer read 90 days of raw samples.** A new hourly rollup
  table (`samples_hourly`) summarises each completed hour, and any chart bucket
  of an hour or more is served from it - about 2,160 rows for a 90-day range in
  place of 259,200. The rollup runs every 10 minutes in chunks that yield the
  event loop, follows the same retention as the raw samples, and stores the
  sample count behind each row so re-bucketing uses a weighted mean (an hour
  short a few polls must not count the same as a full one). This is about
  RETENTION, not fleet size: 90 days at 30 seconds is a quarter-million rows
  per entity whether you watch five devices or five hundred, so a homelab
  Raspberry Pi hits it as surely as a large fleet does. Measured against the
  same request served from raw data: **~50x faster at 30 days, ~110x at 90**.
  Chart buckets past an hour snap to whole hours so the rolled-up answer is
  identical to the raw one rather than merely close.
- **95th-percentile lines removed from traffic graphs.** Two unindexed sorts of
  the whole range per chart, which on a Pi cost 750 ms of blocked event loop on
  a 90-day view. The lines were also the first thing to become unreadable on a
  busy graph. The underlying data is unchanged; nothing else used them.

- **Poll scheduler: freed slots refill immediately.** Polls were only ever
  started on the 5-second tick, which capped the loop at `POLL_CONCURRENCY`
  starts per tick - 48 polls/minute on defaults, however fast devices
  answered. Past roughly 24 devices at a 30s interval the loop could not keep
  up and silently stretched the effective interval rather than reporting it:
  samples kept flowing and graphs kept drawing, just coarser than configured.
  Measured on a synthetic 100-device fleet at the unchanged default
  concurrency of 4: **576 samples/min before, 2160 after** (full rate), with
  p95 time-since-poll falling from 142s to 28s at under 1% CPU. Fleets larger
  than ~24 devices were affected; no configuration change is needed to pick
  up the fix.
- **Poll concurrency is a Settings field, not just an environment variable.**
  The behind warning tells you to raise it; sending someone to edit a compose
  file and restart a container was a dead end for the small teams this is for.
  The field shows the live value and how many polls are in flight, and explains
  what a slot actually is. `POLL_CONCURRENCY` still **wins** where it is set -
  an explicit deployment decision should not be silently overridden from a web
  page - and the UI then goes read-only saying exactly that, and where to change
  it instead. Changes reach the running poll loop immediately.
- **The export now says whether the poll loop is keeping up.** `snmp-status.json`
  carries a `poller` block (`behind`, `overdueDevices`, `worstLateS`,
  `concurrency`). The log and Settings already warned, but both need someone to
  go and look - and the failure mode is precisely that nothing looks wrong.
  AlertCanvas raises a warning on it by default, so degraded monitoring reaches
  you through the same channel as a device going down. Additive, no schema bump.
- **Docs: capacity depends on how fast your agents answer, not just how many.**
  Every previously published figure was measured against agents replying in
  under a millisecond. Re-measured on one 100-device fleet varying only reply
  time: 9,180 samples/min instant, 7,400 at 300ms, **3,560 at 1000ms - a 61%
  fall while CPU never moved from ~45%**, because the loop waits rather than
  works. Raising `POLL_CONCURRENCY` to 64 restored full rate on the slow fleet
  at 64% of one core, so slow agents raise the concurrency you need rather than
  capping your capacity. Also measured: at equal entity count, fewer/denser
  devices cost ~40% less CPU per entity than many small ones, so a switch stack
  presenting as one agent is cheaper to poll than the same switches separately.
- **snmp-status.json schema v4**: `device` on each interface is now the device
  NAME rather than a `{name, host, status}` object (a 48-port switch serialised
  the same host and status 48 times, while `devices[]` has listed all three
  since v3); `id` is gone because it was exactly `device + ":" + name`; and
  `sampledAt` is epoch seconds instead of a 24-character ISO string. With
  minifying and rate rounding, a real 400-interface export went from **696 to
  361 bytes per interface - 48% smaller**. PingCanvas and AlertCanvas accept
  **either** schema, so suite apps can be upgraded in any order.
- **`snmp-status.json` is ~35% smaller.** It is written minified rather than
  pretty-printed - measured on a real export, **31% of the file was indentation
  and newlines**, paid for again on every poll in disk writes and in every
  consumer's parse. Nothing reads it by eye; `jq .` handles inspection. Rates
  are also rounded: throughput to whole bits per second (the extra ~16
  significant digits are arithmetic residue from dividing a counter delta),
  errors and discards to three decimals - deliberately *not* to whole numbers,
  because those are events per second and one error every twenty minutes is a
  real 0.0008/s that whole-number rounding would erase. No shape change, so
  consumers need no update. Measured on a live export: 278KB to 182KB.
- **`snmp-status.json` now marks stale interfaces.** When an `ifIndex` starts
  reporting a different `ifName` than the one recorded - a module swapped, a
  VLAN interface recreated, a chassis renumbered on reboot - the entity was
  already flagged stale in the UI, but the export said nothing. It kept
  shipping the **old** name with counters from whatever occupies that index
  **now**, and no consumer could tell: a wall tile or alert rule bound to
  `Gi0/1` reported a different port's traffic and looked healthy doing it.
  Affected entries now carry `"stale": true`. Additive and backward
  compatible - the field is **omitted when false** rather than emitted as
  `false`, because on a large fleet that would add hundreds of KB to a file
  rewritten in full every poll. Verified against a fleet with half its
  interfaces deliberately renamed: 198 stale in the database, 198 marked in
  the export, no false positives or negatives.
- **Docs: put `snmp-status.json` on a RAM disk.** Every write regenerates the
  whole file (coalesced to at most one per second), so bytes written scale with
  file size rather than with what changed. Measured on a 400-device /
  20,800-entity fleet with an 11MB export: **83-97% of everything the app wrote
  to disk**, several times the time-series database itself, or ~80GB/day - real
  wear on a Pi's SD card. The file is pure derived state and regenerates within
  seconds of a restart, so pointing `export_path` at tmpfs cut bytes reaching
  the card from 69MB/min to 14MB/min. README documents both the direct
  (`/dev/shm`) and Docker (named volume with `driver_opts: type: tmpfs`,
  **not** the per-container `tmpfs:` key) forms. A non-issue at homelab sizes -
  a 20-device board exports ~130KB.
- **Docs: the nightly prune, and why the database file never shrinks.** Freed
  pages are kept inside the file and reused, so lowering retention reclaims no
  disk on its own and the file stays at its high-water mark - measured, a
  648MB file holding 20MB of live data. That is normal rather than a leak, but
  nothing said so, and someone lowering retention specifically to free space
  would reasonably conclude the prune was broken. README now says it and
  documents the one-off `VACUUM` that does return the space.
- **Unreachable devices can no longer starve the ones that answer.** A device
  that responds holds a poll slot for ~50ms; one that does not holds it for a
  full timeout, ~10s - roughly 200x more - so about a dozen dark devices
  saturated the old default on their own, whatever the rest of the fleet was
  doing. At most half of `POLL_CONCURRENCY` is now given to devices already
  marked down. Measured on a Pi 3B+ with 400 devices, 40 dark, at the OLD
  concurrency of 4: **2592 samples/min before, ~7800 after**, with reachable
  devices back to an 18s median on a 30s interval.
- **`POLL_CONCURRENCY` default raised from 4 to 16.** A slot is one
  outstanding UDP request, not a worker - it spends its time waiting, so a
  larger cap is close to free and simply stops a backlog forming. Verified on
  a Pi 3B+: 400 devices at a true 30s interval, 68% of one core, no thermal
  throttling.
- **The poll loop now says when it is behind.** A saturated loop warns in the
  log (at most every 10 minutes, naming the current concurrency) and shows a
  warning on Settings, instead of quietly recording history at a longer
  interval than the one configured.
- **snmp-status.json schema v3**: a top-level `devices[]` roster
  `{ name, host, status }` lists every device with ANY exported value, so
  consumers (AlertCanvas device-down alerting) no longer depend on
  interface-embedded device blocks. `pollIntervalSec` rides at the top
  level for staleness math. `state`-kind metrics (binary alarms, e.g. UPS
  on-battery) carry a `status` field like cpu/battery do.
- **Device re-IP**: Edit accepts host/port in place - entity ids and codes
  survive, so boards and alerting keep working across an address change.
- **Bulk add "From file"**: pull addresses out of a CrossCanvas board
  (.xcanvas) or a CSV with an IP column.
- Suite integration: LaunchCanvas SSO token accept (opt-in via
  SUITE_SECRET), disabled devices leave the export, credential-edit UI.

## 1.0.0 - 2026-07-18

First public release.

- **Outlet kind + switched PDU support**: per-port On/Off cards (red when
  off), state-timeline graphs, and vendor entries for ZDL / PDU02IP 2-port
  power strips (both firmware generations - one matched by sysDescr since
  its agent garbles sysObjectID; the ZDL variant adds an internal
  temperature sensor). Outlet-state semantics were established empirically
  by toggling ports and diffing.
- **`extend` outputs tolerate banners**: the full output is read and the
  first numeric line wins, so tools like NUT's `upsc` (which prints an SSL
  notice ahead of the value) work without shell wrappers.

- **snmp-status.json schema v2**: a new `metrics[]` array publishes any
  exported non-interface sensor (CPU, memory, disk, temperature, fan,
  power, utilization) plus per-device uptime as
  `{ code, kind, host, display, value, unit, status?, sampledAt }` with
  short pre-formatted display strings. Only CPU carries an ok/warn/crit
  status; everything else is display-only. Every sensor now mints a short
  stable code (shown as chips in the Sensors dialog and on exported
  cards); Export checkboxes appear in the Sensors dialog and an uptime
  export toggle in the device Edit dialog. `interfaces[]` is unchanged, so
  v1 consumers keep working.

- **Custom sensors via snmpd `extend`** (NET-SNMP-EXTEND-MIB): name your
  extend directives `temp-*`, `fan-*`, `power-*`, or `util-*` and their
  numeric output becomes a tracked sensor with cards and history - the
  doorway for NVIDIA GPU telemetry (nvidia-smi), UPS stats, and anything
  else a shell one-liner can print. Adds `power` (watts) and `gauge`
  (percent) entity kinds.
- **Fan sensor support** (new `fan` entity kind): RPM cards - a tracked fan
  at 0 rpm paints its meter red - and history graphs. First source is the
  **ASRock Rack BMC sensor table** (AMI MegaRAC IPMI firmware), which also
  feeds temperatures; sensors reading "Not Available" (host powered off,
  unpopulated headers) are listed but untracked by default.
- **Battery and runtime kinds** for UPS monitoring via the `extend`
  convention (`batt-` = charge percent, `runtime-` = seconds remaining):
  battery cards alarm low (red at 20%), runtime displays humanize, and
  exported battery metrics carry a forward-safe ok/warn/crit status. NUT's
  `upsc` is the canonical source for USB UPSes.
- **Code chips are paste-ready `{code}` tokens** (the PingCanvas board
  syntax) and copy themselves to the clipboard on click - including in the
  interface table, where clicking a chip no longer navigates to the detail
  view.
- **All 29 CrossCanvas themes** now carry over, grouped as in its picker
  (Paper / Warm / Cool / Night / Screen); previously 21.
- Temperature and power metric displays carry their name prefix
  (`Temp 42C`, `Power 9.5W`) like every other kind, so bare `{code}`
  tokens self-label consistently.
- README: documents the `{code}` brace rule for PingCanvas boards, the
  cleartext nature of SNMPv1/v2c, the first-run setup-page claim window,
  and that unencrypted backups contain credentials.
- 95th-percentile chart labels no longer overlap when the in/out values
  nearly coincide.

## 0.1.0 - 2026-07-17

Initial release.

- **Polling**: SNMPv2c and v3 (SHA-2 auth; DES/AES-128/both AES-256 key-
  localization variants), single-process tick scheduler with concurrency
  caps, BigInt counter math with 32-bit wrap correction, reboot detection
  via sysUpTime, up/down after consecutive failures.
- **Discovery**: add-device wizard verifies credentials with a GET, then
  walks ifTable/ifXTable, HOST-RESOURCES (CPU / memory / filesystems),
  temperature sensors (LM-SENSORS-MIB, ENTITY-SENSOR-MIB, vendor health
  OIDs), and an extensible sysObjectID-keyed vendor map (Cisco CPU/memory/
  ENVMON, MikroTik health). No MIB files - numeric OIDs only. SNMPv1
  GetNext fallback for agents that ignore GetBulk. Curated noise defaults:
  loopbacks, container/hypervisor plumbing (veth/tap/fwbr), tmpfs and ZFS
  snapshot mounts, redundant per-core temps, and implausible sensor
  readings are listed but untracked.
- **Storage**: SQLite (WAL) with samples clustered for range scans, global
  polling interval and retention settings, nightly prune, streamed
  VACUUM INTO backups from the Settings page.
- **UI**: dependency-free vanilla HTML/CSS/JS in the CrossCanvas design
  language, 21 grouped themes. Sortable device list with CPU / top-
  interface columns; device pages with resource cards, interface filter,
  per-interface Track/Export toggles, sensor manager, and free-text
  notes; SVG history graphs with avg+max series, 95th-percentile lines,
  link-speed scaling, and a link-status strip.
- **Integration**: atomic `snmp-status.json` export of checked interfaces
  with stable short interface codes for external dashboards (PingCanvas).
- **Deployment**: single container (two runtime dependencies), automatic
  HTTPS when a cert pair exists (`tools/gen-cert.sh`), scrypt-hashed UI
  password with sessions, optional at-rest credential encryption,
  SELinux-friendly compose defaults, automatic schema migrations.
