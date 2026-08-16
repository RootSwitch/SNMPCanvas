'use strict';
// SQLite via better-sqlite3: one connection shared by the web handlers and the
// poller (same process, synchronous library - no cross-connection contention).
// WAL keeps web reads unblocked during poller writes.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.SNMPCANVAS_DATA || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'snmpcanvas.db');
const db = new Database(DB_FILE);
// Owner-only. This file holds the devices it polls and their credentials, and it sits in a directory the suite
// deliberately leaves world-readable (the kiosk's web tier runs as a different
// uid and serves boards out of it), so the directory cannot protect it.
// Narrowed here rather than with a process-wide umask, which would also
// restrict the export files that web tier has to read. SQLite copies this mode
// onto the -wal and -shm files it creates alongside.
try { fs.chmodSync(DB_FILE, 0o600); } catch (_) { /* best effort - some mounts refuse chmod */ }
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id                   INTEGER PRIMARY KEY,
  name                 TEXT NOT NULL,
  host                 TEXT NOT NULL,
  port                 INTEGER NOT NULL DEFAULT 161,
  snmp_version         TEXT NOT NULL CHECK (snmp_version IN ('2c','3')),
  sys_descr            TEXT,
  sys_object_id        TEXT,
  sys_name             TEXT,
  vendor_key           TEXT,
  poll_interval_s      INTEGER,
  enabled              INTEGER NOT NULL DEFAULT 1,
  status               TEXT NOT NULL DEFAULT 'unknown',
  last_poll_ts         INTEGER,
  last_seen_ts         INTEGER,
  last_sysuptime_cs    INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_ts           INTEGER NOT NULL,
  -- Identity columns (Tier C): static facts collected at discovery /
  -- rediscover / the startup backfill, never per-poll. NULL = the device
  -- does not report it (rendered as N/A, never guessed).
  os_summary           TEXT,
  hw_model             TEXT,
  cpu_cores            INTEGER,
  ram_kb               INTEGER
);

CREATE TABLE IF NOT EXISTS credentials (
  device_id     INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  community     TEXT,
  v3_user       TEXT,
  v3_level      TEXT CHECK (v3_level IN ('noAuthNoPriv','authNoPriv','authPriv')),
  v3_auth_proto TEXT,
  v3_auth_key   TEXT,
  v3_priv_proto TEXT,
  v3_priv_key   TEXT,
  enc           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS entities (
  id           INTEGER PRIMARY KEY,
  device_id    INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('if','cpu','mem','fs','temp','fan','power','gauge','battery','runtime','outlet','meter','state')),
  snmp_index   TEXT NOT NULL,
  name         TEXT,
  alias        TEXT,
  speed_bps    INTEGER,
  -- Advertised speed is a CLAIM (virtio/netvsc advertise fiction).
  -- speed_untrusted flips when a measured rate exceeds the claim beyond
  -- timing jitter; speed_override_bps is the operator's honest number and
  -- outranks both. See poller.js speed-trust block.
  speed_untrusted    INTEGER NOT NULL DEFAULT 0,
  speed_override_bps INTEGER,
  extra        TEXT,
  tracked      INTEGER NOT NULL DEFAULT 1,
  export       INTEGER NOT NULL DEFAULT 0,
  admin_status INTEGER,
  oper_status  INTEGER,
  stale        INTEGER NOT NULL DEFAULT 0,
  poll_state   TEXT,
  code         TEXT,
  UNIQUE (device_id, kind, snmp_index)
);
CREATE INDEX IF NOT EXISTS idx_entities_export ON entities(export) WHERE export = 1;

-- One row per tracked entity per successful poll. Column meaning by kind:
--   if : v0 in_bps, v1 out_bps, v2 in_err/s, v3 out_err/s, v4 in_disc/s, v5 out_disc/s; status = ifOperStatus
--   cpu: v0 load pct
--   mem/fs: v0 used bytes, v1 total bytes
CREATE TABLE IF NOT EXISTS samples (
  entity_id INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  status    INTEGER,
  v0 REAL, v1 REAL, v2 REAL, v3 REAL, v4 REAL, v5 REAL,
  PRIMARY KEY (entity_id, ts)
) WITHOUT ROWID;

