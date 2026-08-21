'use strict';
// Pins the LAG flag and the premise behind the always-available speed
// override: ifType 161 (ieee8023adLag) marks a bundle whose advertised speed
// is usually ONE member's. The flag must fire for 161 exactly, stay quiet for
// plain ethernet, survive a JSON round trip that may hand back a string, and
// never throw on an entity with no extra at all - and it must reach the page
// through the same summary shape the device view receives.
//
//   node tools/check-lag.js

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.SNMPCANVAS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'snmpcanvas-lag-'));

const { isLag, entitySummary } = require('../server/api');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}

check('ifType 161 is a LAG', isLag({ ifType: 161 }) === true);
check('plain ethernet (6) is not', isLag({ ifType: 6 }) === false);
check('a string 161 from a JSON round trip still counts', isLag({ ifType: '161' }) === true);
check('no extra at all does not throw',
    isLag(null) === false && isLag(undefined) === false && isLag({}) === false);

// Through the real summary, as the device page receives it. A bond with no
// override must still report its partial claim honestly as ADVERTISED - the
// flag points at the problem, it does not invent a number.
const row = (extra) => ({
    id: 1, kind: 'if', snmp_index: '5', name: 'bond0', alias: '', code: null,
    speed_bps: 1e9, speed_untrusted: 0, speed_override_bps: null,
    tracked: 1, export: 0, stale: 0, admin_status: 1, oper_status: 1, extra
});
const bond = entitySummary(row('{"hc":1,"ifType":161}'), null);
check('entitySummary carries lag:true for a bond', bond.lag === true);
check('...and omits it for an access port', entitySummary(row('{"hc":1,"ifType":6}'), null).lag === undefined);
check('the bond still reports its partial claim as advertised, unmodified',
    bond.advertisedBps === 1e9 && bond.speedBps === 1e9, `${bond.advertisedBps} / ${bond.speedBps}`);

console.log(failures ? `\n${failures} FAILED` : '\nall lag checks passed');
process.exit(failures ? 1 : 0);
