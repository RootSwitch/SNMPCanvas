'use strict';
// Verifies the inventory export's stencil guesser against real device-class
// strings. Three ordering bugs were found by a downstream port of this exact
// function: MikroTik CRS switches exported as routers ("routeros" in the
// router rule), TrueNAS as servers ("truenas" ahead of the nas rule, and its
// sysDescr contains FreeBSD anyway), and Catalyst 9000-class switches as
// routers (they run IOS-XE, which the router rule matched first). A wrong
// icon is worse than a neutral one, so ambiguity must stay blank.
//
//   node tools/check-stencil-guess.js

const { guessStencil } = require('../server/inventory');

let failures = 0;
function check(name, expect, d) {
    const got = guessStencil(d);
    const pass = got === expect;
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}   ${JSON.stringify(got)}${pass ? '' : ' (wanted ' + JSON.stringify(expect) + ')'}`);
    if (!pass) failures++;
}

// MikroTik: model evidence decides; bare RouterOS stays blank.
check('MikroTik CRS is a SWITCH (Cloud Router Switch)', 'switch',
    { sys_descr: 'RouterOS CRS317-1G-16S+', name: 'core-sw' });
check('MikroTik CSS is a switch', 'switch', { sys_descr: 'SwOS CSS326-24G-2S+', name: 'acc' });
check('MikroTik CCR is a router', 'router', { sys_descr: 'RouterOS CCR2004-1G-12S+2XS', name: 'edge' });
check('MikroTik RB is a router', 'router', { sys_descr: 'RouterOS RB5009UG+S+', name: 'rtr' });
check('MikroTik hAP is an access point', 'access point', { sys_descr: 'RouterOS hAP ac3', name: 'attic' });
check('bare RouterOS with no model stays BLANK, never a coin flip', '',
    { sys_descr: 'RouterOS CHR', name: 'lab' });

// Appliances beat the OS they are built on.
check('TrueNAS is a NAS despite containing FreeBSD', 'nas',
    { sys_descr: 'TrueNAS-13.0-U6.8. Hardware: Intel Xeon. Software: FreeBSD 13.1-RELEASE-p9', name: 'tank' });
check('pfSense is a firewall despite containing FreeBSD', 'firewall',
    { sys_descr: 'pfSense fw1 2.8.1-RELEASE FreeBSD 15.0-CURRENT amd64', name: 'fw1' });
check('Synology is a NAS', 'nas', { sys_descr: 'Linux DSM', sys_name: 'synology-ds920', name: 'backup' });

// Switch beats router when both words appear (L3 switches run IOS-XE).
check('Catalyst on IOS XE is a SWITCH', 'switch',
    { sys_descr: 'Cisco IOS Software [Cupertino], Catalyst L3 Switch Software (CAT9K_IOSXE)', name: 'c9300' });
check('CSR on IOS XE is a router', 'router',
    { sys_descr: 'Cisco IOS Software [Cupertino], Virtual XE Software, IOS XE', name: 'csr' });

// The straightforward classes still land.
check('Windows is a server', 'server', { sys_descr: 'Hardware: Intel64 - Software: Windows Version 6.3 (Build 20348)', name: 'dc1' });
check('Linux is a server', 'server', { sys_descr: 'Linux web01 6.8.0-45-generic #45-Ubuntu', name: 'web01' });
check('Smart-UPS is a UPS', 'ups', { sys_descr: 'APC Web/SNMP Management Card, Smart-UPS 2200', name: 'ups1' });
check('UniFi AP via wifi keyword', 'access point', { sys_descr: 'U6-Enterprise 6.8.2', sys_name: 'wifi-hall', name: 'ap-hall' });
check('unknown gear stays blank', '', { sys_descr: 'QSW-M2108-2S', name: 'qsw' });

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall stencil-guess checks passed');
process.exit(failures ? 1 : 0);
