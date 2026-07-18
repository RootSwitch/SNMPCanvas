'use strict';
// All /api/* handlers. Routes are (method, regex) pairs dispatched by
// server.js; bodies are JSON in and JSON out. Mutating routes require
// Content-Type: application/json (cross-site forms can't send it - CSRF belt
// on top of the SameSite=Lax cookie).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, getSetting, setSetting, saveCredentials, loadCredentials, generateIfCode, DATA_DIR } = require('./db');
const auth = require('./auth');
const discover = require('./discover');
const poller = require('./poller');
const exporter = require('./exporter');
const inventory = require('./inventory');

// Reject an export path that would let an authenticated user overwrite the
// application's own files (e.g. public/app.js). The exporter writes JSON here
// and renames over the target, so an unconstrained path is an arbitrary-file
// clobber of anything the node user owns. Allow the data dir and any mounted
// volume outside the app tree (the suite deploy points this at PingCanvas's
// data folder), but never a path inside the app source.
const APP_ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.resolve(DATA_DIR);
function exportPathError(v) {
    if (!v) { return 'Export path cannot be empty.'; }
    if (!/\.json$/i.test(v)) { return 'Export path must end in .json'; }
    const resolved = path.resolve(v);
    const inApp = resolved === APP_ROOT || resolved.startsWith(APP_ROOT + path.sep);
    const inData = resolved === DATA_ROOT || resolved.startsWith(DATA_ROOT + path.sep);
    if (inApp && !inData) {
        return 'Export path may not write inside the application directory - use the data folder or a mounted export volume.';
    }
    return null;
}

// --- probe tokens: creds from a successful probe are held server-side for a
// few minutes so the confirm step never round-trips secrets through the page.
const probes = new Map(); // token -> { target, result, expires }
const PROBE_TTL_MS = 10 * 60 * 1000;

function sweepProbes() {
    const now = Date.now();
    for (const [k, v] of probes) if (v.expires <= now) probes.delete(k);
}

// --- tiny helpers ---
function json(res, status, body) {
    const buf = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buf);
}
const ok = (res, body = { ok: true }) => json(res, 200, body);
const bad = (res, msg) => json(res, 400, { error: msg });
const notFound = (res) => json(res, 404, { error: 'not found' });

function clientIp(req) {
    // Behind the reverse proxy the README recommends for TLS, every request
    // arrives from the proxy's address - so keying the login limiter on
    // socket.remoteAddress alone would let one attacker's failures lock out
    // everyone. Honor X-Forwarded-For ONLY when the operator asserts a trusted
    // proxy via TRUST_PROXY=1; otherwise a client could spoof the header to
    // evade the limiter or lock out an arbitrary IP. Take the first hop (the
    // original client) that a trusted proxy prepends.
    if (process.env.TRUST_PROXY === '1') {
        const xff = req.headers['x-forwarded-for'];
        if (xff) {
            const first = String(xff).split(',')[0].trim();
            if (first) { return first; }
        }
    }
    return req.socket.remoteAddress || 'unknown';
}

function effectiveInterval(device) {
    return device.poll_interval_s || parseInt(getSetting('poll_interval_s'), 10) || 300;
}

// Uptime for display: last known sysUpTime plus wall time since, while up.
function uptimeSeconds(device) {
    if (device.status !== 'up' || device.last_sysuptime_cs == null) return null;
    const sinceSeen = Math.max(0, Math.floor(Date.now() / 1000) - (device.last_seen_ts || 0));
    return Math.floor(device.last_sysuptime_cs / 100) + sinceSeen;
}

function deviceSummary(d) {
    return {
        id: d.id, name: d.name, host: d.host, port: d.port, snmpVersion: d.snmp_version,
        sysDescr: d.sys_descr || '', sysName: d.sys_name || '', vendorKey: d.vendor_key,
        enabled: !!d.enabled, status: d.status, notes: d.notes || '',
        exportUptime: !!d.export_uptime, uptimeCode: d.uptime_code || null,
        lastPollTs: d.last_poll_ts, lastSeenTs: d.last_seen_ts,
        uptimeSeconds: uptimeSeconds(d),
        pollIntervalS: d.poll_interval_s, effectiveIntervalS: effectiveInterval(d)
    };
}

