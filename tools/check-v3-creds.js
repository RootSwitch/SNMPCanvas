'use strict';
// SNMPv3 credential spellings: what happens when a protocol name is not one of
// ours. It used to be `AUTH_PROTOS[x] || sha` and `PRIV_PROTOS[x] || aes`, so
// an unrecognized string quietly became a DIFFERENT protocol and the agent
// answered "wrong digest" - telling the operator their PASSWORD was bad when
// the typo was in the PROTOCOL NAME. A failure that names the wrong thing is
// worse than one that names nothing.
//
//   node tools/check-v3-creds.js
//
// Two properties are load-bearing here and they pull in opposite directions,
// which is why this is a file and not a one-line guard:
//   REFUSE a name we do not recognize, rather than guessing which was meant.
//   ACCEPT the spellings people actually type, or an install that has been
//   quietly riding the old fallback (it sent "SHA", and the device really does
//   speak sha) breaks on upgrade for a credential that was working fine.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.SNMPCANVAS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'snmpcanvas-v3creds-'));

const S = require('../server/snmp');
const { credsFromBody } = require('../server/api');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}
// desOk stays true throughout: this file is about NAMES. Whether the build can
// perform DES is check-des.js's subject, and mixing them would make failures
// here depend on which OpenSSL the test machine carries.
const problem = (c) => S.v3CredProblem(c, true);
const authPriv = (over) => ({ v3_level: 'authPriv', v3_auth_proto: 'sha', v3_priv_proto: 'aes', ...over });

// --- the bug: a typo must never become a different protocol ---------------
const badAuth = problem(authPriv({ v3_auth_proto: 'sha-2566' }));
check('an unrecognized auth protocol is REFUSED, not silently SHA',
    typeof badAuth === 'string');
check('...and the refusal quotes what was actually sent',
    !!badAuth && badAuth.includes('sha-2566'));
check('...and lists what would have worked', !!badAuth && badAuth.includes('sha256'));

const badPriv = problem(authPriv({ v3_priv_proto: 'aes-129' }));
check('an unrecognized privacy protocol is REFUSED, not silently AES',
    typeof badPriv === 'string' && badPriv.includes('aes-129'));
const badLevel = problem(authPriv({ v3_level: 'encrypted' }));
check('an unrecognized security level is REFUSED, not silently authPriv',
    typeof badLevel === 'string' && badLevel.includes('encrypted'));

// --- ambiguity gets its own answer, because guessing here is expensive -----
for (const spelling of ['aes256', 'AES-256', 'aes-256-cfb']) {
    const m = problem(authPriv({ v3_priv_proto: spelling }));
    check(`"${spelling}" is refused as ambiguous, naming BOTH variants`,
        typeof m === 'string' && m.includes('aes256b') && m.includes('aes256r'));
}

// --- generosity: the spellings people actually type ------------------------
// Every one of these is unambiguous, so refusing them would be pedantry that
// breaks working installs.
const AUTH_OK = [['SHA', 'sha'], ['sha1', 'sha'], ['SHA-1', 'sha'], ['HMAC-SHA', 'sha'],
    ['SHA-256', 'sha256'], ['HMAC-SHA256', 'sha256'], ['sha_512', 'sha512'], ['MD5', 'md5']];
const PRIV_OK = [['AES', 'aes'], ['aes-128', 'aes'], ['AES-128-CFB', 'aes'],
    ['aes256b', 'aes256b'], ['AES-256-Blumenthal', 'aes256b'],
    ['aes256r', 'aes256r'], ['AES-256-C', 'aes256r'], ['aes256cisco', 'aes256r']];
const LEVEL_OK = [['authPriv', 'authPriv'], ['priv', 'authPriv'], ['AUTHPRIV', 'authPriv'],
    ['auth', 'authNoPriv'], ['authNoPriv', 'authNoPriv'],
    ['noauth', 'noAuthNoPriv'], ['noAuthNoPriv', 'noAuthNoPriv']];

for (const [typed, want] of AUTH_OK) {
    const r = S.resolveV3(authPriv({ v3_auth_proto: typed }));
    check(`auth "${typed}" resolves to ${want} and is accepted`,
        r.authProto === want && problem(authPriv({ v3_auth_proto: typed })) === null, r.authProto);
}
for (const [typed, want] of PRIV_OK) {
    const r = S.resolveV3(authPriv({ v3_priv_proto: typed }));
    check(`priv "${typed}" resolves to ${want} and is accepted`,
        r.privProto === want && problem(authPriv({ v3_priv_proto: typed })) === null, r.privProto);
}
for (const [typed, want] of LEVEL_OK) {
    const r = S.resolveV3(authPriv({ v3_level: typed }));
    check(`level "${typed}" resolves to ${want} and is accepted`,
        r.level === want && problem(authPriv({ v3_level: typed })) === null, r.level);
}

