'use strict';
// Every OID SNMPCanvas touches, as named numeric constants - no MIB files, no
// MIB parsing. Adding vendor CPU/memory support means adding one entry to
// VENDORS below; nothing else changes.

// --- SNMPv2-MIB system group (scalars, .0 instances) ---
const SYS = {
    sysDescr:    '1.3.6.1.2.1.1.1.0',
    sysObjectID: '1.3.6.1.2.1.1.2.0',
    sysUpTime:   '1.3.6.1.2.1.1.3.0',   // TimeTicks (centiseconds), wraps at ~497 days
    sysName:     '1.3.6.1.2.1.1.5.0',
    sysLocation: '1.3.6.1.2.1.1.6.0'    // free-text site/rack; CrossCanvas nests it into zones on import
};

// --- IF-MIB ifTable (indexed by ifIndex) ---
const IF = {
    ifDescr:        '1.3.6.1.2.1.2.2.1.2',
    ifType:         '1.3.6.1.2.1.2.2.1.3',
    ifSpeed:        '1.3.6.1.2.1.2.2.1.5',   // bps, saturates at ~4.29G
    ifAdminStatus:  '1.3.6.1.2.1.2.2.1.7',   // 1 up, 2 down, 3 testing
    ifOperStatus:   '1.3.6.1.2.1.2.2.1.8',
    ifInOctets:     '1.3.6.1.2.1.2.2.1.10',  // Counter32 - only used when HC absent
    ifInDiscards:   '1.3.6.1.2.1.2.2.1.13',
    ifInErrors:     '1.3.6.1.2.1.2.2.1.14',
    ifOutOctets:    '1.3.6.1.2.1.2.2.1.16',
    ifOutDiscards:  '1.3.6.1.2.1.2.2.1.19',
    ifOutErrors:    '1.3.6.1.2.1.2.2.1.20'
};

// --- IF-MIB ifXTable (same ifIndex; 64-bit counters + nicer names) ---
const IFX = {
    ifName:       '1.3.6.1.2.1.31.1.1.1.1',
    ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6',   // Counter64
    ifHCOutOctets:'1.3.6.1.2.1.31.1.1.1.10',  // Counter64
    ifHighSpeed:  '1.3.6.1.2.1.31.1.1.1.15',  // Mbps
    ifAlias:      '1.3.6.1.2.1.31.1.1.1.18'
};

// ifType values default-checked at discovery (everything else starts
// unchecked so a 500-row stack doesn't flood the tracked set).
const DEFAULT_TRACKED_IFTYPES = new Set([
    6,    // ethernetCsmacd
    7,    // iso88023Csmacd (old-style ethernet, seen on printers/embedded)
    161   // ieee8023adLag
]);

// --- HOST-RESOURCES-MIB (Linux hosts, Windows, many appliances) ---
const HR = {
    hrProcessorLoad:          '1.3.6.1.2.1.25.3.3.1.2',  // 0-100 gauge per core
    hrStorageType:            '1.3.6.1.2.1.25.2.3.1.2',
    hrStorageDescr:           '1.3.6.1.2.1.25.2.3.1.3',
    hrStorageAllocationUnits: '1.3.6.1.2.1.25.2.3.1.4',
    hrStorageSize:            '1.3.6.1.2.1.25.2.3.1.5',
    hrStorageUsed:            '1.3.6.1.2.1.25.2.3.1.6'
};

const HR_STORAGE_RAM       = '1.3.6.1.2.1.25.2.1.2';
const HR_STORAGE_FIXEDDISK = '1.3.6.1.2.1.25.2.1.4';

// --- ASRock Rack BMC sensor table (AMI MegaRAC-based IPMI firmware) ---
// Named hardware sensors with formatted string readings ("600.00rpm",
// "32.00&deg;C", "3.30V", "Not Available"). The reading suffix classifies
// the sensor; fans finally get real tachometers this way, since the BMC
// owns the sensor bus the host OS can't read.
const ASROCK_BMC = {
    nameOid:  '1.3.6.1.4.1.49622.2.1.3',
    valueOid: '1.3.6.1.4.1.49622.2.1.4'
};

