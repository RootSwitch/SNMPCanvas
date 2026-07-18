'use strict';
// Development helper: a fake SNMP device built on net-snmp's agent, so you can
// exercise SNMPCanvas without real hardware.
//
//   node tools/mock-agent.js            # v2c community "public", v3 user "labuser"
//   MOCK_PORT=16100 node tools/mock-agent.js
//
// Simulates a Linux-ish box: system group, 4 interfaces (ifTable + ifXTable
// with 64-bit counters), 2 CPU cores (hrProcessorLoad), RAM + one filesystem
// (hrStorageTable). Counters move with pseudo-random traffic every 5 seconds.

const snmp = require('net-snmp');

const PORT = parseInt(process.env.MOCK_PORT || '16100', 10);
const OT = snmp.ObjectType;
const RO = snmp.MaxAccess['read-only'];

// net-snmp encodes Counter64 from an 8-byte Buffer, not a Number/BigInt.
function c64(big) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(big));
    return buf;
}

const agent = snmp.createAgent({ port: PORT, disableAuthorization: false }, (error /*, data */) => {
    if (error) console.error('agent error:', error.message);
});
const authorizer = agent.getAuthorizer();
authorizer.addCommunity('public');
authorizer.addUser({
    name: 'labuser',
    level: snmp.SecurityLevel.authPriv,
    authProtocol: snmp.AuthProtocols.sha,
    authKey: 'authpass123',
    privProtocol: snmp.PrivProtocols.aes,
    privKey: 'privpass123'
});
const mib = agent.getMib();

// --- system group ---
const scalars = [
    ['sysDescr', '1.3.6.1.2.1.1.1', OT.OctetString, 'SNMPCanvas mock agent - Linux mocklab 6.6.0 x86_64'],
    ['sysObjectID', '1.3.6.1.2.1.1.2', OT.OID, '1.3.6.1.4.1.8072.3.2.10'],
    ['sysUpTime', '1.3.6.1.2.1.1.3', OT.TimeTicks, 0],
    ['sysContact', '1.3.6.1.2.1.1.4', OT.OctetString, 'lab@example.net'],
    ['sysName', '1.3.6.1.2.1.1.5', OT.OctetString, 'mocklab'],
    ['sysLocation', '1.3.6.1.2.1.1.6', OT.OctetString, 'the basement']
];
for (const [name, oid, type, value] of scalars) {
    mib.registerProvider({ name, type: snmp.MibProviderType.Scalar, oid, scalarType: type, maxAccess: RO });
    mib.setScalarValue(name, value);
}

// --- ifTable / ifXTable ---
mib.registerProvider({
    name: 'ifTable', type: snmp.MibProviderType.Table, oid: '1.3.6.1.2.1.2.2.1',
    tableColumns: [
        { number: 1, name: 'ifIndex', type: OT.Integer, maxAccess: RO },
        { number: 2, name: 'ifDescr', type: OT.OctetString, maxAccess: RO },
        { number: 3, name: 'ifType', type: OT.Integer, maxAccess: RO },
        { number: 5, name: 'ifSpeed', type: OT.Gauge, maxAccess: RO },
        { number: 7, name: 'ifAdminStatus', type: OT.Integer, maxAccess: RO },
        { number: 8, name: 'ifOperStatus', type: OT.Integer, maxAccess: RO },
        { number: 10, name: 'ifInOctets', type: OT.Counter, maxAccess: RO },
        { number: 13, name: 'ifInDiscards', type: OT.Counter, maxAccess: RO },
        { number: 14, name: 'ifInErrors', type: OT.Counter, maxAccess: RO },
        { number: 16, name: 'ifOutOctets', type: OT.Counter, maxAccess: RO },
        { number: 19, name: 'ifOutDiscards', type: OT.Counter, maxAccess: RO },
        { number: 20, name: 'ifOutErrors', type: OT.Counter, maxAccess: RO }
    ],
    tableIndex: [{ columnName: 'ifIndex' }]
});
mib.registerProvider({
    name: 'ifXTable', type: snmp.MibProviderType.Table, oid: '1.3.6.1.2.1.31.1.1.1',
    tableColumns: [
        { number: 1, name: 'ifName', type: OT.OctetString, maxAccess: RO },
        { number: 6, name: 'ifHCInOctets', type: OT.Counter64, maxAccess: RO },
        { number: 10, name: 'ifHCOutOctets', type: OT.Counter64, maxAccess: RO },
        { number: 15, name: 'ifHighSpeed', type: OT.Gauge, maxAccess: RO },
        { number: 18, name: 'ifAlias', type: OT.OctetString, maxAccess: RO }
    ],
    tableAugments: 'ifTable'
});

