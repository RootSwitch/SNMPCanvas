'use strict';
// One undecodable SNMP response must fail one poll, not kill the application.
//
//   node tools/check-decode-crash.js
//
// THE BUG THIS GUARDS. net-snmp's Session extends EventEmitter and emits
// 'error' from onMsg when a response cannot be decoded (3.26.3, index.js:2417,
// inside the Message.createFromBuffer catch). In Node an 'error' event with NO
// registered listener is THROWN rather than dropped - a language rule, not a
// library quirk - so it surfaced as an uncaught exception.
//
// SNMPCanvas is a single process. The poller, the API and the web UI share it,
// so this was never a degraded poll: one malformed datagram took the whole
// application down. The trigger is any misbehaving device it polls, or anything
// able to land a datagram on the session's source port - a firmware bug is
// enough, malice is optional. For a tool whose job is talking to equipment it
// does not control, that is reachable in normal operation.
//
// BOTH HALVES ARE ASSERTED, because either alone proves nothing:
//
//   guarded  server/snmp.js createSession - must SURVIVE and report the host.
//   raw      snmp.createSession direct, no listener - must DIE. This is the
//            fault-arrived half. If the raw child also survives, the garbage
//            never reached the decoder and the guarded pass is meaningless.
//
// Each half runs as its own child, because the failing one exits the process
// by design and cannot share one with the test.

const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PORT = parseInt(process.env.CHECK_PORT || '16199', 10);
const MODE = process.env.CHECK_MODE;
const ROOT = path.join(__dirname, '..');

// --- the children -------------------------------------------------------------

if (MODE === 'guarded' || MODE === 'raw') {
    const target = { host: '127.0.0.1', port: PORT, version: '2c', creds: { community: 'public' } };
    let session;

    if (MODE === 'guarded') {
        session = require(path.join(ROOT, 'server', 'snmp.js')).createSession(target);
    } else {
        const snmp = require('net-snmp');
        session = snmp.createSession(target.host, 'public', {
            port: PORT, retries: 0, timeout: 2000, version: snmp.Version2c
        });
    }

    // sysDescr. The response never decodes, so this callback is not the point -
    // what matters is whether the process is alive a second later.
    session.get(['1.3.6.1.2.1.1.1.0'], () => { /* timeout or error, both fine */ });

    setTimeout(() => {
        console.log('STILL-ALIVE');
        try { session.close(); } catch (_) { /* already closed */ }
        process.exit(0);
    }, 3000);
    return;
}

// --- the parent ---------------------------------------------------------------

console.log('an undecodable SNMP response must not kill the process\n');

const agent = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-agent.js')], {
    env: { ...process.env, MOCK_GARBAGE: '1', MOCK_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
});
let agentOut = '';
agent.stdout.on('data', (b) => { agentOut += b.toString(); });
agent.stderr.on('data', (b) => { agentOut += b.toString(); });

let pass = 0;
let fail = 0;
const ok = (l) => { pass++; console.log(`  ok   ${l}`); };
const bad = (l, d) => { fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d)); };

function runChild(mode) {
    return spawnSync(process.execPath, [__filename], {
        env: { ...process.env, CHECK_MODE: mode, CHECK_PORT: String(PORT) },
        encoding: 'utf8',
        timeout: 15000
    });
}

setTimeout(() => {
    // The fault-arrived half FIRST, so a broken garbage responder is reported
    // as that rather than as a passing guard.
    const raw = runChild('raw');
    const rawOut = `${raw.stdout || ''}${raw.stderr || ''}`;
    if (raw.status !== 0 && !rawOut.includes('STILL-ALIVE')) {
        ok('an UNGUARDED session dies on the undecodable response - the fault reached the decoder');
        const line = rawOut.split('\n').find((l) => /Error|error/.test(l));
        if (line) console.log(`         ${line.trim().slice(0, 110)}`);
    } else {
        bad('the unguarded session SURVIVED - the garbage never reached the decoder, '
            + 'so the guarded result below proves nothing', `exit ${raw.status}`);
    }

    const guarded = runChild('guarded');
    const guardedOut = `${guarded.stdout || ''}${guarded.stderr || ''}`;
    if (guarded.status === 0 && guardedOut.includes('STILL-ALIVE')) {
        ok('the GUARDED session survives the same response - one poll fails, the app lives');
    } else {
        bad('the guarded session died - server/snmp.js is not attaching its listener',
            `exit ${guarded.status}`);
    }

    // A device sending undecodable responses is worth knowing about, so the log
    // has to name it. "Something failed" sends nobody anywhere.
    if (/session error from 127\.0\.0\.1/.test(guardedOut)) {
        ok('and the log names the host that sent it');
    } else {
        bad('the guarded session recovered silently - the offending host is not named', guardedOut.slice(0, 200));
    }

    agent.kill();
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}, 1200);
