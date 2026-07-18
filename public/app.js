'use strict';
// SNMPCanvas frontend: hash-routed views over the JSON API. Vanilla DOM, no
// framework, no build step - the file you read is the file that runs.

(function () {
    const $main = document.getElementById('main');
    const $modal = document.getElementById('modal');
    const $nav = document.getElementById('nav');
    const $logout = document.getElementById('logout-btn');

    let refreshTimer = null;

    // ===== helpers =====
    function esc(s) {
        return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async function api(method, path, body) {
        const opts = { method, headers: {} };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(path, opts);
        if (res.status === 401 && !path.startsWith('/api/session') && !path.startsWith('/api/login')) {
            renderLogin(false);
            throw new Error('authentication required');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(data.error || `${res.status}`);
            err.status = res.status;
            throw err;
        }
        return data;
    }
    const GET = (p) => api('GET', p);

    const OPER = { 1: 'up', 2: 'down', 3: 'testing', 4: 'unknown', 5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown' };

    function fmtBps(v) { return v == null ? '-' : Charts.fmtValue(v, 'bps'); }
    function fmtBytes(v) { return v == null ? '-' : Charts.fmtValue(v, 'bytes'); }
    function fmtSpeed(bps) {
        if (!bps) return '-';
        return bps >= 1e9 ? (bps / 1e9) + ' G' : bps >= 1e6 ? (bps / 1e6) + ' M' : (bps / 1e3) + ' k';
    }
    function fmtUptime(sec) {
        if (sec == null) return '-';
        const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
        return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
    function fmtAgo(ts) {
        if (!ts) return 'never';
        const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
        return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
    }
    function dot(status) { return `<span class="dot ${esc(status)}"></span>`; }

    // Code chips render as paste-ready {code} tokens (PingCanvas board
    // syntax) and copy themselves on click instead of triggering whatever
    // they happen to sit inside (row links, cards).
    function codeChip(code) {
        return code ? `<span class="code-chip" title="Click to copy {${esc(code)}}">{${esc(code)}}</span>` : '';
    }

    function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
        // Plain-http fallback (LAN deployments without TLS)
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } finally { ta.remove(); }
        return Promise.resolve();
    }

    // Capture phase so the copy wins over row-navigation click handlers.
    document.addEventListener('click', (ev) => {
        const chip = ev.target.closest?.('.code-chip');
        if (!chip) return;
        ev.stopPropagation();
        ev.preventDefault();
        const token = chip.textContent.trim();
        copyText(token).then(() => {
            chip.classList.add('copied');
            const prev = chip.textContent;
            chip.textContent = 'copied';
            setTimeout(() => { chip.textContent = prev; chip.classList.remove('copied'); }, 700);
        }).catch(() => { /* clipboard unavailable - token stays selectable */ });
    }, true);

    function setAutoRefresh(fn, ms) {
        clearInterval(refreshTimer);
        refreshTimer = fn ? setInterval(fn, ms) : null;
    }

    function setNav(active, visible) {
        $nav.style.display = visible ? '' : 'none';
        $logout.style.display = visible ? '' : 'none';
        for (const a of $nav.querySelectorAll('a')) a.classList.toggle('active', a.dataset.nav === active);
    }

    // ===== theme picker (grouped like CrossCanvas's - ungrouped Classic
    // first, then an <optgroup> per vibe, in themes.js authoring order) =====
    const $theme = document.getElementById('theme-select');
    let optgroup = null;
    for (const [key, t] of Object.entries(Themes.THEMES)) {
        const o = document.createElement('option');
        o.value = key; o.textContent = t.label;
        if (!t.group) {
            $theme.appendChild(o);
        } else {
            if (!optgroup || optgroup.label !== t.group) {
                optgroup = document.createElement('optgroup');
                optgroup.label = t.group;
                $theme.appendChild(optgroup);
            }
            optgroup.appendChild(o);
        }
    }
    $theme.value = Themes.currentTheme();
    $theme.addEventListener('change', () => Themes.applyTheme($theme.value));

    $logout.addEventListener('click', async () => {
        await api('POST', '/api/logout', {});
        location.hash = '#/devices';
        route();
    });

    // ===== router =====
    window.addEventListener('hashchange', route);

    async function route() {
        setAutoRefresh(null);
        ifFilter = ''; // filter is per-visit; auto-refresh re-renders keep it, navigation clears it
        const session = await GET('/api/session');
        if (!session.authenticated) { renderLogin(session.needsSetup); return; }

        const hash = location.hash || '#/devices';
        let m;
        if ((m = hash.match(/^#\/device\/(\d+)\/entity\/(\d+)$/))) return renderEntity(+m[1], +m[2]);
        if ((m = hash.match(/^#\/device\/(\d+)$/))) return renderDevice(+m[1]);
        if (hash.startsWith('#/settings')) return renderSettings();
        return renderDevices();
    }

    // ===== login / first-run =====
    function renderLogin(needsSetup) {
        setNav(null, false);
        setAutoRefresh(null);
        $main.innerHTML = `
        <div class="login-wrap"><div class="login-card">
            <h1><svg width="20" height="20" viewBox="0 0 64 64" fill="none" stroke="var(--se-accent)">
                <path d="M32 5 L32 12" stroke-width="5" stroke-linecap="round"/>
                <path d="M18 45 L12 59 M46 45 L52 59 M32 45 L32 59" stroke-width="5" stroke-linecap="round"/>
                <rect x="9" y="12" width="46" height="34" rx="3" fill="#f4f1ea" stroke-width="4"/>
                <polyline points="13.5,30 20,30 23,25.5 26,30 31,30 34,18 38,40.5 41,30 44.5,27 47.5,30 50.5,30" stroke="var(--se-logo-b)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg> SNMPCanvas</h1>
            <div class="sub">${needsSetup ? 'First run - choose an admin password (8+ characters).' : 'Enter the password to continue.'}</div>
            <form id="login-form">
                <input type="password" id="pw" placeholder="Password" autofocus autocomplete="${needsSetup ? 'new-password' : 'current-password'}">
                ${needsSetup ? '<input type="password" id="pw2" placeholder="Confirm password" autocomplete="new-password">' : ''}
                <button class="btn-primary" type="submit">${needsSetup ? 'Set password' : 'Log in'}</button>
                <div class="error-text" id="login-err" style="margin-top:8px"></div>
            </form>
        </div></div>`;
        document.getElementById('login-form').addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const pw = document.getElementById('pw').value;
            const err = document.getElementById('login-err');
            try {
                if (needsSetup) {
                    if (pw !== document.getElementById('pw2').value) { err.textContent = 'Passwords do not match.'; return; }
                    await api('POST', '/api/setup', { password: pw });
                } else {
                    await api('POST', '/api/login', { password: pw });
                }
                location.hash = '#/devices';
                route();
            } catch (e) { err.textContent = e.message; }
        });
    }

    // ===== devices list =====
    // Sort state survives the 30s auto-refresh (module scope, not persisted).
    let deviceSort = { key: 'name', dir: 1 };
    const SORT_VALUE = {
        status: (d) => d.status + (d.enabled ? '' : 'z'),
        name: (d) => d.name.toLowerCase(),
        host: (d) => d.host,
        cpu: (d) => d.cpuPct ?? -1,
        topbw: (d) => (d.topIf && d.topIf.bps != null) ? d.topIf.bps : -1,
        ifcount: (d) => d.interfaceCount,
        uptime: (d) => d.uptimeSeconds ?? -1,
        lastpoll: (d) => d.lastPollTs ?? 0
    };

    async function renderDevices() {
        setNav('devices', true);
        const { devices } = await GET('/api/devices');
        const val = SORT_VALUE[deviceSort.key] || SORT_VALUE.name;
        devices.sort((a, b) => {
            const x = val(a), y = val(b);
            return (x < y ? -1 : x > y ? 1 : 0) * deviceSort.dir;
        });
        const arrow = (key) => deviceSort.key === key ? (deviceSort.dir === 1 ? ' ▲' : ' ▼') : '';
        $main.innerHTML = `
        <div class="page-head">
            <h1>Devices</h1>
            <span class="sub">${devices.length} device${devices.length === 1 ? '' : 's'}</span>
            <span class="spacer"></span>
            <button id="add-btn" class="btn-primary">+ Add device</button>
        </div>
        <div class="panel">
        ${devices.length === 0 ? '<div class="muted">No devices yet - click <strong>Add device</strong> to poll your first one.</div>' : `
        <table class="list"><thead><tr>
            <th class="sortable" data-sort="status">Status${arrow('status')}</th>
            <th class="sortable" data-sort="name">Name${arrow('name')}</th>
            <th class="sortable" data-sort="host">Address${arrow('host')}</th>
            <th class="num sortable" data-sort="cpu">CPU${arrow('cpu')}</th>
            <th>Top interface</th>
            <th class="num sortable" data-sort="topbw">Top usage${arrow('topbw')}</th>
            <th class="num hide-sm sortable" data-sort="ifcount">Interfaces${arrow('ifcount')}</th>
            <th class="num sortable" data-sort="uptime">Uptime${arrow('uptime')}</th>
            <th class="num hide-sm sortable" data-sort="lastpoll">Last poll${arrow('lastpoll')}</th>
        </tr></thead><tbody>
        ${devices.map((d) => {
            const stale = d.status !== 'up';
            const cpu = d.cpuPct == null ? '<span class="muted">N/A</span>' : esc(d.cpuPct.toFixed(0)) + '%';
            const topName = d.topIf ? esc(d.topIf.name) : '<span class="muted">N/A</span>';
            const topBw = d.topIf && d.topIf.bps != null
                ? fmtBps(d.topIf.bps) + (d.topIf.pct != null ? ` <span class="muted">(${d.topIf.pct < 1 ? '<1' : esc(d.topIf.pct.toFixed(0))}%)</span>` : '')
                : '<span class="muted">N/A</span>';
            return `
            <tr class="rowlink" data-id="${d.id}" title="${esc((d.sysDescr || '').slice(0, 160))}">
                <td>${dot(d.status)}${esc(d.status)}${d.enabled ? '' : ' <span class="badge">paused</span>'}</td>
                <td><strong>${esc(d.name)}</strong></td>
                <td>${esc(d.host)}${d.port !== 161 ? ':' + d.port : ''}</td>
                <td class="num${stale ? ' muted' : ''}">${cpu}</td>
                <td class="${stale ? 'muted' : ''}">${topName}</td>
                <td class="num${stale ? ' muted' : ''}">${topBw}</td>
                <td class="num hide-sm">${d.interfaceCount}</td>
                <td class="num">${fmtUptime(d.uptimeSeconds)}</td>
                <td class="num muted hide-sm">${fmtAgo(d.lastPollTs)}</td>
            </tr>`;
        }).join('')}
        </tbody></table>`}
        </div>`;
        document.getElementById('add-btn').addEventListener('click', addDeviceWizard);
        for (const tr of $main.querySelectorAll('tr.rowlink')) {
            tr.addEventListener('click', () => { location.hash = `#/device/${tr.dataset.id}`; });
        }
        for (const th of $main.querySelectorAll('th.sortable')) {
            th.addEventListener('click', () => {
                const key = th.dataset.sort;
                deviceSort = { key, dir: deviceSort.key === key ? -deviceSort.dir : 1 };
                renderDevices();
            });
        }
        setAutoRefresh(() => { if (location.hash === '' || location.hash === '#/devices') renderDevices(); }, 30000);
    }

    // ===== add-device wizard =====
    function addDeviceWizard() {
        $modal.innerHTML = `
        <h2>Add device</h2>
        <form id="probe-form">
        <div class="form-grid">
            <label>Address</label><input type="text" id="f-host" placeholder="IP or hostname" required>
            <label>Port</label><input type="number" id="f-port" value="161" min="1" max="65535">
            <label>SNMP version</label>
            <select id="f-version"><option value="2c">v2c</option><option value="3">v3</option></select>
            <label class="v2c-only">Community</label><input class="v2c-only" type="text" id="f-community" value="public">
            <label class="v3-only" style="display:none">Username</label><input class="v3-only" style="display:none" type="text" id="f-user">
            <label class="v3-only" style="display:none">Security level</label>
            <select class="v3-only" style="display:none" id="f-level">
                <option value="authPriv">authPriv (auth + encryption)</option>
                <option value="authNoPriv">authNoPriv (auth only)</option>
                <option value="noAuthNoPriv">noAuthNoPriv</option>
            </select>
            <label class="v3-auth" style="display:none">Auth protocol</label>
            <select class="v3-auth" style="display:none" id="f-authproto">
                <option value="sha">SHA-1</option><option value="sha256">SHA-256</option>
                <option value="sha512">SHA-512</option><option value="md5">MD5</option>
            </select>
            <label class="v3-auth" style="display:none">Auth password</label><input class="v3-auth" style="display:none" type="password" id="f-authkey">
            <label class="v3-priv" style="display:none">Privacy protocol</label>
            <select class="v3-priv" style="display:none" id="f-privproto">
                <option value="aes">AES-128</option>
                <option value="aes256b">AES-256 (Blumenthal)</option>
                <option value="aes256r">AES-256 (Reeder / Cisco)</option>
                <option value="des">DES</option>
            </select>
            <label class="v3-priv" style="display:none">Privacy password</label><input class="v3-priv" style="display:none" type="password" id="f-privkey">
        </div>
        <div class="form-actions">
            <button type="submit" class="btn-primary" id="probe-btn">Test &amp; discover</button>
            <button type="button" id="cancel-btn">Cancel</button>
            <span class="muted small" id="probe-status"></span>
        </div>
        <div class="error-text" id="probe-err" style="margin-top:8px"></div>
        </form>
        <div id="inventory"></div>`;
        $modal.showModal();

        const showFields = () => {
            const v3 = document.getElementById('f-version').value === '3';
            const level = document.getElementById('f-level').value;
            for (const el of $modal.querySelectorAll('.v2c-only')) el.style.display = v3 ? 'none' : '';
            for (const el of $modal.querySelectorAll('.v3-only')) el.style.display = v3 ? '' : 'none';
            for (const el of $modal.querySelectorAll('.v3-auth')) el.style.display = v3 && level !== 'noAuthNoPriv' ? '' : 'none';
            for (const el of $modal.querySelectorAll('.v3-priv')) el.style.display = v3 && level === 'authPriv' ? '' : 'none';
        };
        document.getElementById('f-version').addEventListener('change', showFields);
        document.getElementById('f-level').addEventListener('change', showFields);
        document.getElementById('cancel-btn').addEventListener('click', () => $modal.close());

        document.getElementById('probe-form').addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const err = document.getElementById('probe-err');
            const status = document.getElementById('probe-status');
            const btn = document.getElementById('probe-btn');
            err.textContent = ''; status.textContent = 'Probing… (walking tables can take a moment)';
            btn.disabled = true;
            const body = {
                host: document.getElementById('f-host').value.trim(),
                port: parseInt(document.getElementById('f-port').value, 10) || 161,
                version: document.getElementById('f-version').value,
                community: document.getElementById('f-community').value,
                v3_user: document.getElementById('f-user').value,
                v3_level: document.getElementById('f-level').value,
                v3_auth_proto: document.getElementById('f-authproto').value,
                v3_auth_key: document.getElementById('f-authkey').value,
                v3_priv_proto: document.getElementById('f-privproto').value,
                v3_priv_key: document.getElementById('f-privkey').value
            };
            try {
                const r = await api('POST', '/api/devices/probe', body);
                status.textContent = '';
                renderInventory(r);
            } catch (e) {
                status.textContent = '';
                err.textContent = e.message;
            } finally {
                btn.disabled = false;
            }
        });
    }

    function renderInventory(r) {
        const inv = document.getElementById('inventory');
        const groups = { if: 'Interfaces', cpu: 'CPU', mem: 'Memory', fs: 'Storage', temp: 'Temperatures', fan: 'Fans', power: 'Power', gauge: 'Utilization', battery: 'Battery', runtime: 'Runtime', outlet: 'Outlets' };
        const byKind = { if: [], cpu: [], mem: [], fs: [], temp: [], fan: [], power: [], gauge: [], battery: [], runtime: [], outlet: [] };
        for (const e of r.entities) byKind[e.kind]?.push(e);

        inv.innerHTML = `
        <hr style="border:none;border-top:1px solid var(--se-border);margin:14px 0">
        <div><strong>${esc(r.system.sysName || 'device')}</strong>
            <span class="muted small">${esc((r.system.sysDescr || '').slice(0, 90))}</span>
            ${r.vendorKey ? `<span class="badge">${esc(r.vendorKey)}</span>` : ''}</div>
        ${r.warnings.length ? `<div class="warn-text" style="margin-top:6px">${r.warnings.map(esc).join('<br>')}</div>` : ''}
        <div class="form-grid" style="margin-top:10px">
            <label>Device name</label><input type="text" id="f-name" value="${esc(r.system.sysName || '')}">
            <label>Polling interval</label>
            <span><input type="number" id="f-interval" placeholder="global default" min="30" style="width:110px"> seconds (blank = global)</span>
        </div>
        ${Object.entries(groups).map(([kind, label]) => byKind[kind].length === 0 ? '' : `
        <div class="inv-group">
            <h4>${label} (${byKind[kind].length})${kind === 'if' ? ' - checked = tracked' : ''}</h4>
            <div class="inv-scroll">
            ${byKind[kind].map((e) => `
                <label class="inv-row">
                    <input type="checkbox" data-key="${esc(e.kind)}:${esc(e.snmpIndex)}" ${e.tracked ? 'checked' : ''}>
                    <span class="grow">${esc(e.name)}${e.alias ? ` <span class="muted">· ${esc(e.alias)}</span>` : ''}</span>
                    ${e.kind === 'if' ? `<span class="muted small">${fmtSpeed(e.speedBps)}${e.extra && e.extra.hc === false ? ' · 32-bit' : ''}</span>
                    <span class="badge ${OPER[e.operStatus] === 'up' ? 'up' : OPER[e.operStatus] === 'down' ? 'down' : ''}">${OPER[e.operStatus] || '?'}</span>` : ''}
                </label>`).join('')}
            </div>
        </div>`).join('')}
        <div class="form-actions">
            <button class="btn-primary" id="save-device-btn">Add device</button>
            <span class="error-text" id="save-err"></span>
        </div>`;

        document.getElementById('save-device-btn').addEventListener('click', async () => {
            const entities = [...inv.querySelectorAll('input[type=checkbox]')].map((cb) => {
                const [kind, ...rest] = cb.dataset.key.split(':');
                return { kind, snmpIndex: rest.join(':'), tracked: cb.checked };
            });
            try {
                const saved = await api('POST', '/api/devices', {
                    probeToken: r.probeToken,
                    name: document.getElementById('f-name').value,
                    pollIntervalS: document.getElementById('f-interval').value || null,
                    entities
                });
                $modal.close();
                location.hash = `#/device/${saved.id}`;
            } catch (e) {
                document.getElementById('save-err').textContent = e.message;
            }
        });
    }

    // ===== device details =====
    let ifFilter = ''; // interface filter text, kept across auto-refresh

    async function renderDevice(id) {
        setNav('devices', true);
        let data;
        try {
            data = await GET(`/api/devices/${id}`);
        } catch (e) {
            $main.innerHTML = `<div class="panel error-text">${esc(e.message)}</div>`;
            return;
        }
        const d = data.device;
        const cards = data.entities.filter((e) => e.kind !== 'if' && e.tracked);
        // Tracked interfaces first, then untracked (dimmed, poll-able via the
        // Track checkbox - useful for opting into per-VM taps and the like).
        const allIfs = data.entities.filter((e) => e.kind === 'if');
        const ifs = [...allIfs.filter((e) => e.tracked), ...allIfs.filter((e) => !e.tracked)];
        const trackedCount = allIfs.filter((e) => e.tracked).length;

        $main.innerHTML = `
        <div class="page-head">
            <a href="#/devices" class="muted">← Devices</a>
            <h1>${dot(d.status)}${esc(d.name)}</h1>
            <span class="sub">${esc(d.host)}${d.port !== 161 ? ':' + d.port : ''} · SNMPv${esc(d.snmpVersion)}
                · up ${fmtUptime(d.uptimeSeconds)} · polled ${fmtAgo(d.lastPollTs)} every ${d.effectiveIntervalS}s</span>
            <span class="spacer"></span>
            <button id="dev-edit">Edit</button>
            ${data.entities.some((e) => e.kind !== 'if') ? '<button id="dev-sensors">Sensors</button>' : ''}
            <button id="dev-rediscover">Rediscover</button>
        </div>
        ${d.sysDescr ? `<div class="muted small" style="margin:-8px 0 12px">${esc(d.sysDescr.slice(0, 220))}</div>` : ''}
        ${d.notes ? `<div class="notes-block">${esc(d.notes)}</div>` : ''}
        ${cards.length ? `<div class="cards">${cards.map(resourceCard).join('')}</div>` : ''}
        <div class="panel">
            <h2 style="display:flex;align-items:center;gap:10px">Interfaces
                <span class="muted small">(${trackedCount} tracked${allIfs.length - trackedCount ? `, ${allIfs.length - trackedCount} untracked` : ''})</span>
                <span style="flex:1"></span>
                ${allIfs.length > 8 ? '<input type="text" id="if-filter" placeholder="filter name / alias" style="font-weight:400;width:190px">' : ''}
            </h2>
            ${ifs.length === 0 ? '<div class="muted">No interfaces discovered.</div>' : `
            <table class="list"><thead><tr>
                <th title="Poll and graph this interface">Track</th>
                <th title="Write this interface to snmp-status.json every poll">Export</th>
                <th>Status</th><th>Name</th><th class="hide-sm">Alias</th><th class="num">Speed</th>
                <th class="num">In</th><th class="num">Out</th><th class="num hide-sm">Err/s</th><th class="num hide-sm">Disc/s</th>
            </tr></thead><tbody>
            ${ifs.map((e) => {
                const v = e.latest && e.tracked ? e.latest.v : [];
                const oper = OPER[e.operStatus] || 'unknown';
                return `<tr class="${e.tracked ? 'rowlink' : ''}" data-eid="${e.id}" data-search="${esc((e.name + ' ' + e.alias).toLowerCase())}" ${e.tracked ? '' : 'style="opacity:0.55"'}>
                    <td><input type="checkbox" class="tracked-cb" data-eid="${e.id}" ${e.tracked ? 'checked' : ''}></td>
                    <td><input type="checkbox" class="export-cb" data-eid="${e.id}" ${e.export ? 'checked' : ''} ${e.tracked ? '' : 'disabled'}></td>
                    <td><span class="badge ${oper === 'up' ? 'up' : oper === 'down' ? 'down' : ''}">${oper}</span>
                        ${e.stale ? '<span class="badge stale" title="ifIndex may have moved - rediscover this device">stale</span>' : ''}</td>
                    <td><strong>${esc(e.name)}</strong> ${codeChip(e.code)}</td>
                    <td class="muted hide-sm">${esc(e.alias)}</td>
                    <td class="num">${fmtSpeed(e.speedBps)}</td>
                    <td class="num">${e.tracked ? fmtBps(v[0]) : '-'}</td>
                    <td class="num">${e.tracked ? fmtBps(v[1]) : '-'}</td>
                    <td class="num hide-sm">${e.tracked ? ((v[2] ?? 0) + (v[3] ?? 0)).toFixed(2).replace(/^0\.00$/, '0') : '-'}</td>
                    <td class="num hide-sm">${e.tracked ? ((v[4] ?? 0) + (v[5] ?? 0)).toFixed(2).replace(/^0\.00$/, '0') : '-'}</td>
                </tr>`;
            }).join('')}
            </tbody></table>`}
        </div>`;

        for (const card of $main.querySelectorAll('.card[data-eid]')) {
            card.addEventListener('click', () => { location.hash = `#/device/${id}/entity/${card.dataset.eid}`; });
        }
        for (const tr of $main.querySelectorAll('tr.rowlink')) {
            tr.addEventListener('click', (ev) => {
                if (ev.target.classList.contains('export-cb')) return;
                location.hash = `#/device/${id}/entity/${tr.dataset.eid}`;
            });
        }
        for (const cb of $main.querySelectorAll('.export-cb')) {
            cb.addEventListener('click', (ev) => ev.stopPropagation());
            cb.addEventListener('change', async () => {
                try { await api('PATCH', `/api/entities/${cb.dataset.eid}`, { export: cb.checked }); }
                catch (e) { cb.checked = !cb.checked; alert(e.message); }
            });
        }
        const filterInput = document.getElementById('if-filter');
        if (filterInput) {
            const applyFilter = () => {
                const q = ifFilter.trim().toLowerCase();
                for (const tr of $main.querySelectorAll('tr[data-search]')) {
                    tr.style.display = !q || tr.dataset.search.includes(q) ? '' : 'none';
                }
            };
            filterInput.addEventListener('input', () => { ifFilter = filterInput.value; applyFilter(); });
            // Survive the auto-refresh re-render.
            if (ifFilter) { filterInput.value = ifFilter; applyFilter(); }
        }
        for (const cb of $main.querySelectorAll('.tracked-cb')) {
            cb.addEventListener('click', (ev) => ev.stopPropagation());
            cb.addEventListener('change', async () => {
                try {
                    await api('PATCH', `/api/entities/${cb.dataset.eid}`, { tracked: cb.checked });
                    renderDevice(id);
                } catch (e) { cb.checked = !cb.checked; alert(e.message); }
            });
        }
        document.getElementById('dev-edit').addEventListener('click', () => editDeviceModal(d));
        const sensorsBtn = document.getElementById('dev-sensors');
        if (sensorsBtn) sensorsBtn.addEventListener('click', () => manageSensorsModal(id, data.entities));
        document.getElementById('dev-rediscover').addEventListener('click', async (ev) => {
            ev.target.disabled = true; ev.target.textContent = 'Rediscovering…';
            try {
                const r = await api('POST', `/api/devices/${id}/rediscover`, {});
                const s = r.summary;
                alert(`Rediscovery complete.\nAdded: ${s.added.length ? s.added.join(', ') : 'none'}\nRemoved: ${s.removed.length ? s.removed.join(', ') : 'none'}\nRenamed: ${s.updated.length ? s.updated.join(', ') : 'none'}`);
                renderDevice(id);
            } catch (e) {
                alert('Rediscovery failed: ' + e.message);
                renderDevice(id);
            }
        });
        setAutoRefresh(() => { if (location.hash === `#/device/${id}`) renderDevice(id); }, 30000);
    }

    function resourceCard(e) {
        const v = e.latest ? e.latest.v : [];
        // Exported sensors wear their code chip - the key a dashboard binds to.
        const chip = e.export && e.code ? ' ' + codeChip(e.code) : '';
        if (e.kind === 'temp') {
            const c = v[0];
            return `<div class="card" data-eid="${e.id}">
                <div class="card-title">${esc(e.name)}${chip}</div>
                <div class="card-value">${c == null ? '-' : c.toFixed(1) + '°C'}</div>
                <div class="meter"><i class="${c >= 70 ? 'hot' : ''}" style="width:${Math.min(100, c || 0)}%"></i></div>
            </div>`;
        }
        if (e.kind === 'fan') {
            const rpm = v[0];
            // A tracked fan reading 0 is the alarm case - paint it hot.
            return `<div class="card" data-eid="${e.id}">
                <div class="card-title">${esc(e.name)}${chip}</div>
                <div class="card-value">${rpm == null ? '-' : Math.round(rpm) + ' rpm'}</div>
                <div class="meter"><i class="${rpm === 0 ? 'hot' : ''}" style="width:${rpm === 0 ? 100 : Math.min(100, (rpm || 0) / 80)}%"></i></div>
            </div>`;
        }
        if (e.kind === 'power') {
            const w = v[0];
            return `<div class="card" data-eid="${e.id}">
                <div class="card-title">${esc(e.name)}${chip}</div>
                <div class="card-value">${w == null ? '-' : (w >= 1000 ? (w / 1000).toFixed(2) + ' kW' : w.toFixed(1) + ' W')}</div>
                <div class="meter"><i style="width:${Math.min(100, (w || 0) / 10)}%"></i></div>
            </div>`;
        }
        if (e.kind === 'gauge') {
            const pct = v[0];
            return `<div class="card" data-eid="${e.id}">
                <div class="card-title">${esc(e.name)}${chip}</div>
                <div class="card-value">${pct == null ? '-' : pct.toFixed(0) + '%'}</div>
                <div class="meter"><i class="${pct > 90 ? 'hot' : ''}" style="width:${Math.min(100, pct || 0)}%"></i></div>
            </div>`;
        }
        if (e.kind === 'battery') {
            const pct = v[0];
            // Batteries alarm LOW: red meter at 20% and below.
            return `<div class="card" data-eid="${e.id}">
                <div class="card-title">${esc(e.name)}${chip}</div>
                <div class="card-value">${pct == null ? '-' : pct.toFixed(0) + '%'}</div>
                <div class="meter"><i class="${pct != null && pct <= 20 ? 'hot' : ''}" style="width:${Math.min(100, pct || 0)}%"></i></div>
            </div>`;
        }
        if (e.kind === 'outlet') {
            const on = v[0];
            return `<div class="card" data-eid="${e.id}">
                <div class="card-title">${esc(e.name)}${chip}</div>
                <div class="card-value">${on == null ? '-' : on ? 'On' : 'Off'}</div>
                <div class="meter"><i class="${on === 0 ? 'hot' : ''}" style="width:${on == null ? 0 : 100}%"></i></div>
            </div>`;
        }
        if (e.kind === 'runtime') {
            const sec = v[0];
            return `<div class="card" data-eid="${e.id}">
                <div class="card-title">${esc(e.name)}${chip}</div>
                <div class="card-value">${sec == null ? '-' : Charts.fmtValue(sec, 'dur')}</div>
                <div class="meter"><i class="${sec != null && sec <= 300 ? 'hot' : ''}" style="width:${Math.min(100, (sec || 0) / 36)}%"></i></div>
            </div>`;
        }
        if (e.kind === 'cpu') {
            const pct = v[0];
            return `<div class="card" data-eid="${e.id}">
                <div class="card-title">${esc(e.name)}${chip}</div>
                <div class="card-value">${pct == null ? '-' : pct.toFixed(0) + '%'}</div>
                <div class="meter"><i class="${pct > 85 ? 'hot' : ''}" style="width:${Math.min(100, pct || 0)}%"></i></div>
            </div>`;
        }
        const used = v[0], total = v[1];
        const pct = used != null && total > 0 ? used / total * 100 : null;
        return `<div class="card" data-eid="${e.id}">
            <div class="card-title">${esc(e.name)}${chip}</div>
            <div class="card-value">${pct == null ? '-' : pct.toFixed(0) + '%'}</div>
            <div class="card-sub">${fmtBytes(used)} of ${fmtBytes(total)}</div>
            <div class="meter"><i class="${pct > 90 ? 'hot' : ''}" style="width:${Math.min(100, pct || 0)}%"></i></div>
        </div>`;
    }

    // Track/untrack CPU, memory, storage, and temperature sensors after the
    // add-device wizard (interfaces have their own Track column).
    function manageSensorsModal(deviceId, entities) {
        const kinds = { cpu: 'CPU', mem: 'Memory', fs: 'Storage', temp: 'Temperatures', fan: 'Fans', power: 'Power', gauge: 'Utilization', battery: 'Battery', runtime: 'Runtime', outlet: 'Outlets' };
        const sensors = entities.filter((e) => e.kind !== 'if');
        $modal.innerHTML = `
        <h2>Sensors</h2>
        <div class="muted small" style="margin-bottom:8px">
            <strong>T</strong>rack = poll &amp; graph · <strong>E</strong>xport = publish to snmp-status.json
            (the code chip is the key external dashboards reference)</div>
        ${Object.entries(kinds).map(([kind, label]) => {
            const list = sensors.filter((e) => e.kind === kind);
            return list.length === 0 ? '' : `
            <div class="inv-group"><h4>${label} (${list.length})</h4>
            <div class="inv-scroll">
            ${list.map((e) => `
                <div class="inv-row">
                    <input type="checkbox" class="ms-track" title="Track: poll and graph this sensor"
                        data-eid="${e.id}" data-was="${e.tracked ? 1 : 0}" ${e.tracked ? 'checked' : ''}>
                    <input type="checkbox" class="ms-export" title="Export to snmp-status.json"
                        data-eid="${e.id}" data-was="${e.export ? 1 : 0}" ${e.export ? 'checked' : ''} ${e.tracked ? '' : 'disabled'}>
                    <span class="grow">${esc(e.name)}</span>
                    ${codeChip(e.code)}
                    ${e.latest && e.latest.v[0] != null && kind === 'temp' ? `<span class="muted small">${e.latest.v[0].toFixed(1)}°C</span>` : ''}
                </div>`).join('')}
            </div></div>`;
        }).join('')}
        <div class="form-actions">
            <button class="btn-primary" id="ms-save">Save</button>
            <button id="ms-cancel">Cancel</button>
            <span class="error-text" id="ms-err"></span>
        </div>`;
        $modal.showModal();
        for (const t of $modal.querySelectorAll('.ms-track')) {
            t.addEventListener('change', () => {
                const ex = $modal.querySelector(`.ms-export[data-eid="${t.dataset.eid}"]`);
                ex.disabled = !t.checked;
                if (!t.checked) ex.checked = false;
            });
        }
        document.getElementById('ms-cancel').addEventListener('click', () => $modal.close());
        document.getElementById('ms-save').addEventListener('click', async () => {
            try {
                for (const t of $modal.querySelectorAll('.ms-track')) {
                    const ex = $modal.querySelector(`.ms-export[data-eid="${t.dataset.eid}"]`);
                    if (t.checked !== (t.dataset.was === '1') || ex.checked !== (ex.dataset.was === '1')) {
                        await api('PATCH', `/api/entities/${t.dataset.eid}`, { tracked: t.checked, export: ex.checked });
                    }
                }
                $modal.close();
                renderDevice(deviceId);
            } catch (e) { document.getElementById('ms-err').textContent = e.message; }
        });
    }

    function editDeviceModal(d) {
        $modal.innerHTML = `
        <h2>Edit ${esc(d.name)}</h2>
        <div class="form-grid">
            <label>Name</label><input type="text" id="e-name" value="${esc(d.name)}">
            <label>Polling interval</label>
            <span><input type="number" id="e-interval" min="30" style="width:110px" value="${d.pollIntervalS || ''}" placeholder="global"> seconds (blank = global ${d.effectiveIntervalS}s)</span>
            <label>Polling</label>
            <label><input type="checkbox" id="e-enabled" ${d.enabled ? 'checked' : ''}> enabled</label>
            <label>Uptime</label>
            <label><input type="checkbox" id="e-uptime" ${d.exportUptime ? 'checked' : ''}> export to snmp-status.json
                ${codeChip(d.uptimeCode)}</label>
            <label style="align-self:start">Notes</label>
            <textarea id="e-notes" rows="3" placeholder="anything worth remembering about this device">${esc(d.notes)}</textarea>
        </div>
        <div class="form-actions">
            <button class="btn-primary" id="e-save">Save</button>
            <button id="e-cancel">Cancel</button>
            <span class="spacer" style="flex:1"></span>
            <button class="btn-danger" id="e-delete">Delete device…</button>
        </div>
        <div class="error-text" id="e-err" style="margin-top:8px"></div>`;
        $modal.showModal();
        document.getElementById('e-cancel').addEventListener('click', () => $modal.close());
        document.getElementById('e-save').addEventListener('click', async () => {
            try {
                await api('PATCH', `/api/devices/${d.id}`, {
                    name: document.getElementById('e-name').value,
                    pollIntervalS: document.getElementById('e-interval').value || null,
                    enabled: document.getElementById('e-enabled').checked,
                    exportUptime: document.getElementById('e-uptime').checked,
                    notes: document.getElementById('e-notes').value
                });
                $modal.close();
                renderDevice(d.id);
            } catch (e) { document.getElementById('e-err').textContent = e.message; }
        });
        document.getElementById('e-delete').addEventListener('click', async () => {
            if (!confirm(`Delete "${d.name}" and all its history? This cannot be undone.`)) return;
            try {
                await api('DELETE', `/api/devices/${d.id}`);
                $modal.close();
                location.hash = '#/devices';
            } catch (e) { document.getElementById('e-err').textContent = e.message; }
        });
    }

    // ===== entity history (graphs) =====
    const RANGES = [['1h', 3600], ['6h', 6 * 3600], ['24h', 86400], ['7d', 7 * 86400], ['30d', 30 * 86400], ['90d', 90 * 86400]];
    let scaleToLink = false; // utilization mode: pin the traffic y-axis to link speed

    async function renderEntity(deviceId, entityId, rangeSec) {
        setNav('devices', true);
        rangeSec = rangeSec || 86400;
        const to = Math.floor(Date.now() / 1000);
        const from = to - rangeSec;
        let data;
        try {
            data = await GET(`/api/entities/${entityId}/samples?from=${from}&to=${to}&maxPoints=500`);
        } catch (e) {
            $main.innerHTML = `<div class="panel error-text">${esc(e.message)}</div>`;
            return;
        }
        const pts = data.points;
        const kind = data.kind;

        $main.innerHTML = `
        <div class="page-head">
            <a href="#/device/${deviceId}" class="muted">← Device</a>
            <h1>${esc(data.name)}</h1>
            ${codeChip(data.code)}
            <span class="sub">${data.bucketSec >= 3600 ? (data.bucketSec / 3600) + 'h' : (data.bucketSec / 60) + 'm'} buckets</span>
            <span class="spacer"></span>
            <div class="range-btns">
                ${RANGES.map(([label, sec]) => `<button data-range="${sec}" class="${sec === rangeSec ? 'active' : ''}">${label}</button>`).join('')}
                ${data.kind === 'if' && data.speedBps > 0 ? `<button id="scale-btn" class="${scaleToLink ? 'active' : ''}"
                    title="Pin the traffic y-axis to the link speed (${fmtSpeed(data.speedBps)}bps) so the chart reads as utilization">Link scale</button>` : ''}
            </div>
        </div>
        <div id="charts"></div>`;

        for (const b of $main.querySelectorAll('[data-range]')) {
            b.addEventListener('click', () => renderEntity(deviceId, entityId, +b.dataset.range));
        }
        const scaleBtn = document.getElementById('scale-btn');
        if (scaleBtn) scaleBtn.addEventListener('click', () => {
            scaleToLink = !scaleToLink;
            renderEntity(deviceId, entityId, rangeSec);
        });

        const wrap = document.getElementById('charts');
        const opts = { from, to, bucketSec: data.bucketSec };
        if (pts.length === 0) {
            wrap.innerHTML = '<div class="panel muted">No samples in this range yet.</div>';
            return;
        }
        if (kind === 'if') {
            chartBlock(wrap, 'Traffic', {
                ...opts, unit: 'bps',
                yMax: scaleToLink && data.speedBps > 0 ? data.speedBps : undefined,
                hlines: data.p95 ? [
                    { value: data.p95.in, cls: 'a', label: '95th in' },
                    { value: data.p95.out, cls: 'b', label: '95th out' }
                ] : [],
                series: [
                    { label: 'In (avg)', cls: 'a', area: true, data: pts.map((p) => [p[0], p[1]]) },
                    { label: 'In (max)', cls: 'c', data: pts.map((p) => [p[0], p[2]]) },
                    { label: 'Out (avg)', cls: 'b', area: true, data: pts.map((p) => [p[0], p[3]]) },
                    { label: 'Out (max)', cls: 'd', data: pts.map((p) => [p[0], p[4]]) }
                ]
            });
            chartBlock(wrap, 'Errors & discards', {
                ...opts, unit: 'pps',
                series: [
                    { label: 'In errors', cls: 'a', data: pts.map((p) => [p[0], p[5]]) },
                    { label: 'Out errors', cls: 'b', data: pts.map((p) => [p[0], p[6]]) },
                    { label: 'In discards', cls: 'c', data: pts.map((p) => [p[0], p[7]]) },
                    { label: 'Out discards', cls: 'd', data: pts.map((p) => [p[0], p[8]]) }
                ]
            });
            const stripWrap = document.createElement('div');
            stripWrap.className = 'chart-wrap';
            stripWrap.innerHTML = '<h3>Link status</h3><div class="status-strip"></div>';
            wrap.appendChild(stripWrap);
            Charts.statusStrip(stripWrap.querySelector('.status-strip'), pts, from, to, data.bucketSec);
        } else if (kind === 'cpu') {
            chartBlock(wrap, 'CPU load', {
                ...opts, unit: 'pct', yMax: 100,
                series: [{ label: 'Load %', cls: 'a', area: true, data: pts.map((p) => [p[0], p[1]]) }]
            });
        } else if (kind === 'temp') {
            chartBlock(wrap, 'Temperature', {
                ...opts, unit: 'degc',
                series: [
                    { label: '°C (avg)', cls: 'a', area: true, data: pts.map((p) => [p[0], p[1]]) },
                    { label: '°C (max)', cls: 'c', data: pts.map((p) => [p[0], p[2]]) }
                ]
            });
        } else if (kind === 'fan') {
            chartBlock(wrap, 'Fan speed', {
                ...opts, unit: 'rpm',
                series: [
                    { label: 'RPM (avg)', cls: 'a', area: true, data: pts.map((p) => [p[0], p[1]]) },
                    { label: 'RPM (max)', cls: 'c', data: pts.map((p) => [p[0], p[2]]) }
                ]
            });
        } else if (kind === 'power') {
            chartBlock(wrap, 'Power draw', {
                ...opts, unit: 'w',
                series: [
                    { label: 'Watts (avg)', cls: 'a', area: true, data: pts.map((p) => [p[0], p[1]]) },
                    { label: 'Watts (max)', cls: 'c', data: pts.map((p) => [p[0], p[2]]) }
                ]
            });
        } else if (kind === 'gauge' || kind === 'battery') {
            chartBlock(wrap, kind === 'battery' ? 'Battery charge' : 'Utilization', {
                ...opts, unit: 'pct', yMax: 100,
                series: [
                    { label: '% (avg)', cls: 'a', area: true, data: pts.map((p) => [p[0], p[1]]) },
                    { label: '% (max)', cls: 'c', data: pts.map((p) => [p[0], p[2]]) }
                ]
            });
        } else if (kind === 'outlet') {
            chartBlock(wrap, 'Outlet state', {
                ...opts, unit: 'onoff', yMax: 1,
                series: [{ label: 'On/Off', cls: 'a', area: true, data: pts.map((p) => [p[0], p[1]]) }]
            });
        } else if (kind === 'runtime') {
            chartBlock(wrap, 'Runtime remaining', {
                ...opts, unit: 'dur',
                series: [
                    { label: 'Runtime (avg)', cls: 'a', area: true, data: pts.map((p) => [p[0], p[1]]) },
                    { label: 'Runtime (max)', cls: 'c', data: pts.map((p) => [p[0], p[2]]) }
                ]
            });
        } else {
            chartBlock(wrap, kind === 'mem' ? 'Memory' : 'Storage', {
                ...opts, unit: 'bytes',
                series: [
                    { label: 'Used', cls: 'a', area: true, data: pts.map((p) => [p[0], p[1]]) },
                    { label: 'Total', cls: 'b', data: pts.map((p) => [p[0], p[3]]) }
                ]
            });
        }
    }

    function chartBlock(parent, title, chartOpts) {
        const div = document.createElement('div');
        div.className = 'chart-wrap panel';
        div.innerHTML = `<h3>${title}</h3><div class="chart-body"></div>`;
        parent.appendChild(div);
        Charts.render(div.querySelector('.chart-body'), chartOpts);
    }

    // ===== settings =====
    async function renderSettings() {
        setNav('settings', true);
        const s = await GET('/api/settings');
        $main.innerHTML = `
        <div class="page-head"><h1>Settings</h1></div>
        <div class="panel">
            <h2>Polling &amp; retention</h2>
            <div class="form-grid">
                <label>Global polling interval</label>
                <span><input type="number" id="s-interval" value="${s.pollIntervalS}" min="30" style="width:110px"> seconds</span>
                <label>History retention</label>
                <span><input type="number" id="s-retention" value="${s.retentionDays}" min="1" style="width:110px"> days (pruned nightly at 03:30)</span>
            </div>
        </div>
        <div class="panel">
            <h2>Interface export</h2>
            <div class="muted small" style="margin-bottom:8px">
                Interfaces with the <strong>Export</strong> box checked are written to this JSON file after every poll,
                for external dashboards to ingest.</div>
            <div class="form-grid">
                <label>snmp-status.json path</label><input type="text" id="s-export" value="${esc(s.exportPath)}">
            </div>
            ${s.exportError ? `<div class="error-text" style="margin-top:8px">Last write failed: ${esc(s.exportError)}</div>` : ''}
        </div>
        <div class="form-actions" style="margin-bottom:16px">
            <button class="btn-primary" id="s-save">Save settings</button>
            <span id="s-msg"></span>
        </div>
        <div class="panel">
            <h2>Change password</h2>
            <div class="form-grid">
                <label>Current password</label><input type="password" id="p-cur" autocomplete="current-password">
                <label>New password</label><input type="password" id="p-new" autocomplete="new-password">
                <label>Confirm new</label><input type="password" id="p-new2" autocomplete="new-password">
            </div>
            <div class="form-actions">
                <button id="p-save">Change password</button>
                <span id="p-msg"></span>
            </div>
        </div>
        <div class="panel">
            <h2>Backup</h2>
            <div class="muted small" style="margin-bottom:8px">
                Downloads a consistent snapshot of the whole database - devices, credentials, settings, and all history.
                Restore by stopping SNMPCanvas and replacing <code>snmpcanvas.db</code> in the data directory with the snapshot.</div>
            ${s.credentialEncryption ? '' : `<div class="warn-text small" style="margin-bottom:8px">
                SNMP credentials in the backup are unencrypted (set SNMPCANVAS_SECRET to change that) - store the file accordingly.</div>`}
            <a class="btn" href="/api/backup" download>Download database backup</a>
        </div>
        <div class="panel">
            <h2>Inventory export</h2>
            <div class="muted small" style="margin-bottom:8px">
                Downloads your monitored devices as a CSV ready to import into
                <b>CrossCanvas</b> (File &rarr; Import inventory). Each device arrives with its
                name, IP address and description; devices with an IP are monitoring-ready in
                PingCanvas straight away. A best-effort stencil is guessed from each device's
                SNMP description - adjust any in the editor after import.</div>
            <a class="btn" href="/api/inventory.csv" download>Export inventory (CrossCanvas CSV)</a>
        </div>
        <div class="panel muted small">
            Data directory: <code>${esc(s.dataDir)}</code><br>
            SNMP credential encryption at rest: ${s.credentialEncryption ? '<span class="ok-text">enabled</span>' : 'disabled (set SNMPCANVAS_SECRET to enable)'}
        </div>`;

        document.getElementById('s-save').addEventListener('click', async () => {
            const msg = document.getElementById('s-msg');
            try {
                await api('PATCH', '/api/settings', {
                    pollIntervalS: parseInt(document.getElementById('s-interval').value, 10),
                    retentionDays: parseInt(document.getElementById('s-retention').value, 10),
                    exportPath: document.getElementById('s-export').value
                });
                msg.className = 'ok-text'; msg.textContent = 'Saved.';
            } catch (e) { msg.className = 'error-text'; msg.textContent = e.message; }
        });
        document.getElementById('p-save').addEventListener('click', async () => {
            const msg = document.getElementById('p-msg');
            const next = document.getElementById('p-new').value;
            if (next !== document.getElementById('p-new2').value) {
                msg.className = 'error-text'; msg.textContent = 'New passwords do not match.'; return;
            }
            try {
                await api('POST', '/api/settings/password', { current: document.getElementById('p-cur').value, next });
                msg.className = 'ok-text'; msg.textContent = 'Password changed.';
                for (const id of ['p-cur', 'p-new', 'p-new2']) document.getElementById(id).value = '';
            } catch (e) { msg.className = 'error-text'; msg.textContent = e.message; }
        });
    }

    route();
})();
