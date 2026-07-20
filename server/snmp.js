'use strict';
// Thin promise wrapper around net-snmp. Everything SNMP-protocol-shaped lives
// here: session construction for v2c/v3, GETs with per-varbind error handling,
// column walks with runaway protection, and value coercion (Counter64 Buffers
// become BigInt - never Number).

const snmp = require('net-snmp');

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

const LEVELS = {
    noAuthNoPriv: snmp.SecurityLevel.noAuthNoPriv,
    authNoPriv:   snmp.SecurityLevel.authNoPriv,
    authPriv:     snmp.SecurityLevel.authPriv
};

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
        const level = LEVELS[c.v3_level] !== undefined ? c.v3_level : 'authPriv';
        const user = { name: c.v3_user || '', level: LEVELS[level] };
        if (level !== 'noAuthNoPriv') {
            user.authProtocol = AUTH_PROTOS[c.v3_auth_proto] || snmp.AuthProtocols.sha;
            user.authKey = c.v3_auth_key || '';
        }
        if (level === 'authPriv') {
            user.privProtocol = PRIV_PROTOS[c.v3_priv_proto] || snmp.PrivProtocols.aes;
            user.privKey = c.v3_priv_key || '';
        }
        return snmp.createV3Session(target.host, user, options);
    }
    return snmp.createSession(target.host, target.creds.community || 'public', options);
}

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

// GET an arbitrarily long OID list, chunked into PDUs of `per` varbinds.
async function getMany(session, oids, per = 25) {
    const out = new Map();
    for (let i = 0; i < oids.length; i += per) {
        const part = await get(session, oids.slice(i, i + per));
        for (const [k, v] of part) out.set(k, v);
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

module.exports = { createSession, get, getMany, walkColumn, closeQuietly, AUTH_PROTOS, PRIV_PROTOS, LEVELS };
