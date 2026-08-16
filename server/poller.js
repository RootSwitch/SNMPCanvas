'use strict';
// The polling engine: due devices are polled up to CONCURRENCY at a time, and
// a freed slot is refilled the moment its poll finishes. A 5-second tick still
// runs, but only to reconcile the schedule against the database, check whether
// the loop is falling behind, and wake devices that have just come due - it is
// not what limits throughput. Counter math is BigInt end to end; rates are
// stored, not raw counters, so graphs are a straight read.

const S = require('./snmp');
const O = require('./oids');
const { db, getSetting, loadCredentials } = require('./db');
const auth = require('./auth');
const exporter = require('./exporter');
const discover = require('./discover');
// Named import: `reconcile` is already a function here (the poll SCHEDULE
// reconciler), and two different reconciles in one file is a trap.
const { reconcileDevice } = require('./reconcile');

const TICK_MS = 5000;
// A slot is not a worker - it is one outstanding UDP request. Slots spend
// their time WAITING, which is exactly the resource an unreachable device
// consumes (5s timeout x 1 retry = ~10s of a slot, against ~50ms for a device
// that answers). A generous cap is close to free: it does not create work, it
// only stops a backlog forming, so on a healthy fleet it is inert. Measured on
// a Raspberry Pi 3B+ polling 400 devices with 40 of them dark: 4 could not keep
// up at all, 16 held a true 30s interval at 80% of a core, 32 self-limited to
// 24 in flight. 16 is the default because it is the largest value proven safe
// on the weakest box the suite targets.
const CONCURRENCY_DEFAULT = 16;
const CONCURRENCY_MAX = 512;

// Settable from the UI, because the warning this app prints when it falls
// behind says "raise POLL_CONCURRENCY" - and telling someone to edit a compose
// file and restart a container is a dead end for the small teams this is aimed
// at. The environment variable still WINS where it is set: that is an explicit
// deployment decision, and silently overriding it from a web page would be
// worse than not offering the field at all. The UI says which one is in force.
const CONCURRENCY_ENV = process.env.POLL_CONCURRENCY
    ? Math.min(CONCURRENCY_MAX, Math.max(1, parseInt(process.env.POLL_CONCURRENCY, 10) || CONCURRENCY_DEFAULT))
    : null;

// Re-read once per tick rather than per pump(): pump runs on every poll
// completion (thousands a minute on a large fleet), and a settings lookup there
// would be pure overhead. A change therefore takes effect within one tick.
let concurrencyCache = null;
function readConcurrency() {
    if (CONCURRENCY_ENV != null) return CONCURRENCY_ENV;
    const v = parseInt(getSetting('poll_concurrency'), 10);
    return Math.min(CONCURRENCY_MAX, Math.max(1, v || CONCURRENCY_DEFAULT));
}
function concurrency() {
    if (concurrencyCache == null) concurrencyCache = readConcurrency();
    return concurrencyCache;
}

// Devices already known down may occupy at most half the slots. Without this,
// enough dark devices starve every healthy one: each holds a slot for a full
// timeout, so ~12 of them saturated the old default on their own regardless of
// how small the rest of the fleet was. Down devices consequently get repolled
// more slowly the more of them there are, which is the right trade - it is also
// most of what an explicit per-device backoff would have bought.
function downSlotMax() { return Math.max(1, Math.floor(concurrency() / 2)); }
const DEVICE_WALL_CLOCK_MS = 60 * 1000;   // hard cap per device poll
const DOWN_AFTER_FAILURES = 2;            // one missed poll is not "down"
const META_REFRESH_EVERY = 12;            // ifName/ifAlias/ifHighSpeed refresh cadence
const WRAP32 = 2n ** 32n;

const inFlight = new Set();      // device ids
const downInFlight = new Set();  // subset of inFlight whose device is already down
const nextDue = new Map();       // device id -> ms epoch
const pollSeq = new Map();       // device id -> counter (meta refresh cadence)
let timer = null;

