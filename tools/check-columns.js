'use strict';
// Verifies the fleet-table aggregates behind the column picker: down ports,
// worst interface errors, health (worst-case over state sensors), UPS, and
// the effective-speed rule reaching the Top-usage percentage.
//
//   node tools/check-columns.js
//
// These are reductions with edge cases (admin-down ports must not count as
// down; absent sensor kinds must be N/A rather than a fake ok; an unrated
// interface must show raw bps with no percentage), driven against a seeded
// database through the same function the API serves.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snmpcanvas-columns-'));
process.env.SNMPCANVAS_DATA = TMP;      // must be set before ./db is required

const { db } = require('../server/db');
const { deviceListSummaries } = require('../server/api');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}

const now = Math.floor(Date.now() / 1000);
const insDev = db.prepare(`INSERT INTO devices (id, name, host, snmp_version, status, last_seen_ts, created_ts, sys_location)
                           VALUES (?, ?, ?, '2c', 'up', ?, ?, ?)`);
insDev.run(1, 'edge-sw', '10.0.0.2', now, now, 'closet A');
insDev.run(2, 'ups-1', '10.0.0.3', now, now, null);
insDev.run(3, 'bare', '10.0.0.4', now, now, null);

const insEnt = db.prepare(`INSERT INTO entities
    (id, device_id, kind, snmp_index, name, speed_bps, speed_untrusted, speed_override_bps,
     tracked, export, admin_status, oper_status, code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`);
// edge-sw: 4 interfaces - up, down-while-admin-up, admin-down (deliberate),
// and an unrated virtio carrying the busiest traffic.
insEnt.run(1, 1, 'if', '1', 'ge-0/0/1', 1e9, 0, null, 1, 1, 'C1');
insEnt.run(2, 1, 'if', '2', 'ge-0/0/2', 1e9, 0, null, 1, 2, 'C2');   // down, admin up -> counts
insEnt.run(3, 1, 'if', '3', 'ge-0/0/3', 1e9, 0, null, 2, 2, 'C3');   // admin down -> not counted
insEnt.run(4, 1, 'if', '4', 'vtnet0', 1e9, 1, null, 1, 1, 'C4');     // unrated
// edge-sw: two state sensors, one alarming.
insEnt.run(5, 1, 'state', '1', 'PSU 1', null, 0, null, null, null, 'C5');
insEnt.run(6, 1, 'state', '2', 'PSU 2', null, 0, null, null, null, 'C6');
// ups-1: battery + runtime, no interfaces.
insEnt.run(7, 2, 'battery', '1', 'Charge', null, 0, null, null, null, 'C7');
insEnt.run(8, 2, 'runtime', '1', 'Runtime', null, 0, null, null, null, 'C8');

const insS = db.prepare('INSERT INTO samples (entity_id, ts, status, v0, v1, v2, v3) VALUES (?, ?, 1, ?, ?, ?, ?)');
insS.run(1, now, 2e8, 1e8, 0.5, 0.25);      // errs 0.75/s
insS.run(2, now, 0, 0, 12.5, 0);            // errs 12.5/s - the worst
insS.run(4, now, 1.5e9, 3e8, 0, 0);         // busiest, on the unrated NIC
insS.run(5, now, 0, null, null, null);      // PSU 1 ok
insS.run(6, now, 1, null, null, null);      // PSU 2 ALARM
insS.run(7, now, 94, null, null, null);     // 94% charge
insS.run(8, now, 2760, null, null, null);   // 46m runtime

const rows = Object.fromEntries(deviceListSummaries().map((d) => [d.name, d]));

check('down ports counts oper-down while admin-up only', rows['edge-sw'].downPorts === 1,
    String(rows['edge-sw'].downPorts));
check('worst interface errors picks the worst, not the first', rows['edge-sw'].worstIfErrs === 12.5,
    String(rows['edge-sw'].worstIfErrs));
check('top usage lands on the busiest interface', rows['edge-sw'].topIf.name === 'vtnet0');
check('...with raw bps but NO percentage (unrated speed)', rows['edge-sw'].topIf.pct === null,
    JSON.stringify(rows['edge-sw'].topIf));
check('health is worst-case: one alarm makes the device alarm',
    rows['edge-sw'].health.state === 'alarm' && rows['edge-sw'].health.alarms === 1,
    JSON.stringify(rows['edge-sw'].health));
check('location carries sysLocation', rows['edge-sw'].sysLocation === 'closet A');
check('UPS charge and runtime ride together', rows['ups-1'].ups.chargePct === 94 && rows['ups-1'].ups.runtimeS === 2760,
    JSON.stringify(rows['ups-1'].ups));
check('no interfaces means zero down ports and null errors',
    rows['ups-1'].downPorts === 0 && rows['ups-1'].worstIfErrs === null);
check('a device with no sensors gets N/A health, never a fake ok', rows.bare.health === null);
check('a device with no battery gets no UPS cell', rows.bare.ups === null);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall column checks passed');
process.exit(failures ? 1 : 0);
