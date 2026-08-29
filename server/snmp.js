'use strict';
// Thin promise wrapper around net-snmp. Everything SNMP-protocol-shaped lives
// here: session construction for v2c/v3, GETs with per-varbind error handling,
// column walks with runaway protection, and value coercion (Counter64 Buffers
// become BigInt - never Number).

const snmp = require('net-snmp');
const crypto = require('node:crypto');

const AUTH_PROTOS = {
    md5:    snmp.AuthProtocols.md5,
    sha:    snmp.AuthProtocols.sha,
    sha224: snmp.AuthProtocols.sha224,
    sha256: snmp.AuthProtocols.sha256,
    sha384: snmp.AuthProtocols.sha384,
    sha512: snmp.AuthProtocols.sha512
};

// aes256b (Blumenthal) and aes256r (Reeder/Cisco-style) are incompatible
// key-localization variants of AES-256 - devices use one or the other, and
// picking the wrong one looks exactly like a bad password.
const PRIV_PROTOS = {
    des:     snmp.PrivProtocols.des,
    aes:     snmp.PrivProtocols.aes,
    aes256b: snmp.PrivProtocols.aes256b,
    aes256r: snmp.PrivProtocols.aes256r
};

// --- privacy protocol availability ---------------------------------------
// OpenSSL 3 moved SINGLE DES to its legacy provider, so a stock Node build
// cannot perform it. net-snmp accepts the protocol and fails much later, deep
// inside the cipher, with
//     error:0308010C:digital envelope routines::unsupported
// which names neither DES, nor SNMP, nor anything to do about it. The measured
// cost of that silence is an operator concluding they mistyped their own
// snmpwalk and moving on - it happened on this fleet, on a PDU walk, months
// before anyone suspected the cipher. 3DES and AES are unaffected; only single
// DES was removed.
//
// DETECTED, never assumed: --openssl-legacy-provider genuinely restores it
// (measured, not inferred), so a device that speaks nothing but DES - some
// v3-only BMCs offer no better - stays monitorable, and the refusal below
// names that way back in rather than just saying no.
let desUsableCache = null;
function desUsable() {
    if (desUsableCache === null) {
        try {
            crypto.createCipheriv('des-cbc', Buffer.alloc(8), Buffer.alloc(8));
            desUsableCache = true;
        } catch (_) {
            desUsableCache = false;
        }
    }
    return desUsableCache;
}

const LEVELS = {
    noAuthNoPriv: snmp.SecurityLevel.noAuthNoPriv,
    authNoPriv:   snmp.SecurityLevel.authNoPriv,
    authPriv:     snmp.SecurityLevel.authPriv
};

// --- v3 credential spelling ----------------------------------------------
// The protocol tables above are keyed by this app's canonical spellings, and
// the credential form only ever sends those - but the API accepts whatever it
// is handed. An unrecognized string used to fall through `|| sha` and
// `|| aes` and silently become a DIFFERENT protocol, which reaches the wire
// as "wrong digest": the operator is told their PASSWORD is wrong when the
// typo was in the PROTOCOL NAME. That is worse than the DES error it sits
// beside, because a failure naming the WRONG thing sends you looking in the
// wrong place, where one naming nothing at least leaves you suspicious of
// everything.
//
// So: canonicalize GENEROUSLY, refuse only what is left. Generous is a safety
// property here, not a convenience - an install quietly living on the old
// fallback (it passed "SHA", and the device really does speak SHA) keeps
// working, while a real typo now stops instead of guessing. The spellings are
// the ones people type when mirroring a working snmpwalk or an agent's own
// createUser line.
const spell = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

const AUTH_SPELLINGS = {
    md5: 'md5', hmacmd5: 'md5',
    sha: 'sha', sha1: 'sha', hmacsha: 'sha', hmacsha1: 'sha',
    sha224: 'sha224', hmacsha224: 'sha224',
    sha256: 'sha256', hmacsha256: 'sha256',
    sha384: 'sha384', hmacsha384: 'sha384',
    sha512: 'sha512', hmacsha512: 'sha512'
};
const PRIV_SPELLINGS = {
    des: 'des', descbc: 'des',
    aes: 'aes', aes128: 'aes', aescfb128: 'aes', aes128cfb: 'aes',
    aes256b: 'aes256b', aes256blumenthal: 'aes256b',
    aes256r: 'aes256r', aes256c: 'aes256r', aes256reeder: 'aes256r', aes256cisco: 'aes256r'
};
// Bare AES-256 names the cipher but NOT the key-localization scheme, and the
// two schemes are incompatible. Recognized as a family so it can be refused
// with an explanation rather than filed under "unknown protocol" - or, far
// worse, guessed.
const AMBIGUOUS_AES256 = new Set(['aes256', 'aes256cfb']);
// rouser and snmpwalk vocabulary alongside our own.
const LEVEL_SPELLINGS = {
    authpriv: 'authPriv', priv: 'authPriv',
    authnopriv: 'authNoPriv', auth: 'authNoPriv',
    noauthnopriv: 'noAuthNoPriv', noauth: 'noAuthNoPriv'
};