const log = (...args) => console.log(new Date().toISOString(), '[poller]', ...args);
// Absolute rate ceiling for interfaces with NO trusted speed: generous
// beyond any single link this app will meet, so only true counter garbage
// (undetected resets, double 32-bit wraps) becomes a gap.
const ABS_RATE_CEILING = 2e12;   // 2 Tbps

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
    // Let the exporter publish whether we are keeping up. Registered rather
    // than imported the other way round: exporter.js must not require this
    // module, since we already require it.
    exporter.setHealthSource(health);
    primeSchedule();
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
    log(`started (tick ${TICK_MS / 1000}s, concurrency ${concurrency()}${CONCURRENCY_ENV != null ? ' from POLL_CONCURRENCY' : ''})`);
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
    if (pollSoon) pump();   // start it now rather than up to a tick later
}
function deviceRemoved(deviceId) {
    nextDue.delete(deviceId);
    pollSeq.delete(deviceId);
}

function tick() {
    try {
        maybePrune();
        maybeRollup();
        reconcile();
        pump();
    } catch (err) {
        log('tick error:', err.message);
    }
}

// The schedule lives in nextDue; the database is the authority on which devices
// belong in it. Re-derive the membership once per tick so a row enabled or
// deleted behind the API's back still gets picked up, and so pump() - which
// runs far more often - can work off memory alone.
function reconcile() {
    concurrencyCache = readConcurrency();   // a Settings change takes effect within one tick
    const enabled = db.prepare('SELECT id FROM devices WHERE enabled = 1').all();
    const live = new Set(enabled.map((r) => r.id));
    for (const id of nextDue.keys()) if (!live.has(id)) nextDue.delete(id);
    for (const r of enabled) if (!nextDue.has(r.id)) nextDue.set(r.id, Date.now());
    checkBehind();
}

// Fill every free slot with whatever is due, now.
//
// This used to happen only on the 5s tick, which capped the loop at CONCURRENCY
// starts per tick - 48 polls/minute on defaults, no matter how fast devices
// answered. Past ~24 devices at a 30s interval the loop could not keep up and
// quietly stretched the effective interval instead: samples kept flowing and
// graphs kept drawing, just coarser than configured, with nothing saying so.
// Measured on a 100-device fleet: 576 samples/min before, 2160 after.
//
// Called on every tick AND as each poll finishes, so a slot freed 200ms into a
// tick is reused at 200ms rather than idling out the remaining 4.8 seconds.
function pump() {
    if (inFlight.size >= concurrency()) return;
    const now = Date.now();
    const due = [];
    for (const [id, at] of nextDue) {
        if (at <= now && !inFlight.has(id)) due.push([id, at]);
    }
    if (!due.length) return;
    due.sort((a, b) => a[1] - b[1]);   // longest-overdue first, so nothing starves
    const byId = db.prepare('SELECT * FROM devices WHERE id = ?');
    // Walk the WHOLE due list rather than the first `free` of it: a run of down
    // devices at the head must be skipped past, not allowed to consume the pass.
    for (const [id] of due) {
        if (inFlight.size >= concurrency()) break;
        const device = byId.get(id);
        if (!device || !device.enabled) { nextDue.delete(id); continue; }
        const isDown = device.status === 'down';
        if (isDown && downInFlight.size >= downSlotMax()) continue;   // keep slots for reachable devices
        inFlight.add(id);
        if (isDown) downInFlight.add(id);
        scheduleNext(device); // schedule next poll now; overruns skip, never queue twice
        pollDevice(device)
            .catch((err) => log(`device ${device.id} (${device.host}) poll crashed:`, err.message))
            .finally(() => { inFlight.delete(id); downInFlight.delete(id); pump(); });
    }
}

// A poll loop that cannot keep up does not fail - it stretches. The samples
// keep arriving and every graph still draws, just coarser than the interval
// says, which is easy to watch for a week without noticing. Say so instead.
let behind = { behind: false, overdueDevices: 0, worstLateS: 0, since: null };
let lastBehindLog = 0;
const BEHIND_LOG_EVERY_MS = 10 * 60 * 1000;

