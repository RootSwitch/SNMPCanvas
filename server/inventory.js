'use strict';
// Export the device inventory as a CrossCanvas-import CSV, so a monitored
// fleet can seed a diagram in one step. CrossCanvas's inventory importer wants
// a header row of:
//   label,stencil,Hostname,IP-Address,Serial-Number,Asset-Tag,Description,Location,Firmware
// `label` is the only column it truly needs; the rest become Device Details
// fields (an IP-Address makes the device monitoring-ready in PingCanvas).

const { db } = require('./db');

const COLUMNS = ['label', 'stencil', 'Hostname', 'IP-Address',
    'Serial-Number', 'Asset-Tag', 'Description', 'Location', 'Firmware'];

// CSV cell: quote when it contains a comma/quote/newline (doubling inner
// quotes), and neutralize spreadsheet formula injection by prefixing a value
// that opens with = + - @ (or a tab/CR) with a single quote - the same guard
// the family applies to its other CSV exports.
function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) { s = "'" + s; }
    if (/[",\n\r]/.test(s)) { s = '"' + s.replace(/"/g, '""') + '"'; }
    return s;
}

// Best-effort stencil from what SNMP already told us. CrossCanvas tolerates a
// blank stencil (generic icon), so only guess when a keyword is unambiguous -
// a wrong icon is worse than a neutral one. The importer matches these names
// (and their aliases) against the bundled stencil library.
function guessStencil(d) {
    const hay = `${d.sys_descr || ''} ${d.sys_name || ''} ${d.name || ''}`.toLowerCase();
    // MikroTik first, and on MODEL evidence only: everything they ship
    // reports "RouterOS" - routers, switches, firewalls and APs alike - so
    // the OS name proves nothing and the model prefix is the real signal
    // (CRS = Cloud Router SWITCH). No recognizable model means blank, not
    // a coin flip. From a downstream review that caught every CRS core
    // switch exporting as a router because "routeros" sat in the router rule.
    if (/routeros|mikrotik|\bswos\b/.test(hay)) {   // SwOS = their switch-only OS
        if (/\bcrs|\bcss/.test(hay)) { return 'switch'; }
        if (/\bccr|\brb\d|routerboard/.test(hay)) { return 'router'; }
        if (/\bhap\b|\bwap\b|\bcap\b/.test(hay)) { return 'access point'; }
        return '';
    }
    // Appliances before the operating systems they are built on: pfSense IS
    // FreeBSD and TrueNAS IS FreeBSD, so the appliance keyword must claim
    // the device before the OS keyword can call it a server.
    if (/\bfirewall\b|fortigate|palo ?alto|\basa\b|pfsense|opnsense/.test(hay)) { return 'firewall'; }
    if (/access ?point|\bap\b|wireless|\bwifi\b|wlan/.test(hay)) { return 'access point'; }
    if (/truenas|\bnas\b|synology|qnap/.test(hay)) { return 'nas'; }
    if (/\bups\b|\bpdu\b|smart-?ups/.test(hay)) { return 'ups'; }
    // Switch before router: an L3 switch's sysDescr carries both "Catalyst"
    // and "IOS XE", and the router rule matching ios-xe first turned every
    // Catalyst 9000-class SWITCH into a router icon.
    if (/\bswitch\b|catalyst|switchos|procurve|\bnexus\b/.test(hay)) { return 'switch'; }
    if (/\brouter\b|\bios[- ]?xe\b|\bvyos\b/.test(hay)) { return 'router'; }
    if (/\bserver\b|linux|windows|ubuntu|debian|freebsd|proxmox|esxi|vmware/.test(hay)) { return 'server'; }
    return '';
}

// sys_descr is often multi-line and long; flatten and cap it so a cell stays
// readable in the diagram's Description field.
function oneLine(v, max) {
    if (v == null) { return ''; }
    const s = String(v).replace(/\s+/g, ' ').trim();
    return max && s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function rowFor(d) {
    return [
        d.name || d.sys_name || d.host,   // label - never blank (importer needs it)
        guessStencil(d),                  // stencil (may be blank)
        d.sys_name || d.name || '',       // Hostname
        d.host || '',                     // IP-Address
        '',                               // Serial-Number (not tracked)
        '',                               // Asset-Tag (not tracked)
        oneLine(d.sys_descr, 160),        // Description
        oneLine(d.sys_location, 120),     // Location (SNMP sysLocation; CrossCanvas nests it into zones)
        ''                                // Firmware (left blank - unreliable to parse)
    ];
}

function buildCsv() {
    const devices = db.prepare(
        'SELECT name, host, sys_descr, sys_name, sys_location, vendor_key FROM devices ORDER BY name').all();
    const lines = [COLUMNS.join(',')];
    for (const d of devices) { lines.push(rowFor(d).map(csvCell).join(',')); }
    return lines.join('\r\n') + '\r\n';   // CRLF: friendliest for spreadsheet apps
}

module.exports = { buildCsv, COLUMNS, csvCell, guessStencil };
