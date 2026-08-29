'use strict';
// Drives the identity summarizers against the REAL corpus: every sysDescr
// shape from the user's 27-device fleet (2026-08-12 sqlite paste) plus the
// shelf walks. Every rule in identity.js must trace to one of these
// strings - if a rule has no fixture here, it is a guess.
//
//   node tools/check-identity.js

const IDY = require('../server/identity');

let failures = 0;
function check(name, got, want) {
    const pass = got === want;
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${pass ? '' : `   got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
    if (!pass) failures++;
}

const E = '1.3.6.1.4.1.';

// --- OS summaries, one per family, real strings ------------------------------
check('Proxmox host',
    IDY.summarizeOS(E + '8072.3.2.10', 'Linux pve-1 6.17.2-1-pve #1 SMP PREEMPT_DYNAMIC PMX 6.17.2-1 (2025-10-21T11:55Z) x86_64'),
    'Linux 6.17.2-1-pve (Proxmox)');
check('plain Linux (Rocky kernel)',
    IDY.summarizeOS(E + '8072.3.2.10', 'Linux dns-1.domain.local 6.12.0-211.34.1.el10_2.x86_64 #1 SMP PREEMPT_DYNAMIC Tue Jul 14 23:43:25 UTC 2026 x86_64'),
    'Linux 6.12.0-211.34.1.el10_2.x86_64');
check('AMI BMC (armv6l, hostname "(none)")',
    IDY.summarizeOS(E + '8072.3.2.10', 'Linux (none) 3.18.0 #1 Thu Mar 7 09:57:34 CST 2024 armv6l'),
    'Linux 3.18.0');
check('Raspberry Pi',
    IDY.summarizeOS(E + '8072.3.2.10', 'Linux pi3b 6.18.34+rpt-rpi-v8 #1 SMP PREEMPT Debian 1:6.18.34-1+rpt1 (2026-06-09) aarch64'),
    'Linux 6.18.34+rpt-rpi-v8');
check('Windows Server 2022',
    IDY.summarizeOS(E + '311.1.1.3.1.3', 'Hardware: AMD64 Family 26 Model 68 Stepping 0 AT/AT COMPATIBLE - Software: Windows Version 6.3 (Build 20348 Multiprocessor Free)'),
    'Windows Server 2022 (build 20348)');
check('pfSense',
    IDY.summarizeOS(E + '12325.1.1.2.1.1', 'pfSense FW-1.domain.local 2.8.1-RELEASE FreeBSD 15.0-CURRENT amd64'),
    'pfSense 2.8.1 (FreeBSD 15.0-CURRENT)');
check('TrueNAS',
    IDY.summarizeOS(E + '50536.3.1', 'TrueNAS-13.0-U6.8 (5021f909d2). Hardware: amd64 Intel(R) Xeon(R) W-1290 CPU @ 3.20GHz running at 3192 MHz. Software: FreeBSD 13.1-RELEASE-p9 (revision 199506)'),
    'TrueNAS 13.0-U6.8');
check('RouterOS with private-OID version',
    IDY.summarizeOS(E + '14988.1', 'RouterOS CRS317-1G-16S+', '7.20.6'),
    'RouterOS 7.20.6');
check('RouterOS without the private fetch',
    IDY.summarizeOS(E + '14988.1', 'RouterOS CRS317-1G-16S+'),
    'RouterOS');
check('UniFi',
    IDY.summarizeOS(E + '41112', 'U7-Pro-XG-B 8.6.11.18870'),
    'UniFi 8.6.11.18870');
check('APC management card',
    IDY.summarizeOS(E + '318.1.3.4.8', 'APC Web/SNMP Management Card (MB:v4.2.9 PF:v3.0.0.12 PN:apc_hw21_aos_3.0.0.12.bin AF1:v3.0.0.5 AN1:apc_hw21_rpdu2g_3.0.0.5.bin MN:AP7811B HR:B3 SN: X MD:07/18/2024) '),
    'APC AOS v3.0.0.12');
check('unknown family falls back to a clipped sysDescr',
    IDY.summarizeOS(E + '99999.1', 'Some Appliance OS 4.2 build 7 with a very long tail that goes on and on and on'),
    'Some Appliance OS 4.2 build 7 with a very long…');
check('FS switch (unknown family, real string)',
    IDY.summarizeOS(E + '52642.1.1.10.1.793', 'FS Campus Switch (S5860-20SQ) By FS.COM Inc'),
    'FS Campus Switch (S5860-20SQ) By FS.COM Inc');

// --- CPU model cleanup, real strings from the tierc walks --------------------
check('Linux x86 CPU string cleans up',
    IDY.cleanCpuModel('GenuineIntel: Intel(R) N150'), 'Intel(R) N150');
check('Windows "Unknown Processor Type" is junk',
    IDY.cleanCpuModel('Unknown Processor Type'), null);
check('the FreeBSD floating-point joke is junk',
    IDY.cleanCpuModel("Guessing that there's a floating point co-processor"), null);
check('empty descr is junk', IDY.cleanCpuModel(''), null);

// --- TrueNAS sysDescr Hardware: extraction -----------------------------------
check('TrueNAS CPU from sysDescr',
    IDY.cpuFromTrueNasDescr('TrueNAS-13.0-U6.8 (x). Hardware: amd64 Intel(R) Xeon(R) W-1290 CPU @ 3.20GHz running at 3192 MHz. Software: FreeBSD 13.1'),
    'Intel(R) Xeon(R) W-1290');
check('TrueNAS Ryzen with trailing spaces (real string)',
    IDY.cpuFromTrueNasDescr('TrueNAS-13.0-U6.8 (x). Hardware: amd64 AMD Ryzen 9 9950X3D 16-Core Processor           running at 4299 MHz. Software: FreeBSD 13.1'),
    'AMD Ryzen 9 9950X3D 16-Core Processor');

// --- ENTITY-MIB pick (Dell shape: entPhysicalName filled, models empty) ------
check('entity pick prefers modelName',
    IDY.pickEntityModel(new Map([[1, 'X1008']]), new Map([[1, 'ignored']]), null), 'X1008');
check('entity pick falls to name when models empty',
    IDY.pickEntityModel(new Map(), new Map([[1, ''], [2, 'PowerConnect 2816']]), null), 'PowerConnect 2816');
check('entity pick returns null on nothing', IDY.pickEntityModel(new Map(), new Map(), null), null);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall identity checks passed');
process.exit(failures ? 1 : 0);