function entitySummary(e, latest) {
    const extra = e.extra ? JSON.parse(e.extra) : {};
    return {
        id: e.id, kind: e.kind, snmpIndex: e.snmp_index, name: e.name, alias: e.alias || '', code: e.code || null,
        speedBps: e.speed_bps, tracked: !!e.tracked, export: !!e.export, stale: !!e.stale,
        adminStatus: e.admin_status, operStatus: e.oper_status,
        hc: extra.hc !== undefined ? !!extra.hc : undefined,
        latest: latest ? { ts: latest.ts, status: latest.status, v: [latest.v0, latest.v1, latest.v2, latest.v3, latest.v4, latest.v5] } : null
    };
}

function credsFromBody(body) {
    if (body.version === '3') {
        return {
            v3_user: String(body.v3_user || ''),
            v3_level: ['noAuthNoPriv', 'authNoPriv', 'authPriv'].includes(body.v3_level) ? body.v3_level : 'authPriv',
            v3_auth_proto: String(body.v3_auth_proto || 'sha'),
            v3_auth_key: String(body.v3_auth_key || ''),
            v3_priv_proto: String(body.v3_priv_proto || 'aes'),
            v3_priv_key: String(body.v3_priv_key || '')
        };
    }
    return { community: String(body.community || 'public') };
}

