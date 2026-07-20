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

const db = new Database(path.join(DATA_DIR, 'snmpcanvas.db'));
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
  created_ts           INTEGER NOT NULL
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
  kind         TEXT NOT NULL CHECK (kind IN ('if','cpu','mem','fs','temp','fan','power','gauge','battery','runtime','outlet')),
  snmp_index   TEXT NOT NULL,
  name         TEXT,
  alias        TEXT,
  speed_bps    INTEGER,
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

function generateIfCode(deviceName, entityName, taken) {
    for (const c of codeCandidates(deviceName, entityName)) {
        if (taken ? !taken.has(c) : !codeIsTaken(c)) return c;
    }
    return crypto.randomBytes(4).toString('hex').toUpperCase(); // unreachable in practice
}

// --- lightweight migrations for databases created by earlier versions ---
const deviceCols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
if (!deviceCols.includes('notes')) db.exec('ALTER TABLE devices ADD COLUMN notes TEXT');
if (!deviceCols.includes('export_uptime')) db.exec('ALTER TABLE devices ADD COLUMN export_uptime INTEGER NOT NULL DEFAULT 0');
if (!deviceCols.includes('uptime_code')) db.exec('ALTER TABLE devices ADD COLUMN uptime_code TEXT');
if (!deviceCols.includes('sys_location')) db.exec('ALTER TABLE devices ADD COLUMN sys_location TEXT');

const entityCols = db.prepare('PRAGMA table_info(entities)').all().map((c) => c.name);
if (!entityCols.includes('code')) db.exec('ALTER TABLE entities ADD COLUMN code TEXT');

// The kind CHECK constraint has grown over time ('temp', then 'fan');
// SQLite can't alter a CHECK, so databases created before the newest kind
// get a one-time table rebuild (ids preserved - samples reference them).
const entitySql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entities'").get().sql;
if (!entitySql.includes("'outlet'")) {
    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
        db.exec(`
            CREATE TABLE entities_migrate (
              id           INTEGER PRIMARY KEY,
              device_id    INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
              kind         TEXT NOT NULL CHECK (kind IN ('if','cpu','mem','fs','temp','fan','power','gauge','battery','runtime','outlet')),
              snmp_index   TEXT NOT NULL,
              name         TEXT,
              alias        TEXT,
              speed_bps    INTEGER,
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
            DROP TABLE entities;
            ALTER TABLE entities_migrate RENAME TO entities;
        `);
    })();
    db.pragma('foreign_keys = ON');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_entities_export ON entities(export) WHERE export = 1');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_code ON entities(code) WHERE code IS NOT NULL');

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
    retention_days: '90',
    export_path: path.join(DATA_DIR, 'snmp-status.json')
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

module.exports = { db, DATA_DIR, getSetting, setSetting, saveCredentials, loadCredentials, generateIfCode };