// --- the invariant that keeps a fix from becoming the same bug -------------
// Whatever resolveV3 returns must be a real key in the protocol tables. If it
// were not, createSession would hand net-snmp `undefined` and we would be back
// to a silent substitution by a different road.
const strays = [];
for (const [typed] of AUTH_OK) {
    if (S.AUTH_PROTOS[S.resolveV3(authPriv({ v3_auth_proto: typed })).authProto] === undefined) strays.push(typed);
}
for (const [typed] of PRIV_OK) {
    if (S.PRIV_PROTOS[S.resolveV3(authPriv({ v3_priv_proto: typed })).privProto] === undefined) strays.push(typed);
}
for (const [typed] of LEVEL_OK) {
    if (S.LEVELS[S.resolveV3(authPriv({ v3_level: typed })).level] === undefined) strays.push(typed);
}
check('every canonical value indexes a real protocol table', strays.length === 0, strays.join(', '));

// --- absent is not a typo (the property that protects upgrades) -----------
check('absent fields keep their documented defaults', problem({ v3_user: 'u' }) === null);
const d = S.resolveV3({ v3_user: 'u' });
check('...and those defaults are authPriv / sha / aes',
    d.level === 'authPriv' && d.authProto === 'sha' && d.privProto === 'aes');
check('empty strings behave as absent, not as typos',
    problem({ v3_level: '', v3_auth_proto: '', v3_priv_proto: '' }) === null);
check('v2c credentials are untouched', problem({ community: 'public' }) === null);

// --- only the fields the level actually uses are judged -------------------
check('nonsense privacy does not matter at authNoPriv',
    problem({ v3_level: 'authNoPriv', v3_auth_proto: 'sha', v3_priv_proto: 'nonsense' }) === null);
check('nonsense auth does not matter at noAuthNoPriv',
    problem({ v3_level: 'noAuthNoPriv', v3_auth_proto: 'nonsense' }) === null);

// --- and it reaches the session builder, both ways ------------------------
let threw = null;
let sess = null;
try {
    sess = S.createSession({ host: '127.0.0.1', port: 161, version: '3',
        creds: { v3_user: 'u', v3_level: 'authPriv', v3_auth_proto: 'sha-2566',
                 v3_auth_key: 'k', v3_priv_proto: 'aes', v3_priv_key: 'k' } });
} catch (err) { threw = err.message; }
if (sess) S.closeQuietly(sess);
check('createSession refuses a typo instead of substituting SHA',
    !!threw && threw.includes('sha-2566'), threw || 'did not throw');

let good = null;
let goodErr = null;
try {
    good = S.createSession({ host: '127.0.0.1', port: 161, version: '3',
        creds: { v3_user: 'u', v3_level: 'authPriv', v3_auth_proto: 'SHA-256',
                 v3_auth_key: 'k', v3_priv_proto: 'AES', v3_priv_key: 'k' } });
} catch (err) { goodErr = err.message; }
if (good) S.closeQuietly(good);
check('a credential written in CLI spelling still builds a session',
    !!good && !goodErr, goodErr || '');

// --- the route layer must not normalize the guard blind -------------------
// Found by driving the deployed build rather than by reading it: the API had
// its OWN silent substitution one layer earlier, whitelisting the level and
// replacing anything else with authPriv, so a nonsense level reached the guard
// already laundered and was never refused. A guard is only as honest as what
// reaches it.
const bodyOf = (over) => credsFromBody({ version: '3', v3_user: 'u', v3_auth_key: 'k',
    v3_priv_key: 'k', ...over });
check('a nonsense level SURVIVES credsFromBody, so the guard can refuse it',
    bodyOf({ v3_level: 'encrypted' }).v3_level === 'encrypted');
check('...and the guard does refuse it',
    typeof problem(bodyOf({ v3_level: 'encrypted' })) === 'string');
check('an alias survives too, and resolves rather than being eaten',
    bodyOf({ v3_level: 'priv' }).v3_level === 'priv' &&
    problem(bodyOf({ v3_level: 'priv' })) === null &&
    S.resolveV3(bodyOf({ v3_level: 'priv' })).level === 'authPriv');
check('an absent level still defaults to authPriv at the route layer',
    bodyOf({}).v3_level === 'authPriv' && problem(bodyOf({})) === null);
check('the canonical spellings are unchanged by the round trip',
    bodyOf({ v3_level: 'noAuthNoPriv' }).v3_level === 'noAuthNoPriv' &&
    bodyOf({ v3_level: 'authNoPriv' }).v3_level === 'authNoPriv');
check('v2c bodies still come back as a community', credsFromBody({ version: '2c',
    community: 'public' }).community === 'public');

console.log(failures ? `\n${failures} FAILED` : '\nall v3 credential checks passed');
process.exit(failures ? 1 : 0);
