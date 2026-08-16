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

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall drift checks passed');
    process.exit(failures ? 1 : 0);
})();