// Canonical { level, authProto, privProto }. An ABSENT field keeps its
// documented default, because omitting what you do not use is not a typo and
// refusing it would break every caller that sends only what it needs. A field
// that is present but unrecognized resolves to undefined, for v3CredProblem to
// refuse by name.
function resolveV3(creds) {
    const c = creds || {};
    const l = spell(c.v3_level), a = spell(c.v3_auth_proto), p = spell(c.v3_priv_proto);
    return {
        level:     l ? LEVEL_SPELLINGS[l] : 'authPriv',
        authProto: a ? AUTH_SPELLINGS[a]  : 'sha',
        privProto: p ? PRIV_SPELLINGS[p]  : 'aes'
    };
}

// An operator-facing reason these credentials cannot work, or null when they
// can. Called where credentials are ACCEPTED, so a doomed choice is refused
// while the operator is still looking at the form it came from, and again at
// session construction, which catches credentials stored before these checks
// existed. Only the fields the chosen level actually USES are judged: a
// nonsense privacy protocol is nobody's problem at authNoPriv. `desOk` is
// injectable so the tests can drive both OpenSSL worlds on any machine.
function v3CredProblem(creds, desOk) {
    if (!creds) return null;
    const { level, authProto, privProto } = resolveV3(creds);
    if (!level) {
        return 'Unknown SNMPv3 security level "' + creds.v3_level + '". ' +
               'Use authPriv, authNoPriv, or noAuthNoPriv.';
    }
    if (level !== 'noAuthNoPriv' && !authProto) {
        return 'Unknown SNMPv3 auth protocol "' + creds.v3_auth_proto + '". ' +
               'Use one of: md5, sha, sha224, sha256, sha384, sha512.';
    }
    if (level === 'authPriv') {
        if (AMBIGUOUS_AES256.has(spell(creds.v3_priv_proto))) {
            return '"' + creds.v3_priv_proto + '" does not say WHICH AES-256: use aes256b ' +
                   '(Blumenthal) or aes256r (Reeder / Cisco). They are incompatible ' +
                   'key-localization schemes, and the wrong one fails exactly like a wrong privacy ' +
                   'password - so this is the one place a guess would cost more than a question.';
        }
        if (!privProto) {
            return 'Unknown SNMPv3 privacy protocol "' + creds.v3_priv_proto + '". ' +
                   'Use one of: des, aes, aes256b, aes256r.';
        }
        if (privProto === 'des' && !(desOk === undefined ? desUsable() : desOk)) {
            return 'DES privacy is not available in this build: OpenSSL 3 moved single DES to its legacy ' +
                   'provider. Choose AES-128 or AES-256 if the device offers either. If it speaks nothing ' +
                   'but DES, start the server with NODE_OPTIONS=--openssl-legacy-provider.';
        }
    }
    return null;
}

const log = (...args) => console.log(new Date().toISOString(), '[snmp]', ...args);

// A device that sends undecodable responses will send more than one, so the
// log is rate limited per host rather than per packet.
const lastDecodeErrLog = new Map();
const DECODE_ERR_QUIET_MS = 30000;

/**
 * Attach the 'error' listener that keeps one bad packet from killing the app.
 *
 * WHY THIS EXISTS. net-snmp's Session extends EventEmitter and emits 'error'
 * from onMsg when a response cannot be decoded (3.26.3, index.js:2417, inside
 * the Message.createFromBuffer catch). In Node an 'error' event with NO
 * registered listener is THROWN, not dropped - that is a language rule, not a
 * library quirk - so it became an uncaught exception.
 *
 * SNMPCanvas is a single process. The poller, the API and the web UI share it,
 * so this was not a degraded poll: one undecodable response took the whole
 * application down, and the trigger is any misbehaving device it polls or
 * anything able to land a malformed UDP datagram on the session's source port.
 * For a tool whose job is talking to equipment it does not control, that is
 * reachable in normal operation rather than only under attack.
 *
 * The listener degrades the failure to what it should always have been: this
 * one request fails on its own timeout, the session is closed by its caller,
 * and every other poll continues. The host is named because a device emitting
 * undecodable responses is worth knowing about in its own right - it is usually
 * a firmware bug or a mismatched v3 configuration.
 *
 * NOT A CATCH-ALL. A separate net-snmp bug means socket-level errors never
 * reach here at all; see the note below createSession.
 */
