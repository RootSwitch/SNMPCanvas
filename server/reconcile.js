'use strict';
// Reconciling a fresh probe against the stored entity list. Extracted from the
// Rediscover route so the poller can run the SAME repair automatically: a
// device whose agent renumbered its instances after a reboot needs exactly
// this, and having two implementations of "which entities are real now" is how
// the manual and automatic paths drift apart.

const { db, generateIfCode } = require('./db');

// d: the devices row. result: what discover.probe() returned.
// Returns { added, removed, updated } - lists of human-readable changes.
// Callers own the follow-up (poller.deviceChanged, exporter.scheduleWrite).
function reconcileDevice(d, result) {
    const summary = { added: [], removed: [], updated: [] };
    db.transaction(() => {
        const idy = result.identity || {};
        db.prepare(`UPDATE devices SET sys_descr = ?, sys_object_id = ?, sys_name = ?, sys_location = ?, vendor_key = ?,
                    os_summary = ?, hw_model = ?, cpu_cores = ?, ram_kb = ? WHERE id = ?`)
            .run(result.system.sysDescr, result.system.sysObjectID, result.system.sysName, result.system.sysLocation, result.vendorKey,
                 idy.osSummary || null, idy.hwModel || null, idy.cpuCores || null, idy.ramKb || null, d.id);
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
        // Prune entities that vanished - but ONLY when the same KIND was
        // otherwise seen this probe. Trusting an incomplete probe as the
        // authoritative inventory is a footgun: a cold hrProcessorLoad (e.g.
        // right after an snmpd restart) returns zero CPU and would untrack the
        // device's CPU; a timed-out ifTable walk returns zero interfaces and
        // would untrack ALL of them at once. "Saw 19 of 20 interfaces" is a
        // real decommission; "saw 0 of a kind that used to exist" is a failed
        // read for that class - keep it (the poller marks it stale, and the
        // user can remove a genuinely-dead entity by hand).
        const seenKinds = new Set(result.entities.map((e) => e.kind));
        for (const e of existing) {
            const key = `${e.kind}:${e.snmp_index}`;
            if (!seen.has(key) && e.tracked && seenKinds.has(e.kind)) {
                db.prepare('UPDATE entities SET tracked = 0, export = 0, stale = 1 WHERE id = ?').run(e.id);
                summary.removed.push(`${e.kind} ${e.name} (untracked, history kept)`);
            }
        }
    })();
    return summary;
}

module.exports = { reconcileDevice };
