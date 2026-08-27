'use strict';
// Which interfaces arrive PRE-TICKED at discovery. This is worth driving
// directly because a wrong default here is invisible: the operator accepts a
// checklist without reading it, and a stray row then looks like a choice they
// made rather than one the app made for them.
//
//   node tools/check-iftrack.js
//
// The bug this pins: IF_NOISE was written entirely from Linux, Proxmox and
// Ubiquiti names (veth, docker0, virbr, tap, gretap, mld-), so Windows
// pseudo-interfaces - WAN Miniports, RAS adapters, isatap, Teredo - passed it
// untouched. They report ethernetCsmacd(6) like a real NIC, so they were
// pre-ticked on every Windows host discovered. Found on the operator's own
// desktop: 5 interfaces tracked where 2 were real.
//
// Fixtures below are real rows, not invented ones:
//   Cisco CSR    - snmpwalks/CML/vpn/CSR0 - Tunnel (Gi1-4 connector true(1),
//                  Nu0 other(1), Tu0 tunnel(131))
//   Windows      - the WAN Miniport set on the operator's DC, per
//                  snmpwalks/tierc/tierc-Windows-DC-2.txt

const { shouldTrackInterface } = require('../server/discover');

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}
// (type, name, connector, descr) -> tracked. connector: 1 true, 2 false,
// 0 absent. descr is ifDescr - the stock Microsoft service puts the human
// name there while ifName is ethernet_32774-style.
const T = (type, name, conn, descr) => shouldTrackInterface(type, name, conn, descr);

// --- real hardware is never dropped, whatever else is true of it ----------
check('a physical port is tracked', T(6, 'Gi1', 1) === true);
check('...and still is when the agent omits ifConnectorPresent', T(6, 'Gi1', 0) === true);
check('an old-style ethernet port (ifType 7) is tracked', T(7, 'eth0', 1) === true);
check('a DOWN physical port is still tracked (state is not the question)',
    T(6, 'Ethernet 2', 1) === true);

// --- the Windows gap this change closes -----------------------------------
check('WAN Miniport unticks on the connector object', T(6, 'WAN Miniport (IP)', 2) === false);
check('...and on the name alone, for agents that omit the object',
    T(6, 'WAN Miniport (Network Monitor)', 0) === false);
check('RAS / isatap / Teredo untick by name',
    T(6, 'RAS Async Adapter', 0) === false &&
    T(6, 'isatap.{9B1D2C3E}', 0) === false &&
    T(6, 'Teredo Tunneling Pseudo-Interface', 0) === false);
check('the RAS pseudo-adapter naming unticks', T(6, 'Local Area Connection* 9', 0) === false);
// The asterisk is what makes that name a pseudo-adapter. A genuine old NIC
// carries the same words without it and must survive.
check('...but a REAL NIC named "Local Area Connection" survives',
    T(6, 'Local Area Connection', 1) === true &&
    T(6, 'Local Area Connection 2', 0) === true);

// --- Bluetooth PAN: real hardware, wrong default ---------------------------
// Not a defect like the miniports - it is genuine hardware with a connector,
// so nothing else here excludes it. It is simply not what "tracked by
// default" should mean on a wall display.
check('Bluetooth PAN is not pre-ticked', T(6, 'Bluetooth Network Connection', 1) === false);
check('...nor its Linux name', T(6, 'bnep0', 0) === false && T(6, 'bnep', 0) === false);
check('...but a real NIC is unaffected', T(6, 'Ethernet', 1) === true);

// --- connector-less but real ----------------------------------------------
check('a LAG is tracked despite having no connector', T(161, 'Po1', 2) === true);
check('...and a bond by any name', T(161, 'bond0', 2) === true);

// --- absent object changes nothing ----------------------------------------
// The safety property: an agent that does not answer .17 must behave exactly
// as it did before this check existed.
check('connector 0 (absent) never unticks on its own',
    T(6, 'eth0', 0) === true && T(6, 'Gi0/1', 0) === true);
check('connector 1 (true) never unticks either', T(6, 'eth0', 1) === true);

// --- the ifType gate still governs ----------------------------------------
// On a router the connector test buys nothing, because these already fail on
// type. Pinned so nobody "simplifies" the type gate away later.
check('Nu0 (other) is untracked by type, connector irrelevant',
    T(1, 'Nu0', 2) === false && T(1, 'Nu0', 1) === false);
check('Tu0 (tunnel 131) is untracked by type', T(131, 'Tu0', 2) === false);
check('a softwareLoopback is untracked by type', T(24, 'lo', 1) === false);

// --- the stock Microsoft service: descr carries the real name --------------
// From a real domain controller on the stock service (found by the RSCanvas
// fork; the defect was inherited from this file). Stock ifName is
// "ethernet_32774"-style and the human-readable name lives in ifDescr - so
// every Windows pattern above was dead on stock-service hosts until descr
// joined the test. The fourth argument below is ifDescr.
check('a stock-service WAN miniport unticks on its DESCR',
    T(6, 'ethernet_32774', 0, 'Local Area Connection* 9') === false);
check('...and a stock-service real NIC survives with its descr',
    T(6, 'ethernet_32777', 0, 'Ethernet') === true &&
    T(6, 'ethernet_32769', 0, 'LAN') === true);
check('an NDIS filter clone unticks (Npcap)',
    T(6, 'ethernet_3', 0, 'Ethernet 3-Npcap Packet Driver (NPCAP)-0000') === false);
check('...and the WFP / QoS / NDIS-capture clones',
    T(6, 'ethernet_1', 0, 'Ethernet 3-WFP Native MAC Layer LightWeight Filter-0000') === false &&
    T(6, 'ethernet_5', 0, 'Ethernet 3-QoS Packet Scheduler-0000') === false &&
    T(6, 'ethernet_2', 0, 'Ethernet 3-Microsoft NDIS Capture-0001') === false);
check('...including the 64-char ifDescr truncation, mid-word',
    T(6, 'ethernet_7', 0, 'Ethernet 3-WFP 802.3 MAC Layer LightWeight Filte') === false);
check('a real port whose ALIAS style descr is plain text is untouched',
    T(6, 'Gi1', 1, 'Uplink to core') === true);
check('descr absent (every non-Windows agent) changes nothing',
    T(6, 'eth0', 0) === true && T(6, 'WAN Miniport (IP)', 0) === false);

// --- the Linux list still works -------------------------------------------
check('the original Linux noise list is intact',
    T(6, 'veth1a2b', 0) === false && T(6, 'docker0', 0) === false &&
    T(6, 'virbr0', 0) === false && T(6, 'tap101i0', 0) === false);

console.log(failures ? `\n${failures} FAILED` : '\nall interface-tracking checks passed');
process.exit(failures ? 1 : 0);