// --- route table ---
// handler(req, res, params, body). `authRequired: false` routes are public.
const routes = [
    { method: 'GET', path: /^\/api\/health$/, authRequired: false, handler: (req, res) => ok(res, { ok: true, version: require('../package.json').version }) },

    { method: 'GET', path: /^\/api\/session$/, authRequired: false, handler: (req, res) => {
        const authed = auth.validateSession(auth.tokenFromRequest(req));
        ok(res, { authenticated: authed, needsSetup: !auth.passwordIsSet() });
    } },

    { method: 'POST', path: /^\/api\/setup$/, authRequired: false, handler: (req, res, p, body) => {
        if (auth.passwordIsSet()) return json(res, 409, { error: 'already configured' });
        if (!body.password || String(body.password).length < 8) return bad(res, 'Password must be at least 8 characters.');
        auth.setPassword(String(body.password));
        const token = auth.createSession();
        res.setHeader('Set-Cookie', auth.sessionCookie(token));
        ok(res);
    } },

    { method: 'POST', path: /^\/api\/login$/, authRequired: false, handler: (req, res, p, body) => {
        const ip = clientIp(req);
        if (!auth.loginAllowed(ip)) return json(res, 429, { error: 'Too many attempts - wait a minute.' });
        if (!auth.checkPassword(String(body.password || ''))) {
            auth.recordLoginFailure(ip);
            return json(res, 401, { error: 'Wrong password.' });
        }
        auth.recordLoginSuccess(ip);
        const token = auth.createSession();
        res.setHeader('Set-Cookie', auth.sessionCookie(token));
        ok(res);
    } },

    { method: 'POST', path: /^\/api\/logout$/, authRequired: false, handler: (req, res) => {
        auth.destroySession(auth.tokenFromRequest(req));
        res.setHeader('Set-Cookie', auth.clearCookie());
        ok(res);
    } },

    { method: 'GET', path: /^\/api\/devices$/, handler: (req, res) => {
        const devices = db.prepare('SELECT * FROM devices ORDER BY name COLLATE NOCASE').all();
        const ifCount = db.prepare("SELECT count(*) AS n FROM entities WHERE device_id = ? AND kind = 'if' AND tracked = 1");
        const cpuEnt = db.prepare("SELECT id FROM entities WHERE device_id = ? AND kind = 'cpu' AND tracked = 1 LIMIT 1");
        const ifEnts = db.prepare("SELECT id, name, speed_bps FROM entities WHERE device_id = ? AND kind = 'if' AND tracked = 1");
        const latest = db.prepare('SELECT v0, v1 FROM samples WHERE entity_id = ? ORDER BY ts DESC LIMIT 1');
        ok(res, { devices: devices.map((d) => {
            // CPU % - null when the device has no CPU entity (shown as N/A).
            const cpu = cpuEnt.get(d.id);
            const cpuSample = cpu ? latest.get(cpu.id) : null;
            // Busiest interface right now: highest of in/out bps across
            // tracked interfaces, with utilization % when the speed is known.
            let topIf = null;
            for (const e of ifEnts.all(d.id)) {
                const s = latest.get(e.id);
                if (!s) continue;
                const bps = Math.max(s.v0 ?? -1, s.v1 ?? -1);
                if (bps < 0) continue;
                if (!topIf || bps > topIf.bps) {
                    topIf = { entityId: e.id, name: e.name, bps, pct: e.speed_bps > 0 ? bps / e.speed_bps * 100 : null };
                }
            }
            return {
                ...deviceSummary(d),
                interfaceCount: ifCount.get(d.id).n,
                cpuPct: cpuSample ? cpuSample.v0 : null,
                topIf
            };
        }) });
    } },

    { method: 'POST', path: /^\/api\/devices\/probe$/, handler: async (req, res, p, body) => {
        sweepProbes();
        const host = String(body.host || '').trim();
        if (!host) return bad(res, 'Host is required.');
        const version = body.version === '3' ? '3' : '2c';
        const target = {
            host,
            port: Math.min(65535, Math.max(1, parseInt(body.port, 10) || 161)),
            version,
            creds: credsFromBody(body)
        };
        try {
            const result = await discover.probe(target);
            const token = crypto.randomBytes(16).toString('base64url');
            probes.set(token, { target, result, expires: Date.now() + PROBE_TTL_MS });
            ok(res, { probeToken: token, system: result.system, vendorKey: result.vendorKey, entities: result.entities, warnings: result.warnings });
        } catch (err) {
            json(res, 502, { error: err.message, code: err.code || 'snmp' });
        }
    } },

    { method: 'POST', path: /^\/api\/devices$/, handler: (req, res, p, body) => {
        sweepProbes();
        const probe = probes.get(String(body.probeToken || ''));
        if (!probe) return bad(res, 'Probe expired - run the test again.');
        const { target, result } = probe;
        const name = String(body.name || result.system.sysName || target.host).trim() || target.host;
        const chosen = new Map((Array.isArray(body.entities) ? body.entities : []).map((e) => [`${e.kind}:${e.snmpIndex}`, !!e.tracked]));
        const interval = body.pollIntervalS ? Math.max(30, parseInt(body.pollIntervalS, 10) || 0) || null : null;

        const deviceId = db.transaction(() => {
            const info = db.prepare(`INSERT INTO devices
                (name, host, port, snmp_version, sys_descr, sys_object_id, sys_name, vendor_key, poll_interval_s, created_ts, uptime_code)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(name, target.host, target.port, target.version, result.system.sysDescr,
                     result.system.sysObjectID, result.system.sysName, result.vendorKey, interval,
                     Math.floor(Date.now() / 1000), generateIfCode(name, 'uptime'));
            const id = info.lastInsertRowid;
            saveCredentials(id, target.creds);
            const ins = db.prepare(`INSERT INTO entities (device_id, kind, snmp_index, name, alias, speed_bps, extra, tracked, admin_status, oper_status, code)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            for (const e of result.entities) {
                const tracked = chosen.has(`${e.kind}:${e.snmpIndex}`) ? chosen.get(`${e.kind}:${e.snmpIndex}`) : e.tracked;
                ins.run(id, e.kind, String(e.snmpIndex), e.name, e.alias || null, e.speedBps || null,
                        JSON.stringify(e.extra || {}), tracked ? 1 : 0, e.adminStatus || null, e.operStatus || null,
                        generateIfCode(name, e.name));
            }
            return id;
        })();
        probes.delete(String(body.probeToken));
        poller.deviceChanged(deviceId, true); // poll right away
        ok(res, { id: deviceId });
    } },

    { method: 'GET', path: /^\/api\/devices\/(\d+)$/, handler: (req, res, p) => {
        const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(p[0]);
        if (!d) return notFound(res);
        const latest = db.prepare('SELECT * FROM samples WHERE entity_id = ? ORDER BY ts DESC LIMIT 1');
        const entities = db.prepare('SELECT * FROM entities WHERE device_id = ? ORDER BY kind, CAST(snmp_index AS INTEGER), snmp_index').all(d.id)
            .map((e) => entitySummary(e, latest.get(e.id)));
        ok(res, { device: deviceSummary(d), entities });
    } },

    { method: 'PATCH', path: /^\/api\/devices\/(\d+)$/, handler: (req, res, p, body) => {
        const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(p[0]);
        if (!d) return notFound(res);
        const name = body.name !== undefined ? String(body.name).trim() : d.name;
        if (!name) return bad(res, 'Name cannot be empty.');
        const interval = body.pollIntervalS !== undefined
            ? (body.pollIntervalS ? Math.max(30, parseInt(body.pollIntervalS, 10) || 0) || null : null)
            : d.poll_interval_s;
        const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : d.enabled;
        const notes = body.notes !== undefined ? String(body.notes).slice(0, 2000) : d.notes;
        const exportUptime = body.exportUptime !== undefined ? (body.exportUptime ? 1 : 0) : d.export_uptime;
        db.prepare('UPDATE devices SET name = ?, poll_interval_s = ?, enabled = ?, notes = ?, export_uptime = ? WHERE id = ?')
            .run(name, interval, enabled, notes, exportUptime, d.id);
        if (body.credentials && typeof body.credentials === 'object') {
            saveCredentials(d.id, credsFromBody({ version: d.snmp_version, ...body.credentials }));
        }
        poller.deviceChanged(d.id, enabled && !d.enabled);
        exporter.scheduleWrite();
        ok(res);
    } },

    { method: 'DELETE', path: /^\/api\/devices\/(\d+)$/, handler: (req, res, p) => {
        const d = db.prepare('SELECT id FROM devices WHERE id = ?').get(p[0]);
        if (!d) return notFound(res);
        db.transaction(() => {
            const ids = db.prepare('SELECT id FROM entities WHERE device_id = ?').all(d.id);
            const del = db.prepare('DELETE FROM samples WHERE entity_id = ?');
            for (const row of ids) del.run(row.id);
            db.prepare('DELETE FROM devices WHERE id = ?').run(d.id); // cascades credentials + entities
        })();
        poller.deviceRemoved(d.id);
        exporter.scheduleWrite();
        ok(res);
    } },

    // Re-walk the device and reconcile: new entities are added (default
    // tracking rules), vanished ones are untracked (history kept), renames
    // and speed changes are applied. Returns a summary of what changed.
    { method: 'POST', path: /^\/api\/devices\/(\d+)\/rediscover$/, handler: async (req, res, p) => {
        const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(p[0]);
        if (!d) return notFound(res);
        const creds = loadCredentials(d.id);
        let result;
        try {
            result = await discover.probe({ host: d.host, port: d.port, version: d.snmp_version, creds });
        } catch (err) {
            return json(res, 502, { error: err.message, code: err.code || 'snmp' });
        }
        const summary = { added: [], removed: [], updated: [] };
        db.transaction(() => {
            db.prepare('UPDATE devices SET sys_descr = ?, sys_object_id = ?, sys_name = ?, vendor_key = ? WHERE id = ?')
                .run(result.system.sysDescr, result.system.sysObjectID, result.system.sysName, result.vendorKey, d.id);
            const existing = db.prepare('SELECT * FROM entities WHERE device_id = ?').all(d.id);
            const byKey = new Map(existing.map((e) => [`${e.kind}:${e.snmp_index}`, e]));
            const seen = new Set();
            const ins = db.prepare(`INSERT INTO entities (device_id, kind, snmp_index, name, alias, speed_bps, extra, tracked, admin_status, oper_status, code)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            const upd = db.prepare('UPDATE entities SET name = ?, alias = ?, speed_bps = ?, extra = ?, stale = 0, admin_status = ?, oper_status = ? WHERE id = ?');
            for (const e of result.entities) {
                const key = `${e.kind}:${e.snmpIndex}`;
                seen.add(key);
                const cur = byKey.get(key);
                if (!cur) {
                    ins.run(d.id, e.kind, String(e.snmpIndex), e.name, e.alias || null, e.speedBps || null,
                            JSON.stringify(e.extra || {}), e.tracked ? 1 : 0, e.adminStatus || null, e.operStatus || null,
                            generateIfCode(d.name, e.name));
                    summary.added.push(`${e.kind} ${e.name}`);
                } else {
                    if (cur.name !== e.name) summary.updated.push(`${cur.name} → ${e.name}`);
                    upd.run(e.name, e.alias || cur.alias, e.speedBps || cur.speed_bps,
                            JSON.stringify(e.extra || {}), e.adminStatus || null, e.operStatus || null, cur.id);
                }
            }
            for (const e of existing) {
                const key = `${e.kind}:${e.snmp_index}`;
                if (!seen.has(key) && e.tracked) {
                    db.prepare('UPDATE entities SET tracked = 0, export = 0, stale = 1 WHERE id = ?').run(e.id);
                    summary.removed.push(`${e.kind} ${e.name} (untracked, history kept)`);
                }
            }
        })();
        poller.deviceChanged(d.id, true);
        ok(res, { summary, warnings: result.warnings });
    } },

    { method: 'PATCH', path: /^\/api\/entities\/(\d+)$/, handler: (req, res, p, body) => {
        const e = db.prepare('SELECT * FROM entities WHERE id = ?').get(p[0]);
        if (!e) return notFound(res);
        const tracked = body.tracked !== undefined ? (body.tracked ? 1 : 0) : e.tracked;
        const exp = body.export !== undefined ? (body.export ? 1 : 0) : e.export;
        db.prepare('UPDATE entities SET tracked = ?, export = ? WHERE id = ?')
            .run(tracked, tracked ? exp : 0, e.id);
        if (exp !== e.export || tracked !== e.tracked) exporter.scheduleWrite();
        ok(res);
    } },

    // Graph data, server-side bucketed to <= maxPoints buckets.
    { method: 'GET', path: /^\/api\/entities\/(\d+)\/samples$/, handler: (req, res, p, body, query) => {
        const e = db.prepare('SELECT e.*, d.poll_interval_s AS dev_interval FROM entities e JOIN devices d ON d.id = e.device_id WHERE e.id = ?').get(p[0]);
        if (!e) return notFound(res);
        const now = Math.floor(Date.now() / 1000);
        const to = parseInt(query.get('to'), 10) || now;
        const from = parseInt(query.get('from'), 10) || (to - 24 * 3600);
        const maxPoints = Math.min(2000, Math.max(50, parseInt(query.get('maxPoints'), 10) || 500));
        const base = e.dev_interval || parseInt(getSetting('poll_interval_s'), 10) || 300;
        const bucket = Math.max(base, Math.ceil((to - from) / maxPoints / base) * base);
        const rows = db.prepare(`
            SELECT (ts / @b) * @b AS t,
                   avg(v0) a0, max(v0) m0, avg(v1) a1, max(v1) m1,
                   avg(v2) a2, avg(v3) a3, avg(v4) a4, avg(v5) a5,
                   min(status) st
            FROM samples WHERE entity_id = @id AND ts >= @from AND ts <= @to
            GROUP BY t ORDER BY t`).all({ b: bucket, id: e.id, from, to });
        // 95th percentile of the raw (unbucketed) samples in range - the
        // classic capacity-planning number, for interfaces only.
        let p95 = null;
        if (e.kind === 'if') {
            const pct = (col) => {
                const n = db.prepare(`SELECT count(*) c FROM samples WHERE entity_id = ? AND ts >= ? AND ts <= ? AND ${col} IS NOT NULL`)
                    .get(e.id, from, to).c;
                if (n < 20) return null; // too few samples to be meaningful
                return db.prepare(`SELECT ${col} v FROM samples WHERE entity_id = ? AND ts >= ? AND ts <= ? AND ${col} IS NOT NULL
                                   ORDER BY ${col} LIMIT 1 OFFSET ?`)
                    .get(e.id, from, to, Math.floor(n * 0.95)).v;
            };
            p95 = { in: pct('v0'), out: pct('v1') };
        }
        ok(res, {
            kind: e.kind, name: e.name, code: e.code || null, speedBps: e.speed_bps, bucketSec: bucket, from, to, p95,
            points: rows.map((r) => [r.t, r.a0, r.m0, r.a1, r.m1, r.a2, r.a3, r.a4, r.a5, r.st])
        });
    } },

    // Device inventory as a CrossCanvas-import CSV, so a monitored fleet can
    // seed a diagram in one step (an IP-Address makes each device
    // monitoring-ready in PingCanvas).
    { method: 'GET', path: /^\/api\/inventory\.csv$/, handler: (req, res) => {
        const csv = inventory.buildCsv();
        const stamp = new Date().toISOString().slice(0, 10);
        res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="snmpcanvas-inventory-${stamp}.csv"`,
            'Cache-Control': 'no-store'
        });
        res.end(csv);
    } },

    // Consistent snapshot of the database, streamed as a download.
    { method: 'GET', path: /^\/api\/backup$/, handler: (req, res) => {
        const tmp = path.join(DATA_DIR, `.backup-${Date.now()}.db`);
        db.prepare('VACUUM INTO ?').run(tmp);
        const stamp = new Date().toISOString().slice(0, 10);
        const stat = fs.statSync(tmp);
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': stat.size,
            'Content-Disposition': `attachment; filename="snmpcanvas-${stamp}.db"`,
            'Cache-Control': 'no-store'
        });
        const stream = fs.createReadStream(tmp);
        const cleanup = () => fs.unlink(tmp, () => {});
        stream.on('close', cleanup);
        stream.on('error', cleanup);
        stream.pipe(res);
    } },

    { method: 'GET', path: /^\/api\/settings$/, handler: (req, res) => {
        ok(res, {
            pollIntervalS: parseInt(getSetting('poll_interval_s'), 10),
            retentionDays: parseInt(getSetting('retention_days'), 10),
            exportPath: getSetting('export_path'),
            exportError: exporter.getLastError(),
            dataDir: DATA_DIR,
            credentialEncryption: !!process.env.SNMPCANVAS_SECRET
        });
    } },

    { method: 'PATCH', path: /^\/api\/settings$/, handler: (req, res, p, body) => {
        if (body.pollIntervalS !== undefined) {
            const v = parseInt(body.pollIntervalS, 10);
            if (!v || v < 30) return bad(res, 'Polling interval must be at least 30 seconds.');
            setSetting('poll_interval_s', v);
        }
        if (body.retentionDays !== undefined) {
            const v = parseInt(body.retentionDays, 10);
            if (!v || v < 1) return bad(res, 'Retention must be at least 1 day.');
            setSetting('retention_days', v);
        }
        if (body.exportPath !== undefined) {
            const v = String(body.exportPath).trim();
            const err = exportPathError(v);
            if (err) return bad(res, err);
            setSetting('export_path', v);
            exporter.scheduleWrite();
        }
        ok(res);
    } },

    { method: 'POST', path: /^\/api\/settings\/password$/, handler: (req, res, p, body) => {
        if (!auth.checkPassword(String(body.current || ''))) return json(res, 401, { error: 'Current password is wrong.' });
        if (!body.next || String(body.next).length < 8) return bad(res, 'New password must be at least 8 characters.');
        auth.setPassword(String(body.next));
        ok(res);
    } }
];

