# Changelog

## Unreleased (since 1.0.0)

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
