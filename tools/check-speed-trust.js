'use strict';
// Verifies the speed-trust mechanism end to end: the poller's conviction +
// clamp decision (speedTrustAndClamp) against a real database, and the
// exporter contract AlertCanvas keys on (speedBps > 0 gates utilization
// rules, so a nulled speed IS the alert fix).
//
//   node tools/check-speed-trust.js
//
// The bug class this pins: virtio/netvsc interfaces advertise fictional
// speeds; nightly replication then (a) alerted at 133-153% "utilization"
// and (b) had its fastest samples silently discarded by the 2x-advertised
// sanity clamp. Real-world acceptance cases: FreeBSD hn1 (Hyper-V netvsc)
// and a TrueNAS guest vtnet2 (virtio-net).

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snmpcanvas-speedtrust-'));
process.env.SNMPCANVAS_DATA = TMP;      // must be set before ./db is required

const { db, setSetting } = require('../server/db');
const { speedTrustAndClamp } = require('../server/poller');
const exporter = require('../server/exporter');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}

// --- fixture ----------------------------------------------------------------
const now = Math.floor(Date.now() / 1000);
db.prepare(`INSERT INTO devices (id, name, host, snmp_version, status, last_seen_ts, created_ts)
            VALUES (1, 'truenas', '10.0.0.9', '2c', 'up', ?, ?)`).run(now, now);
const insEnt = db.prepare(`INSERT INTO entities
    (id, device_id, kind, snmp_index, name, speed_bps, speed_untrusted, speed_override_bps, tracked, export, code)
    VALUES (?, 1, 'if', ?, ?, ?, ?, ?, 1, 1, ?)`);
insEnt.run(1, '1', 'vtnet2', 1e9, 0, null, 'AAAA');   // fiction-speed virtio
insEnt.run(2, '2', 'igb0', 1e9, 0, null, 'BBBB');     // honest 1G, 32-bit device
insEnt.run(3, '3', 'hn1', 10e9, 1, null, 'CCCC');     // already convicted
insEnt.run(4, '4', 'vtnet3', 1e9, 0, 10e9, 'DDDD');   // operator override 10G

const row = (id) => db.prepare('SELECT * FROM entities WHERE id = ?').get(id);

// --- 1. conviction: HC rate beyond the claim flips the persisted flag -------
{
    const e = row(1);
    const v = [1.5e9, 2e8, null, null, null, null];   // replication night on "1G" virtio
    speedTrustAndClamp(e, v, true, '10.0.0.9');
    check('fiction speed convicts on 64-bit evidence', row(1).speed_untrusted === 1);
    check('the convicting sample SURVIVES (no more discarded replication traffic)', v[0] === 1.5e9, String(v[0]));
}

// --- 2. jitter tolerance: 1.05x is timing noise, not fiction ----------------
{
    db.prepare('UPDATE entities SET speed_untrusted = 0 WHERE id = 1').run();
    const e = row(1);
    const v = [1.05e9, null, null, null, null, null];
    speedTrustAndClamp(e, v, true, '10.0.0.9');
    check('a 1.05x reading does not convict', row(1).speed_untrusted === 0);
    check('and the sample is kept', v[0] === 1.05e9);
    db.prepare('UPDATE entities SET speed_untrusted = 0 WHERE id = 1').run();
}

// --- 3. 32-bit counters cannot convict, and keep the old clamp --------------
{
    const e = row(2);
    const v = [3e9, null, null, null, null, null];    // wrap garbage on a real 1G
    speedTrustAndClamp(e, v, false, '10.0.0.9');
    check('32-bit garbage does not convict a real link', row(2).speed_untrusted === 0);
    check('and is clamped to a gap, as before', v[0] === null);
}

// --- 4. convicted interface: absolute ceiling only ---------------------------
{
    const e = row(3);
    const v = [15e9, 3e12, null, null, null, null];   // real 15G burst + true garbage
    speedTrustAndClamp(e, v, true, '10.0.0.9');
    check('unrated: real traffic above the fictional 2x is now KEPT', v[0] === 15e9);
    check('unrated: physically absurd rates still become gaps', v[1] === null);
}

// --- 5. operator override outranks everything --------------------------------
{
    const e = row(4);
    const v = [12e9, 25e9, null, null, null, null];
    speedTrustAndClamp(e, v, true, '10.0.0.9');
    check('override: traffic under 2x override is kept', v[0] === 12e9);
    check('override: traffic beyond 2x override is clamped', v[1] === null);
    check('override is never convicted', row(4).speed_untrusted === 0);
}

// --- 6. exporter contract: effective speed is what AlertCanvas divides by ----
setSetting('export_path', path.join(TMP, 'snmp-status.json'));
db.prepare("INSERT INTO samples (entity_id, ts, status, v0, v1) VALUES (1, ?, 1, 5e8, 1e8)").run(now);
db.prepare("INSERT INTO samples (entity_id, ts, status, v0, v1) VALUES (3, ?, 1, 15e9, 1e9)").run(now);
db.prepare("INSERT INTO samples (entity_id, ts, status, v0, v1) VALUES (4, ?, 1, 12e9, 1e9)").run(now);
db.prepare('UPDATE entities SET speed_untrusted = 1 WHERE id = 3').run();
exporter.write();
const feed = JSON.parse(fs.readFileSync(path.join(TMP, 'snmp-status.json'), 'utf8'));
const byName = Object.fromEntries(feed.interfaces.map((i) => [i.name, i]));
check('trusted interface exports its advertised speed', byName.vtnet2.speedBps === 1e9);
check('UNRATED interface exports speedBps null (AlertCanvas util rules go quiet)',
    byName.hn1.speedBps === null, JSON.stringify(byName.hn1.speedBps));
check('overridden interface exports the override', byName.vtnet3.speedBps === 10e9);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall speed-trust checks passed');
process.exit(failures ? 1 : 0);
