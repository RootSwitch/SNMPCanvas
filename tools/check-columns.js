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

// Tier B fixtures on edge-sw: temperature ladder (a hotter NVMe must NOT
// beat the CPU sensor), fullest-FS pick (never sum - ZFS-style shared
// space), and memory pct.
insEnt.run(9, 1, 'temp', '1', 'CPU Temp', null, 0, null, null, null, 'C9');
insEnt.run(10, 1, 'temp', '2', 'NVMe Composite', null, 0, null, null, null, 'C10');
insEnt.run(11, 1, 'fs', '1', 'zroot', null, 0, null, null, null, 'C11');
insEnt.run(12, 1, 'fs', '2', 'zroot/vm', null, 0, null, null, null, 'C12');
insEnt.run(13, 1, 'mem', '1', 'Real memory', null, 0, null, null, null, 'C13');
insS.run(9, now, 46, null, null, null);        // CPU 46C
insS.run(10, now, 61, null, null, null);       // NVMe hotter - must not win
insS.run(11, now, 820e9, 1000e9, null, null);  // zroot 82%
insS.run(12, now, 120e9, 400e9, null, null);   // child dataset 30%
insS.run(13, now, 6.2e9, 8e9, null, null);     // 77.5%
// ups-1: a lone unnamed-family sensor falls back to max-of-all (itself).
insEnt.run(14, 2, 'temp', '1', 'Battery Temperature', null, 0, null, null, null, 'C14');
insS.run(14, now, 24, null, null, null);

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

check('temperature ladder: CPU sensor beats a hotter peripheral',
    rows['edge-sw'].temp.c === 46 && /CPU/.test(rows['edge-sw'].temp.name),
    JSON.stringify(rows['edge-sw'].temp));
check('...and reports how many sensors it chose from', rows['edge-sw'].temp.of === 2);
check('no name match falls back to max-of-all',
    rows['ups-1'].temp.c === 24 && rows['ups-1'].temp.of === 1,
    JSON.stringify(rows['ups-1'].temp));
check('fullest FS is a pick, not a sum', rows['edge-sw'].fs.name === 'zroot' && Math.round(rows['edge-sw'].fs.pct) === 82,
    JSON.stringify(rows['edge-sw'].fs));
check('memory reports used/total pct', Math.round(rows['edge-sw'].mem.pct) === 78,
    JSON.stringify(rows['edge-sw'].mem));
check('devices without temp/fs/mem stay null', rows.bare.temp === null && rows.bare.fs === null && rows.bare.mem === null);
check('an unmatched vendor key gives a null label, never a fake',
    rows['edge-sw'].vendorLabel === null);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall column checks passed');
process.exit(failures ? 1 : 0);
