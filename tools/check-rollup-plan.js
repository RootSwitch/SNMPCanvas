'use strict';
// The hourly rollup must read samples BY ENTITY, using the primary key.
//
//   node tools/check-rollup-plan.js
//
// samples is PRIMARY KEY (entity_id, ts), so a query filtering on `ts` alone
// cannot use it and SQLite scans the whole table. That is invisible on a fast
// disk with a small table - 192 ms on an NVMe test box - and catastrophic
// where this app is meant to run: measured on a real Pi 3B+, one chunk read
// 14.8 MILLION rows to emit 1,644 hourly rows, taking 66.5 SECONDS. Since
// better-sqlite3 is synchronous, that is 66 seconds in which the process
// answers nothing at all - the health endpoint, which does no work whatsoever,
// timed out against an otherwise idle machine. The same work per entity: 1.7s.
//
// The plan is pinned rather than the runtime, because a regression here is
// silent by nature. Both queries still return correct answers; only the plan
// distinguishes the version that is 40x slower and getting worse as the table
// grows toward its retention limit. The strings are IMPORTED, never re-typed,
// so this cannot pass while the shipped query says something else.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.SNMPCANVAS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'snmpcanvas-rollup-'));

const { db } = require('../server/db');
const { ROLLUP_SQL, PRUNE_SAMPLES_SQL } = require('../server/poller');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}
// Bind by PLACEHOLDER COUNT rather than a fixed list. The regression this
// file exists to catch changes the query's arity as well as its plan, and a
// test that dies on `too many parameter values` reports a stack trace where it
// should report which property broke. Values are irrelevant to the plan.
const planOf = (sql) => {
    const n = (sql.match(/\?/g) || []).length;
    return db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...Array(n).fill(1))
        .map((r) => r.detail).join(' | ');
};

// --- a fixture with enough shape to aggregate ------------------------------
const HOUR = 3600;
const base = 1700000000 - (1700000000 % HOUR);   // aligned, so hour buckets are exact
db.prepare(`INSERT INTO devices (id, name, host, port, snmp_version, created_ts)
            VALUES (1, 'dev', '10.0.0.1', 161, '2c', ?)`).run(base);
const insEnt = db.prepare(`INSERT INTO entities (id, device_id, kind, snmp_index, name)
                           VALUES (?, 1, 'if', ?, ?)`);
const insSample = db.prepare('INSERT INTO samples (entity_id, ts, status, v0, v1) VALUES (?, ?, ?, ?, ?)');
const ENTITIES = [1, 2, 3];
for (const id of ENTITIES) insEnt.run(id, String(id), 'if' + id);
// 3 entities x 4 hours x 6 samples: enough for real averages, maxima and a
// min(status) that is not the same as the first row.
for (const id of ENTITIES) {
    for (let h = 0; h < 4; h++) {
        for (let k = 0; k < 6; k++) {
            insSample.run(id, base + h * HOUR + k * 600, k === 3 ? 2 : 1, id * 100 + k, id * 10 + k);
        }
    }
}

// --- the pinned property ---------------------------------------------------
const rollPlan = planOf(ROLLUP_SQL);
check('the rollup SEARCHes by primary key rather than scanning',
    /SEARCH .*samples.* USING PRIMARY KEY/.test(rollPlan), rollPlan);
check('...and never SCANs the samples table',
    !/SCAN\s+samples\b/.test(rollPlan), rollPlan);
// The prune has always done this correctly; pin it so it stays that way.
const prunePlan = planOf(PRUNE_SAMPLES_SQL);
check('the prune deletes by primary key rather than scanning',
    /SEARCH .*samples.* USING PRIMARY KEY/.test(prunePlan) && !/SCAN\s+samples\b/.test(prunePlan),
    prunePlan);

// The rollup must supply entity_id. Guard the exact regression: dropping that
// predicate leaves a query that still answers correctly and scans everything.
check('the rollup query actually constrains entity_id',
    /entity_id\s*=\s*\?/.test(ROLLUP_SQL));

// --- and it must still be CORRECT -----------------------------------------
// Per-entity is only worth having if it produces exactly what the whole-table
// aggregate did. Run the shipped statement for every entity, then compare
// against the old form computed independently here.
let ran = null;
try {
    const roll = db.prepare(ROLLUP_SQL);
    for (const id of ENTITIES) roll.run(id, base, base + 4 * HOUR);
    ran = db.prepare(ROLLUP_SQL);
} catch (err) {
    check('the rollup statement takes (entity_id, from, to)', false, err.message);
}
const got = db.prepare('SELECT entity_id, hour_ts, n, a0, a1, m0, m1, st FROM samples_hourly ORDER BY entity_id, hour_ts').all();

const want = db.prepare(`
    SELECT entity_id, (ts / 3600) * 3600 AS hour_ts, count(*) AS n,
           avg(v0) AS a0, avg(v1) AS a1, max(v0) AS m0, max(v1) AS m1, min(status) AS st
    FROM samples WHERE ts >= ? AND ts < ?
    GROUP BY entity_id, (ts / 3600) * 3600
    ORDER BY entity_id, hour_ts`).all(base, base + 4 * HOUR);

check('per-entity rollup produces the same rows as the whole-table aggregate',
    JSON.stringify(got) === JSON.stringify(want),
    got.length + ' rows vs ' + want.length);
check('...and that is 12 rows (3 entities x 4 hours), not an empty pass',
    got.length === 12, String(got.length));
check('...with 6 samples averaged into each', got.every((r) => r.n === 6));
check('...and min(status) survives the rewrite', got.every((r) => r.st === 1));

// Re-running must not double-count: the rollup reprocesses hours whenever a
// chunk is retried, so INSERT OR REPLACE has to hold.
if (ran) for (const id of ENTITIES) ran.run(id, base, base + 4 * HOUR);
const again = db.prepare('SELECT COUNT(*) c, MAX(n) mx FROM samples_hourly').get();
check('re-running a chunk replaces rather than duplicating',
    again.c === 12 && again.mx === 6, JSON.stringify(again));

console.log(failures ? `\n${failures} FAILED` : '\nall rollup plan checks passed');
process.exit(failures ? 1 : 0);
