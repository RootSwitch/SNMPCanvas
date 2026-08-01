'use strict';
// The Address column must sort like addresses, not like words.
//
//   node tools/check-sort.js
//
// A raw string compare puts 192.168.1.10 before 192.168.1.9 and .100 before
// .11. That is wrong in any table and embarrassing in a network tool, so the
// device list builds a padded sort key instead.
//
// hostSortKey lives in public/app.js, which is browser code with no module
// boundary. Rather than re-implement it here - a copy would drift and prove
// nothing - the real function source is EXTRACTED from the shipped file and
// evaluated, the same trick PingCanvas's kiosk schema test uses. If someone
// edits hostSortKey, this test sees the edit.

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'public', 'app.js');
const src = fs.readFileSync(SRC, 'utf8');

// Pull one `function name(...) { ... }` out by brace matching from its start.
function extract(name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error(`${name} not found in public/app.js`);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces reading ${name}`);
}

const hostSortKey = new Function(
    extract('expandIPv6') + '\n' + extract('hostSortKey') + '\nreturn hostSortKey;')();

let failures = 0;
function check(name, pass, detail) {
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`);
    if (!pass) failures++;
}
const sorted = (list) => list.slice().sort((a, b) => {
    const x = hostSortKey(a), y = hostSortKey(b);
    return x < y ? -1 : x > y ? 1 : 0;
});
const order = (name, input, expected) => {
    const got = sorted(input);
    check(name, JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(got));
};

// --- the reported bug -------------------------------------------------------
order('octets sort numerically, not as text',
    ['192.168.1.100', '192.168.1.9', '192.168.1.10', '192.168.1.1'],
    ['192.168.1.1', '192.168.1.9', '192.168.1.10', '192.168.1.100']);

order('the leading octet too (9 before 10, not after)',
    ['10.0.0.1', '9.9.9.9', '172.16.0.1', '99.1.1.1'],
    ['9.9.9.9', '10.0.0.1', '99.1.1.1', '172.16.0.1']);

order('third octet ordering',
    ['10.0.20.1', '10.0.3.1', '10.0.100.1'],
    ['10.0.3.1', '10.0.20.1', '10.0.100.1']);

// --- IPv6 -------------------------------------------------------------------
order('IPv6 sorts numerically inside a subnet',
    ['2001:db8::10', '2001:db8::2', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::2', '2001:db8::10']);

check('compressed and expanded IPv6 are the same key',
    hostSortKey('2001:db8::7') === hostSortKey('2001:0db8:0000:0000:0000:0000:0000:0007'),
    hostSortKey('2001:db8::7') + ' vs ' + hostSortKey('2001:0db8:0000:0000:0000:0000:0000:0007'));

check('IPv6 case does not affect the key',
    hostSortKey('2001:DB8::AB') === hostSortKey('2001:db8::ab'));

check('bracketed IPv6 matches the bare form',
    hostSortKey('[2001:db8::1]') === hostSortKey('2001:db8::1'));

// --- bands, and things that are not addresses -------------------------------
order('v4 then v6 then hostnames, not interleaved',
    ['switch-a', '2001:db8::1', '10.0.0.1'],
    ['10.0.0.1', '2001:db8::1', 'switch-a']);

order('hostnames stay case-insensitive',
    ['switch-B', 'Switch-a', 'switch-C'],
    ['Switch-a', 'switch-B', 'switch-C']);

// An out-of-range or malformed address is NOT an address - it must not be
// padded into a nonsense numeric slot, it should fall to the name band.
check('999.1.1.1 is not treated as IPv4', hostSortKey('999.1.1.1').startsWith('3'));
check('1.2.3 is not treated as IPv4', hostSortKey('1.2.3').startsWith('3'));
check('256.0.0.1 is not treated as IPv4', hostSortKey('256.0.0.1').startsWith('3'));
check('a bare word is not treated as IPv6', hostSortKey('core-sw1').startsWith('3'));
check('a malformed v6 falls back rather than throwing', hostSortKey('2001:db8:::1').startsWith('3'));
check('too many groups is not IPv6', hostSortKey('1:2:3:4:5:6:7:8:9').startsWith('3'));

// --- defensive: the list comes from an API, so nulls are reachable ----------
check('null host does not throw', hostSortKey(null) === '3');
check('undefined host does not throw', hostSortKey(undefined) === '3');
check('whitespace is trimmed', hostSortKey('  10.0.0.1  ') === hostSortKey('10.0.0.1'));

console.log(failures ? `\n${failures} check(s) FAILED` : '\naddress sort intact');
process.exit(failures ? 1 : 0);