function checkBehind() {
    const now = Date.now();
    const globalS = parseInt(getSetting('poll_interval_s'), 10) || 300;
    let overdue = 0;
    let worstLate = 0;
    // Devices already down are EXCLUDED on purpose. DOWN_SLOT_MAX deliberately
    // deprioritises them, so they run late by design - counting them here would
    // make this warn on any fleet with a few dark boxes, which is most of them,
    // and an alarm that is always on is not an alarm. What matters is a device
    // that is answering fine and still is not being polled on time.
    for (const r of db.prepare("SELECT id, poll_interval_s FROM devices WHERE enabled = 1 AND status <> 'down'").all()) {
        const at = nextDue.get(r.id);
        if (at === undefined || inFlight.has(r.id)) continue;
        // nextDue is set when a poll STARTS, so anything more than a full
        // interval past due has already missed at least one whole cycle.
        const iv = Math.max(30, r.poll_interval_s || globalS) * 1000;
        const late = now - at;
        if (late > iv) { overdue++; if (late > worstLate) worstLate = late; }
    }

    const isBehind = overdue > 0;
    behind = {
        behind: isBehind,
        overdueDevices: overdue,
        worstLateS: Math.round(worstLate / 1000),
        since: isBehind ? (behind.since || now) : null
    };
    if (!isBehind) { lastBehindLog = 0; return; }
    if (now - lastBehindLog < BEHIND_LOG_EVERY_MS) return;
    lastBehindLog = now;
    log(`WARNING: poll loop is behind - ${overdue} reachable device(s) have missed a full interval, worst is `
        + `${behind.worstLateS}s overdue. Effective interval is longer than configured. `
        + `Raise poll concurrency (currently ${concurrency()}), lengthen the poll interval, or split the fleet.`);
}

// The API calls this after a settings write so a change is live immediately
// rather than up to a tick later - without it, saving a new concurrency and
// re-reading the page showed the OLD value, which reads as "it ignored me".
function settingsChanged() { concurrencyCache = readConcurrency(); }