function guard(session, host) {
    session.on('error', (err) => {
        const now = Date.now();
        const last = lastDecodeErrLog.get(host) || 0;
        if (now - last > DECODE_ERR_QUIET_MS) {
            lastDecodeErrLog.set(host, now);
            log(`session error from ${host}: ${err && err.message ? err.message : err}`
                + ` (this poll fails; further session errors from this host are quiet for`
                + ` ${DECODE_ERR_QUIET_MS / 1000}s)`);
        }
    });
    return session;
}

// target: { host, port, version: '2c'|'3', creds: { community } |
//          { v3_user, v3_level, v3_auth_proto, v3_auth_key, v3_priv_proto, v3_priv_key } }
function createSession(target) {
    const options = {
        port: target.port || 161,
        retries: 1,
        timeout: 5000,
        version: target.version === '3' ? snmp.Version3
               : target.version === '1' ? snmp.Version1   // discovery fallback for GetBulk-broken agents
               : snmp.Version2c
    };
    if (target.version === '3') {
        const c = target.creds;
        // Backstop for credentials saved before these checks existed: fail with
        // the sentence that names the cause, rather than with the cipher's own
        // noise or by quietly substituting a protocol nobody chose.
        const credProblem = v3CredProblem(c);
        if (credProblem) throw new Error(credProblem);
        const canon = resolveV3(c);
        const user = { name: c.v3_user || '', level: LEVELS[canon.level] };
        if (canon.level !== 'noAuthNoPriv') {
            user.authProtocol = AUTH_PROTOS[canon.authProto];
            user.authKey = c.v3_auth_key || '';
        }
        if (canon.level === 'authPriv') {
            user.privProtocol = PRIV_PROTOS[canon.privProto];
            user.privKey = c.v3_priv_key || '';
        }
        // BOTH return paths are guarded. v3 is the one more likely to receive
        // something it cannot decode, because a key or protocol mismatch
        // produces a response that fails to authenticate rather than a clean
        // error - so guarding only the v2c path would have left the likelier
        // trigger open.
        return guard(snmp.createV3Session(target.host, user, options), target.host);
    }
    return guard(
        snmp.createSession(target.host, target.creds.community || 'public', options),
        target.host
    );
}

// A SECOND net-snmp BUG, WHICH NOTHING HERE CAN FIX, recorded so that a
// mystifying symptom has a written cause.
//
//     Session.prototype.onError = function (error) { this.emit (error); };
//
// (3.26.3, index.js:2409.) The Error object is passed as the EVENT NAME
// instead of emit("error", error). That handler is the only one registered for
// the session socket (index.js:2094), so every dgram-level failure - EACCES on
// a privileged source port, EHOSTUNREACH or ENETUNREACH from an ICMP error,
// EMFILE when the poller runs out of descriptors - is emitted under a nonsense
// event name and vanishes. The guard above cannot see them, because they are
// not 'error' events; and for the same reason they do not throw either. They
// silently do nothing.
//
// The symptom is a poll that degrades to a bare timeout with no stated cause,
// which on a large fleet is indistinguishable from a slow device. If timeouts
// appear across many hosts at once, suspect a socket-level cause - descriptor
// exhaustion above all - rather than the devices.
//
// One line upstream fixes it. Until then there is no workaround here, which is
// why this is a comment and a docs entry rather than code.

// Coerce a varbind value to a JS value. Counter64 arrives as a raw Buffer.
function coerce(vb) {
    if (vb.type === snmp.ObjectType.Counter64) {
        const buf = vb.value;
        if (!Buffer.isBuffer(buf) || buf.length === 0) return 0n;
        return BigInt('0x' + buf.toString('hex'));
    }
    if (Buffer.isBuffer(vb.value)) return vb.value.toString('utf8');
    return vb.value;
}

// GET a list of OIDs. Resolves to a Map(oid -> value); OIDs the agent doesn't
// have (noSuchObject/noSuchInstance/endOfMibView) map to null. Rejects only on
// request-level failure (timeout, auth error, decode error).
function get(session, oids) {
    return new Promise((resolve, reject) => {
        if (oids.length === 0) return resolve(new Map());
        session.get(oids, (err, varbinds) => {
            if (err) return reject(translateError(err));
            const out = new Map();
            for (let i = 0; i < varbinds.length; i++) {
                const vb = varbinds[i];
                out.set(oids[i], snmp.isVarbindError(vb) ? null : coerce(vb));
            }
            resolve(out);
        });
    });
}

// The offending OID out of a PDU-level error, or null. net-snmp builds its
// message as "<status>: <oid>" from the response's errorIndex, so the agent
// has already named the varbind it choked on. Trusted only when that OID is
// one we actually asked for in this chunk - a parse that finds anything else
// is a parse that is wrong, and evicting on it would drop a live metric.
function offendingOid(err, chunk) {
    if (!err || err.code !== 'snmp') return null;   // timeouts/auth are not per-varbind
    const m = /(\d+(?:\.\d+){3,})/.exec(String(err.message || ''));
    return m && chunk.includes(m[1]) ? m[1] : null;
}