// Dispatch. Returns false when no /api route matches (server.js then tries static).
async function handle(req, res, pathname, query) {
    for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = route.path.exec(pathname);
        if (!m) continue;

        if (route.authRequired !== false && !auth.validateSession(auth.tokenFromRequest(req))) {
            return json(res, 401, { error: 'authentication required' });
        }

        let body = {};
        if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
            const ct = String(req.headers['content-type'] || '');
            const hasBody = req.headers['content-length'] && req.headers['content-length'] !== '0';
            if (hasBody && !ct.includes('application/json')) return json(res, 415, { error: 'expected application/json' });
            if (hasBody) {
                try {
                    body = await readJson(req);
                } catch (err) {
                    return bad(res, err.message);
                }
            } else if (req.method !== 'DELETE') {
                if (!ct.includes('application/json')) return json(res, 415, { error: 'expected application/json' });
            }
        }
        try {
            await route.handler(req, res, m.slice(1), body, query);
        } catch (err) {
            console.error(new Date().toISOString(), '[api]', req.method, pathname, err);
            if (!res.headersSent) json(res, 500, { error: 'internal error' });
        }
        return true;
    }
    return false;
}

function readJson(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
            catch (_) { reject(new Error('invalid JSON')); }
        });
        req.on('error', reject);
    });
}

module.exports = { handle };
