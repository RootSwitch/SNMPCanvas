'use strict';
// Add-device probe: validate credentials with a system-group GET, then walk
// the standard tables (plus the vendor map) into an inventory the user
// confirms in the UI. Hardcoded numeric OIDs only -- see oids.js.

const S = require('./snmp');
const O = require('./oids');

// Filesystems that are usually noise (tmpfs mounts net-snmp mislabels as
// FixedDisk, TrueNAS system-dataset internals, ZFS snapshot mounts).
// Discovered and listed, but default to untracked -- the user can still
// check them in the wizard.
const FS_NOISE = /^\/(run|dev|proc|sys|snap|tmp)(\/|$)|^\/var\/db\/system(\/|$)|\/\.zfs(\/|$)/;

// Plumbing that reports a real ethernet ifType but is rarely what anyone
// wants graphed by default: docker/libvirt (veth, docker0, br-<hash>, virbr),
// Proxmox per-VM taps and firewall bridges (which also renumber on VM
// restart/migration, breeding stale entities), and the Linux pseudo-device
// zoo that Ubiquiti APs expose (ifb, gretap, erspan, tunnel endpoints,
// mld-wifi, dummy VAPs) plus per-SSID VLAN subinterfaces (wifi0ap0.50 --
// the base per-SSID VAPs like wifi0ap0 stay tracked).
const IF_NOISE = new RegExp('^(' + [
    'veth', 'docker\\d', 'br-[0-9a-f]{12}$', 'virbr',
    'tap\\d+i\\d+', 'fwbr\\d+', 'fwpr\\d+p\\d+', 'fwln\\d+i\\d+',
    'ifb\\d', 'gretap\\d', 'erspan\\d', 'gre\\d', 'sit\\d', 'ip6tnl', 'ip6gre', 'teql\\d',
    'mld-', 'dum\\w*vap', 'miireg', 'soc\\d', 'pd\\d+$',
    'wifi\\d+ap\\d+\\.\\d+$'
].join('|') + ')');

// Walks a column into a Map(index -> value); missing tables resolve to an
// empty Map instead of failing the whole probe.
async function walkMap(session, oid, warnings, what) {
    try {
        const rows = await S.walkColumn(session, oid);
        return new Map(rows.map((r) => [r.index, r.value]));
    } catch (err) {
        if (err.code !== 'timeout') warnings.push(`${what}: ${err.message}`);
        return new Map();
    }
}

