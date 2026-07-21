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
        const sys = await S.get(session, [O.SYS.sysDescr, O.SYS.sysObjectID, O.SYS.sysUpTime, O.SYS.sysName, O.SYS.sysLocation]);
        const system = {
            sysDescr: sys.get(O.SYS.sysDescr) != null ? String(sys.get(O.SYS.sysDescr)) : '',
            sysObjectID: sys.get(O.SYS.sysObjectID) != null ? String(sys.get(O.SYS.sysObjectID)) : '',
            sysUpTime: Number(sys.get(O.SYS.sysUpTime) ?? 0),
            sysName: sys.get(O.SYS.sysName) != null ? String(sys.get(O.SYS.sysName)) : '',
            sysLocation: sys.get(O.SYS.sysLocation) != null ? String(sys.get(O.SYS.sysLocation)) : ''
        };

        const vendor = O.matchVendor(system.sysObjectID, system.sysDescr);
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

        // 3. CPU from the vendor map (Cisco/MikroTik). The HOST-RESOURCES
        //    fallback for everything else is deferred to after the storage walk.
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
        // The HOST-RESOURCES CPU fallback runs after the storage walk below, so
        // it can tell a cold hrProcessorLoad cache (retry + warn) apart from a
        // device that genuinely lacks host-resources (no CPU, no warning).

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

        // CPU (HOST-RESOURCES fallback). Deferred to here so hrType (above) tells
        // us whether the agent exposes host-resources at all. net-snmp computes
        // hrProcessorLoad lazily from sampled CPU deltas, so right after an snmpd
        // restart (or on a many-core / slow agent) the first walk can come back
        // empty or time out on a cold cache while every static table answers fine
        // - and a plain walk drops CPU silently (the timeout is swallowed). So: if
        // the agent has host-resources storage but no hrProcessorLoad, retry once
        // (the first walk warms the cache), then warn rather than vanish. No
        // host-resources at all means genuinely no CPU here - no retry, no noise.
        if (!cpuFound) {
            let hrCpu = await walkMap(walkSession, O.HR.hrProcessorLoad, warnings, 'hrProcessorLoad');
            if (hrCpu.size === 0 && hrType.size > 0) {
                hrCpu = await walkMap(walkSession, O.HR.hrProcessorLoad, warnings, 'hrProcessorLoad (retry)');
                if (hrCpu.size === 0) {
                    warnings.push('The agent exposes HOST-RESOURCES storage but returned no CPU load ' +
                        '(hrProcessorLoad). If this device has a CPU, its cache is likely still cold from a ' +
                        'recent snmpd restart - use Rediscover in a moment and the CPU should appear.');
                }
            }
            if (hrCpu.size > 0) {
                entities.push({
                    kind: 'cpu', snmpIndex: 'cpu', name: `CPU (${hrCpu.size} core${hrCpu.size > 1 ? 's' : ''})`,
                    extra: { style: 'gauge-avg', oids: [...hrCpu.keys()].map((i) => `${O.HR.hrProcessorLoad}.${i}`) },
                    tracked: true
                });
            }
        }

        // 5. Temperature sensors: vendor health OIDs, LM-SENSORS-MIB
        //    (lmsensors on Linux/Proxmox, drive temps on TrueNAS), and the
        //    standard ENTITY-SENSOR-MIB. lmsensors exposes plenty of junk
        //    (unconnected headers reading 0 or wrapped negatives), so
        //    implausible readings default to untracked rather than hidden.
        const plausibleC = (c) => c != null && c > 0 && c < 110;

        if (vendor && vendor.temp) {
            if (vendor.temp.style === 'scalars') {
                const got = await S.get(session, vendor.temp.sensors.map((t) => t.oid));
                for (const t of vendor.temp.sensors) {
                    const raw = got.get(t.oid);
                    if (raw == null) continue;
                    entities.push({
                        kind: 'temp', snmpIndex: `v-${t.oid.split('.').slice(-2).join('.')}`, name: `Temp: ${t.name}`,
                        extra: { style: 'div', valueOid: t.oid, div: t.div || 1 },
                        tracked: plausibleC(Number(raw) / (t.div || 1))
                    });
                }
            } else if (vendor.temp.style === 'walk-tenthF') {
                // Tenths of a degree Fahrenheit (budget PDU internal sensors).
                const rows = await walkMap(walkSession, vendor.temp.oid, warnings, `${vendor.key} temperature`);
                for (const [idx, raw] of rows) {
                    const c = Number.isFinite(Number(raw)) ? (Number(raw) / 10 - 32) * 5 / 9 : null;
                    entities.push({
                        kind: 'temp', snmpIndex: `v-${idx}`, name: `Temp: Sensor ${idx}`,
                        extra: { style: 'tenthF', valueOid: `${vendor.temp.oid}.${idx}` },
                        tracked: plausibleC(c)
                    });
                }
            } else if (vendor.temp.style === 'walk-descr-value') {
                const div = vendor.temp.div || 1;
                const names = await walkMap(walkSession, vendor.temp.descrOid, warnings, `${vendor.key} temperatures`);
                const vals = await walkMap(walkSession, vendor.temp.valueOid, warnings, `${vendor.key} temperature values`);
                for (const [idx, name] of names) {
                    // Some agents pad the sensor table with placeholder rows for
                    // absent slots (FS/Ruijie lists them as "dev:invalid" reading
                    // 0). Skip empty/invalid names, and gate tracking on a
                    // plausible reading like the other temp styles.
                    const nm = String(name).trim();
                    if (!nm || /invalid/i.test(nm)) continue;
                    const c = vals.has(idx) ? Number(vals.get(idx)) / div : null;
                    entities.push({
                        kind: 'temp', snmpIndex: `v-${idx}`, name: `Temp: ${nm}`,
                        extra: { style: 'div', valueOid: `${vendor.temp.valueOid}.${idx}`, div },
                        tracked: plausibleC(c)
                    });
                }
            }
        }

        // Fan tachometers: vendor RPM tables. Absent bays and stopped fans
        // read 0, so only spinning fans are tracked at discovery - a running
        // fan that later drops to 0 still polls and can raise an alarm.
        if (vendor && vendor.fan) {
            if (vendor.fan.style === 'walk-rpm') {
                const rows = await walkMap(walkSession, vendor.fan.rpmOid, warnings, `${vendor.key} fans`);
                let n = 0;
                for (const [idx, raw] of rows) {
                    n++;
                    const rpm = Number.isFinite(Number(raw)) ? Number(raw) : null;
                    entities.push({
                        kind: 'fan', snmpIndex: `v-${idx}`, name: `Fan ${n}`,
                        extra: { style: 'div', valueOid: `${vendor.fan.rpmOid}.${idx}`, div: 1 },
                        tracked: rpm != null && rpm > 0 && rpm < 60000
                    });
                }
            }
        }

        // Vendor scalar health metrics: a declarative list of single-value
        // OIDs (battery charge, runtime remaining, output load, ...), each
        // tagged with its kind and divisor. One GET; a sensor the device
        // lacks reads null and is skipped, and an implausible reading is
        // listed untracked rather than dropped, matching the temp styles.
        if (vendor && Array.isArray(vendor.metrics) && vendor.metrics.length) {
            const got = await S.get(session, vendor.metrics.map((m) => m.oid));
            for (const m of vendor.metrics) {
                const raw = got.get(m.oid);
                if (raw == null) continue;
                if (m.kind === 'state') {
                    // Enum status scalar normalized at poll time to 0 (ok) /
                    // 1 (alarm) / null (unknown); the ok/unknown value sets
                    // and display texts ride along in extra.
                    const rv = Number(raw);
                    entities.push({
                        kind: 'state', snmpIndex: `v-${m.oid}`, name: m.name,
                        extra: { style: 'state', valueOid: m.oid, okValues: m.ok || [],
                                 unknownValues: m.unknown || [], okText: m.okText || 'OK',
                                 alarmText: m.alarmText || 'Alarm' },
                        tracked: Number.isFinite(rv) && !(m.unknown || []).includes(rv)
                    });
                    continue;
                }
                const div = m.div || 1;
                const val = Number(raw) / div;
                const ok = m.kind === 'temp' ? plausibleC(val)
                    : (m.kind === 'battery' || m.kind === 'gauge') ? (val >= 0 && val <= 100)
                    : m.kind === 'runtime' ? (val >= 0 && val < 1e7)
                    : (m.kind === 'power' || m.kind === 'meter') ? (val >= 0 && val < 1e6)
                    : Number.isFinite(val);
                const extra = { style: 'div', valueOid: m.oid, div };
                if (m.unit) extra.unit = m.unit;
                if (m.max) extra.max = m.max;
                entities.push({
                    kind: m.kind, snmpIndex: `v-${m.oid}`, name: m.name, extra,
                    tracked: ok
                });
            }
        }

        // Standard UPS-MIB (RFC 1628) power source: any network-managed UPS
        // that answers it gets an on-battery state entity, vendor entry or
        // not (Eaton, Schneider, ...). Skipped when a vendor metric already
        // supplied one (APC NMCs answer both trees - avoid the duplicate).
        if (!entities.some((e) => e.kind === 'state')) {
            let raw = null;
            try {
                const got = await S.get(session, [O.UPS_MIB.outputSource]);
                raw = got.get(O.UPS_MIB.outputSource);
            } catch (err) {
                // Probing a non-UPS: a missing OID is a null varbind, but a
                // flaky agent that errors the whole request must not sink an
                // otherwise-complete discovery.
                warnings.push(`UPS-MIB check skipped: ${err.message}`);
            }
            if (raw != null) {
                const rv = Number(raw);
                entities.push({
                    kind: 'state', snmpIndex: 'v-upsmib-source', name: 'Power',
                    extra: { style: 'state', valueOid: O.UPS_MIB.outputSource,
                             okValues: [3], unknownValues: [1], okText: 'Online',
                             alarmText: 'On battery' },
                    tracked: Number.isFinite(rv) && rv !== 1
                });
            }
        }

        // APC Rack PDU load: one amps meter per metered phase and per metered
        // bank. rPDULoadStatusLoad is tenths of amps; the row's phase- and
        // bank-number columns (0 = not that kind of row) name it. Walking the
        // table generalizes across single/three-phase and 1..N bank models.
        if (vendor && vendor.load && vendor.load.style === 'apc-rpdu') {
            const loads = await walkMap(walkSession, vendor.load.loadOid, warnings, `${vendor.key} load`);
            const phases = await walkMap(walkSession, vendor.load.phaseOid, warnings, `${vendor.key} load phase`);
            const banks = await walkMap(walkSession, vendor.load.bankOid, warnings, `${vendor.key} load bank`);
            for (const [idx, raw] of loads) {
                const ph = Number(phases.get(idx)) || 0;
                const bk = Number(banks.get(idx)) || 0;
                const name = ph > 0 ? `Phase L${ph}` : bk > 0 ? `Bank ${bk}` : `Load ${idx}`;
                const amps = Number.isFinite(Number(raw)) ? Number(raw) / 10 : null;
                entities.push({
                    kind: 'meter', snmpIndex: `load-${idx}`, name,
                    extra: { style: 'div', valueOid: `${vendor.load.loadOid}.${idx}`, div: 10, unit: 'A', max: vendor.load.maxAmps || 20 },
                    tracked: amps != null && amps >= 0 && amps < 1000
                });
            }
        }

        // Switched power strips: one entity per outlet (state 1=on, 0=off).
        // Either a walkable per-port column (stateOid) or, for firmware that
        // scatters states across a flat list, explicit per-port instances.
        if (vendor && vendor.outlets) {
            if (vendor.outlets.stateOid) {
                const states = await walkMap(walkSession, vendor.outlets.stateOid, warnings, `${vendor.key} outlets`);
                for (const [idx] of states) {
                    entities.push({
                        kind: 'outlet', snmpIndex: idx, name: `Outlet ${idx}`,
                        extra: { style: 'outlet', valueOid: `${vendor.outlets.stateOid}.${idx}` },
                        tracked: true
                    });
                }
            } else if (vendor.outlets.ports) {
                const got = await S.get(session, vendor.outlets.ports.map((p) => p.oid));
                for (const p of vendor.outlets.ports) {
                    if (got.get(p.oid) == null) continue;
                    entities.push({
                        kind: 'outlet', snmpIndex: String(p.n), name: `Outlet ${p.n}`,
                        extra: { style: 'outlet', valueOid: p.oid },
                        tracked: true
                    });
                }
            }
        }

        const lmNames = await walkMap(walkSession, O.TEMP.lmTempDevice, warnings, 'lmsensors temperatures');
        if (lmNames.size > 0) {
            const lmValues = await walkMap(walkSession, O.TEMP.lmTempValue, warnings, 'lmsensors values');
            // When a CPU package sensor exists, the per-core clones are
            // redundant - list them, but untracked by default.
            const hasPackage = [...lmNames.values()].some((n) => /^Package id/i.test(String(n)));
            for (const [idx, name] of lmNames) {
                const raw = Number(lmValues.get(idx));
                const c = Number.isFinite(raw) ? (raw >= 1000 ? raw / 1000 : raw) : null;
                const coreDup = hasPackage && /^Core \d+$/i.test(String(name));
                entities.push({
                    kind: 'temp', snmpIndex: `lm-${idx}`, name: `Temp: ${String(name)}`,
                    extra: { style: 'lm', valueOid: `${O.TEMP.lmTempValue}.${idx}` },
                    tracked: plausibleC(c) && !coreDup
                });
            }
        }

        const entTypes = await walkMap(walkSession, O.TEMP.entSensorType, warnings, 'entity sensors');
        const celsius = [...entTypes].filter(([, t]) => Number(t) === 8).map(([i]) => i);
        if (celsius.length > 0) {
            const entScale = await walkMap(walkSession, O.TEMP.entSensorScale, warnings, 'entity sensor scale');
            const entPrec = await walkMap(walkSession, O.TEMP.entSensorPrecision, warnings, 'entity sensor precision');
            const entValue = await walkMap(walkSession, O.TEMP.entSensorValue, warnings, 'entity sensor values');
            const entNames = await walkMap(walkSession, O.TEMP.entPhysicalName, warnings, 'entity names');
            for (const idx of celsius) {
                const scaleExp = (Number(entScale.get(idx) ?? 9) - 9) * 3;   // enum 9 = units
                const precision = Number(entPrec.get(idx) ?? 0);
                const raw = Number(entValue.get(idx));
                const c = Number.isFinite(raw) ? raw * Math.pow(10, scaleExp - precision) : null;
                entities.push({
                    kind: 'temp', snmpIndex: `ent-${idx}`,
                    name: `Temp: ${String(entNames.get(idx) ?? `sensor ${idx}`)}`,
                    extra: { style: 'entity', valueOid: `${O.TEMP.entSensorValue}.${idx}`, scaleExp, precision },
                    tracked: plausibleC(c)
                });
            }
        }

        // 6. ASRock Rack BMC sensor table: named hardware sensors with
        //    formatted string readings. The suffix classifies each row -
        //    "...rpm" is a fan, "...&deg;C" a temperature; voltage rails and
        //    discrete status sensors (0x....) are skipped. "Not Available"
        //    rows (host off, unpopulated fan headers) classify by name and
        //    default to untracked.
        const bmcNames = await walkMap(walkSession, O.ASROCK_BMC.nameOid, warnings, 'ASRock BMC sensors');
        if (bmcNames.size > 0) {
            const bmcValues = await walkMap(walkSession, O.ASROCK_BMC.valueOid, warnings, 'ASRock BMC readings');
            for (const [idx, rawName] of bmcNames) {
                const name = String(rawName);
                const reading = String(bmcValues.get(idx) ?? '');
                let kind = null, available = true;
                if (/rpm\s*$/i.test(reading)) kind = 'fan';
                else if (/deg|°/i.test(reading)) kind = 'temp';
                else if (/not available/i.test(reading)) {
                    available = false;
                    if (/fan/i.test(name)) kind = 'fan';
                    else if (/temp/i.test(name)) kind = 'temp';
                }
                if (!kind) continue; // voltages, discrete status sensors
                const value = available ? parseFloat(reading) : null;
                entities.push({
                    kind,
                    snmpIndex: `ar-${idx}`,
                    name: `${kind === 'fan' ? 'Fan' : 'Temp'}: ${name}`,
                    extra: { style: 'asrock-str', valueOid: `${O.ASROCK_BMC.valueOid}.${idx}` },
                    tracked: available && Number.isFinite(value) &&
                        (kind === 'fan' ? value >= 0 && value < 30000 : value > 0 && value < 110)
                });
            }
        }

        // 7. NET-SNMP-EXTEND-MIB outputs: the agent owner publishes numbers
        //    with one-line `extend` directives in snmpd.conf, named by a
        //    convention that picks the kind: temp- (degrees C), fan- (RPM),
        //    power- (watts), util- (percent). This is the doorway for data
        //    SNMP can't see natively - nvidia-smi GPU stats, UPS runtime,
        //    anything a shell command can print. Explicit configuration is
        //    treated as intent: numeric outputs default to tracked.
        const extendRows = await walkMap(walkSession, O.NSEXTEND_OUTPUT, warnings, 'snmpd extend outputs');
        for (const [idx, rawValue] of extendRows) {
            // Index is the extend name as a length-prefixed ASCII string.
            const parts = idx.split('.').map(Number);
            const name = String.fromCharCode(...parts.slice(1, 1 + parts[0]));
            const m = /^(temp|fan|power|util|batt|runtime)-(.+)$/i.exec(name);
            if (!m) continue;
            const kind = { temp: 'temp', fan: 'fan', power: 'power', util: 'gauge', batt: 'battery', runtime: 'runtime' }[m[1].toLowerCase()];
            const label = { temp: 'Temp', fan: 'Fan', power: 'Power', gauge: 'Util', battery: 'Batt', runtime: 'Runtime' }[kind];
            // First numeric line wins - banners (upsc's SSL notice) are skipped.
            let value = NaN;
            for (const line of String(rawValue).split(/\r?\n/)) {
                const n = parseFloat(line);
                if (Number.isFinite(n)) { value = n; break; }
            }
            entities.push({
                kind,
                snmpIndex: `ext-${name}`,
                name: `${label}: ${m[2]}`,
                extra: { style: 'extend', valueOid: `${O.NSEXTEND_OUTPUT}.${idx}` },
                tracked: Number.isFinite(value)
            });
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
