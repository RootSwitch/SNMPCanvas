'use strict';
// Device identity: OS summary, hardware model, CPU model cleanup. PURE
// functions only - discovery does the fetching, this module does the
// judgement, and tools/check-identity.js drives it against the real
// sysDescr corpus captured from the user's fleet and shelf walks
// (2026-08-12). Every rule here traces to an observed string; when nothing
// matches, the fallback is an honest clip of sysDescr, never a guess.

// Windows reports "Version 6.3" forever (legacy compatibility lie); the
// BUILD is the truth. Small map, extend as builds appear in the wild.
const WINDOWS_BUILDS = {
    26100: 'Server 2025', 25398: 'Server 23H2', 20348: 'Server 2022',
    17763: 'Server 2019', 14393: 'Server 2016',
    22631: '11 23H2', 22621: '11 22H2', 22000: '11', 19045: '10 22H2'
};

const ENT = (oid) => `1.3.6.1.4.1.${oid}`;

// sysObjectID prefixes for agent families (observed values in comments):
const FAMILY = [
    { key: 'windows', prefix: ENT('311.') },       // 311.1.1.3.1.3
    { key: 'pfsense', prefix: ENT('12325.') },     // 12325.1.1.2.1.1
    { key: 'truenas', prefix: ENT('50536.') },     // 50536.3.1
    { key: 'routeros', prefix: ENT('14988.') },    // 14988.1
    { key: 'unifi', prefix: ENT('41112') },        // 41112
    { key: 'netsnmp', prefix: ENT('8072.') },      // 8072.3.2.10
    { key: 'apc', prefix: ENT('318.') },
    { key: 'cisco', prefix: ENT('9.') }
];

function familyOf(sysObjectID) {
    const oid = String(sysObjectID || '').replace(/^\./, '');
    const hit = FAMILY.find((f) => oid.startsWith(f.prefix));
    return hit ? hit.key : null;
}

// One line, clipped - the honest fallback for agents we have no rule for.
function clip(s, n) {
    const line = String(s || '').split('\n')[0].trim();
    return line.length > n ? line.slice(0, n - 1).trimEnd() + '…' : line;
}

// sysObjectID + sysDescr -> a short OS/software summary. Rules per family,
// each verified against a real device's string:
//   netsnmp : "Linux MPC1 6.17.2-1-pve #1 SMP ..."          -> "Linux 6.17.2-1-pve (Proxmox)"
//   windows : "Hardware: ... Software: Windows Version 6.3
//              (Build 20348 Multiprocessor Free)"            -> "Windows Server 2022 (build 20348)"
//   pfsense : "pfSense FW-1.dl 2.8.1-RELEASE FreeBSD 15.0-CURRENT amd64"
//                                                            -> "pfSense 2.8.1 (FreeBSD 15.0-CURRENT)"
//   truenas : "TrueNAS-13.0-U6.8 (...). Hardware: ... Software: FreeBSD 13.1-RELEASE-p9 ..."
//                                                            -> "TrueNAS 13.0-U6.8"
//   routeros: "RouterOS CRS317-1G-16S+" (version is NOT here - the private
//             OID supplies it; osVersion argument)           -> "RouterOS 7.20.6"
//   unifi   : "U6-Enterprise 6.8.2.15592"                    -> "UniFi 6.8.2.15592"
//   apc     : mgmt-card blob "APC Web/SNMP Management Card (MB:v4.2.9 PF:v3.0.0.12 ...)"
//                                                            -> "APC AOS v3.0.0.12"
function summarizeOS(sysObjectID, sysDescr, osVersion) {
    const d = String(sysDescr || '');
    switch (familyOf(sysObjectID)) {
        case 'netsnmp': {
            const m = d.match(/^Linux\s+\S+\s+(\S+)/);
            if (!m) return clip(d, 48) || null;
            const pve = /-pve\b/.test(m[1]) ? ' (Proxmox)' : '';
            return `Linux ${m[1]}${pve}`;
        }
        case 'windows': {
            const b = d.match(/Build\s+(\d+)/i);
            if (!b) return 'Windows';
            const name = WINDOWS_BUILDS[Number(b[1])];
            return name ? `Windows ${name} (build ${b[1]})` : `Windows (build ${b[1]})`;
        }
        case 'pfsense': {
            const m = d.match(/^pfSense\s+\S+\s+(\S+?)-RELEASE\s+FreeBSD\s+(\S+)/);
            return m ? `pfSense ${m[1]} (FreeBSD ${m[2]})` : clip(d, 48);
        }
        case 'truenas': {
            const m = d.match(/^TrueNAS-(\S+)/);
            return m ? `TrueNAS ${m[1]}` : clip(d, 48);
        }
        case 'routeros':
            return osVersion ? `RouterOS ${osVersion}` : 'RouterOS';
        case 'unifi': {
            const m = d.match(/\s([\d][\d.]+)\s*$/);
            return m ? `UniFi ${m[1]}` : 'UniFi';
        }
        case 'apc': {
            const m = d.match(/PF:v([\d.]+)/);
            return m ? `APC AOS v${m[1]}` : clip(d, 48);
        }
        case 'cisco': {
            const m = d.match(/Version\s+([^,\s]+)/);
            return m ? `IOS ${m[1]}` : clip(d, 48);
        }
        default:
            return clip(d, 48) || null;
    }
}

// hrDeviceDescr strings for processor rows, as observed:
//   Linux x86 : "GenuineIntel: Intel(R) N150"   -> "Intel(R) N150"
//   Windows   : "Unknown Processor Type"        -> junk
//   FreeBSD/Pi: "" or "Guessing that there's a floating point co-processor"
function cleanCpuModel(s) {
    let v = String(s || '').trim();
    if (!v) return null;
    if (/unknown processor/i.test(v)) return null;
    if (/guessing/i.test(v)) return null;
    v = v.replace(/^(GenuineIntel|AuthenticAMD)\s*:\s*/i, '').replace(/\s+/g, ' ').trim();
    return v || null;
}

// ENTITY-MIB pick: modelName beats name beats descr; first non-empty wins
// (chassis rows come first on the gear that fills the table properly, and
// on gear that repeats one string - the Dells - any row is the right row).
function pickEntityModel(models, names, descrs) {
    for (const map of [models, names, descrs]) {
        if (!map) continue;
        for (const v of map.values()) {
            const s = String(v || '').trim();
            if (s) return s;
        }
    }
    return null;
}

// TrueNAS smuggles the CPU model inside sysDescr:
//   "... Hardware: amd64 Intel(R) Xeon(R) W-1290 CPU @ 3.20GHz running at ..."
function cpuFromTrueNasDescr(sysDescr) {
    const m = String(sysDescr || '').match(/Hardware:\s+\S+\s+(.+?)\s+running at/i);
    return m ? m[1].replace(/\s+/g, ' ').replace(/\s*CPU\s*@.*$/i, '').trim() : null;
}

module.exports = { summarizeOS, cleanCpuModel, pickEntityModel, cpuFromTrueNasDescr, familyOf, WINDOWS_BUILDS };
