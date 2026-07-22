'use strict';
// The polling engine: a single 5-second tick loop scans for due devices and
// polls them with a concurrency cap. Counter math is BigInt end to end;
// rates are stored, not raw counters, so graphs are a straight read.

const S = require('./snmp');
const O = require('./oids');
const { db, getSetting, loadCredentials } = require('./db');
const auth = require('./auth');
const exporter = require('./exporter');

const TICK_MS = 5000;
const CONCURRENCY = Math.max(1, parseInt(process.env.POLL_CONCURRENCY || '4', 10) || 4);
const DEVICE_WALL_CLOCK_MS = 60 * 1000;   // hard cap per device poll
const DOWN_AFTER_FAILURES = 2;            // one missed poll is not "down"
const META_REFRESH_EVERY = 12;            // ifName/ifAlias/ifHighSpeed refresh cadence
const WRAP32 = 2n ** 32n;

const inFlight = new Set();      // device ids
const nextDue = new Map();       // device id -> ms epoch
const pollSeq = new Map();       // device id -> counter (meta refresh cadence)
let timer = null;

const log = (...args) => console.log(new Date().toISOString(), '[poller]', ...args);

function intervalMs(device) {
    const s = device.poll_interval_s || parseInt(getSetting('poll_interval_s'), 10) || 300;
    return Math.max(30, s) * 1000;
}

function scheduleNext(device, fromNow = intervalMs(device)) {
    nextDue.set(device.id, Date.now() + fromNow);
}

// On boot, stagger devices across 0-30s so a restart doesn't fire everything
// at once at every interval boundary thereafter.
function primeSchedule() {
    const devices = db.prepare('SELECT * FROM devices WHERE enabled = 1').all();
    for (const d of devices) {
        const due = d.last_poll_ts ? d.last_poll_ts * 1000 + intervalMs(d) : 0;
        nextDue.set(d.id, Math.max(Date.now() + Math.floor(Math.random() * 30000), Math.min(due, Date.now() + intervalMs(d))));
    }
}

