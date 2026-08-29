'use strict';
// DES privacy is offered by the credential form and cannot be performed by a
// stock OpenSSL 3 build. This drives the refusal directly, because the bug it
// replaces was invisible by construction: net-snmp accepts the protocol and
// fails much later inside the cipher with
//     error:0308010C:digital envelope routines::unsupported
// which names neither DES nor SNMP nor anything to act on. The observed cost
// on this fleet was an operator concluding they had mistyped their own
// snmpwalk command, months before the cipher was suspected at all.
//
//   node tools/check-des.js
//
// Both worlds are driven EXPLICITLY (desOk true and false), so this file says
// the same thing on a machine running --openssl-legacy-provider and one not.

const S = require('../server/snmp');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}
const des = (over) => ({ v3_level: 'authPriv', v3_priv_proto: 'des', ...over });

// --- the refusal, and what it must say ------------------------------------
const msg = S.privProtoProblem(des(), false);
check('DES at authPriv is refused when the build cannot perform it',
    typeof msg === 'string' && msg.length > 0);
// The OPENING CLAUSE has to name it, not a mention buried in the remedy: an
// operator scanning a red toast reads the first few words. A weaker
// `msg.includes('DES')` passed while the message opened with "That privacy
// protocol...", which is the exact vagueness this whole check exists to kill.
check('...and its OPENING CLAUSE names DES, so nobody blames their own typing',
    !!msg && msg.split(':')[0].includes('DES'), msg ? msg.split(':')[0] : '');
check('...and names the way back in, for a device that speaks nothing else',
    !!msg && msg.includes('--openssl-legacy-provider'));
check('...and names AES as the ordinary answer', !!msg && msg.includes('AES'));

// --- the other world ------------------------------------------------------
check('DES is allowed where the build CAN perform it',
    S.privProtoProblem(des(), true) === null);

// --- only DES, and only where privacy is actually used --------------------
check('no AES variant is ever refused',
    S.privProtoProblem({ v3_level: 'authPriv', v3_priv_proto: 'aes' }, false) === null &&
    S.privProtoProblem({ v3_level: 'authPriv', v3_priv_proto: 'aes256b' }, false) === null &&
    S.privProtoProblem({ v3_level: 'authPriv', v3_priv_proto: 'aes256r' }, false) === null);
check('authNoPriv never encrypts, so DES there is not a problem',
    S.privProtoProblem(des({ v3_level: 'authNoPriv' }), false) === null);
check('...nor at noAuthNoPriv', S.privProtoProblem(des({ v3_level: 'noAuthNoPriv' }), false) === null);
check('v2c credentials are untouched', S.privProtoProblem({ community: 'public' }, false) === null);
check('absent credentials are not a problem', S.privProtoProblem(null, false) === null);

// The defaulting here must MATCH createSession's, or this could permit a
// credential the session builder then encrypts with DES anyway.
check('an absent level defaults to authPriv, exactly as createSession does',
    typeof S.privProtoProblem({ v3_priv_proto: 'des' }, false) === 'string');
check('...and so does an unrecognized level',
    typeof S.privProtoProblem(des({ v3_level: 'nonsense' }), false) === 'string');

// --- the backstop ---------------------------------------------------------
// Credentials stored before this check existed never pass through the API
// guard again; they reach createSession directly on the next poll.
const live = S.desUsable();
check('desUsable() answers with a boolean', typeof live === 'boolean');
let threw = null;
let sess = null;
try {
    sess = S.createSession({ host: '127.0.0.1', port: 161, version: '3',
        creds: { v3_user: 'u', v3_level: 'authPriv', v3_auth_proto: 'sha', v3_auth_key: 'k',
                 v3_priv_proto: 'des', v3_priv_key: 'k' } });
} catch (err) { threw = err.message; }
if (sess) S.closeQuietly(sess);
if (live) {
    check('this build performs DES, so createSession builds the session',
        threw === null, 'legacy provider present');
} else {
    check('createSession refuses stored DES creds with the explaining message',
        !!threw && threw.includes('DES'), threw || 'did not throw');
}

console.log(failures ? `\n${failures} FAILED` : '\nall DES checks passed');
process.exit(failures ? 1 : 0);