// --- NET-SNMP-EXTEND-MIB (snmpd `extend` directive) ---
// Anything the agent owner can print with a one-liner becomes a sensor:
//   extend temp-GPU  /usr/bin/nvidia-smi --query-gpu=temperature.gpu ...
// The name prefix picks the kind: temp- (degrees C), fan- (RPM),
// power- (watts), util- (percent). Output must be a single number.
// nsExtendOutputFull, indexed by the extend name as a length-prefixed
// string. The FULL output (not the first-line column) because some tools
// print banners before the number - NUT's upsc leads with an SSL notice on
// stdout - and the consumer takes the first numeric line.
const NSEXTEND_OUTPUT = '1.3.6.1.4.1.8072.1.3.2.3.1.2';

// --- Temperature sensors ---
// LM-SENSORS-MIB (net-snmp with lmsensors - Linux hosts, Proxmox, FreeBSD/
// TrueNAS drive temps). Values are milli-°C in practice.
const TEMP = {
    lmTempDevice: '1.3.6.1.4.1.2021.13.16.2.1.2',
    lmTempValue:  '1.3.6.1.4.1.2021.13.16.2.1.3',
    // ENTITY-SENSOR-MIB (RFC 3433) - standard sensor table on network gear.
    entSensorType:      '1.3.6.1.2.1.99.1.1.1.1',   // 8 = celsius
    entSensorScale:     '1.3.6.1.2.1.99.1.1.1.2',   // enum: 9=units, 8=milli...
    entSensorPrecision: '1.3.6.1.2.1.99.1.1.1.3',
    entSensorValue:     '1.3.6.1.2.1.99.1.1.1.4',
    entPhysicalName:    '1.3.6.1.2.1.47.1.1.1.1.7'
};