function start() {
    primeSchedule();
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
    log(`started (tick ${TICK_MS / 1000}s, concurrency ${CONCURRENCY})`);
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

// Called by the API when a device is added/enabled/interval-changed.
function deviceChanged(deviceId, pollSoon = false) {
    const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
    if (!d || !d.enabled) { nextDue.delete(deviceId); return; }
    nextDue.set(deviceId, pollSoon ? Date.now() : Date.now() + intervalMs(d));
}
function deviceRemoved(deviceId) {
    nextDue.delete(deviceId);
    pollSeq.delete(deviceId);
}

function tick() {
    try {
        maybePrune();
        if (inFlight.size >= CONCURRENCY) return;
        const now = Date.now();
        const due = db.prepare('SELECT * FROM devices WHERE enabled = 1').all()
            .filter((d) => !inFlight.has(d.id) && (nextDue.get(d.id) ?? 0) <= now)
            .sort((a, b) => (nextDue.get(a.id) ?? 0) - (nextDue.get(b.id) ?? 0));
        for (const device of due) {
            if (inFlight.size >= CONCURRENCY) break;
            inFlight.add(device.id);
            scheduleNext(device); // schedule next poll now; overruns skip, never queue twice
            pollDevice(device)
                .catch((err) => log(`device ${device.id} (${device.host}) poll crashed:`, err.message))
                .finally(() => inFlight.delete(device.id));
        }
    } catch (err) {
        log('tick error:', err.message);
    }
}

async function pollDevice(device) {
    const started = Date.now();
    const nowS = Math.floor(started / 1000);
    const creds = loadCredentials(device.id);
    if (!creds) return;
    const target = { host: device.host, port: device.port, version: device.snmp_version, creds };
    const session = S.createSession(target);
    const deadline = setTimeout(() => S.closeQuietly(session), DEVICE_WALL_CLOCK_MS);

    try {
        // 1. Liveness + reboot detection.
        let sys;
        try {
            sys = await S.get(session, [O.SYS.sysUpTime, O.SYS.sysName]);
        } catch (err) {
            recordFailure(device, nowS, err);
            return;
        }
        const uptimeCs = Number(sys.get(O.SYS.sysUpTime) ?? 0);
        const elapsedCs = device.last_poll_ts ? (nowS - device.last_poll_ts) * 100 : 0;
        // A drop in sysUpTime means reboot - unless the counter legitimately
        // wrapped its 32-bit TimeTicks (~497 days).
        const rebooted = device.last_sysuptime_cs != null &&
            uptimeCs < device.last_sysuptime_cs &&
            (device.last_sysuptime_cs + elapsedCs) < 2 ** 32;

        // 2. Gather tracked entities and build the exact-instance GET list.
        const entities = db.prepare("SELECT * FROM entities WHERE device_id = ? AND tracked = 1").all(device.id);
        const seq = (pollSeq.get(device.id) ?? 0) + 1;
        pollSeq.set(device.id, seq);
        const refreshMeta = seq % META_REFRESH_EVERY === 1;

        const oidList = [];
        const jobs = []; // { entity, extra, oids: {key: oid} }
        for (const e of entities) {
            const extra = e.extra ? JSON.parse(e.extra) : {};
            const oids = {};
            if (e.kind === 'if') {
                const i = e.snmp_index;
                if (extra.hc) {
                    oids.inOct = `${O.IFX.ifHCInOctets}.${i}`;
                    oids.outOct = `${O.IFX.ifHCOutOctets}.${i}`;
                } else {
                    oids.inOct = `${O.IF.ifInOctets}.${i}`;
                    oids.outOct = `${O.IF.ifOutOctets}.${i}`;
                }
                oids.inErr = `${O.IF.ifInErrors}.${i}`;
                oids.outErr = `${O.IF.ifOutErrors}.${i}`;
                oids.inDisc = `${O.IF.ifInDiscards}.${i}`;
                oids.outDisc = `${O.IF.ifOutDiscards}.${i}`;
                oids.oper = `${O.IF.ifOperStatus}.${i}`;
                oids.admin = `${O.IF.ifAdminStatus}.${i}`;
                if (refreshMeta) {
                    oids.name = `${O.IFX.ifName}.${i}`;
                    oids.alias = `${O.IFX.ifAlias}.${i}`;
                    oids.highSpeed = `${O.IFX.ifHighSpeed}.${i}`;
                }
            } else if (e.kind === 'cpu') {
                (extra.oids || []).forEach((oid, n) => { oids[`load${n}`] = oid; });
            } else if (['temp', 'fan', 'power', 'gauge', 'battery', 'runtime', 'outlet', 'meter', 'state'].includes(e.kind)) {
                oids.value = extra.valueOid;
            } else if (extra.style === 'used-free') {
                oids.used = extra.usedOid;
                oids.free = extra.freeOid;
            } else if (extra.style === 'hr-storage') {
                oids.used = extra.usedOid;
                oids.size = extra.sizeOid;
            }
            jobs.push({ entity: e, extra, oids });
            oidList.push(...Object.values(oids));
        }

        let values = new Map();
        if (oidList.length > 0) {
            try {
                values = await S.getMany(session, oidList);
            } catch (err) {
                recordFailure(device, nowS, err);
                return;
            }
        }

        // 3. Compute samples.
        const rows = [];      // { entityId, status, v: [v0..v5] }
        const updates = [];   // entity denorm updates
        for (const job of jobs) {
            const e = job.entity;
            const prev = e.poll_state ? JSON.parse(e.poll_state) : null;
            const v = [null, null, null, null, null, null];
            let status = null;

            if (e.kind === 'if') {
                status = numOrNull(values.get(job.oids.oper));
                const admin = numOrNull(values.get(job.oids.admin));
                const counters = {};
                for (const key of ['inOct', 'outOct', 'inErr', 'outErr', 'inDisc', 'outDisc']) {
                    const raw = values.get(job.oids[key]);
                    counters[key] = raw == null ? null : BigInt(raw).toString();
                }
                if (prev && prev.c && !rebooted) {
                    const elapsed = (started - prev.ts) / 1000;
                    if (elapsed > 0) {
                        const is64 = !!job.extra.hc;
                        v[0] = rate(counters.inOct, prev.c.inOct, elapsed, is64, 8);
                        v[1] = rate(counters.outOct, prev.c.outOct, elapsed, is64, 8);
                        v[2] = rate(counters.inErr, prev.c.inErr, elapsed, false, 1);
                        v[3] = rate(counters.outErr, prev.c.outErr, elapsed, false, 1);
                        v[4] = rate(counters.inDisc, prev.c.inDisc, elapsed, false, 1);
                        v[5] = rate(counters.outDisc, prev.c.outDisc, elapsed, false, 1);
                        // Sanity clamp: an undetected reset / double 32-bit wrap
                        // shows up as an impossible rate. Store the gap instead.
                        if (e.speed_bps > 0) {
                            if (v[0] != null && v[0] > e.speed_bps * 2) v[0] = null;
                            if (v[1] != null && v[1] > e.speed_bps * 2) v[1] = null;
                        }
                    }
                }
                const update = { id: e.id, oper_status: status, admin_status: admin, poll_state: JSON.stringify({ ts: started, c: counters }) };
                if (refreshMeta) {
                    const newName = values.get(job.oids.name);
                    const newAlias = values.get(job.oids.alias);
                    const highSpeed = numOrNull(values.get(job.oids.highSpeed));
                    // A different string at this ifIndex usually means the
                    // device renumbered after reboot - flag, don't guess.
                    update.stale = (newName != null && e.name && String(newName) !== e.name) ? 1 : 0;
                    if (newAlias != null) update.alias = String(newAlias);
                    if (highSpeed > 0) update.speed_bps = highSpeed * 1e6;
                }
                updates.push(update);
            } else if (e.kind === 'cpu') {
                const loads = Object.keys(job.oids).map((k) => numOrNull(values.get(job.oids[k]))).filter((x) => x != null);
                if (loads.length > 0) v[0] = loads.reduce((a, b) => a + b, 0) / loads.length;
                updates.push({ id: e.id, poll_state: null });
            } else if (e.kind === 'temp') {
                v[0] = tempToC(job.extra, sensorRaw(job.extra, values.get(job.oids.value)));
                updates.push({ id: e.id, poll_state: null });
            } else if (e.kind === 'fan') {
                const rpm = scalarVal(job.extra, values.get(job.oids.value));
                v[0] = (rpm != null && rpm >= 0 && rpm < 60000) ? rpm : null;
                updates.push({ id: e.id, poll_state: null });
            } else if (e.kind === 'power') {
                const w = scalarVal(job.extra, values.get(job.oids.value));
                v[0] = (w != null && w >= 0 && w < 1e6) ? w : null;
                updates.push({ id: e.id, poll_state: null });
            } else if (e.kind === 'gauge' || e.kind === 'battery') {
                const pct = scalarVal(job.extra, values.get(job.oids.value));
                v[0] = (pct != null && pct >= 0 && pct <= 100) ? pct : null;
                updates.push({ id: e.id, poll_state: null });
            } else if (e.kind === 'runtime') {
                const sec = scalarVal(job.extra, values.get(job.oids.value));
                v[0] = (sec != null && sec >= 0 && sec < 1e7) ? sec : null;
                updates.push({ id: e.id, poll_state: null });
            } else if (e.kind === 'meter') {
                const x = scalarVal(job.extra, values.get(job.oids.value));
                v[0] = (x != null && x >= 0 && x < 1e6) ? x : null;
                updates.push({ id: e.id, poll_state: null });
            } else if (e.kind === 'outlet') {
                const st = numOrNull(values.get(job.oids.value));
                v[0] = st == null ? null : (st ? 1 : 0);
                status = v[0] == null ? null : (v[0] ? 1 : 2);   // reuse up/down badge semantics
                updates.push({ id: e.id, oper_status: status, poll_state: null });
            } else if (e.kind === 'state') {
                // Enum -> 0 (ok) / 1 (alarm) / null (unknown) via the value
                // sets discovery stored; alarm shows the down badge.
                const raw = numOrNull(values.get(job.oids.value));
                const unknown = job.extra.unknownValues || [];
                if (raw == null || unknown.includes(raw)) { v[0] = null; }
                else { v[0] = (job.extra.okValues || []).includes(raw) ? 0 : 1; }
                status = v[0] == null ? null : (v[0] ? 2 : 1);
                updates.push({ id: e.id, oper_status: status, poll_state: null });
            } else if (job.extra.style === 'used-free') {
                const used = numOrNull(values.get(job.oids.used));
                const free = numOrNull(values.get(job.oids.free));
                if (used != null) { v[0] = used; v[1] = free != null ? used + free : null; }
                updates.push({ id: e.id, poll_state: null });
            } else if (job.extra.style === 'hr-storage') {
                const alloc = job.extra.allocUnits || 1;
                const used = numOrNull(values.get(job.oids.used));
                const size = numOrNull(values.get(job.oids.size));
                if (used != null) v[0] = used * alloc;
                if (size != null) v[1] = size * alloc;
                updates.push({ id: e.id, poll_state: null });
            }
            rows.push({ entityId: e.id, status, v });
        }

        // 4. Persist everything in one transaction.
        persistPoll(device, nowS, uptimeCs, rows, updates);
        if (rebooted) log(`device ${device.id} (${device.host}) rebooted - counter deltas discarded this cycle`);

        // 5. Refresh the export file if any exported interface lives here.
        exporter.scheduleWrite();
    } finally {
        clearTimeout(deadline);
        S.closeQuietly(session);
    }
}

function numOrNull(x) {
    if (x == null) return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
}

// BMC-style sensors return formatted strings ("600.00rpm", "32.00&deg;C",
// "Not Available"); numeric styles pass through as numbers.
function sensorRaw(extra, value) {
    if (value == null) return null;
    if (extra.style === 'extend') {
        // Multiline output: first numeric line wins (tools like upsc print
        // banners before the number).
        for (const line of String(value).split(/\r?\n/)) {
            const n = parseFloat(line);
            if (Number.isFinite(n)) return n;
        }
        return null;
    }
    if (extra.style === 'asrock-str') {
        const n = parseFloat(String(value));
        return Number.isFinite(n) ? n : null;   // "Not Available" -> null
    }
    return numOrNull(value);
}

// Numeric scalar reading with the entity's divisor applied - vendor scalars
// reported in tenths, or a runtime in TimeTicks (hundredths of a second).
// Temperature has its own scale path (tempToC) and must not go through this.
function scalarVal(extra, value) {
    const n = sensorRaw(extra, value);
    return n == null ? null : n / (extra.div || 1);
}

// Raw sensor reading -> °C by source style; implausible values (unconnected
// headers, wrapped negatives) become gaps instead of ruining the graph.
function tempToC(extra, raw) {
    if (raw == null) return null;
    let c;
    if (extra.style === 'lm') c = raw >= 1000 ? raw / 1000 : raw;               // LM-SENSORS milli-°C
    else if (extra.style === 'entity') c = raw * Math.pow(10, (extra.scaleExp || 0) - (extra.precision || 0));
    else if (extra.style === 'asrock-str') c = raw;                             // already °C after parse
    else if (extra.style === 'tenthF') c = (raw / 10 - 32) * 5 / 9;             // budget PDUs: tenths of °F
    else c = raw / (extra.div || 1);                                            // vendor scalars/tables
    return (c <= -40 || c >= 150) ? null : c;
}

// Counter delta -> per-second rate. cur/prev are decimal strings (BigInt-safe).
// mult=8 turns octets into bits. Returns null on reset/underflow/missing.
function rate(cur, prev, elapsedSec, is64, mult) {
    if (cur == null || prev == null) return null;
    let delta = BigInt(cur) - BigInt(prev);
    if (delta < 0n) {
        if (is64) return null;                 // 64-bit wrap between polls isn't physical: reset
        delta += WRAP32;                       // 32-bit wrap correction
        if (delta < 0n) return null;
    }
    return Number(delta) * mult / elapsedSec;
}

// Prepared once at load (schema exists by then - db.js builds it on require);
// re-preparing per poll cycle recompiled the SQL for every device, every cycle.
const insertSample = db.prepare(
    'INSERT OR REPLACE INTO samples (entity_id, ts, status, v0, v1, v2, v3, v4, v5) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const updEntityStmt = db.prepare(`UPDATE entities SET
    oper_status = COALESCE(@oper_status, oper_status),
    admin_status = COALESCE(@admin_status, admin_status),
    alias = COALESCE(@alias, alias),
    speed_bps = COALESCE(@speed_bps, speed_bps),
    stale = COALESCE(@stale, stale),
    poll_state = @poll_state
    WHERE id = @id`);

function persistPoll(device, nowS, uptimeCs, rows, updates) {
    const ins = insertSample;
    const updEntity = updEntityStmt;
    db.transaction(() => {
        for (const r of rows) ins.run(r.entityId, nowS, r.status, ...r.v);
        for (const u of updates) {
            updEntity.run({ oper_status: null, admin_status: null, alias: null, speed_bps: null, stale: null, ...u });
        }
        db.prepare(`UPDATE devices SET status = 'up', last_poll_ts = ?, last_seen_ts = ?,
                    last_sysuptime_cs = ?, consecutive_failures = 0 WHERE id = ?`)
            .run(nowS, nowS, uptimeCs, device.id);
    })();
}

function recordFailure(device, nowS, err) {
    const failures = device.consecutive_failures + 1;
    const status = failures >= DOWN_AFTER_FAILURES ? 'down' : device.status;
    db.prepare('UPDATE devices SET status = ?, last_poll_ts = ?, consecutive_failures = ? WHERE id = ?')
        .run(status, nowS, failures, device.id);
    if (status === 'down' && device.status !== 'down') {
        log(`device ${device.id} (${device.host}) marked DOWN: ${err.message}`);
        exporter.scheduleWrite();
    }
}

// --- nightly retention prune (03:30 local, tracked via settings.last_prune_day) ---
function maybePrune() {
    const now = new Date();
    if (now.getHours() !== 3 || now.getMinutes() < 30) return;
    const today = now.toISOString().slice(0, 10);
    if (getSetting('last_prune_day') === today) return;
    db.prepare("INSERT INTO settings (key, value) VALUES ('last_prune_day', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(today);
    setImmediate(prune);
}

function prune() {
    try {
        const retentionDays = parseInt(getSetting('retention_days'), 10) || 90;
        const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
        const entityIds = db.prepare('SELECT id FROM entities').all().map((r) => r.id);
        const del = db.prepare('DELETE FROM samples WHERE entity_id = ? AND ts < ?');
        let total = 0;
        const step = (i) => {
            if (i >= entityIds.length) {
                db.pragma('wal_checkpoint(TRUNCATE)');
                auth.pruneSessions();
                log(`prune finished: ${total} samples older than ${retentionDays}d removed`);
                return;
            }
            total += del.run(entityIds[i], cutoff).changes;
            setImmediate(() => step(i + 1)); // yield the event loop between entities
        };
        step(0);
    } catch (err) {
        log('prune failed:', err.message);
    }
}

module.exports = { start, stop, deviceChanged, deviceRemoved, prune };
