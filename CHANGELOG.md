# Changelog

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
