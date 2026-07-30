'use strict';
// Verifies the snmp-status.json contract that PingCanvas and AlertCanvas read.
//
//   node tools/check-export.js
//
// This is a CROSS-APP contract, which is why it is worth a test of its own: a
// change here breaks a different repository than the one being edited, and it
// breaks it silently - a kiosk whose annotations stop binding still renders a
// perfectly good board with no numbers on it.
//
// It builds a throwaway database, seeds entities, and runs the REAL exporter,
// so nothing here can pass while the shipped writer disagrees with it.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snmpcanvas-export-'));
process.env.SNMPCANVAS_DATA = TMP;      // must be set before ./db is required

const { db, setSetting } = require('../server/db');
const exporter = require('../server/exporter');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}

// --- fixture ----------------------------------------------------------------
const now = Math.floor(Date.now() / 1000);
// export_uptime = 1 so the device-uptime metric is actually in the feed. Without
// it the uptime block never runs, and every assertion about metrics[] below is
// blind to the one entry that is built by hand rather than mapped - which is
// exactly how an ISO sampledAt survived there through the whole v4 migration.
// uptime_code is set explicitly: db.js backfills codes at require time, which is
// before this fixture inserts anything.
db.prepare(`INSERT INTO devices (id, name, host, snmp_version, status, last_seen_ts, created_ts,
                                 export_uptime, uptime_code, last_sysuptime_cs)
            VALUES (1, 'core-sw1', '10.0.0.2', '2c', 'up', ?, ?, 1, 'U7TM', 4320000)`).run(now, now);
db.prepare(`INSERT INTO entities (id, device_id, kind, snmp_index, name, alias, speed_bps, export, code, admin_status, oper_status, stale)
            VALUES (1, 1, 'if', '1', 'Gi0/1', 'uplink to fw', 1000000000, 1, 'K7Q2', 1, 1, 0)`).run();
// A second interface that has gone STALE - the flag exists so a consumer can
// tell "0 bps" from "we have not heard about this port lately", and dropping it
// would silently turn the second into the first.
db.prepare(`INSERT INTO entities (id, device_id, kind, snmp_index, name, alias, speed_bps, export, code, admin_status, oper_status, stale)
            VALUES (2, 1, 'if', '2', 'Gi0/2', '', 1000000000, 1, 'M4XB', 1, 2, 1)`).run();
db.prepare(`INSERT INTO entities (id, device_id, kind, snmp_index, name, export, code)
            VALUES (3, 1, 'cpu', '1', 'CPU', 1, 'P9RT')`).run();

const ins = db.prepare('INSERT INTO samples (entity_id, ts, status, v0, v1, v2, v3, v4, v5) VALUES (?,?,?,?,?,?,?,?,?)');
// Error rates are deliberately FRACTIONAL: a port doing one CRC error a minute
// is 0.0167/s, and rounding that to an integer reports zero errors on a port
// that is quietly failing.
ins.run(1, now, 1, 12345678.9, 234567.4, 0.0167, 0, 0, 0);
ins.run(2, now - 3600, 2, 0, 0, 0, 0, 0, 0);
ins.run(3, now, null, 37.5, null, null, null, null, null);
setSetting('export_path', path.join(TMP, 'snmp-status.json'));

// --- run the real exporter --------------------------------------------------
exporter.setHealthSource(() => ({ behind: false, overdueDevices: 0, worstLateS: 0, concurrency: 16 }));
exporter.write();
const err = exporter.getLastError();
if (err) { console.error('exporter reported:', err); process.exit(1); }

const raw = fs.readFileSync(path.join(TMP, 'snmp-status.json'), 'utf8');
const doc = JSON.parse(raw);
const ifs = doc.interfaces || [];
const mets = doc.metrics || [];
const one = ifs.find((i) => i.code === 'K7Q2') || {};

console.log(`${raw.length} bytes, ${ifs.length} interfaces, ${mets.length} metrics, ${(doc.devices || []).length} devices\n`);

check('schemaVersion is 4', doc.schemaVersion === 4, String(doc.schemaVersion));
check('device is a plain string, not an object', typeof one.device === 'string', JSON.stringify(one.device));
check('the per-interface id field is gone', !('id' in one));
check('sampledAt is epoch seconds', typeof one.sampledAt === 'number' && one.sampledAt > 1e9, String(one.sampledAt));
// EVERY metric, not mets[0]. Device-uptime rows are pushed AFTER the mapped ones,
// so an index-0 check structurally cannot reach them, and null is legitimate (no
// sample yet) - so the check also requires at least one real epoch value or it
// could pass on a feed where nothing was ever stamped.
const badTs = mets.filter((m) => m.sampledAt !== null && typeof m.sampledAt !== 'number');
const someTs = mets.some((m) => typeof m.sampledAt === 'number' && m.sampledAt > 1e9);
check('EVERY metric carries epoch sampledAt or null', mets.length > 0 && badTs.length === 0 && someTs,
    badTs.length
        ? `${badTs.length} non-numeric, first: ${badTs[0].kind} ${JSON.stringify(badTs[0].sampledAt)}`
        : (someTs ? `${mets.length} checked` : 'none carried a real epoch value'));
check('the device-uptime metric is in the feed', mets.some((m) => m.kind === 'uptime'),
    JSON.stringify(mets.map((m) => m.kind)));
check('devices[] still carries host and status', !!(doc.devices || [])[0]?.host, JSON.stringify((doc.devices || [])[0]));
check('poller health is published', !!doc.poller && doc.poller.behind === false, JSON.stringify(doc.poller));

// Every interface must resolve to a device in devices[] - that join is how a
// consumer attributes a port to a box.
const known = new Set((doc.devices || []).map((d) => d.name));
const orphans = ifs.filter((i) => !known.has(i.device));
check('every interface joins devices[]', orphans.length === 0, `${orphans.length} orphan(s)`);

const stale = ifs.find((i) => i.code === 'M4XB');
check('stale is present on a stale interface', stale && stale.stale === true, JSON.stringify(stale && stale.stale));
check('stale is ABSENT on a fresh one, not false', !('stale' in one), JSON.stringify(one.stale));

check('throughput is rounded to whole bps', ifs.filter((i) => i.inBps != null).every((i) => Number.isInteger(i.inBps)),
    JSON.stringify(ifs.map((i) => i.inBps)));
check('fractional error rates survive rounding', one.inErrorsPerSec > 0 && !Number.isInteger(one.inErrorsPerSec),
    String(one.inErrorsPerSec));

check('written minified (no pretty-print padding)', !/\n\s\s/.test(raw), `${raw.length} bytes`);

// The three keys a board annotation can bind to. If any stops being derivable
// the kiosk silently shows nothing for that port.
check('short code is exported', one.code === 'K7Q2', one.code);
check('ifName is exported', one.name === 'Gi0/1', one.name);
check('alias is exported', one.alias === 'uplink to fw', one.alias);

db.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) FAILED` : '\nexport contract intact');
process.exit(failures ? 1 : 0);