function health() {
    return {
        ...behind,
        concurrency: concurrency(),
        // Where the number came from, so the UI can explain why its field is
        // read-only on a deployment that sets the variable.
        concurrencySource: CONCURRENCY_ENV != null ? 'env' : 'setting',
        inFlight: inFlight.size,
        scheduled: nextDue.size
    };
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
            recordFailure(device, nowS, err, 'liveness');
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
        const evicted = [];
        if (oidList.length > 0) {
            try {
                values = await S.getMany(session, oidList, 25, evicted);
            } catch (err) {
                recordFailure(device, nowS, err, 'entities');
                return;
            }
        }
        // An evicted OID means the agent refused a varbind we asked for by
        // name - the stored instance no longer exists on the device. Flag the
        // owning entity and repair the definition, rather than paying an extra
        // round trip for the same dead instance on every poll forever.
        if (evicted.length > 0) {
            const ownerOf = new Map();
            for (const job of jobs) for (const oid of Object.values(job.oids)) ownerOf.set(oid, job.entity);
            const names = new Set();
            const mark = db.prepare('UPDATE entities SET stale = 1 WHERE id = ?');
            for (const oid of evicted) {
                const owner = ownerOf.get(oid);
                if (owner) { mark.run(owner.id); names.add(owner.name); }
            }
            log(`${device.host}: agent refused ${evicted.length} stored instance(s) (${[...names].join(', ') || 'unknown'}) - kept polling the rest, re-indexing`);
            requestReindex(device, 'instances refused');
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
                        speedTrustAndClamp(e, v, is64, device.host);
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
                    if (highSpeed > 0) {
                        update.speed_bps = highSpeed * 1e6;
                        // A CHANGED claim gets fresh trust - a genuine
                        // renegotiation is a new speed to test. An unchanged
                        // claim keeps its earned verdict.
                        if (e.speed_untrusted && update.speed_bps !== e.speed_bps) update.speed_untrusted = 0;
                    }
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
        if (rebooted) {
            log(`device ${device.id} (${device.host}) rebooted - counter deltas discarded this cycle`);
            // A reboot is the moment an agent renumbers its instances, so it
            // is also the moment the stored entity list is most likely wrong.
            requestReindex(device, 'device rebooted');
        }

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

// Speed trust + sanity clamp, one decision. Advertised ifSpeed/ifHighSpeed
// is a CLAIM, and virtual NICs (virtio/netvsc) advertise fiction -
// host-local traffic is not bounded by it. A measured rate beyond the claim
// plus timing jitter PROVES the claim false: persist that verdict
// (speed_untrusted) so utilization math and alerting stop dividing by a
// lie. An operator override (speed_override_bps) outranks everything and is
// never second-guessed here.
//
// Only 64-bit counters can CONVICT: a 32-bit rate can itself be wrap
// garbage, and a false conviction would let that garbage into the graphs
// from then on.
//
// The clamp half: an undetected reset / double 32-bit wrap shows up as an
// impossible rate - store the gap instead. Only a TRUSTED speed can judge
// "impossible"; clamping against fictional advertised speeds silently
// discarded real replication traffic (the fastest samples, no less). With
// no trusted speed, fall back to the absolute ceiling.
//
// Exported for tools/check-speed-trust.js - this is the whole defect
// surface of the "133% utilization at replication time" bug class, so it
// gets driven directly against a real database.
function speedTrustAndClamp(e, v, is64, host) {
    const override = e.speed_override_bps > 0 ? e.speed_override_bps : 0;
    const advertised = e.speed_bps > 0 ? e.speed_bps : 0;
    if (is64 && !override && advertised && !e.speed_untrusted) {
        const worst = Math.max(v[0] ?? 0, v[1] ?? 0);
        if (worst > advertised * 1.1) {
            e.speed_untrusted = 1;   // effective for the clamp below
            markSpeedUntrusted.run(e.id);
            log(`${host} ${e.name || 'if.' + e.snmp_index}: measured ${Math.round(worst / 1e6)} Mbps exceeds advertised ${Math.round(advertised / 1e6)} Mbps - speed marked untrusted, utilization suspended (set a speed override to restore it)`);
        }
    }
    const trustedSpeed = override || (e.speed_untrusted ? 0 : advertised);
    const ceiling = trustedSpeed > 0 ? trustedSpeed * 2 : ABS_RATE_CEILING;
    if (v[0] != null && v[0] > ceiling) v[0] = null;
    if (v[1] != null && v[1] > ceiling) v[1] = null;
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
    speed_untrusted = COALESCE(@speed_untrusted, speed_untrusted),
    stale = COALESCE(@stale, stale),
    poll_state = @poll_state
    WHERE id = @id`);
const markSpeedUntrusted = db.prepare('UPDATE entities SET speed_untrusted = 1 WHERE id = ?');

function persistPoll(device, nowS, uptimeCs, rows, updates) {
    const ins = insertSample;
    const updEntity = updEntityStmt;
    db.transaction(() => {
        for (const r of rows) ins.run(r.entityId, nowS, r.status, ...r.v);
        for (const u of updates) {
            updEntity.run({ oper_status: null, admin_status: null, alias: null, speed_bps: null, speed_untrusted: null, stale: null, ...u });
        }
        // A clean poll clears the recorded reason too - a stale "why it went
        // down" beside a device that is currently up is worse than no reason.
        db.prepare(`UPDATE devices SET status = 'up', last_poll_ts = ?, last_seen_ts = ?,
                    last_sysuptime_cs = ?, consecutive_failures = 0,
                    last_error = NULL, last_error_ts = NULL, last_error_phase = NULL WHERE id = ?`)
            .run(nowS, nowS, uptimeCs, device.id);
    })();
}

// `phase` says WHICH read failed, and that distinction is the whole point:
// 'liveness' means the device never answered at all (network, ACL, agent
// down); 'entities' means it answered the system OIDs happily and then failed
// the metric GET, which is what a stale entity list looks like from here.
// Those need opposite responses and used to be one word, "down".
function recordFailure(device, nowS, err, phase) {
    const failures = device.consecutive_failures + 1;
    const status = failures >= DOWN_AFTER_FAILURES ? 'down' : device.status;
    db.prepare(`UPDATE devices SET status = ?, last_poll_ts = ?, consecutive_failures = ?,
                last_error = ?, last_error_ts = ?, last_error_phase = ? WHERE id = ?`)
        .run(status, nowS, failures, String(err.message || err), nowS, phase || null, device.id);
    if (status === 'down' && device.status !== 'down') {
        log(`device ${device.id} (${device.host}) marked DOWN during ${phase} read: ${err.message}`);
        exporter.scheduleWrite();
    }
    // A device that answers liveness but dies on its metric GET is describing
    // a stale instance list, whatever the agent calls the error. Repair it
    // rather than waiting for someone to notice and click Rediscover.
    if (phase === 'entities') requestReindex(device, 'metric poll failed');
}

// --- automatic re-index -----------------------------------------------------
// Three separate incidents pointed here, all the same shape: the stored entity
// definition outlived the device's reality (a reboot renumbered HOST-RESOURCES
// instances, a vCPU or memory change moved them, a NIC re-enumerated), and
// only a hand-run Rediscover fixed it. The poller already DETECTS reboots - it
// discards counter deltas on one - so it has the trigger and did nothing with
// it.
//
// Deliberately conservative: one device at a time, a long per-device cooldown,
// and every failure swallowed after logging. This is a repair path, not a
// monitoring path - it must never be able to consume the poll loop, and a
// device whose probe keeps failing must not be re-probed every cycle.
const REINDEX_COOLDOWN_MS = 30 * 60 * 1000;
const reindexLast = new Map();     // device id -> ms epoch of last attempt
const reindexQueue = [];           // device ids awaiting a probe
let reindexRunning = false;

function requestReindex(device, reason) {
    const last = reindexLast.get(device.id) || 0;
    if (Date.now() - last < REINDEX_COOLDOWN_MS) return;
    if (reindexQueue.includes(device.id)) return;
    reindexLast.set(device.id, Date.now());
    reindexQueue.push(device.id);
    log(`device ${device.id} (${device.host}) queued for re-index: ${reason}`);
    if (!reindexRunning) setImmediate(runReindexQueue);
}

async function runReindexQueue() {
    if (reindexRunning) return;
    reindexRunning = true;
    try {
        while (reindexQueue.length > 0) {
            const id = reindexQueue.shift();
            const d = db.prepare('SELECT * FROM devices WHERE id = ? AND enabled = 1').get(id);
            if (!d) continue;
            try {
                const creds = loadCredentials(d.id);
                if (!creds) continue;
                const result = await discover.probe({ host: d.host, port: d.port, version: d.snmp_version, creds });
                // untrack:false - the automatic path may add and correct,
                // never retire what an operator chose to track.
                const summary = reconcileDevice(d, result, { untrack: false });
                const changed = summary.added.length + summary.updated.length + summary.flagged.length;
                log(`device ${d.id} (${d.host}) re-indexed: ${summary.added.length} added, ` +
                    `${summary.updated.length} renamed, ${summary.flagged.length} flagged missing`);
                if (changed > 0) { deviceChanged(d.id, true); exporter.scheduleWrite(); }
            } catch (err) {
                // Loud but not fatal: the next trigger tries again after the
                // cooldown, and the device keeps being polled meanwhile.
                log(`device ${d.id} (${d.host}) re-index failed: ${err.message}`);
            }
        }
    } finally {
        reindexRunning = false;
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

// Rollup rows whose entity no longer exists - left behind by any device
// deleted before the delete route learned to clean samples_hourly. The
// per-entity prune below iterates EXISTING entities, so those rows are
// invisible to it forever; this sweep is the idempotent guard.
//
// samples_hourly ONLY, deliberately. `samples` cannot hold orphans: device
// deletion has always removed its rows inside the same transaction as the
// device row, so either both are gone or neither is. Sweeping it anyway cost
// a full table scan of the largest table in the database, every night, to
// find nothing - EXPLAIN QUERY PLAN says SCAN samples, not the skip-scan the
// first version of this comment claimed (93ms per 1.2M rows measured warm,
// seconds on a real fleet, and it blocks the loop because better-sqlite3 is
// synchronous). The rollup is ~1 row per entity per hour against 120 for
// samples, so scanning it is the cheap 1% of that.
function sweepOrphanHistory() {
    const live = new Set(db.prepare('SELECT id FROM entities').all().map((r) => r.id));
    const owners = db.prepare('SELECT DISTINCT entity_id AS e FROM samples_hourly').all();
    const del = db.prepare('DELETE FROM samples_hourly WHERE entity_id = ?');
    let removed = 0;
    for (const { e } of owners) {
        if (!live.has(e)) removed += del.run(e).changes;
    }
    if (removed) log(`orphan sweep: ${removed} rollup rows for deleted entities removed`);
    return removed;
}

function prune() {
    try {
        sweepOrphanHistory();
        const retentionDays = parseInt(getSetting('retention_days'), 10) || 90;
        const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
        const entityIds = db.prepare('SELECT id FROM entities').all().map((r) => r.id);
        const del = db.prepare('DELETE FROM samples WHERE entity_id = ? AND ts < ?');
        // The rollup obeys the same retention as the raw rows it summarises.
        // Retention is a promise about how long data is KEPT, and an hourly
        // average is still that data - leaving it behind would quietly turn a
        // 90-day setting into forever.
        const delHourly = db.prepare('DELETE FROM samples_hourly WHERE entity_id = ? AND hour_ts < ?');
        let total = 0;
        const step = (i) => {
            if (i >= entityIds.length) {
                db.pragma('wal_checkpoint(TRUNCATE)');
                auth.pruneSessions();
                log(`prune finished: ${total} samples older than ${retentionDays}d removed`);
                return;
            }
            total += del.run(entityIds[i], cutoff).changes;
            delHourly.run(entityIds[i], cutoff);
            setImmediate(() => step(i + 1)); // yield the event loop between entities
        };
        step(0);
    } catch (err) {
        log('prune failed:', err.message);
    }
}

// --- hourly rollup ----------------------------------------------------------
// Collapses completed hours of `samples` into one row per entity per hour, so
// that opening a 90-day graph reads ~2,160 rows instead of ~259,200. Measured
// on a Raspberry Pi 3B+ the unrolled 90-day query took 14 SECONDS - and
// better-sqlite3 is synchronous, so that was 14 seconds in which no device was
// polled and every other user's page hung too. One person opening one graph
// stalled the whole instance.
//
// Runs on a timer rather than nightly like the prune: the point is for a chart
// opened at 14:05 to be able to use rolled-up data from 13:00, not to wait for
// 03:30. Only COMPLETE hours are rolled up - the current hour is still
// receiving samples, and a row summarising a partial hour would be wrong until
// re-summarised.
const ROLLUP_EVERY_MS = 10 * 60 * 1000;
const ROLLUP_CHUNK_S = 6 * 3600;   // hours aggregated per event-loop yield
let rollupAt = 0;
let rollupRunning = false;

function maybeRollup() {
    if (rollupRunning || Date.now() < rollupAt) return;
    rollupAt = Date.now() + ROLLUP_EVERY_MS;
    setImmediate(rollup);
}

function rollup() {
    let from;
    let nowHour;
    try {
        nowHour = Math.floor(Date.now() / 1000 / 3600) * 3600;
        from = parseInt(getSetting('rollup_through_ts'), 10) || 0;
        if (!from) {
            // First run on an existing database: start at the oldest sample, so
            // history that predates this feature still gets summarised.
            const oldest = db.prepare('SELECT MIN(ts) m FROM samples').get().m;
            if (oldest == null) { setRollupMark(nowHour); return; }
            from = Math.floor(oldest / 3600) * 3600;
        }
        if (from >= nowHour) return;
    } catch (err) {
        log('rollup failed to start:', err.message);
        return;
    }

    rollupRunning = true;
    const started = Date.now();
    const backfill = nowHour - from > 2 * ROLLUP_CHUNK_S;
    // INSERT OR REPLACE, not INSERT: the last chunk of a previous run may have
    // covered an hour that was still in progress on a clock skew, and a device
    // added mid-hour produces rows for an hour already summarised. Replacing is
    // idempotent; ignoring would freeze a wrong average in place.
    const roll = db.prepare(`
        INSERT OR REPLACE INTO samples_hourly (entity_id, hour_ts, n, a0, a1, a2, a3, a4, a5, m0, m1, st)
        SELECT entity_id, (ts / 3600) * 3600, count(*),
               avg(v0), avg(v1), avg(v2), avg(v3), avg(v4), avg(v5),
               max(v0), max(v1), min(status)
        FROM samples WHERE ts >= ? AND ts < ?
        GROUP BY entity_id, (ts / 3600) * 3600`);

    let rows = 0;
    const step = (start) => {
        if (start >= nowHour) {
            rollupRunning = false;
            if (backfill) log(`rollup backfill finished: ${rows} hourly rows in ${((Date.now() - started) / 1000).toFixed(1)}s`);
            return;
        }
        const end = Math.min(start + ROLLUP_CHUNK_S, nowHour);
        try {
            rows += roll.run(start, end).changes;
            setRollupMark(end);
        } catch (err) {
            // Leave the mark where it was so the next run retries this chunk.
            rollupRunning = false;
            log('rollup failed:', err.message);
            return;
        }
        setImmediate(() => step(end)); // yield between chunks, as the prune does
    };
    step(from);
}

function setRollupMark(ts) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('rollup_through_ts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(ts));
}

module.exports = { start, stop, deviceChanged, deviceRemoved, prune, rollup, health, settingsChanged, speedTrustAndClamp, sweepOrphanHistory };
