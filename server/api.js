'use strict';
// All /api/* handlers. Routes are (method, regex) pairs dispatched by
// server.js; bodies are JSON in and JSON out. Mutating routes require
// Content-Type: application/json (cross-site forms can't send it - CSRF belt
// on top of the SameSite=Lax cookie).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, getSetting, setSetting, saveCredentials, loadCredentials, generateIfCode, DATA_DIR, DB_FILE } = require('./db');
const S = require('./snmp');
const auth = require('./auth');
const themeFile = require('./theme');
const discover = require('./discover');
const poller = require('./poller');
const exporter = require('./exporter');
const inventory = require('./inventory');
const reconcile = require('./reconcile');

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

// --- history cost readout -----------------------------------------------
// The Settings page states the retention POLICY; these three functions state
// its CONSEQUENCE: what is on disk, how many days it actually spans, and what
// the configured window will cost at the current rate. The projection scales
// the real file rather than modelling bytes-per-row - that way it includes
// indexes, the hourly rollup, free pages and WAL amplification without
// pretending to know any of them individually.

function dbSizeBytes() {
    // page_count * page_size is the main file exactly; the WAL rides on top
    // and is real disk until the next checkpoint. -shm is a fixed 32KB map.
    let bytes = db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true });
    try { bytes += fs.statSync(DB_FILE + '-wal').size; } catch (_) { /* no WAL between checkpoints */ }
    return bytes;
}

function oldestSampleTs() {
    // samples is keyed (entity_id, ts), so a bare MIN(ts) is a full table
    // scan - minutes of blocked event loop on a big fleet. One index seek per
    // entity is microseconds each; the prune walks entities the same way.
    const minTs = db.prepare('SELECT MIN(ts) AS m FROM samples WHERE entity_id = ?');
    let oldest = null;
    for (const { id } of db.prepare('SELECT id FROM entities').all()) {
        const m = minTs.get(id).m;
        if (m != null && (oldest == null || m < oldest)) oldest = m;
    }
    return oldest;
}

function historySummary(dbBytes, oldestTs, retentionDays, nowS) {
    const heldDays = oldestTs != null ? (nowS - oldestTs) / 86400 : null;
    if (heldDays == null || heldDays < 1 / 24 || !(dbBytes > 0)) {
        // Nothing stored, or under an hour of it: a rate scaled from minutes
        // of data would be noise dressed as a projection. Honest nulls.
        return { dbBytes: dbBytes || 0, heldDays, bytesPerDay: null, projectedBytes: null, steady: false };
    }
    const bytesPerDay = dbBytes / heldDays;
    return {
        dbBytes, heldDays, bytesPerDay,
        projectedBytes: Math.round(bytesPerDay * retentionDays),
        // Once the span reaches the window, the nightly prune holds it here.
        steady: heldDays >= retentionDays
    };
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
    // Truthy so handle()'s early exits (auth 401, 415, body errors) read as
    // "handled" - the server's 404 fallback must never double-write a reply.
    return true;
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
    // evade the limiter or lock out an arbitrary IP.
    if (process.env.TRUST_PROXY === '1') {
        const xff = req.headers['x-forwarded-for'];
        if (xff) {
            // A trusted proxy APPENDS the client IP it observed, so the LAST
            // hop is the one this operator's proxy vouches for; earlier hops are
            // client-supplied and spoofable. Assumes a single reverse proxy -
            // the documented topology.
            const hops = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
            if (hops.length) { return hops[hops.length - 1]; }
        }
    }
    return req.socket.remoteAddress || 'unknown';
}

function effectiveInterval(device) {
    return device.poll_interval_s || parseInt(getSetting('poll_interval_s'), 10) || 300;
}

// pollIntervalS from a request body -> seconds (clamped to >= 30), null to
// clear back to the global default, or NaN for garbage the caller must reject
// (parseInt('junk') used to coerce to the 30s floor silently).
function intervalFromBody(v) {
    if (v == null || v === '' || v === 0 || v === false) return null;
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return NaN;
    return n <= 0 ? null : Math.max(30, n);
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
        osSummary: d.os_summary || null, hwModel: d.hw_model || null,
        cpuCores: d.cpu_cores || null, ramKb: d.ram_kb || null,
        uptimeSeconds: uptimeSeconds(d),
        pollIntervalS: d.poll_interval_s, effectiveIntervalS: effectiveInterval(d),
        // Present only while a poll is failing. The phase is the actionable
        // half: 'liveness' means the device never answered, 'entities' means
        // it answered and then refused the metric read.
        lastError: d.last_error ? { message: d.last_error, phase: d.last_error_phase || null, at: d.last_error_ts } : null
    };
}

