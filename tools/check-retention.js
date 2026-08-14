'use strict';
// Verifies the retention consequence readout: oldest-sample lookup (per-entity
// index seeks, since samples has no ts-leading index) and the size projection
// (scale what is on disk, honest nulls under an hour of data).
//
//   node tools/check-retention.js

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snmpcanvas-retention-'));
process.env.SNMPCANVAS_DATA = TMP;      // must be set before ./db is required

const { db } = require('../server/db');
const { historySummary, oldestSampleTs } = require('../server/api');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}

const DAY = 86400;
const now = 1_800_000_000;

// --- oldestSampleTs against a seeded database ---
check('empty database has no oldest sample', oldestSampleTs() === null);

const insDev = db.prepare(`INSERT INTO devices (id, name, host, snmp_version, status, created_ts)
                           VALUES (?, ?, ?, '2c', 'up', ?)`);
insDev.run(1, 'a', '10.0.0.2', now);
insDev.run(2, 'b', '10.0.0.3', now);
const insEnt = db.prepare(`INSERT INTO entities (id, device_id, kind, snmp_index, name, tracked, code)
                           VALUES (?, ?, 'if', ?, ?, 1, ?)`);
insEnt.run(1, 1, '1', 'eth0', 'C1');
insEnt.run(2, 2, '1', 'eth0', 'C2');
insEnt.run(3, 2, '2', 'eth1', 'C3');    // entity with no samples at all
const insS = db.prepare('INSERT INTO samples (entity_id, ts, status) VALUES (?, ?, 1)');
insS.run(1, now - 5 * DAY);
insS.run(1, now);
insS.run(2, now - 37 * DAY);            // the true oldest, on the other device
insS.run(2, now);

check('oldest sample found across entities', oldestSampleTs() === now - 37 * DAY,
    String(oldestSampleTs()));

// --- orphan sweep: history rows whose entity no longer exists ---
// The per-entity prune iterates EXISTING entities, so a device deleted before
// samples_hourly cleanup existed left rollup rows invisible to every cleanup
// path. The sweep is the idempotent guard.
const { sweepOrphanHistory } = require('../server/poller');
insS.run(999, now - DAY);                    // orphan raw sample
db.prepare('INSERT INTO samples_hourly (entity_id, hour_ts, n) VALUES (999, ?, 12)').run(now - DAY);
db.prepare('INSERT INTO samples_hourly (entity_id, hour_ts, n) VALUES (1, ?, 12)').run(now - DAY);
const swept = sweepOrphanHistory();
check('orphan sweep removes history for deleted entities', swept === 2, String(swept));
check('...and leaves live entities’ history alone',
    db.prepare('SELECT count(*) n FROM samples_hourly WHERE entity_id = 1').get().n === 1
    && db.prepare('SELECT count(*) n FROM samples WHERE entity_id = 1').get().n === 2);
check('sweep is idempotent: second run finds nothing', sweepOrphanHistory() === 0);

// --- historySummary (pure) ---
const empty = historySummary(0, null, 90, now);
check('no history: nulls, not zeros pretending to be data',
    empty.heldDays === null && empty.bytesPerDay === null && empty.projectedBytes === null);

const young = historySummary(96e3, now - 600, 90, now);
check('under an hour held: size reported, rate and projection withheld',
    young.dbBytes === 96e3 && young.heldDays !== null && young.bytesPerDay === null && young.projectedBytes === null,
    JSON.stringify(young));

const growing = historySummary(412e6, now - 37 * DAY, 90, now);
check('growing: rate is size over span', Math.round(growing.bytesPerDay) === Math.round(412e6 / 37),
    String(growing.bytesPerDay));
check('...projection scales the real file to the window',
    growing.projectedBytes === Math.round((412e6 / 37) * 90) && !growing.steady,
    String(growing.projectedBytes));

const steady = historySummary(1.0e9, now - 91 * DAY, 90, now);
check('span past the window reports steady state', steady.steady === true);

const skewed = historySummary(5e6, now + 3600, 90, now);
check('clock skew (oldest in the future) degrades to honest nulls',
    skewed.bytesPerDay === null && skewed.projectedBytes === null);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall retention checks passed');
process.exit(failures ? 1 : 0);
