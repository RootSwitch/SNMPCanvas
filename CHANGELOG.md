# Changelog

## 0.2.0 (unreleased)

- **snmp-status.json schema v2**: a new `metrics[]` array publishes any
  exported non-interface sensor (CPU, memory, disk, temperature, fan,
  power, utilization) plus per-device uptime as
  `{ code, kind, host, display, value, unit, status?, sampledAt }` with
  short value-only display strings ("45%", "62C", "600rpm" - board
  authors write their own labels). Only CPU carries an ok/warn/crit
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
- 95th-percentile chart labels no longer overlap when the in/out values
  nearly coincide.

## 0.1.0 — 2026-07-17

Initial release.

- **Polling**: SNMPv2c and v3 (SHA-2 auth; DES/AES-128/both AES-256 key-
  localization variants), single-process tick scheduler with concurrency
  caps, BigInt counter math with 32-bit wrap correction, reboot detection
  via sysUpTime, up/down after consecutive failures.
- **Discovery**: add-device wizard verifies credentials with a GET, then
  walks ifTable/ifXTable, HOST-RESOURCES (CPU / memory / filesystems),
  temperature sensors (LM-SENSORS-MIB, ENTITY-SENSOR-MIB, vendor health
  OIDs), and an extensible sysObjectID-keyed vendor map (Cisco CPU/memory/
  ENVMON, MikroTik health). No MIB files — numeric OIDs only. SNMPv1
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