// vendor_key -> human label, from the same VENDORS table discovery matched
// against. Key stays the compact display; the label rides the tooltip.
const { VENDORS } = require('./oids');
const VENDOR_LABELS = Object.fromEntries(VENDORS.map((v) => [v.key, v.label]));
function vendorLabelFor(key) { return key ? (VENDOR_LABELS[key] || null) : null; }

// The fleet-table payload: one row per device with its summary columns.
// Extracted from the GET /api/devices handler so tools/check-columns.js can
// drive it against a seeded database - these aggregates (down ports, worst
// errors, health, UPS) are reductions with edge cases worth pinning.
function deviceListSummaries() {
    const devices = db.prepare('SELECT * FROM devices ORDER BY name COLLATE NOCASE').all();
    const ifCount = db.prepare("SELECT count(*) AS n FROM entities WHERE device_id = ? AND kind = 'if' AND tracked = 1");
    const cpuEnt = db.prepare("SELECT id FROM entities WHERE device_id = ? AND kind = 'cpu' AND tracked = 1 LIMIT 1");
    const ifEnts = db.prepare(`SELECT id, name, speed_bps, speed_untrusted, speed_override_bps,
                                      admin_status, oper_status
                               FROM entities WHERE device_id = ? AND kind = 'if' AND tracked = 1`);
    const auxEnts = db.prepare(`SELECT id, kind, name FROM entities
                                WHERE device_id = ? AND tracked = 1
                                AND kind IN ('state','battery','runtime','temp','fs','mem')`);
    const latest = db.prepare('SELECT v0, v1, v2, v3, v4, v5 FROM samples WHERE entity_id = ? ORDER BY ts DESC LIMIT 1');
    return devices.map((d) => {
        // CPU % - null when the device has no CPU entity (shown as N/A).
        const cpu = cpuEnt.get(d.id);
        const cpuSample = cpu ? latest.get(cpu.id) : null;
        // Busiest interface right now: highest of in/out bps across tracked
        // interfaces, with utilization % when the EFFECTIVE speed is known
        // (override, else advertised-while-trusted - an unrated virtio NIC
        // shows honest raw bps with no percentage).
        let topIf = null;
        let downPorts = 0;
        let worstIfErrs = null;
        for (const e of ifEnts.all(d.id)) {
            // Down = operationally down while administratively up; a port
            // someone shut on purpose is not a problem to surface.
            if (e.oper_status === 2 && e.admin_status === 1) downPorts++;
            const s = latest.get(e.id);
            if (!s) continue;
            const errs = (s.v2 ?? 0) + (s.v3 ?? 0);
            if (s.v2 != null || s.v3 != null) worstIfErrs = Math.max(worstIfErrs ?? 0, errs);
            const bps = Math.max(s.v0 ?? -1, s.v1 ?? -1);
            if (bps < 0) continue;
            if (!topIf || bps > topIf.bps) {
                const effSpeed = e.speed_override_bps > 0 ? e.speed_override_bps
                    : (e.speed_untrusted ? null : (e.speed_bps || null));
                topIf = { entityId: e.id, name: e.name, bps, pct: effSpeed > 0 ? bps / effSpeed * 100 : null };
            }
        }
        // Health: worst case over the device's binary state entities
        // (PSU on-battery, fan alarms...). Absent kinds mean no column
        // content, never a fake "ok".
        let health = null;
        let ups = null;
        // Temperature is a PREFERENCE LADDER, not a max: a CPU or
        // system/board sensor represents "the device's temperature" even
        // when an NVMe or PSU sensor runs hotter. Max is only the fallback
        // when no sensor name gives itself away.
        const temps = [];
        // Filesystems and memory PICK the fullest, never sum - nested
        // namespaces (ZFS datasets share pool space) make sums double-count.
        let fs = null;
        let mem = null;
        for (const e of auxEnts.all(d.id)) {
            const s = latest.get(e.id);
            if (!s || s.v0 == null) continue;
            if (e.kind === 'state') {
                if (!health) health = { state: 'ok', alarms: 0 };
                if (s.v0) { health.state = 'alarm'; health.alarms++; }
            } else if (e.kind === 'battery') {
                ups = { ...(ups || {}), chargePct: Math.round(s.v0) };
            } else if (e.kind === 'runtime') {
                ups = { ...(ups || {}), runtimeS: Math.round(s.v0) };
            } else if (e.kind === 'temp') {
                temps.push({ name: e.name || '', c: s.v0 });
            } else if (e.kind === 'fs' || e.kind === 'mem') {
                if (s.v1 > 0) {
                    const pct = s.v0 / s.v1 * 100;
                    if (e.kind === 'fs') { if (!fs || pct > fs.pct) fs = { name: e.name || '', pct }; }
                    else { if (!mem || pct > mem.pct) mem = { name: e.name || '', pct }; }
                }
            }
        }
        let temp = null;
        if (temps.length) {
            const byName = (re) => temps.find((t) => re.test(t.name));
            const pick = byName(/cpu|core|package/i) || byName(/system|board|ambient|chassis|intake/i)
                || temps.reduce((a, b) => (b.c > a.c ? b : a));
            temp = { name: pick.name, c: Math.round(pick.c), of: temps.length };
        }
        return {
            ...deviceSummary(d),
            interfaceCount: ifCount.get(d.id).n,
            cpuPct: cpuSample ? cpuSample.v0 : null,
            topIf,
            downPorts,
            worstIfErrs,
            health,
            ups,
            temp,
            fs,
            mem,
            vendorLabel: vendorLabelFor(d.vendor_key),
            sysLocation: d.sys_location || null
        };
    });
}