// --- Vendor CPU/memory map, matched by longest dotted prefix of the
// device's sysObjectID. `style` is interpreted by discover.js/poller.js:
//   cpu 'walk-gauge-pct'   walk `oid`; each row is a 0-100 gauge; rows averaged
//   cpu 'scalar-gauge-pct' GET `oid` (a .0 scalar 0-100 gauge)
//   mem 'used-free-pools'  walk nameOid; per pool GET usedOid/freeOid (bytes)
const VENDORS = [
    {
        key: 'cisco',
        label: 'Cisco (IOS / IOS-XE / NX-OS)',
        prefix: '1.3.6.1.4.1.9.',
        cpu: {
            style: 'walk-gauge-pct',
            oid: '1.3.6.1.4.1.9.9.109.1.1.1.1.8',       // cpmCPUTotal5minRev
            fallback: '1.3.6.1.4.1.9.9.109.1.1.1.1.5'   // cpmCPUTotal5min (older)
        },
        mem: {
            style: 'used-free-pools',
            nameOid: '1.3.6.1.4.1.9.9.48.1.1.1.2',      // ciscoMemoryPoolName
            usedOid: '1.3.6.1.4.1.9.9.48.1.1.1.5',      // ciscoMemoryPoolUsed
            freeOid: '1.3.6.1.4.1.9.9.48.1.1.1.6'       // ciscoMemoryPoolFree
        },
        temp: {   // CISCO-ENVMON-MIB (already °C)
            style: 'walk-descr-value',
            descrOid: '1.3.6.1.4.1.9.9.13.1.3.1.2',     // ciscoEnvMonTemperatureDescr
            valueOid: '1.3.6.1.4.1.9.9.13.1.3.1.3',     // ciscoEnvMonTemperatureValue
            div: 1
        }
    },
    {
        // Budget 2-port IP power strips (shared OEM firmware, two badges).
        // Outlet state 1=on/0=off; the ZDL variant adds an internal temp
        // sensor in tenths of a degree Fahrenheit (confirmed against the
        // unit's own display).
        key: 'zdl-pdu',
        label: 'ZDL power strip',
        prefix: '1.3.6.1.4.1.30650.',
        outlets: { stateOid: '1.3.6.1.4.1.30650.3.3.3.1.4' },
        temp: { style: 'walk-tenthF', oid: '1.3.6.1.4.1.30650.3.3.5.1.3' }
    },
    {
        key: 'pdu02ip',
        label: 'PDU02IP power strip',
        prefix: '1.3.6.1.4.1.26104.',
        outlets: { stateOid: '1.3.6.1.4.1.26104.3.3.3.1.4' }
    },
    {
        // First-generation PDU02IP firmware: garbled sysObjectID (matched by
        // sysDescr instead) and outlet states at fixed slots in a flat status
        // list - positions established by toggling ports and diffing.
        key: 'pdu02ip-v1',
        label: 'PDU02IP power strip (v1 firmware)',
        descr: /PDU02IP Remote Power Control/,
        outlets: {
            ports: [
                { n: 1, oid: '1.3.6.1.4.1.26104.1.1.1.5.1.8' },
                { n: 2, oid: '1.3.6.1.4.1.26104.1.1.1.5.1.9' }
            ]
        }
    },
    {
        key: 'mikrotik',
        label: 'MikroTik RouterOS',
        prefix: '1.3.6.1.4.1.14988.',
        // CPU/memory come from HOST-RESOURCES; only health sensors are
        // vendor-specific. Values in tenths of °C; not all models have them.
        temp: {
            style: 'scalars',
            sensors: [
                { name: 'Board temperature', oid: '1.3.6.1.4.1.14988.1.1.3.10.0', div: 10 },
                { name: 'CPU temperature', oid: '1.3.6.1.4.1.14988.1.1.3.11.0', div: 10 }
            ]
        }
    },
    {
        // FS.COM S-series / Ruijie FSOS whitelabel switches (Broadcom-based).
        // No HOST-RESOURCES health tree; sensors live in the device-info
        // entity table. Temperature rows carry a name column (air_inlet /
        // board / switch) and a current-°C column; absent slots are padded
        // with "dev:invalid" rows reading 0, which walk-descr-value skips.
        key: 'fs-ruijie',
        label: 'FS.COM / Ruijie (FSOS)',
        prefix: '1.3.6.1.4.1.52642.',
        temp: {
            style: 'walk-descr-value',
            descrOid: '1.3.6.1.4.1.52642.1.1.10.2.1.1.44.1.4',   // sensor name
            valueOid: '1.3.6.1.4.1.52642.1.1.10.2.1.1.44.1.5',   // current °C
            div: 1
        }
    }
    // Extension examples (untested, contributions welcome):
    // { key: 'fortinet', prefix: '1.3.6.1.4.1.12356.',
    //   cpu: { style: 'scalar-gauge-pct', oid: '1.3.6.1.4.1.12356.101.4.1.3.0' } }  // fgSysCpuUsage
    // { key: 'juniper', prefix: '1.3.6.1.4.1.2636.',
    //   cpu: { style: 'walk-gauge-pct', oid: '1.3.6.1.4.1.2636.3.1.13.1.8' } }      // jnxOperatingCPU
    // MikroTik answers HOST-RESOURCES-MIB; no entry needed.
];

function matchVendor(sysObjectID, sysDescr) {
    // OID-prefix matches take precedence. Trailing-dot compare so a
    // sysObjectID that IS the bare enterprise root (some budget devices)
    // still matches its "1.3.6.1.4.1.NNNN." prefix.
    if (sysObjectID) {
        const candidate = sysObjectID + '.';
        let best = null;
        for (const v of VENDORS) {
            if (v.prefix && candidate.startsWith(v.prefix) && (!best || v.prefix.length > best.prefix.length)) best = v;
        }
        if (best) return best;
    }
    // Fallback for agents with broken sysObjectIDs: match on sysDescr.
    if (sysDescr) {
        for (const v of VENDORS) {
            if (v.descr && v.descr.test(sysDescr)) return v;
        }
    }
    return null;
}

module.exports = { SYS, IF, IFX, HR, TEMP, ASROCK_BMC, NSEXTEND_OUTPUT, HR_STORAGE_RAM, HR_STORAGE_FIXEDDISK, DEFAULT_TRACKED_IFTYPES, VENDORS, matchVendor };
