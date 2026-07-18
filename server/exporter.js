'use strict';
// snmp-status.json writer (schema v2): every poll cycle, exported interfaces
// go to interfaces[] (link color + bandwidth pills in PingCanvas) and every
// other exported sensor goes to metrics[] as { code, kind, host, display }.
// SNMPCanvas owns the display formatting; the kiosk is a code -> display
// swapper. Written atomically (temp file + rename, same directory).

const fs = require('node:fs');
const path = require('node:path');
const { db, getSetting } = require('./db');

const pkg = require('../package.json');

let pending = null;      // debounce timer
let lastError = null;    // surfaced on the settings page

const OPER_STATUS = { 1: 'up', 2: 'down', 3: 'testing', 4: 'unknown', 5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown' };

function scheduleWrite() {
    if (pending) return;
    pending = setTimeout(() => {
        pending = null;
        try {
            write();
            lastError = null;
        } catch (err) {
            lastError = err.message;
            console.error(new Date().toISOString(), '[exporter] write failed:', err.message);
        }
    }, 1000);
    pending.unref?.();
}

function fmtUptime(sec) {
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Per-kind display strings: VALUE-ONLY by convention (the board author
// writes their own label around the {code} token — "CPU: {C1}" — which
// keeps naming under their control and can never double). Kept SHORT for
// label lines. A null value keeps the entry with "--" so an authored code
// never looks like a typo.
function metricDisplay(kind, name, v0, v1) {
    if (v0 == null) return { display: '--', value: null };
    switch (kind) {
        case 'cpu': return { display: `${Math.round(v0)}%`, value: Math.round(v0), unit: '%' };
        case 'mem':
        case 'fs': {
            const pct = v1 > 0 ? v0 / v1 * 100 : null;
            return pct == null ? { display: '--', value: null }
                : { display: `${Math.round(pct)}%`, value: Math.round(pct), unit: '%' };
        }
        case 'temp': return { display: `${Math.round(v0)}C`, value: Math.round(v0), unit: 'C' };
        case 'fan': return { display: `${Math.round(v0)}rpm`, value: Math.round(v0), unit: 'rpm' };
        case 'power': return { display: v0 >= 100 ? `${Math.round(v0)}W` : `${v0.toFixed(1)}W`, value: v0, unit: 'W' };
        case 'gauge': return { display: `${Math.round(v0)}%`, value: Math.round(v0), unit: '%' };
        default: return { display: String(v0), value: v0 };
    }
}

// Only CPU carries a coloring status (the "see the number, don't alert on
// it" rule from the kiosk contract).
function cpuStatus(v0) {
    if (v0 == null) return 'unknown';
    return v0 >= 95 ? 'crit' : v0 >= 85 ? 'warn' : 'ok';
}

function write() {
    const latest = db.prepare('SELECT * FROM samples WHERE entity_id = ? ORDER BY ts DESC LIMIT 1');

    // --- interfaces[] (unchanged from v1) ---
    const ifRows = db.prepare(`
        SELECT e.id, e.snmp_index, e.name, e.alias, e.speed_bps, e.admin_status, e.oper_status, e.code,
               d.name AS device_name, d.host, d.status AS device_status
        FROM entities e JOIN devices d ON d.id = e.device_id
        WHERE e.export = 1 AND e.kind = 'if'
        ORDER BY d.name, e.name`).all();
    const interfaces = ifRows.map((r) => {
        const s = latest.get(r.id);
        const deviceUp = r.device_status === 'up';
        return {
            id: `${r.device_name}:${r.name}`,
            code: r.code,
            device: { name: r.device_name, host: r.host, status: r.device_status },
            ifIndex: Number(r.snmp_index),
            name: r.name,
            alias: r.alias || '',
            speedBps: r.speed_bps || null,
            adminStatus: deviceUp ? (OPER_STATUS[r.admin_status] || 'unknown') : 'unknown',
            operStatus: deviceUp ? (OPER_STATUS[r.oper_status] || 'unknown') : 'unknown',
            sampledAt: s ? new Date(s.ts * 1000).toISOString() : null,
            inBps: deviceUp && s ? s.v0 : null,
            outBps: deviceUp && s ? s.v1 : null,
            inErrorsPerSec: deviceUp && s ? s.v2 : null,
            outErrorsPerSec: deviceUp && s ? s.v3 : null,
            inDiscardsPerSec: deviceUp && s ? s.v4 : null,
            outDiscardsPerSec: deviceUp && s ? s.v5 : null
        };
    });

    // --- metrics[] (schema v2): every exported non-interface sensor ---
    const metricRows = db.prepare(`
        SELECT e.id, e.kind, e.name, e.code, d.name AS device_name, d.status AS device_status
        FROM entities e JOIN devices d ON d.id = e.device_id
        WHERE e.export = 1 AND e.kind != 'if'
        ORDER BY d.name, e.kind, e.name`).all();
    const metrics = metricRows.map((r) => {
        const s = latest.get(r.id);
        const deviceUp = r.device_status === 'up';
        const v0 = deviceUp && s ? s.v0 : null;
        const v1 = deviceUp && s ? s.v1 : null;
        const fmt = metricDisplay(r.kind, r.name, v0, v1);
        const out = {
            code: r.code,
            kind: r.kind === 'fs' ? 'disk' : r.kind === 'gauge' ? 'util' : r.kind,
            host: r.device_name,
            display: fmt.display,
            value: fmt.value ?? null,
            sampledAt: s ? new Date(s.ts * 1000).toISOString() : null
        };
        if (fmt.unit) out.unit = fmt.unit;
        if (r.kind === 'cpu') out.status = cpuStatus(v0);
        return out;
    });

    // --- device uptime metrics ---
    const now = Math.floor(Date.now() / 1000);
    for (const d of db.prepare('SELECT * FROM devices WHERE export_uptime = 1 ORDER BY name').all()) {
        const up = d.status === 'up' && d.last_sysuptime_cs != null;
        const sec = up ? Math.floor(d.last_sysuptime_cs / 100) + Math.max(0, now - (d.last_seen_ts || now)) : null;
        metrics.push({
            code: d.uptime_code,
            kind: 'uptime',
            host: d.name,
            display: up ? fmtUptime(sec) : '--',
            value: sec,
            unit: 's',
            sampledAt: d.last_seen_ts ? new Date(d.last_seen_ts * 1000).toISOString() : null
        });
    }

    const doc = {
        schemaVersion: 2,
        generator: `snmpcanvas/${pkg.version}`,
        generatedAt: new Date().toISOString(),
        interfaces,
        metrics
    };

    const target = getSetting('export_path');
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, target);
}

function getLastError() { return lastError; }

module.exports = { scheduleWrite, write, getLastError };
