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
    return d > 0 ? `up ${d}d ${h}h` : h > 0 ? `up ${h}h ${m}m` : `up ${m}m`;
}

// Per-kind display strings, kept SHORT for label lines. A null value keeps
// the entry with "--" so an authored code never looks like a typo.
function metricDisplay(kind, name, v0, v1, extra) {
    const NULL_LABEL = { cpu: 'CPU', mem: 'Mem', fs: 'Disk', temp: 'Temp', fan: 'Fan', power: 'Power', battery: 'Batt', runtime: 'Runtime', outlet: 'Outlet' };
    if (v0 == null) {
        const label = (kind === 'gauge' || kind === 'meter' || kind === 'state')
            ? String(name || '').replace(/^Util:\s*/i, '').trim() : NULL_LABEL[kind];
        return { display: `${label ? label + ' ' : ''}--`, value: null };
    }
    switch (kind) {
        case 'cpu': return { display: `CPU ${Math.round(v0)}%`, value: Math.round(v0), unit: '%' };
        case 'mem': {
            const pct = v1 > 0 ? v0 / v1 * 100 : null;
            return pct == null ? { display: 'Mem --', value: null }
                : { display: `Mem ${Math.round(pct)}%`, value: Math.round(pct), unit: '%' };
        }
        case 'fs': {
            const pct = v1 > 0 ? v0 / v1 * 100 : null;
            return pct == null ? { display: 'Disk --', value: null }
                : { display: `Disk ${Math.round(pct)}%`, value: Math.round(pct), unit: '%' };
        }
        case 'temp': return { display: `Temp ${Math.round(v0)}C`, value: Math.round(v0), unit: 'C' };
        case 'fan': return { display: `Fan ${Math.round(v0)}rpm`, value: Math.round(v0), unit: 'rpm' };
        case 'power': return { display: `Power ${v0 >= 100 ? Math.round(v0) : v0.toFixed(1)}W`, value: v0, unit: 'W' };
        case 'battery': return { display: `Batt ${Math.round(v0)}%`, value: Math.round(v0), unit: '%' };
        case 'outlet': return { display: v0 ? 'Outlet On' : 'Outlet Off', value: v0 ? 1 : 0 };
        case 'runtime': {
            const d = v0 >= 86400 ? `${Math.floor(v0 / 86400)}d ${Math.floor(v0 % 86400 / 3600)}h`
                : v0 >= 3600 ? `${Math.floor(v0 / 3600)}h ${Math.round(v0 % 3600 / 60)}m`
                : `${Math.round(v0 / 60)}m`;
            return { display: `Runtime ${d}`, value: Math.round(v0), unit: 's' };
        }
        case 'gauge': {
            // Entity names look like "Util: GPU" - reuse the suffix as the label.
            const label = String(name || '').replace(/^Util:\s*/i, '').trim();
            return { display: `${label ? label + ' ' : ''}${Math.round(v0)}%`, value: Math.round(v0), unit: '%' };
        }
        case 'meter': {
            // Generic reading in its own unit (amps, volts, ...); the entity
            // name is the label since there is no fixed kind word.
            const u = (extra && extra.unit) || '';
            const shown = Math.abs(v0) >= 100 ? String(Math.round(v0)) : v0.toFixed(1);
            const label = String(name || '').trim();
            return { display: `${label ? label + ' ' : ''}${shown}${u ? ' ' + u : ''}`, value: v0, unit: u };
        }
        case 'state': {
            // Binary status: 0 ok / 1 alarm, shown with the entity's own
            // wording ("Power Online" / "Power On battery").
            const label = String(name || '').trim();
            const txt = v0 ? ((extra && extra.alarmText) || 'Alarm') : ((extra && extra.okText) || 'OK');
            return { display: `${label ? label + ' ' : ''}${txt}`, value: v0 ? 1 : 0 };
        }
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
        SELECT e.id, e.kind, e.name, e.code, e.extra, d.name AS device_name, d.status AS device_status
        FROM entities e JOIN devices d ON d.id = e.device_id
        WHERE e.export = 1 AND e.kind != 'if'
        ORDER BY d.name, e.kind, e.name`).all();
    const metrics = metricRows.map((r) => {
        const s = latest.get(r.id);
        const deviceUp = r.device_status === 'up';
        const v0 = deviceUp && s ? s.v0 : null;
        const v1 = deviceUp && s ? s.v1 : null;
        const extra = r.extra ? JSON.parse(r.extra) : {};
        const fmt = metricDisplay(r.kind, r.name, v0, v1, extra);
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
        // Forward-safe per the kiosk contract: it ignores status on non-cpu
        // kinds today, but battery is the likely next coloring gate.
        if (r.kind === 'battery') {
            out.status = v0 == null ? 'unknown' : v0 <= 20 ? 'crit' : v0 <= 50 ? 'warn' : 'ok';
        }
        // Same forward-safe contract: an alarm state (on battery, failed fan)
        // is the clearest coloring gate a kiosk could want.
        if (r.kind === 'state') {
            out.status = v0 == null ? 'unknown' : v0 ? 'crit' : 'ok';
        }
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

    // --- devices[] (schema v3): the up/down roster ---
    // Every device contributing ANYTHING to this feed (an interface, a
    // sensor, or just its uptime), with its reachability status. Consumers
    // that alert on device-down can rule off this instead of fishing device
    // blocks out of interface entries - which only covered devices that
    // happened to export an interface.
    const devices = db.prepare(`
        SELECT DISTINCT d.name, d.host, d.status FROM devices d
        LEFT JOIN entities e ON e.device_id = d.id AND e.export = 1
        WHERE e.id IS NOT NULL OR d.export_uptime = 1
        ORDER BY d.name`).all()
        .map((d) => ({ name: d.name, host: d.host, status: d.status || 'unknown' }));

    // Advertise the poll cadence so the consumer's staleness threshold matches
    // this instance's actual refresh rhythm. Without it the PingCanvas kiosk
    // assumes 30s and grays the overlay permanently for any cadence over ~60s -
    // and the default here is 300s. Use the slowest configured interval so a
    // slow-polled device never false-flags the whole overlay as stale.
    const globalInterval = parseInt(getSetting('poll_interval_s'), 10) || 300;
    const maxDeviceInterval = db.prepare(
        'SELECT MAX(poll_interval_s) AS m FROM devices WHERE poll_interval_s IS NOT NULL').get().m || 0;
    const doc = {
        schemaVersion: 3,
        generator: `snmpcanvas/${pkg.version}`,
        generatedAt: new Date().toISOString(),
        pollIntervalSec: Math.max(globalInterval, maxDeviceInterval),
        devices,
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
