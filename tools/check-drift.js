'use strict';
// Verifies the SNMP-drift handling: a v1-era agent that fails a whole GET
// because one stored instance no longer exists must cost that one metric, not
// the whole device.
//
//   node tools/check-drift.js
//
// The field case this comes from: a domain controller renumbered its
// HOST-RESOURCES instances across a reboot, the poller kept asking for
// hrProcessorLoad.6, the agent answered NoSuchName at the PDU level, and the
// device sat DOWN for hours while snmpwalk against it worked fine.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snmpcanvas-drift-'));
process.env.SNMPCANVAS_DATA = TMP;      // before ./db is required

const S = require('../server/snmp');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}

// --- offendingOid: which varbind the agent named -------------------------
const CHUNK = ['1.3.6.1.2.1.25.3.3.1.2.4', '1.3.6.1.2.1.25.3.3.1.2.6', '1.3.6.1.2.1.1.3.0'];
const snmpErr = (msg) => Object.assign(new Error(msg), { code: 'snmp' });

check('names the OID out of a real NoSuchName message',
    S.offendingOid(snmpErr('NoSuchName: 1.3.6.1.2.1.25.3.3.1.2.6'), CHUNK) === '1.3.6.1.2.1.25.3.3.1.2.6');
// The safety rule: an OID we did not ask for means the parse is wrong, and
// evicting on a wrong parse would drop a metric that is working.
check('refuses an OID that is not in the chunk',
    S.offendingOid(snmpErr('NoSuchName: 1.9.9.9.9.9'), CHUNK) === null);
check('refuses a message with no OID at all',
    S.offendingOid(snmpErr('GeneralError'), CHUNK) === null);
// Timeouts and auth failures are whole-request problems. Evicting a varbind
// because the device was unreachable would silently shrink the poll set.
// These messages deliberately CARRY a chunk OID so the error-code gate is the
// only thing that can refuse them - the first version used realistic messages
// with no OID in them, so the regex refused them anyway and the gate was
// never exercised. Planting the defect proved the check could not fail.
check('never evicts on a timeout, even when the message carries an OID', S.offendingOid(
    Object.assign(new Error('No response (timeout) while reading 1.3.6.1.2.1.25.3.3.1.2.6'),
        { code: 'timeout' }), CHUNK) === null);
check('never evicts on an auth failure, even when the message carries an OID', S.offendingOid(
    Object.assign(new Error('Authentication failed at 1.3.6.1.2.1.25.3.3.1.2.6'),
        { code: 'auth' }), CHUNK) === null);

// --- getMany: keep the request alive, report what was dropped ------------
// A fake session standing in for a v1-era agent: it refuses any GET whose
// varbind list contains a dead instance, naming the first one it meets.
function fakeSession(dead) {
    return {
        get(oids, cb) {
            const bad = oids.find((o) => dead.has(o));
            if (bad) return cb(Object.assign(new Error('NoSuchName: ' + bad), { code: 'snmp' }));
            cb(null, oids.map((oid) => ({ oid, type: 2, value: 42 })));
        }
    };
}