-- Hourly rollup of the samples table, so a long history chart need not read
-- every raw row to draw 500 points.
--
-- What this solves is not fleet size, it is RETENTION: 90 days at a 30s
-- interval is ~259,200 rows PER ENTITY whether you watch five devices or five
-- hundred. Aggregating that range measured 14 seconds on a Raspberry Pi - and
-- better-sqlite3 is synchronous, so those were 14 seconds in which nothing
-- polled and the UI was frozen for everyone. An hour of 30s samples is 120
-- rows collapsing to one, so a 90-day chart reads ~2,160 rows instead.
--
-- The n column is the sample count behind each row, and it is not decoration:
-- re-bucketing hours into (say) 4-hour chart buckets needs a WEIGHTED mean,
-- sum(a0*n)/sum(n). Averaging the averages would mis-weight any hour that was
-- short a few polls - exactly the hours when the poller was struggling and the
-- chart matters most.
CREATE TABLE IF NOT EXISTS samples_hourly (
  entity_id INTEGER NOT NULL,
  hour_ts   INTEGER NOT NULL,
  n         INTEGER NOT NULL,
  a0 REAL, a1 REAL, a2 REAL, a3 REAL, a4 REAL, a5 REAL,
  m0 REAL, m1 REAL,
  st INTEGER,
  PRIMARY KEY (entity_id, hour_ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_ts INTEGER NOT NULL,
  expires_ts INTEGER NOT NULL
);
`);

// --- short codes (interfaces, sensors, device uptime) ---
// A compact, human-typeable key for external consumers (snmp-status.json /
// PingCanvas): derived from md5("deviceName:entityName") so a re-added
// device regenerates the same codes, persisted so nothing that happens
// later (un-export, rediscover, rename) can change one, and collision-
// checked at mint time (the newcomer gets a longer form). Codes never
// contain ':' so they can't collide with "Device:Interface" id strings.
// Alphabet drops 0/O and 1/I lookalikes.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function codeCandidates(deviceName, ifName) {
    const digest = crypto.createHash('md5').update(`${deviceName}:${ifName}`).digest('hex');
    let n = BigInt('0x' + digest);
    let b32 = '';
    while (n > 0n) { b32 = CODE_ALPHABET[Number(n % 32n)] + b32; n /= 32n; }
    const out = [];
    for (let len = 4; len <= b32.length; len++) {
        for (let start = 0; start + len <= b32.length && start < 8; start++) out.push(b32.slice(start, start + len));
    }
    return out;
}

function codeIsTaken(c) {
    return db.prepare('SELECT 1 FROM entities WHERE code = ?').get(c) ||
           db.prepare('SELECT 1 FROM devices WHERE uptime_code = ?').get(c);
}

// A code is an opaque ID, but it ends up on screen (docs, screenshots, the
// {code} chip) and saved as plain text in the .xcanvas / DB - so skip the few
// candidate windows that would spell something unfortunate. The alphabet drops
// I and O (rules out a lot) but keeps A/E/U, so real words are reachable
// (FUCK, CUNT, FART...). This is a short curated list, NOT a profanity engine -
// substring match, uppercase like the alphabet; extend as needed. A hit just
// advances to the next hash window, exactly like a collision, so codes stay
// deterministic (a given name still maps to one stable code) and this can never
// exhaust the candidate list.
const CODE_DENY = ['FUCK', 'FUK', 'FCK', 'CUNT', 'CNT', 'SHT', 'ASS', 'AZZ', 'ARSE', 'FART', 'CUM', 'FAG', 'RETARD'];
function codeIsUnfortunate(c) {
    for (const bad of CODE_DENY) { if (c.indexOf(bad) !== -1) return true; }
    return false;
}

function generateIfCode(deviceName, entityName, taken) {
    for (const c of codeCandidates(deviceName, entityName)) {
        const free = taken ? !taken.has(c) : !codeIsTaken(c);
        if (free && !codeIsUnfortunate(c)) return c;
    }
    return crypto.randomBytes(4).toString('hex').toUpperCase(); // unreachable in practice
}

// --- lightweight migrations for databases created by earlier versions ---
const deviceCols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
if (!deviceCols.includes('notes')) db.exec('ALTER TABLE devices ADD COLUMN notes TEXT');
if (!deviceCols.includes('export_uptime')) db.exec('ALTER TABLE devices ADD COLUMN export_uptime INTEGER NOT NULL DEFAULT 0');
if (!deviceCols.includes('uptime_code')) db.exec('ALTER TABLE devices ADD COLUMN uptime_code TEXT');
if (!deviceCols.includes('sys_location')) db.exec('ALTER TABLE devices ADD COLUMN sys_location TEXT');
if (!deviceCols.includes('os_summary')) db.exec('ALTER TABLE devices ADD COLUMN os_summary TEXT');
if (!deviceCols.includes('hw_model')) db.exec('ALTER TABLE devices ADD COLUMN hw_model TEXT');
if (!deviceCols.includes('cpu_cores')) db.exec('ALTER TABLE devices ADD COLUMN cpu_cores INTEGER');
if (!deviceCols.includes('ram_kb')) db.exec('ALTER TABLE devices ADD COLUMN ram_kb INTEGER');
// Why a poll failed, not just that it did. "down" covered two situations an
// operator has to tell apart and could not: the host is unreachable, versus
// the host answers fine and the METRIC poll dies (a stale entity list after a
// reboot renumbered the agent's instances). The first needs the network
// looked at, the second needs a Rediscover - and the log had the answer all
// along while the page said only "down".
if (!deviceCols.includes('last_error')) db.exec('ALTER TABLE devices ADD COLUMN last_error TEXT');
if (!deviceCols.includes('last_error_ts')) db.exec('ALTER TABLE devices ADD COLUMN last_error_ts INTEGER');
if (!deviceCols.includes('last_error_phase')) db.exec('ALTER TABLE devices ADD COLUMN last_error_phase TEXT');

const entityCols = db.prepare('PRAGMA table_info(entities)').all().map((c) => c.name);
if (!entityCols.includes('code')) db.exec('ALTER TABLE entities ADD COLUMN code TEXT');

// The kind CHECK constraint has grown over time ('temp', 'fan', 'outlet',
// now 'meter', then 'state'); SQLite can't alter a CHECK, so databases created before the
// newest kind get a one-time table rebuild (ids preserved - samples reference
// them). The trigger tracks the most recently added kind.
const entitySql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entities'").get().sql;
if (!entitySql.includes("'state'")) {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
        db.exec(`
            CREATE TABLE entities_migrate (
              id           INTEGER PRIMARY KEY,
              device_id    INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
              kind         TEXT NOT NULL CHECK (kind IN ('if','cpu','mem','fs','temp','fan','power','gauge','battery','runtime','outlet','meter','state')),
              snmp_index   TEXT NOT NULL,
              name         TEXT,
              alias        TEXT,
              speed_bps    INTEGER,
              speed_untrusted    INTEGER NOT NULL DEFAULT 0,
              speed_override_bps INTEGER,
              extra        TEXT,
              tracked      INTEGER NOT NULL DEFAULT 1,
              export       INTEGER NOT NULL DEFAULT 0,
              admin_status INTEGER,
              oper_status  INTEGER,
              stale        INTEGER NOT NULL DEFAULT 0,
              poll_state   TEXT,
              code         TEXT,
              UNIQUE (device_id, kind, snmp_index)
            );
            INSERT INTO entities_migrate (id, device_id, kind, snmp_index, name, alias, speed_bps, extra,
                                          tracked, export, admin_status, oper_status, stale, poll_state, code)
              SELECT id, device_id, kind, snmp_index, name, alias, speed_bps, extra,
                     tracked, export, admin_status, oper_status, stale, poll_state, code FROM entities;
            -- new columns default-fill; the ALTER guards below cover DBs
            -- that skip this rebuild
            DROP TABLE entities;
            ALTER TABLE entities_migrate RENAME TO entities;
        `);
    })();
    db.pragma('foreign_keys = ON');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_entities_export ON entities(export) WHERE export = 1');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_code ON entities(code) WHERE code IS NOT NULL');

// Speed-trust columns (added after the rebuild block on purpose: a database
// that just went through the kind rebuild re-reads its columns here).
{
    const cols = db.prepare('PRAGMA table_info(entities)').all().map((c) => c.name);
    if (!cols.includes('speed_untrusted')) db.exec('ALTER TABLE entities ADD COLUMN speed_untrusted INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('speed_override_bps')) db.exec('ALTER TABLE entities ADD COLUMN speed_override_bps INTEGER');
}

// Backfill codes for entities (any kind) and device uptime codes created
// before those columns existed.
{
    const taken = new Set([
        ...db.prepare('SELECT code FROM entities WHERE code IS NOT NULL').all().map((r) => r.code),
        ...db.prepare('SELECT uptime_code FROM devices WHERE uptime_code IS NOT NULL').all().map((r) => r.uptime_code)
    ]);
    const missing = db.prepare(`SELECT e.id, e.name AS entity_name, d.name AS device_name
                                FROM entities e JOIN devices d ON d.id = e.device_id
                                WHERE e.code IS NULL ORDER BY e.id`).all();
    const missingUptime = db.prepare('SELECT id, name FROM devices WHERE uptime_code IS NULL ORDER BY id').all();
    if (missing.length > 0 || missingUptime.length > 0) {
        const updE = db.prepare('UPDATE entities SET code = ? WHERE id = ?');
        const updD = db.prepare('UPDATE devices SET uptime_code = ? WHERE id = ?');
        db.transaction(() => {
            for (const m of missing) {
                const code = generateIfCode(m.device_name, m.entity_name, taken);
                taken.add(code);
                updE.run(code, m.id);
            }
            for (const m of missingUptime) {
                const code = generateIfCode(m.name, 'uptime', taken);
                taken.add(code);
                updD.run(code, m.id);
            }
        })();
    }
}

// --- settings ---
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

const DEFAULTS = {
    poll_interval_s: '30',
    poll_concurrency: '16',
    retention_days: '90',
    // Env overrides are deploy-time defaults, not owners: a value saved in
    // Settings wins. The suite's setup script uses SNMPCANVAS_EXPORT to move
    // the full feed into the unserved .private directory; the wall variant
    // (codes + values, no device names/hosts) defaults to a sibling of the
    // data dir so a served copy exists on every layout. 'off' disables it.
    export_path: process.env.SNMPCANVAS_EXPORT || path.join(DATA_DIR, 'snmp-status.json'),
    export_wall_path: process.env.SNMPCANVAS_WALL_EXPORT || path.join(DATA_DIR, 'snmp-status.wall.json')
};

function getSetting(key) {
    const row = getSettingStmt.get(key);
    return row ? row.value : (DEFAULTS[key] !== undefined ? String(DEFAULTS[key]) : null);
}
function setSetting(key, value) { setSettingStmt.run(key, String(value)); }

// --- SNMP credential encryption at rest (optional, SNMPCANVAS_SECRET) ---
// Credentials must be recoverable (they're sent on every poll), so this is
// encryption, not hashing. Without the secret they're stored as-is and the
// protection is filesystem permissions on the data volume.
const SECRET = process.env.SNMPCANVAS_SECRET || null;
const encKey = SECRET ? crypto.scryptSync(SECRET, 'snmpcanvas-cred-v1', 32) : null;

function encryptValue(plain) {
    if (!encKey || plain === null || plain === undefined) return plain;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
function decryptValue(stored) {
    if (!encKey || stored === null || stored === undefined) return stored;
    const [iv, tag, ct] = String(stored).split(':').map((s) => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

const SECRET_FIELDS = ['community', 'v3_auth_key', 'v3_priv_key'];

function saveCredentials(deviceId, creds) {
    const row = {
        community: creds.community ?? null,
        v3_user: creds.v3_user ?? null,
        v3_level: creds.v3_level ?? null,
        v3_auth_proto: creds.v3_auth_proto ?? null,
        v3_auth_key: creds.v3_auth_key ?? null,
        v3_priv_proto: creds.v3_priv_proto ?? null,
        v3_priv_key: creds.v3_priv_key ?? null
    };
    for (const f of SECRET_FIELDS) row[f] = encryptValue(row[f]);
    db.prepare(`
        INSERT INTO credentials (device_id, community, v3_user, v3_level, v3_auth_proto, v3_auth_key, v3_priv_proto, v3_priv_key, enc)
        VALUES (@device_id, @community, @v3_user, @v3_level, @v3_auth_proto, @v3_auth_key, @v3_priv_proto, @v3_priv_key, @enc)
        ON CONFLICT(device_id) DO UPDATE SET
          community=excluded.community, v3_user=excluded.v3_user, v3_level=excluded.v3_level,
          v3_auth_proto=excluded.v3_auth_proto, v3_auth_key=excluded.v3_auth_key,
          v3_priv_proto=excluded.v3_priv_proto, v3_priv_key=excluded.v3_priv_key, enc=excluded.enc
    `).run({ device_id: deviceId, ...row, enc: encKey ? 1 : 0 });
}

function loadCredentials(deviceId) {
    const row = db.prepare('SELECT * FROM credentials WHERE device_id = ?').get(deviceId);
    if (!row) return null;
    if (row.enc) {
        for (const f of SECRET_FIELDS) row[f] = decryptValue(row[f]);
    }
    return row;
}

module.exports = { db, DATA_DIR, DB_FILE, getSetting, setSetting, saveCredentials, loadCredentials, generateIfCode };