// ifType 161 = ieee8023adLag. FLAGGED, not acted on: many agents advertise
// ONE member's speed for the whole bundle (MikroTik bonds do), so the claim
// is partial rather than fictional - wrong from the first poll, and the
// conviction in poller.speedTrustAndClamp only catches it once traffic
// exceeds a single member, which a lightly used 4x10G bundle may never do.
// The operator knows the real total; the flag just says where to look.
// Exported for tools/check-lag.js.
function isLag(extra) { return Number(extra && extra.ifType) === 161; }

function entitySummary(e, latest) {
    const extra = e.extra ? JSON.parse(e.extra) : {};
    // speedBps is the EFFECTIVE speed every consumer may divide by:
    // operator override first, advertised only while trusted, else null
    // (virtio/netvsc advertise fiction - see poller.speedTrustAndClamp).
    // advertisedBps carries the raw claim for display.
    const effSpeed = e.speed_override_bps > 0 ? e.speed_override_bps
        : (e.speed_untrusted ? null : (e.speed_bps || null));
    return {
        id: e.id, kind: e.kind, snmpIndex: e.snmp_index, name: e.name, alias: e.alias || '', code: e.code || null,
        speedBps: effSpeed, advertisedBps: e.speed_bps || null,
        speedUntrusted: e.speed_untrusted ? true : undefined,
        speedOverrideBps: e.speed_override_bps > 0 ? e.speed_override_bps : undefined,
        lag: isLag(extra) || undefined,
        tracked: !!e.tracked, export: !!e.export, stale: !!e.stale,
        adminStatus: e.admin_status, operStatus: e.oper_status,
        hc: extra.hc !== undefined ? !!extra.hc : undefined,
        unit: extra.unit || undefined, meterMax: extra.max || undefined,
        okText: extra.okText || undefined, alarmText: extra.alarmText || undefined,
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
// One backup at a time. Each one writes a full copy of the database into
// the data directory before streaming it; letting a user stack them (or two
// users start at once) multiplies that against a volume that is usually
// sized for the database plus a little.
let backupInFlight = false;

const routes = [
    { method: 'GET', path: /^\/api\/health$/, authRequired: false, handler: (req, res) => ok(res, { ok: true, version: require('../package.json').version }) },

    // The operator's own palette from <data>/theme.json, if they wrote one.
    // PUBLIC on purpose: the login page is themed too, and gating this would
    // leave the one page every user sees first stuck on Classic. It carries
    // fifteen colours and a label - nothing not already visible on the page.
    // Read per request, so editing the file in the mounted volume takes effect
    // on refresh, which is the whole point of it living outside the image.
    { method: 'GET', path: /^\/api\/theme$/, authRequired: false, handler: (req, res) => {
        const r = themeFile.loadTheme(DATA_DIR);
        if (r.errors.length) {
            // A broken file must not silently fall back - that reads as "my
            // edit did nothing" and sends people editing it again.
            console.error(new Date().toISOString(), '[theme] ignoring', r.path + ':', r.errors.join('; '));
        }
        ok(res, { theme: r.theme, warnings: r.warnings, errors: r.errors });
    } },

    { method: 'GET', path: /^\/api\/session$/, authRequired: false, handler: (req, res) => {
        const authed = auth.authenticate(req);
        ok(res, { authenticated: authed, needsSetup: !auth.passwordIsSet(), sso: auth.ssoEnabled() });
    } },

    { method: 'POST', path: /^\/api\/setup$/, authRequired: false, handler: async (req, res, p, body) => {
        if (auth.passwordIsSet()) return json(res, 409, { error: 'already configured' });
        // In an SSO suite a fresh sub-app is protected by the LaunchCanvas
        // token, not by a race to this setup page: an anonymous LAN visitor
        // (mistyped port, inherited bookmark) must not be able to claim the
        // admin account. A portal-authenticated user still may, to set a local
        // fallback password.
        if (auth.ssoEnabled() && !auth.authenticate(req))
            return json(res, 403, { error: 'This app is part of a single sign-on suite - sign in through LaunchCanvas first. (No portal on this box? Set ADMIN_PASSWORD in the compose file for this app and restart, or remove SUITE_SECRET to restore the normal first-run setup.)' });
        if (!body.password || String(body.password).length < 8) return bad(res, 'Password must be at least 8 characters.');
        await auth.setPassword(String(body.password));
        const token = auth.createSession();
        res.setHeader('Set-Cookie', auth.sessionCookie(token));
        ok(res);
    } },

    { method: 'POST', path: /^\/api\/login$/, authRequired: false, handler: async (req, res, p, body) => {
        const ip = clientIp(req);
        if (!auth.loginAllowed(ip)) return json(res, 429, { error: 'Too many attempts - wait a minute.' });
        if (!await auth.checkPassword(String(body.password || ''))) {
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
        // Drop the suite token as well, or this button is a no-op under SSO:
        // the local session dies, the shared cookie survives, and the next
        // request signs straight back in while the page redraws as logged in.
        res.setHeader('Set-Cookie', [auth.clearCookie(), auth.clearSuiteCookie()]);
        ok(res);
    } },

    { method: 'GET', path: /^\/api\/devices$/, handler: (req, res) => {
        // Poller health rides along so the page people actually watch can
        // say when the loop is behind - the Settings page already warns, but
        // a warning on a page nobody visits daily protected nobody.
        ok(res, { devices: deviceListSummaries(), poller: poller.health() });
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
        // Refuse a credential this build cannot perform while the operator is
        // still looking at the form, rather than letting it become a device
        // that times out forever for a reason nothing on screen explains.
        const credProblem = S.v3CredProblem(target.creds);
        if (credProblem) return bad(res, credProblem);
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
        const interval = intervalFromBody(body.pollIntervalS);
        if (Number.isNaN(interval)) return bad(res, 'Polling interval must be a number of seconds.');

        const deviceId = db.transaction(() => {
            const idy = result.identity || {};
            const info = db.prepare(`INSERT INTO devices
                (name, host, port, snmp_version, sys_descr, sys_object_id, sys_name, sys_location, vendor_key, poll_interval_s, created_ts, uptime_code,
                 os_summary, hw_model, cpu_cores, ram_kb)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(name, target.host, target.port, target.version, result.system.sysDescr,
                     result.system.sysObjectID, result.system.sysName, result.system.sysLocation, result.vendorKey, interval,
                     Math.floor(Date.now() / 1000), generateIfCode(name, 'uptime'),
                     idy.osSummary || null, idy.hwModel || null, idy.cpuCores || null, idy.ramKb || null);
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
        const host = body.host !== undefined ? String(body.host).trim() : d.host;
        if (!host) return bad(res, 'Host cannot be empty.');
        // A supplied port has to be a real port. Clamping-with-a-fallback sent
        // a cleared field to 161, quietly moving the device off the port it
        // actually answers on, and the only symptom was a generic SNMP
        // timeout. Name and host already refuse to be blanked; so does this.
        // An absent key still means "leave it alone".
        let port = d.port;
        if (body.port !== undefined) {
            const raw = String(body.port).trim();
            if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
                return bad(res, 'Port must be a whole number from 1 to 65535.');
            }
            port = Number(raw);
        }
        const interval = body.pollIntervalS !== undefined
            ? intervalFromBody(body.pollIntervalS)
            : d.poll_interval_s;
        if (Number.isNaN(interval)) return bad(res, 'Polling interval must be a number of seconds.');
        const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : d.enabled;
        const notes = body.notes !== undefined ? String(body.notes).slice(0, 2000) : d.notes;
        const exportUptime = body.exportUptime !== undefined ? (body.exportUptime ? 1 : 0) : d.export_uptime;
        // Stored credentials are bound to the host they were entered for. The
        // next poll (or Rediscover) sends them to whatever now answers at this
        // address, so silently carrying them to a NEW host would let anyone who
        // can reach this API read out a community string or v3 key by pointing
        // a device at a listener they control - credentials the API never
        // returns and the database encrypts at rest. Re-point and re-enter
        // together, or not at all. A port-only change stays on the same host,
        // so it does not require this.
        const credsGiven = !!body.credentials && typeof body.credentials === 'object' &&
            (d.snmp_version === '2c'
                ? String(body.credentials.community || '').trim() !== ''
                : String(body.credentials.v3_user || '').trim() !== '');
        if (host !== d.host && !credsGiven) {
            return bad(res, 'Changing the address means re-entering this device\'s SNMP credentials - the stored ones are not sent to a new host.');
        }
        const addressChanged = host !== d.host || port !== d.port;
        // Two devices pointed at one address poll the box twice and export it
        // twice, so a single outage reaches PingCanvas and AlertCanvas as two
        // device-down alarms for the same host. Bulk add already skips
        // addresses it monitors; editing was the way around that. Exact
        // host:port only - no DNS, no aliases, nothing clever.
        if (addressChanged) {
            const clash = db.prepare('SELECT name FROM devices WHERE id != ? AND enabled = 1 AND host = ? AND port = ?')
                .get(d.id, host, port);
            if (clash) return bad(res, `${host}:${port} is already monitored as "${clash.name}".`);
        }
        // Checked before ANY write, so a refused edit changes nothing at all.
        if (body.credentials && typeof body.credentials === 'object') {
            const credProblem = S.v3CredProblem(credsFromBody({ version: d.snmp_version, ...body.credentials }));
            if (credProblem) return bad(res, credProblem);
        }
        db.prepare('UPDATE devices SET name = ?, host = ?, port = ?, poll_interval_s = ?, enabled = ?, notes = ?, export_uptime = ? WHERE id = ?')
            .run(name, host, port, interval, enabled, notes, exportUptime, d.id);
        if (body.credentials && typeof body.credentials === 'object') {
            saveCredentials(d.id, credsFromBody({ version: d.snmp_version, ...body.credentials }));
        }
        if (addressChanged) {
            // Whatever answers at the new address may be a different box, whose
            // counters have nothing to do with the ones we last stored. Rating
            // the difference produces an enormous fake spike - and errors and
            // discards have no sanity clamp, so it lands in the export, pages
            // whoever is watching, and leaves a permanent scar on the history
            // graph. Drop the baselines (the poller's own idiom for "start
            // fresh") and lose one interval of rates instead.
            db.prepare('UPDATE entities SET poll_state = NULL WHERE device_id = ?').run(d.id);
            db.prepare('UPDATE devices SET last_sysuptime_cs = NULL WHERE id = ?').run(d.id);
        }
        poller.deviceChanged(d.id, (enabled && !d.enabled) || (enabled && addressChanged));
        exporter.scheduleWrite();
        ok(res);
    } },

    { method: 'DELETE', path: /^\/api\/devices\/(\d+)$/, handler: (req, res, p) => {
        const d = db.prepare('SELECT id FROM devices WHERE id = ?').get(p[0]);
        if (!d) return notFound(res);
        db.transaction(() => {
            const ids = db.prepare('SELECT id FROM entities WHERE device_id = ?').all(d.id);
            const del = db.prepare('DELETE FROM samples WHERE entity_id = ?');
            // samples_hourly must go here too: the nightly prune iterates
            // EXISTING entities, so rollup rows orphaned by a delete would
            // otherwise be invisible to every cleanup path, forever.
            const delHourly = db.prepare('DELETE FROM samples_hourly WHERE entity_id = ?');
            for (const row of ids) { del.run(row.id); delHourly.run(row.id); }
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
        // Manual Rediscover: a human asked for the inventory to be re-judged,
        // so this is the one path allowed to untrack what vanished.
        const summary = reconcile.reconcileDevice(d, result, { untrack: true });
        poller.deviceChanged(d.id, true);
        ok(res, { summary, warnings: result.warnings });
    } },

    { method: 'PATCH', path: /^\/api\/entities\/(\d+)$/, handler: (req, res, p, body) => {
        const e = db.prepare('SELECT * FROM entities WHERE id = ?').get(p[0]);
        if (!e) return notFound(res);
        const tracked = body.tracked !== undefined ? (body.tracked ? 1 : 0) : e.tracked;
        const exp = body.export !== undefined ? (body.export ? 1 : 0) : e.export;
        // Speed override: a positive bps number sets it, null/0 clears it.
        // speedTrusted: true clears an earned untrusted verdict (the operator
        // vouching for the advertised speed again - e.g. after fixing a
        // mislabeled port); the poller will re-convict if traffic disproves it.
        let override = e.speed_override_bps;
        if (body.speedOverrideBps !== undefined) {
            const n = Number(body.speedOverrideBps);
            override = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
        }
        let untrusted = e.speed_untrusted;
        if (body.speedTrusted === true) untrusted = 0;
        db.prepare('UPDATE entities SET tracked = ?, export = ?, speed_override_bps = ?, speed_untrusted = ? WHERE id = ?')
            .run(tracked, tracked ? exp : 0, override, untrusted, e.id);
        if (exp !== e.export || tracked !== e.tracked ||
            override !== e.speed_override_bps || untrusted !== e.speed_untrusted) exporter.scheduleWrite();
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
        let bucket = Math.max(base, Math.ceil((to - from) / maxPoints / base) * base);
        // Past an hour per bucket the data comes from the hourly rollup, and a
        // bucket that is not a whole number of hours cannot be rebuilt from it:
        // an hour straddling a bucket edge would land entirely on one side
        // instead of being split. Snap up to the next whole hour so every hour
        // belongs to exactly one bucket. Costs a few points at the wide end (a
        // 90-day chart draws 432 rather than 500) and makes the rolled-up
        // answer identical to the raw one instead of merely close.
        if (bucket > 3600) bucket = Math.ceil(bucket / 3600) * 3600;
        // Where the numbers come from depends on how wide the chart is.
        //
        // Under an hour per bucket, read the raw samples - that is the only
        // place the detail exists. At an hour or more, read samples_hourly,
        // which already collapsed each hour to one row. Both are fed through
        // one UNION so a bucket that straddles the rollup frontier (hourly
        // rows behind it, raw rows in front) still comes out as a single
        // point: an hourly row enters as a pre-aggregate of n samples, a raw
        // row as an aggregate of one.
        //
        // Hence the WEIGHTED mean, sum(a0*n)/sum(n), rather than avg(a0).
        // Averaging averages would give an hour that only managed 40 polls the
        // same weight as a full hour of 120 - flattering exactly the periods
        // when the poller was struggling. (A column that is NULL for a kind
        // stays NULL throughout, so no partially-null column is mis-weighted.)
        // The frontier is floored to an hour before it splits the two sources.
        // The rollup only ever advances it to an hour boundary, but if it were
        // ever mid-hour the two WHERE clauses below would overlap: the hourly
        // row for that hour would be counted AND so would the raw samples from
        // the frontier to the end of it.
        const mark = Math.floor((parseInt(getSetting('rollup_through_ts'), 10) || 0) / 3600) * 3600;
        // @b is bound as a BigInt on purpose, and the bucketing is wrong
        // without it. better-sqlite3 binds every JS number as SQLite REAL and
        // only a BigInt as INTEGER, so `ts / @b` was FLOAT division: dividing
        // and re-multiplying returned ts unchanged, every row landed in its own
        // bucket, and GROUP BY grouped nothing. Charts silently shipped one
        // point per raw sample - 259,200 of them for a 90-day range - and
        // maxPoints below was never actually enforced.
        const b = BigInt(bucket);
        const rows = bucket < 3600
            ? db.prepare(`
                SELECT (ts / @b) * @b AS t,
                       avg(v0) a0, max(v0) m0, avg(v1) a1, max(v1) m1,
                       avg(v2) a2, avg(v3) a3, avg(v4) a4, avg(v5) a5,
                       min(status) st
                FROM samples WHERE entity_id = @id AND ts >= @from AND ts <= @to
                GROUP BY t ORDER BY t`).all({ b, id: e.id, from, to })
            : db.prepare(`
                SELECT (sts / @b) * @b AS t,
                       sum(a0 * n) / sum(n) a0, max(m0) m0,
                       sum(a1 * n) / sum(n) a1, max(m1) m1,
                       sum(a2 * n) / sum(n) a2, sum(a3 * n) / sum(n) a3,
                       sum(a4 * n) / sum(n) a4, sum(a5 * n) / sum(n) a5,
                       min(st) st
                FROM (
                    -- 'sts' rather than 't': naming this column t as well
                    -- would make the outer GROUP BY t bind to THIS column
                    -- instead of the bucket expression above it, silently
                    -- grouping by raw hour and returning 24 points per day.
                    SELECT hour_ts sts, n, a0, a1, a2, a3, a4, a5, m0, m1, st
                    FROM samples_hourly
                    WHERE entity_id = @id AND hour_ts >= @from AND hour_ts <= @to AND hour_ts < @mark
                    UNION ALL
                    SELECT ts, 1, v0, v1, v2, v3, v4, v5, v0, v1, status
                    FROM samples
                    WHERE entity_id = @id AND ts >= max(@from, @mark) AND ts <= @to
                )
                GROUP BY t ORDER BY t`).all({ b, id: e.id, from, to, mark });
        const sx = e.extra ? JSON.parse(e.extra) : {};
        ok(res, {
            kind: e.kind, name: e.name, code: e.code || null,
            // effective speed (same rule as entitySummary) + provenance
            speedBps: e.speed_override_bps > 0 ? e.speed_override_bps
                : (e.speed_untrusted ? null : (e.speed_bps || null)),
            advertisedBps: e.speed_bps || null,
            speedUntrusted: e.speed_untrusted ? true : undefined,
            speedOverrideBps: e.speed_override_bps > 0 ? e.speed_override_bps : undefined,
            lag: isLag(sx) || undefined,
            bucketSec: bucket, from, to,
            unit: sx.unit || undefined, meterMax: sx.max || undefined,
            okText: sx.okText || undefined, alarmText: sx.alarmText || undefined,
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
    { method: 'GET', path: /^\/api\/backup$/, handler: async (req, res) => {
        // Random suffix: two same-ms requests must not collide, and every
        // error/abort path must unlink - orphaned full-DB copies would
        // slowly fill the data volume on a flaky connection.
        if (backupInFlight) return json(res, 429, { error: 'a backup is already being prepared - try again when it finishes' });
        const tmp = path.join(DATA_DIR, `.backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
        let stat;
        backupInFlight = true;
        try {
            // db.backup(), not `VACUUM INTO`. Both copy the whole database, but
            // VACUUM INTO is synchronous and better-sqlite3 runs it ON the event
            // loop: measured on a 400 MB database it froze the entire process
            // for 3.0 seconds - no polling, no requests answered, every other
            // user's page hung - and that cost grows with the database, about
            // 7.6s per GB. db.backup() steps through the file a batch of pages
            // at a time and returns to the event loop between batches, which
            // brings the worst single stall down to ~0.4s (one fsync as it
            // finalises; the copying itself is invisible at 200 pages a step).
            //
            // Safe under concurrent writes: SQLite's backup restarts if the
            // source changes mid-copy, but in WAL mode the reader holds a
            // snapshot and writers append instead of moving those pages.
            // Verified against a 250 MB database written to throughout - single
            // clean pass, integrity_check ok, from one connection and two.
            //
            // The one thing given up is compaction: VACUUM INTO rewrote the file
            // without its free pages, this copies them. The download therefore
            // matches the size of the live database, which is the honest number
            // anyway.
            await db.backup(tmp, { progress: () => 200 });
            stat = fs.statSync(tmp);
        } catch (err) {
            fs.unlink(tmp, () => {});
            throw err;
        } finally {
            backupInFlight = false;
        }
        const stamp = new Date().toISOString().slice(0, 10);
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': stat.size,
            'Content-Disposition': `attachment; filename="snmpcanvas-${stamp}.db"`,
            'Cache-Control': 'no-store'
        });
        const stream = fs.createReadStream(tmp);
        const cleanup = () => { stream.destroy(); fs.unlink(tmp, () => {}); };
        stream.on('close', () => fs.unlink(tmp, () => {}));
        stream.on('error', cleanup);
        res.on('close', cleanup); // client abort mid-download
        stream.pipe(res);
    } },

    { method: 'GET', path: /^\/api\/settings$/, handler: (req, res) => {
        ok(res, {
            pollIntervalS: parseInt(getSetting('poll_interval_s'), 10),
            pollConcurrency: poller.health().concurrency,
            retentionDays: parseInt(getSetting('retention_days'), 10),
            exportPath: getSetting('export_path'),
            exportWallPath: getSetting('export_wall_path'),
            exportError: exporter.getLastError(),
            dataDir: DATA_DIR,
            credentialEncryption: !!process.env.SNMPCANVAS_SECRET,
            poller: poller.health(),
            history: historySummary(dbSizeBytes(), oldestSampleTs(),
                parseInt(getSetting('retention_days'), 10) || 90, Math.floor(Date.now() / 1000))
        });
    } },

    { method: 'PATCH', path: /^\/api\/settings$/, handler: (req, res, p, body) => {
        if (body.pollIntervalS !== undefined) {
            const v = parseInt(body.pollIntervalS, 10);
            if (!v || v < 30) return bad(res, 'Polling interval must be at least 30 seconds.');
            setSetting('poll_interval_s', v);
        }
        if (body.pollConcurrency !== undefined) {
            // Refuse rather than accept-and-ignore when the environment sets
            // it: storing a number that has no effect is worse than saying so.
            if (poller.health().concurrencySource === 'env') {
                return bad(res, 'Poll concurrency is set by the POLL_CONCURRENCY environment variable, which takes precedence. Change it there (and restart) or unset it to manage this here.');
            }
            const v = parseInt(body.pollConcurrency, 10);
            if (!v || v < 1 || v > 512) return bad(res, 'Poll concurrency must be between 1 and 512.');
            setSetting('poll_concurrency', v);
            poller.settingsChanged();   // take effect now, not on the next tick
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
        if (body.exportWallPath !== undefined) {
            const v = String(body.exportWallPath).trim();
            if (v.toLowerCase() !== 'off') {           // 'off' disables the wall copy
                const err = exportPathError(v);
                if (err) return bad(res, err);
            }
            setSetting('export_wall_path', v);
            exporter.scheduleWrite();
        }
        ok(res);
    } },

    { method: 'POST', path: /^\/api\/settings\/password$/, handler: async (req, res, p, body) => {
        // Under SSO an app can be running with no local password at all, and the
        // docs (and its own login page) tell the operator to set a fallback one
        // from here. That was impossible: checkPassword is false whenever nothing
        // is stored, so the form answered "Current password is wrong" about a
        // password that never existed. With none to confirm, reaching this route
        // already required a valid portal session - the same proof of authority
        // the confirmation was standing in for.
        if (auth.passwordIsSet() && !await auth.checkPassword(String(body.current || ''))) {
            return json(res, 401, { error: 'Current password is wrong.' });
        }
        if (!body.next || String(body.next).length < 8) return bad(res, 'New password must be at least 8 characters.');
        await auth.setPassword(String(body.next));
        auth.destroyOtherSessions(auth.tokenFromRequest(req));   // evict any stolen cookie
        ok(res);
    } }
];

// Dispatch. Returns false when no /api route matches (server.js then tries static).
async function handle(req, res, pathname, query) {
    for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = route.path.exec(pathname);
        if (!m) continue;

        if (route.authRequired !== false && !auth.authenticate(req)) {
            return json(res, 401, { error: 'authentication required' });
        }

        let body = {};
        if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
            const ct = String(req.headers['content-type'] || '');
            const hasBody = req.headers['transfer-encoding'] !== undefined ||
                (req.headers['content-length'] && req.headers['content-length'] !== '0');
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

module.exports = { handle, deviceListSummaries, historySummary, oldestSampleTs, isLag, entitySummary };
