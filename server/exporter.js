'use strict';
// snmp-status.json writer: every poll cycle, the latest stats of every
// interface whose "export" box is checked are written atomically (temp file +
// rename, same directory) for a downstream dashboard to ingest.

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

function write() {
    const rows = db.prepare(`
        SELECT e.id, e.snmp_index, e.name, e.alias, e.speed_bps, e.admin_status, e.oper_status,
               d.name AS device_name, d.host, d.status AS device_status
        FROM entities e JOIN devices d ON d.id = e.device_id
        WHERE e.export = 1 AND e.kind = 'if'
        ORDER BY d.name, e.name`).all();
    const latest = db.prepare('SELECT * FROM samples WHERE entity_id = ? ORDER BY ts DESC LIMIT 1');

    const interfaces = rows.map((r) => {
        const s = latest.get(r.id);
        const deviceUp = r.device_status === 'up';
        return {
            id: `${r.device_name}:${r.name}`,
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

    const doc = {
        schemaVersion: 1,
        generator: `snmpcanvas/${pkg.version}`,
        generatedAt: new Date().toISOString(),
        interfaces
    };

    const target = getSetting('export_path');
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    fs.renameSync(tmp, target);
}

function getLastError() { return lastError; }

module.exports = { scheduleWrite, write, getLastError };
