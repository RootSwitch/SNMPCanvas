'use strict';
// Reconciling a fresh probe against the stored entity list. Extracted from the
// Rediscover route so the poller can run the SAME repair automatically: a
// device whose agent renumbered its instances after a reboot needs exactly
// this, and having two implementations of "which entities are real now" is how
// the manual and automatic paths drift apart.

const { db, generateIfCode } = require('./db');

// A displaced row is PARKED on a tombstone, never relabelled. The index it
// held now answers as a different interface; renaming the row to match would
// hand that interface the old row's id, tracked flag, short code and history -
// which is exactly the splice this exists to stop. snmp_index is TEXT NOT NULL
// with UNIQUE (device, kind, index), so the tombstone carries the row id to stay
// unique. Only a human Rediscover retires a parked row; see the prune below.
function tombstone(e) { return `gone:${e.snmp_index}#${e.id}`; }

// d: the devices row. result: what discover.probe() returned.
// opts.untrack: allow entities missing from the probe to be UNTRACKED. Opt-in
// because `tracked` is operator-assigned - see the note at the prune below.
// Returns { added, removed, updated, flagged, rebound, parked } - human-readable
// change lists. Callers own the follow-up (poller.deviceChanged, exporter).
function reconcileDevice(d, result, opts = {}) {
    const summary = { added: [], removed: [], updated: [], flagged: [], rebound: [], parked: [] };
    db.transaction(() => {
        const idy = result.identity || {};
        db.prepare(`UPDATE devices SET sys_descr = ?, sys_object_id = ?, sys_name = ?, sys_location = ?, vendor_key = ?,
                    os_summary = ?, hw_model = ?, cpu_cores = ?, ram_kb = ? WHERE id = ?`)
            .run(result.system.sysDescr, result.system.sysObjectID, result.system.sysName, result.system.sysLocation, result.vendorKey,
                 idy.osSummary || null, idy.hwModel || null, idy.cpuCores || null, idy.ramKb || null, d.id);
        const existing = db.prepare('SELECT * FROM entities WHERE device_id = ?').all(d.id);
        const byKey = new Map(existing.map((e) => [`${e.kind}:${e.snmp_index}`, e]));

        // ---- phase 1: plan, against the rows as they were ---------------------
        //
        // Identity is (kind, index) right up until the name at that index
        // changes. Then the index has been re-dealt - a reboot renumbered the
        // agent, a chassis moved a module - and the row's NAME is the better
        // witness to which interface it is. So an index whose occupant changed
        // name is resolved by looking for the row that already carries the new
        // name and has lost its own index: exactly one such row is REBOUND
        // (moved, keeping id, tracked, code and history). Zero or several
        // candidates mints a fresh row instead, because a wrong guess splices
        // two interfaces' counter histories under one code, which is strictly
        // worse than the duplicate a new row costs. Same rule, same reason, as
        // the agent's own persistent-index adoption.
        const probed = result.entities;
        const seen = new Set();
        const same = [];                 // { e, cur } - name unchanged at its index
        const moves = [];                // { cand, e } - an existing row follows its name to a new index
        const inserts = [];              // probed entities nothing can be rebound to
        const displaced = new Map();     // existing.id -> row whose index now answers as something else
        const claimed = new Set();       // existing ids already accounted for this pass

        for (const e of probed) {
            const key = `${e.kind}:${e.snmpIndex}`;
            seen.add(key);
            const cur = byKey.get(key);
            if (cur && cur.name === e.name) { same.push({ e, cur }); claimed.add(cur.id); }
        }
        for (const e of probed) {
            const cur = byKey.get(`${e.kind}:${e.snmpIndex}`);
            if (cur && cur.name === e.name) continue;
            if (cur) displaced.set(cur.id, cur);
            const cands = existing.filter((x) => x.kind === e.kind && x.name === e.name && !claimed.has(x.id));
            if (cands.length === 1) { moves.push({ cand: cands[0], e }); claimed.add(cands[0].id); }
            else inserts.push(e);
        }
        for (const m of moves) displaced.delete(m.cand.id);   // it moved; it is not a corpse

        // ---- phase 2: apply, in an order that never collides on UNIQUE ------
        // Park first, so every index a corpse held is free. Then lift every
        // mover onto a temporary index, so a rotation (A to B's index while B
        // goes to A's) cannot land on a row that has not left yet. Then final
        // moves, then inserts into what is now guaranteed free.
        const park = db.prepare('UPDATE entities SET snmp_index = ?, stale = 1 WHERE id = ?');
        const retire = db.prepare('UPDATE entities SET tracked = 0, export = 0 WHERE id = ?');
        for (const row of displaced.values()) {
            park.run(tombstone(row), row.id);
            if (opts.untrack === true && row.tracked) {
                retire.run(row.id);
                summary.removed.push(`${row.kind} ${row.name} (index ${row.snmp_index} now answers as a different interface; untracked, history kept)`);
            } else {
                summary.parked.push(`${row.kind} ${row.name} (index ${row.snmp_index} now answers as a different interface; parked, still tracked)`);
            }
        }
        const lift = db.prepare('UPDATE entities SET snmp_index = ? WHERE id = ?');
        for (const m of moves) lift.run(`moving:${m.cand.id}`, m.cand.id);
        const land = db.prepare(`UPDATE entities SET snmp_index = ?, alias = ?, speed_bps = ?, extra = ?, stale = 0,
                                 admin_status = ?, oper_status = ? WHERE id = ?`);
        for (const m of moves) {
            land.run(String(m.e.snmpIndex), m.e.alias || m.cand.alias, m.e.speedBps || m.cand.speed_bps,
                     JSON.stringify(m.e.extra || {}), m.e.adminStatus || null, m.e.operStatus || null, m.cand.id);
            summary.rebound.push(`${m.cand.kind} ${m.cand.name}: index ${m.cand.snmp_index} -> ${m.e.snmpIndex} (history, tracking and code kept)`);
        }
        const refresh = db.prepare(`UPDATE entities SET alias = ?, speed_bps = ?, extra = ?, stale = 0,
                                    admin_status = ?, oper_status = ? WHERE id = ?`);
        for (const { e, cur } of same) {
            refresh.run(e.alias || cur.alias, e.speedBps || cur.speed_bps, JSON.stringify(e.extra || {}),
                        e.adminStatus || null, e.operStatus || null, cur.id);
        }
        const ins = db.prepare(`INSERT INTO entities (device_id, kind, snmp_index, name, alias, speed_bps, extra, tracked, admin_status, oper_status, code)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const e of inserts) {
            ins.run(d.id, e.kind, String(e.snmpIndex), e.name, e.alias || null, e.speedBps || null,
                    JSON.stringify(e.extra || {}), e.tracked ? 1 : 0, e.adminStatus || null, e.operStatus || null,
                    generateIfCode(d.name, e.name));
            summary.added.push(`${e.kind} ${e.name}`);
        }

        // ---- prune: rows the probe did not confirm at all ----------------------
        // Only when the same KIND was otherwise seen this probe. Trusting an
        // incomplete probe as the authoritative inventory is a footgun: a cold
        // hrProcessorLoad (e.g. right after an snmpd restart) returns zero CPU
        // and would untrack the device's CPU; a timed-out ifTable walk returns
        // zero interfaces and would untrack ALL of them at once. "Saw 19 of 20
        // interfaces" is a real decommission; "saw 0 of a kind that used to
        // exist" is a failed read for that class - keep it (the poller marks it
        // stale, and the user can remove a genuinely-dead entity by hand).
        //
        // Untracking is OPT-IN, because `tracked` is an OPERATOR-ASSIGNED
        // field. A human pressing Rediscover has asked for the inventory to be
        // re-judged; the automatic re-index has not. The kind guard above
        // covers "saw 0 of a kind", but not "saw 4 of 48" - and the automatic
        // path runs moments after a REBOOT, which is exactly when a switch is
        // most likely to answer with a partly-populated ifTable. Untracking on
        // that reading would silently stop graphing ports somebody chose, and
        // nothing puts them back: a later probe finds the row and updates it,
        // but never sets tracked to 1 again.
        //
        // Parked rows from an EARLIER pass reach here too (their tombstone is
        // never in a probe), which is how a human Rediscover eventually retires
        // a corpse the automatic path could only park.
        const seenKinds = new Set(probed.map((e) => e.kind));
        for (const e of existing) {
            if (claimed.has(e.id) || displaced.has(e.id)) continue;
            const key = `${e.kind}:${e.snmp_index}`;
            if (seen.has(key) || !e.tracked || !seenKinds.has(e.kind)) continue;
            if (opts.untrack === true) {
                db.prepare('UPDATE entities SET tracked = 0, export = 0, stale = 1 WHERE id = ?').run(e.id);
                summary.removed.push(`${e.kind} ${e.name} (untracked, history kept)`);
            } else {
                // Not silence - flag it, so the page shows something is off and
                // a human can decide. `stale` is the existing "this definition
                // may be wrong" marker and costs nothing.
                db.prepare('UPDATE entities SET stale = 1 WHERE id = ?').run(e.id);
                summary.flagged.push(`${e.kind} ${e.name} (missing from probe, still tracked)`);
            }
        }
    })();
    return summary;
}

module.exports = { reconcileDevice };
