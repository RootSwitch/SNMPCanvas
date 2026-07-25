'use strict';
// Verifies the history endpoint against a synthetic 90 days of samples.
//
//   node tools/check-history.js
//
// It builds a throwaway database, runs the real rollup job and calls the real
// API handler - no query is re-typed here, so this cannot pass while the
// shipped SQL is wrong.
//
// Three things are checked, and each one is here because it broke:
//
//   1. Bucketing actually buckets. `(ts / @b) * @b` is INTEGER division only
//      if @b binds as an integer, and better-sqlite3 binds every JS number as
//      REAL - a BigInt is the only way to get an integer. Bound as a number
//      the expression returns ts unchanged, GROUP BY groups nothing, and the
//      endpoint quietly returns one point per raw sample: 259,200 of them for
//      a 90-day range, with maxPoints silently doing nothing. It draws a
//      plausible-looking chart, which is why it survived so long.
//   2. Rolled-up answers equal raw answers. A rollup that shifts the numbers
//      is worse than a slow honest query, because nobody would notice.
//   3. The frontier between the two sources neither double-counts an hour nor
//      drops one.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snmpcanvas-check-'));
process.env.SNMPCANVAS_DATA = TMP;      // must be set before ./db is required

const { db, getSetting, setSetting } = require('../server/db');
const poller = require('../server/poller');
const api = require('../server/api');
const auth = require('../server/auth');

const HOUR = 3600;
const STEP = 30;
const DAYS = 90;

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}

// --- fixture ---------------------------------------------------------------
const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
const from = now - DAYS * 86400;

db.prepare(`INSERT INTO devices (id, name, host, snmp_version, poll_interval_s, created_ts)
            VALUES (1, 'check-sw', '127.0.0.1', '2c', 30, ?)`).run(now);
db.prepare(`INSERT INTO entities (id, device_id, kind, snmp_index, name, speed_bps)
            VALUES (1, 1, 'if', '1', 'Gi0/1', 1000000000)`).run();

process.stdout.write(`seeding ${DAYS}d of ${STEP}s samples... `);
const ins = db.prepare('INSERT INTO samples (entity_id, ts, status, v0, v1, v2, v3, v4, v5) VALUES (1,?,1,?,?,?,0,0,0)');
const commit = db.transaction((rows) => { for (const r of rows) ins.run(...r); });
let buf = [];
let written = 0;
for (let ts = from; ts < now; ts += STEP) {
    // Every 37th hour is RAGGED - only its first 20 polls land, and they carry
    // an unusually high value. Those hours are what separates a weighted mean
    // from averaging-the-averages; without them a broken rollup would pass.
    const ragged = Math.floor(ts / HOUR) % 37 === 0;
    if (ragged && (ts % HOUR) >= 20 * STEP) continue;
    const v = ragged ? 900e6 : (Math.sin(ts / 8000) + 1) * 400e6 + (ts % 7919);
    buf.push([ts, v, v * 0.6, ts % 3]);
    written++;
    if (buf.length >= 30000) { commit(buf); buf = []; }
}
if (buf.length) commit(buf);
console.log(`${written.toLocaleString()} rows`);

// --- the real rollup job ---------------------------------------------------
const t0 = Date.now();
poller.rollup();
// rollup() yields between chunks with setImmediate; drain before querying.
const drain = () => new Promise((resolve) => {
    const spin = () => (parseInt(getSetting('rollup_through_ts'), 10) || 0) >= now ? resolve() : setImmediate(spin);
    spin();
});

// --- calling the real endpoint ---------------------------------------------
auth.setPassword('check-only-' + Math.random());
const token = auth.createSession();

function get(pathname, query) {
    return new Promise((resolve, reject) => {
        const req = { method: 'GET', headers: { cookie: auth.sessionCookie(token).split(';')[0] }, socket: { remoteAddress: '127.0.0.1' } };
        const res = {
            headersSent: false,
            writeHead() { this.headersSent = true; },
            end(buf) { try { resolve(JSON.parse(buf)); } catch (err) { reject(err); } }
        };
        api.handle(req, res, pathname, new URLSearchParams(query)).catch(reject);
    });
}

const MAX_POINTS = 500;
const samples = (days) => get('/api/entities/1/samples', { from: String(now - days * 86400), to: String(now), maxPoints: String(MAX_POINTS) });

(async () => {
    await drain();
    const hourly = db.prepare('SELECT count(*) c FROM samples_hourly').get().c;
    console.log(`rollup: ${hourly.toLocaleString()} hourly rows in ${Date.now() - t0} ms (${Math.round(written / hourly)}:1)\n`);
    check('rollup covers every complete hour', hourly === DAYS * 24, `${hourly} rows`);

    // 1. bucketing
    console.log('\nbucketing');
    for (const days of [1, 7, 30, 90]) {
        const r = await samples(days);
        const raw = Math.floor(days * 86400 / STEP);
        check(`${String(days).padStart(2)}d returns <= maxPoints`, r.points.length <= MAX_POINTS,
            `${r.points.length} points (${raw.toLocaleString()} raw samples, bucket ${r.bucketSec}s)`);
    }

    // 2 + 3. the rollup agrees with the raw data, including across the frontier
    console.log('\nrollup fidelity (same request, rollup on vs off)');
    const markWas = getSetting('rollup_through_ts');
    for (const [label, mark] of [['fully rolled up', now], ['frontier mid-range', now - 45 * 86400]]) {
        setSetting('rollup_through_ts', String(mark));
        const rolled = await samples(90);
        setSetting('rollup_through_ts', '0');           // 0 = read everything raw
        const raw = await samples(90);
        let worst = 0;
        const rawAt = new Map(raw.points.map((p) => [p[0], p]));
        let unmatched = 0;
        for (const p of rolled.points) {
            const q = rawAt.get(p[0]);
            if (!q) { unmatched++; continue; }
            for (let i = 1; i < p.length; i++) {
                if (p[i] == null || q[i] == null) continue;
                worst = Math.max(worst, Math.abs(p[i] - q[i]) / Math.max(1, Math.abs(q[i])));
            }
        }
        check(`${label}: same buckets`, rolled.points.length === raw.points.length && unmatched === 0,
            `${rolled.points.length} vs ${raw.points.length}, ${unmatched} unmatched`);
        check(`${label}: same values`, worst < 1e-9, `max relative difference ${worst.toExponential(1)}`);
    }
    setSetting('rollup_through_ts', markWas);

    db.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
})().catch((err) => {
    console.error(err);
    try { db.close(); fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    process.exit(1);
});
