# Changelog

## Unreleased (since 1.0.0)

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