(async () => {
    const asked = ['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4'];

    const evicted = [];
    const values = await S.getMany(fakeSession(new Set(['1.1.1.3'])), asked, 25, evicted);
    check('one dead instance no longer fails the whole request',
        values.get('1.1.1.1') === 42 && values.get('1.1.1.2') === 42 && values.get('1.1.1.4') === 42);
    check('the dead instance reads as absent, like noSuchInstance',
        values.has('1.1.1.3') && values.get('1.1.1.3') === null);
    check('and it is reported so the caller can flag its entity',
        evicted.length === 1 && evicted[0] === '1.1.1.3', JSON.stringify(evicted));

    const twoEvicted = [];
    const twoValues = await S.getMany(fakeSession(new Set(['1.1.1.1', '1.1.1.4'])), asked, 25, twoEvicted);
    check('several dead instances in one chunk all get evicted',
        twoEvicted.length === 2 && twoValues.get('1.1.1.2') === 42, JSON.stringify(twoEvicted));

    // The control: an error it cannot attribute must still fail loudly. A
    // partial reading returned as if it were whole is the failure this
    // project keeps naming - absence of data reading as data.
    let threw = null;
    try {
        await S.getMany({ get: (o, cb) => cb(Object.assign(new Error('No response (timeout)'), { code: 'timeout' })) },
            asked, 25, []);
    } catch (err) { threw = err; }
    check('an unattributable failure still throws', threw !== null && /timeout/i.test(threw.message));

    // Bound check: an agent that refuses everything must not spin.
    const allDead = new Set(asked);
    let bounded = null;
    try {
        await S.getMany(fakeSession(allDead), asked, 25, []);
    } catch (err) { bounded = err; }
    check('an agent refusing every varbind terminates (evictions are bounded)',
        bounded === null || /NoSuchName/.test(bounded.message));

    // --- untracking is opt-in ------------------------------------------
    // The automatic re-index runs moments after a reboot, which is exactly
    // when a switch may answer with a partly-populated ifTable. `tracked` is
    // operator-assigned, so only a human-initiated Rediscover may retire an
    // entity; the automatic path flags it and leaves it alone. Nothing ever
    // re-tracks an entity, so a wrong untrack is permanent and silent.
    const { db } = require('../server/db');
    const { reconcileDevice } = require('../server/reconcile');
    const now = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO devices (id, name, host, snmp_version, status, created_ts) VALUES (7, 'sw', '203.0.113.5', '2c', 'up', ?)").run(now);
    const insEnt = db.prepare("INSERT INTO entities (id, device_id, kind, snmp_index, name, tracked, code) VALUES (?, 7, 'if', ?, ?, 1, ?)");
    insEnt.run(71, '1', 'ge-0/0/1', 'D1');
    insEnt.run(72, '2', 'ge-0/0/2', 'D2');   // the one a partial probe misses
    // A probe that saw only interface 1 - the "saw 1 of 2" case the existing
    // kind guard does NOT cover.
    const partial = { system: {}, vendorKey: null, identity: {},
        entities: [{ kind: 'if', snmpIndex: '1', name: 'ge-0/0/1', tracked: true, extra: {} }] };

    const auto = reconcileDevice({ id: 7, name: 'sw' }, partial, { untrack: false });
    const afterAuto = db.prepare('SELECT tracked, stale FROM entities WHERE id = 72').get();
    check('automatic re-index does NOT untrack a missing entity',
        afterAuto.tracked === 1, JSON.stringify(afterAuto));
    check('...but flags it stale, so it is not silent',
        afterAuto.stale === 1 && auto.flagged.length === 1, JSON.stringify(auto.flagged));

    const manual = reconcileDevice({ id: 7, name: 'sw' }, partial, { untrack: true });
    const afterManual = db.prepare('SELECT tracked FROM entities WHERE id = 72').get();
    check('manual Rediscover DOES untrack it (a human asked)',
        afterManual.tracked === 0 && manual.removed.length === 1, JSON.stringify(manual.removed));


    // --- a re-dealt index must not relabel the row that held it --------
    // Fixture from a real desktop (4000D-Dake, 2026-09-01): after its agent
    // renumbered every ifIndex, the tracked 10GbE row was renamed in place to
    // "vSwitch (External Virtual Switch)" and later "Loopback Pseudo-Interface
    // 1", keeping the NIC's Gb/s history, tracked flag and short code while
    // polling a loopback - and the real NIC sat at a new index, untracked,
    // never sampled. Name at a changed index is the witness; the row follows.
    db.prepare("INSERT INTO devices (id, name, host, snmp_version, status, created_ts) VALUES (8, 'desk', '203.0.113.6', '2c', 'up', ?)").run(now);
    const ins8 = db.prepare("INSERT INTO entities (id, device_id, kind, snmp_index, name, tracked, code) VALUES (?, 8, 'if', ?, ?, ?, ?)");
    ins8.run(80, '6',  'Ethernet 3', 1, '69PS');                          // the NIC the operator tracks
    ins8.run(81, '11', 'vSwitch (External Virtual Switch)', 0, '5MR9');   // untracked, will take index 6
    ins8.run(82, '3',  'Wi-Fi 4', 0, '3P3F');                             // untracked, holds the index the NIC moves to
    const redeal = { system: {}, vendorKey: null, identity: {}, entities: [
        { kind: 'if', snmpIndex: '3',  name: 'Ethernet 3', tracked: true, extra: {} },
        { kind: 'if', snmpIndex: '6',  name: 'vSwitch (External Virtual Switch)', tracked: true, extra: {} },
        { kind: 'if', snmpIndex: '14', name: 'Wi-Fi 4', tracked: false, extra: {} },
    ] };
    const r1 = reconcileDevice({ id: 8, name: 'desk' }, redeal, { untrack: false });
    const nic = db.prepare('SELECT * FROM entities WHERE id = 80').get();
    check('a tracked row FOLLOWS its interface to the new index', nic.snmp_index === '3' && nic.name === 'Ethernet 3', JSON.stringify(nic));
    check('...keeping id, tracked, code and (therefore) its history', nic.tracked === 1 && nic.code === '69PS' && nic.stale === 0, JSON.stringify(nic));
    const vsw = db.prepare('SELECT * FROM entities WHERE id = 81').get();
    check('the row that now answers at the old index is the vSwitch row, moved - not the NIC row relabelled',
        vsw.snmp_index === '6' && vsw.name === 'vSwitch (External Virtual Switch)' && vsw.code === '5MR9', JSON.stringify(vsw));
    const wifi = db.prepare('SELECT * FROM entities WHERE id = 82').get();
    check('a three-way rotation lands every row without a UNIQUE collision', wifi.snmp_index === '14' && wifi.name === 'Wi-Fi 4', JSON.stringify(wifi));
    check('nothing was renamed in place and nothing was inserted',
        r1.updated.length === 0 && r1.added.length === 0 && r1.rebound.length === 3 && r1.parked.length === 0, JSON.stringify(r1));

    // --- ambiguity mints fresh rather than guessing ------------------------
    // Hyper-V recreates "vSwitch (Default Switch)" with a new GUID every boot,
    // so several same-named rows accumulate. When that name appears at a new
    // index there is no honest way to pick which history it continues.
    ins8.run(83, '4',  'vSwitch (Default Switch)', 0, '89ES');
    ins8.run(84, '24', 'vSwitch (Default Switch)', 0, '9QFE');
    const ambiguous = { system: {}, vendorKey: null, identity: {}, entities: [
        ...redeal.entities,
        { kind: 'if', snmpIndex: '29', name: 'vSwitch (Default Switch)', tracked: false, extra: {} },
        { kind: 'if', snmpIndex: '4',  name: 'Bluetooth Network Connection', tracked: false, extra: {} },
    ] };
    const r2 = reconcileDevice({ id: 8, name: 'desk' }, ambiguous, { untrack: false });
    const dsw = db.prepare("SELECT * FROM entities WHERE device_id = 8 AND snmp_index = '29'").get();
    check('two same-named candidates is ambiguous: a FRESH row is inserted rather than guessing',
        dsw && dsw.id > 84 && r2.added.length === 2, JSON.stringify(r2.added));
    const r83 = db.prepare('SELECT * FROM entities WHERE id = 83').get();
    check('...and the row displaced from index 4 is PARKED on a tombstone, name intact, flagged stale',
        r83.snmp_index === 'gone:4#83' && r83.name === 'vSwitch (Default Switch)' && r83.stale === 1, JSON.stringify(r83));
    check('the untouched duplicate keeps its index', db.prepare('SELECT snmp_index FROM entities WHERE id = 84').get().snmp_index === '24');

    // --- a genuine corpse: tracked, displaced, and nothing to rebind to ----
    ins8.run(95, '18', 'Old NIC', 1, 'OLDN');   // id well clear of the autoincrement the inserts above consumed
    const corpse = { system: {}, vendorKey: null, identity: {}, entities: [
        ...ambiguous.entities,
        { kind: 'if', snmpIndex: '18', name: '6to4 Adapter', tracked: false, extra: {} },
    ] };
    const r3 = reconcileDevice({ id: 8, name: 'desk' }, corpse, { untrack: false });
    const old = db.prepare('SELECT * FROM entities WHERE id = 95').get();
    check('the automatic path parks a displaced tracked row and leaves tracked ALONE (operator-owned)',
        old.snmp_index === 'gone:18#95' && old.stale === 1 && old.tracked === 1 && r3.parked.length === 1, JSON.stringify(old));
    check('...and does not report it twice (parked, not also flagged)', r3.flagged.length === 0, JSON.stringify(r3.flagged));
    const r4 = reconcileDevice({ id: 8, name: 'desk' }, corpse, { untrack: true });
    const retired = db.prepare('SELECT tracked, export, snmp_index FROM entities WHERE id = 95').get();
    check('a later human Rediscover retires the parked corpse', retired.tracked === 0 && retired.export === 0 && r4.removed.length === 1, JSON.stringify(retired));

    // --- a tombstone is never turned into an OID --------------------------
    const P = require('../server/poller');
    check('a parked if index is not pollable', P.isPollableIfIndex('gone:6#80') === false && P.isPollableIfIndex('moving:80') === false);
    check('a real ifIndex is', P.isPollableIfIndex('6') === true && P.isPollableIfIndex(14) === true);

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall drift checks passed');
    process.exit(failures ? 1 : 0);
})();