// A v1-era agent answers a GET containing one dead instance with a PDU-level
// NoSuchName that fails the WHOLE request, where a v2c agent returns
// noSuchInstance for that varbind and answers the rest. Windows is the common
// case, for an architectural reason: its extension-subagent API predates v2c,
// so subagent DLLs can only return v1 error codes and the master agent
// forwards them inside v2c responses. One instance renumbering after a reboot
// therefore took an entire device DOWN until someone ran Rediscover by hand.
const MAX_EVICTIONS_PER_CHUNK = 6;

// GET an arbitrarily long OID list, chunked into PDUs of `per` varbinds.
// `evicted` (optional) collects OIDs dropped to keep the request alive, so a
// caller can flag the entities that own them; passing an array in rather than
// changing the return type keeps the Map contract every caller already reads.
async function getMany(session, oids, per = 25, evicted = null) {
    const out = new Map();
    for (let i = 0; i < oids.length; i += per) {
        let chunk = oids.slice(i, i + per);
        for (let drops = 0; chunk.length > 0; drops++) {
            try {
                const part = await get(session, chunk);
                for (const [k, v] of part) out.set(k, v);
                break;
            } catch (err) {
                // Bounded, and it re-throws when it cannot name a culprit: an
                // unexplained failure must still fail the poll loudly rather
                // than quietly returning a partial reading as if it were whole.
                const bad = drops < MAX_EVICTIONS_PER_CHUNK ? offendingOid(err, chunk) : null;
                if (!bad) throw err;
                if (evicted) evicted.push(bad);
                out.set(bad, null);                 // absent, exactly like noSuchInstance
                chunk = chunk.filter((o) => o !== bad);
            }
        }
    }
    return out;
}

// Walk one table column. Resolves to Array<{ index, value }> where `index` is
// the OID suffix after the column base (e.g. ifIndex, or a multi-part index).
// Guards against broken agents: subtree-prefix enforcement, a hard row cap,
// and a stall detector. The stall guard matters: some agents answer a GetBulk
// on a subtree they don't implement by echoing the requested OID as an error
// varbind forever instead of advancing past it, and net-snmp's subtree() will
// re-request in a tight loop until the process dies. Every varbind in such a
// batch is filtered out (error / out-of-prefix), so "a batch that contributed
// no rows" is the loop's signature - and on a healthy walk it only happens at
// the very end, where stopping is a no-op.
function walkColumn(session, baseOid, maxRows = 10000) {
    return new Promise((resolve, reject) => {
        const rows = [];
        const prefix = baseOid + '.';
        let stopped = false;
        session.subtree(baseOid, 20, (varbinds) => {
            const before = rows.length;
            for (const vb of varbinds) {
                if (snmp.isVarbindError(vb)) continue;
                if (!vb.oid.startsWith(prefix)) continue;
                rows.push({ index: vb.oid.slice(prefix.length), value: coerce(vb) });
                if (rows.length >= maxRows) { stopped = true; return true; } // stop walk
            }
            if (rows.length === before) { stopped = true; return true; }     // stalled walk
        }, (err) => {
            if (err && !stopped) return reject(translateError(err));
            resolve(rows);
        });
    });
}

// Turn net-snmp errors into messages a person adding a device can act on.
function translateError(err) {
    const msg = String(err && err.message || err);
    const e = new Error(msg);
    e.original = err;
    if (err instanceof snmp.RequestTimedOutError || /timed out/i.test(msg)) {
        e.code = 'timeout';
        e.message = 'No response (timeout) - check the address, that SNMP is enabled, and any ACLs.';
    } else if (/usmStatsWrongDigests|authentication|digest/i.test(msg)) {
        e.code = 'auth';
        e.message = 'Authentication failed - wrong auth password or auth protocol.';
    } else if (/usmStatsUnknownUserNames|unknown user/i.test(msg)) {
        e.code = 'auth';
        e.message = 'Unknown SNMPv3 user.';
    } else if (/usmStatsDecryptionErrors|decrypt/i.test(msg)) {
        e.code = 'auth';
        e.message = 'Decryption failed - wrong privacy password or protocol (note: AES-256 has two variants, try the other).';
    } else if (/usmStatsNotInTimeWindows/i.test(msg)) {
        e.code = 'retry';
        e.message = 'SNMPv3 time window sync - try again.';
    } else {
        e.code = 'snmp';
    }
    return e;
}

function closeQuietly(session) {
    try { session.close(); } catch (_) { /* already closed */ }
}

module.exports = { createSession, get, getMany, walkColumn, closeQuietly, offendingOid,
    desUsable, v3CredProblem, resolveV3, AUTH_PROTOS, PRIV_PROTOS, LEVELS };