// target: { host, port, version, creds } -- see snmp.js
// Returns { system, vendorKey, entities, warnings }. Throws with a readable
// message when the device is unreachable or credentials are wrong.
async function probe(target) {
    const session = S.createSession(target);
    const warnings = [];
    let walkSession = session;   // may switch to a v1 session (GetBulk fallback)
    let v1Session = null;
    try {
        // 1. Credential/reachability gate: plain GET of the system group.
        const sys = await S.get(session, [O.SYS.sysDescr, O.SYS.sysObjectID, O.SYS.sysUpTime, O.SYS.sysName]);
        const system = {
            sysDescr: sys.get(O.SYS.sysDescr) != null ? String(sys.get(O.SYS.sysDescr)) : '',
            sysObjectID: sys.get(O.SYS.sysObjectID) != null ? String(sys.get(O.SYS.sysObjectID)) : '',
            sysUpTime: Number(sys.get(O.SYS.sysUpTime) ?? 0),
            sysName: sys.get(O.SYS.sysName) != null ? String(sys.get(O.SYS.sysName)) : ''
        };

        const vendor = O.matchVendor(system.sysObjectID);
        const entities = [];

        // 2. Interfaces: ifTable + ifXTable.
        let ifDescr = await walkMap(walkSession, O.IF.ifDescr, warnings, 'ifDescr');
        // Some embedded agents (printers, older appliances) answer plain GETs
        // but time out on the GetBulk PDU that v2c walks use. Retry with
        // SNMPv1 GetNext walks -- polling is unaffected, it only ever GETs.
        if (ifDescr.size === 0 && target.version === '2c') {
            v1Session = S.createSession({ ...target, version: '1' });
            const retry = await walkMap(v1Session, O.IF.ifDescr, warnings, 'ifDescr (v1 retry)');
            if (retry.size > 0) {
                walkSession = v1Session;
                ifDescr = retry;
                warnings.push('This agent ignores SNMPv2c GetBulk, so discovery fell back to SNMPv1 GetNext walks. ' +
                    '64-bit counters are not visible over v1, so 32-bit counters will be polled instead.');
            }
        }
        if (ifDescr.size > 0) {
            // Sequential column walks -- gentle on slow control planes.
            const ifType = await walkMap(walkSession, O.IF.ifType, warnings, 'ifType');
            const ifSpeed = await walkMap(walkSession, O.IF.ifSpeed, warnings, 'ifSpeed');
            const ifAdmin = await walkMap(walkSession, O.IF.ifAdminStatus, warnings, 'ifAdminStatus');
            const ifOper = await walkMap(walkSession, O.IF.ifOperStatus, warnings, 'ifOperStatus');
            const ifName = await walkMap(walkSession, O.IFX.ifName, warnings, 'ifName');
            const ifAlias = await walkMap(walkSession, O.IFX.ifAlias, warnings, 'ifAlias');
            const ifHighSpeed = await walkMap(walkSession, O.IFX.ifHighSpeed, warnings, 'ifHighSpeed');
            const ifHCIn = await walkMap(walkSession, O.IFX.ifHCInOctets, warnings, 'ifHCInOctets');

            for (const [idx, descr] of ifDescr) {
                const type = Number(ifType.get(idx) ?? 0);
                const highMbps = Number(ifHighSpeed.get(idx) ?? 0);
                const speedBps = highMbps > 0 ? highMbps * 1e6 : Number(ifSpeed.get(idx) ?? 0);
                const hc = ifHCIn.has(idx);
                const name = String(ifName.get(idx) ?? descr ?? `if${idx}`);
                entities.push({
                    kind: 'if',
                    snmpIndex: idx,
                    name,
                    alias: String(ifAlias.get(idx) ?? ''),
                    speedBps,
                    adminStatus: Number(ifAdmin.get(idx) ?? 0) || null,
                    operStatus: Number(ifOper.get(idx) ?? 0) || null,
                    extra: { hc, ifType: type },
                    tracked: O.DEFAULT_TRACKED_IFTYPES.has(type) && !IF_NOISE.test(name)
                });
                if (!hc && speedBps >= 100e6) {
                    warnings.push(`${name}: no 64-bit counters at ${Math.round(speedBps / 1e6)} Mbps -- ` +
                        'rates may be unreliable at long polling intervals (32-bit counters wrap fast).');
                }
            }
        }

        // 3. CPU: vendor map first, HOST-RESOURCES fallback.
        let cpuFound = false;
        if (vendor && vendor.cpu) {
            if (vendor.cpu.style === 'walk-gauge-pct') {
                let rows = await walkMap(walkSession, vendor.cpu.oid, warnings, `${vendor.key} cpu`);
                let base = vendor.cpu.oid;
                if (rows.size === 0 && vendor.cpu.fallback) {
                    rows = await walkMap(walkSession, vendor.cpu.fallback, warnings, `${vendor.key} cpu (fallback)`);
                    base = vendor.cpu.fallback;
                }
                if (rows.size > 0) {
                    entities.push({
                        kind: 'cpu', snmpIndex: 'cpu', name: 'CPU',
                        extra: { style: 'gauge-avg', oids: [...rows.keys()].map((i) => `${base}.${i}`) },
                        tracked: true
                    });
                    cpuFound = true;
                }
            } else if (vendor.cpu.style === 'scalar-gauge-pct') {
                const v = await S.get(session, [vendor.cpu.oid]);
                if (v.get(vendor.cpu.oid) != null) {
                    entities.push({
                        kind: 'cpu', snmpIndex: 'cpu', name: 'CPU',
                        extra: { style: 'gauge-avg', oids: [vendor.cpu.oid] },
                        tracked: true
                    });
                    cpuFound = true;
                }
            }
        }
        if (!cpuFound) {
            const hrCpu = await walkMap(walkSession, O.HR.hrProcessorLoad, warnings, 'hrProcessorLoad');
            if (hrCpu.size > 0) {
                entities.push({
                    kind: 'cpu', snmpIndex: 'cpu', name: `CPU (${hrCpu.size} core${hrCpu.size > 1 ? 's' : ''})`,
                    extra: { style: 'gauge-avg', oids: [...hrCpu.keys()].map((i) => `${O.HR.hrProcessorLoad}.${i}`) },
                    tracked: true
                });
            }
        }

        // 4. Memory: vendor pools first, hrStorage(Ram) fallback. Filesystems
        //    always come from hrStorage(FixedDisk).
        let memFound = false;
        if (vendor && vendor.mem && vendor.mem.style === 'used-free-pools') {
            const names = await walkMap(walkSession, vendor.mem.nameOid, warnings, `${vendor.key} memory pools`);
            for (const [idx, name] of names) {
                entities.push({
                    kind: 'mem', snmpIndex: idx, name: `Memory: ${String(name)}`,
                    extra: { style: 'used-free', usedOid: `${vendor.mem.usedOid}.${idx}`, freeOid: `${vendor.mem.freeOid}.${idx}` },
                    tracked: true
                });
                memFound = true;
            }
        }
        const hrType = await walkMap(walkSession, O.HR.hrStorageType, warnings, 'hrStorageTable');
        if (hrType.size > 0) {
            const hrDescr = await walkMap(walkSession, O.HR.hrStorageDescr, warnings, 'hrStorageDescr');
            const hrAlloc = await walkMap(walkSession, O.HR.hrStorageAllocationUnits, warnings, 'hrStorageAllocationUnits');
            const hrSize = await walkMap(walkSession, O.HR.hrStorageSize, warnings, 'hrStorageSize');
            const ramRows = [];
            for (const [idx, type] of hrType) {
                const typeStr = String(type);
                const isRam = typeStr === O.HR_STORAGE_RAM;
                const isDisk = typeStr === O.HR_STORAGE_FIXEDDISK;
                if (!isRam && !isDisk) continue;
                const alloc = Number(hrAlloc.get(idx) ?? 1) || 1;
                const sizeUnits = Number(hrSize.get(idx) ?? 0);
                if (sizeUnits <= 0) continue;
                const descr = String(hrDescr.get(idx) ?? (isRam ? 'RAM' : `storage ${idx}`));
                if (isRam) {
                    if (!memFound) ramRows.push({ idx, descr, alloc, bytes: sizeUnits * alloc });
                    continue;
                }
                entities.push({
                    kind: 'fs',
                    snmpIndex: idx,
                    name: descr,
                    extra: {
                        style: 'hr-storage', allocUnits: alloc,
                        usedOid: `${O.HR.hrStorageUsed}.${idx}`, sizeOid: `${O.HR.hrStorageSize}.${idx}`
                    },
                    tracked: !FS_NOISE.test(descr)
                });
            }
            // Agents can report many hrStorageRam rows (bsnmpd/pfSense lists
            // every UMA allocator zone). Only the real one is wanted: prefer
            // "Physical memory" (net-snmp), then "Real memory" (BSD), else
            // the largest row.
            if (ramRows.length > 0) {
                const best =
                    ramRows.find((r) => /^physical memory/i.test(r.descr)) ||
                    ramRows.find((r) => /^real memory/i.test(r.descr)) ||
                    ramRows.reduce((a, b) => (b.bytes > a.bytes ? b : a));
                entities.push({
                    kind: 'mem',
                    snmpIndex: best.idx,
                    name: `Memory: ${best.descr}`,
                    extra: {
                        style: 'hr-storage', allocUnits: best.alloc,
                        usedOid: `${O.HR.hrStorageUsed}.${best.idx}`, sizeOid: `${O.HR.hrStorageSize}.${best.idx}`
                    },
                    tracked: true
                });
            }
        }

        // Answered the system group but exposed no tables at all: almost
        // always a restricted SNMP view, not an SNMPCanvas problem.
        if (entities.length === 0) {
            warnings.push('The device responded but exposed no interface, CPU, or storage tables. ' +
                'Its SNMP agent likely restricts this community to the system group ' +
                '(the stock RHEL/Rocky snmpd.conf does this -- widen the "view systemview" lines in /etc/snmp/snmpd.conf).');
        }

        return { system, vendorKey: vendor ? vendor.key : null, entities, warnings };
    } finally {
        S.closeQuietly(session);
        if (v1Session) S.closeQuietly(v1Session);
    }
}

module.exports = { probe };