// name, type, mbps, admin, oper, alias, avg utilization (fraction of speed)
const IFACES = [
    { idx: 1, name: 'eth0', descr: 'Intel I226-V', type: 6, mbps: 2500, admin: 1, oper: 1, alias: 'uplink to core-sw', util: 0.11 },
    { idx: 2, name: 'eth1', descr: 'Intel I226-V', type: 6, mbps: 2500, admin: 1, oper: 1, alias: 'lab vlan trunk', util: 0.34 },
    { idx: 3, name: 'eth2', descr: 'Intel I226-V', type: 6, mbps: 1000, admin: 1, oper: 2, alias: '', util: 0 },
    { idx: 4, name: 'lo', descr: 'loopback', type: 24, mbps: 0, admin: 1, oper: 1, alias: '', util: 0 }
];
const counters = new Map(); // idx -> { in: BigInt, out: BigInt, inErr, inDisc, outErr, outDisc }
for (const i of IFACES) {
    counters.set(i.idx, { in: 0n, out: 0n, inErr: 0, inDisc: 0, outErr: 0, outDisc: 0 });
    mib.addTableRow('ifTable', [i.idx, i.descr, i.type, Math.min(i.mbps * 1e6, 4294967295), i.admin, i.oper, 0, 0, 0, 0, 0, 0]);
    mib.addTableRow('ifXTable', [i.idx, i.name, c64(0), c64(0), i.mbps, i.alias]);
}

// --- HOST-RESOURCES: CPU + storage ---
mib.registerProvider({
    name: 'hrProcessorTable', type: snmp.MibProviderType.Table, oid: '1.3.6.1.2.1.25.3.3.1',
    tableColumns: [
        { number: 1, name: 'hrProcessorFrwID', type: OT.Integer, maxAccess: RO }, // stand-in index column
        { number: 2, name: 'hrProcessorLoad', type: OT.Integer, maxAccess: RO }
    ],
    tableIndex: [{ columnName: 'hrProcessorFrwID' }]
});
mib.addTableRow('hrProcessorTable', [196608, 12]);
mib.addTableRow('hrProcessorTable', [196609, 9]);

mib.registerProvider({
    name: 'hrStorageTable', type: snmp.MibProviderType.Table, oid: '1.3.6.1.2.1.25.2.3.1',
    tableColumns: [
        { number: 1, name: 'hrStorageIndex', type: OT.Integer, maxAccess: RO },
        { number: 2, name: 'hrStorageType', type: OT.OID, maxAccess: RO },
        { number: 3, name: 'hrStorageDescr', type: OT.OctetString, maxAccess: RO },
        { number: 4, name: 'hrStorageAllocationUnits', type: OT.Integer, maxAccess: RO },
        { number: 5, name: 'hrStorageSize', type: OT.Integer, maxAccess: RO },
        { number: 6, name: 'hrStorageUsed', type: OT.Integer, maxAccess: RO }
    ],
    tableIndex: [{ columnName: 'hrStorageIndex' }]
});
// 16 GiB RAM ~38% used; 500 GB disk ~61% used (4 KiB units)
mib.addTableRow('hrStorageTable', [1, '1.3.6.1.2.1.25.2.1.2', 'Physical memory', 4096, 4194304, 1594884]);
mib.addTableRow('hrStorageTable', [3, '1.3.6.1.2.1.25.2.1.4', '/srv/tank', 4096, 122070312, 74462890]);

// --- liveness: tick uptime, move counters, wiggle CPU ---
const bootMs = Date.now();
setInterval(() => {
    mib.setScalarValue('sysUpTime', Math.floor((Date.now() - bootMs) / 10) % 4294967296);
    for (const i of IFACES) {
        if (i.oper !== 1 || i.util === 0) continue;
        const c = counters.get(i.idx);
        const bytesPerSec = i.mbps * 1e6 / 8 * i.util;
        const jitter = 0.5 + Math.random();               // 50%-150% of average
        c.in += BigInt(Math.floor(bytesPerSec * 5 * jitter));
        c.out += BigInt(Math.floor(bytesPerSec * 5 * jitter * 0.35));
        if (Math.random() < 0.05) c.inDisc += 1;          // occasional discard
        mib.setTableSingleCell('ifXTable', 6, [i.idx], c64(c.in));
        mib.setTableSingleCell('ifXTable', 10, [i.idx], c64(c.out));
        mib.setTableSingleCell('ifTable', 10, [i.idx], Number(c.in % 4294967296n));
        mib.setTableSingleCell('ifTable', 16, [i.idx], Number(c.out % 4294967296n));
        mib.setTableSingleCell('ifTable', 13, [i.idx], c.inDisc);
    }
    mib.setTableSingleCell('hrProcessorTable', 2, [196608], Math.max(2, Math.min(98, 12 + Math.floor(Math.random() * 20 - 10))));
    mib.setTableSingleCell('hrProcessorTable', 2, [196609], Math.max(2, Math.min(98, 9 + Math.floor(Math.random() * 16 - 8))));
}, 5000);

console.log(`mock SNMP agent on udp/${PORT} - v2c community "public", v3 user "labuser" (authPriv, SHA-1/"authpass123", AES-128/"privpass123")`);
