'use strict';
// Does the Settings concurrency field actually reach the running poll loop, and
// does POLL_CONCURRENCY still win where a deployment sets it?
//
//   node tools/check-concurrency.js
//
// Both halves matter and they pull in opposite directions. The field exists
// because telling a small team to edit a compose file and restart a container
// was a dead end. The environment variable still has to win, because an
// explicit deployment decision should not be silently overridden from a web
// page - and if it ever stopped winning, the UI would go on cheerfully
// reporting a number the loop was not using.
//
// The loop re-reads the setting once per 5s tick, so each half waits one tick.
// Two modes cannot share a process (the env var is read at module load), so
// this re-runs itself as two children.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const MODE = process.env.CHECK_MODE;

if (!MODE) {
    const { spawnSync } = require('node:child_process');
    let failed = 0;
    for (const mode of ['setting', 'env']) {
        console.log(`\n--- ${mode === 'env' ? 'POLL_CONCURRENCY=24 in the environment' : 'no environment variable'} ---`);
        const env = { ...process.env, CHECK_MODE: mode };
        if (mode === 'env') env.POLL_CONCURRENCY = '24'; else delete env.POLL_CONCURRENCY;
        const r = spawnSync(process.execPath, [__filename], { env, stdio: 'inherit' });
        if (r.status !== 0) failed++;
    }
    console.log(failed ? `\n${failed} mode(s) FAILED` : '\nconcurrency is settable and the environment still wins');
    process.exit(failed ? 1 : 0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snmpcanvas-conc-'));
process.env.SNMPCANVAS_DATA = TMP;

const { getSetting, setSetting } = require('../server/db');
const poller = require('../server/poller');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}

poller.start();
const before = poller.health();

if (MODE === 'env') {
    check('the environment value is in force', before.concurrency === 24, String(before.concurrency));
    check('health reports the source as env', before.concurrencySource === 'env', before.concurrencySource);
    setSetting('poll_concurrency', 99);   // must be ignored
} else {
    check('defaults to 16', before.concurrency === 16, String(before.concurrency));
    check('health reports the source as setting', before.concurrencySource === 'setting', before.concurrencySource);
    setSetting('poll_concurrency', 48);
}

// One tick, plus a margin.
setTimeout(() => {
    const after = poller.health();
    if (MODE === 'env') {
        check('a stored setting cannot override the environment', after.concurrency === 24, String(after.concurrency));
    } else {
        check('the change reaches the live poll loop', after.concurrency === 48, String(after.concurrency));
        check('the value round-trips through settings', getSetting('poll_concurrency') === '48', getSetting('poll_concurrency'));
    }
    poller.stop();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* windows file locks */ }
    process.exit(failures ? 1 : 0);
}, 6500);
