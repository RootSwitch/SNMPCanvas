'use strict';
// Hand-rolled SVG time-series charts — no chart library. Colors come from CSS
// classes bound to the --se-* theme variables, so charts re-theme instantly.
//
// Chart.render(container, {
//   series: [{ label, cls ('a'|'b'|'c'|'d'), area, data: [[tsSec, value|null], ...] }],
//   from, to        // seconds
//   unit: 'bps' | 'pps' | 'pct' | 'bytes'
// })

(function () {
    const W = 860, H = 220, PAD = { l: 58, r: 12, t: 10, b: 22 };

    function fmtValue(v, unit) {
        if (v == null || !isFinite(v)) return '—';
        if (unit === 'pct') return v.toFixed(1) + '%';
        if (unit === 'bytes') return fmtSI(v, 1024, ['B', 'KiB', 'MiB', 'GiB', 'TiB']);
        if (unit === 'bps') return fmtSI(v, 1000, ['bps', 'kbps', 'Mbps', 'Gbps', 'Tbps']);
        return fmtSI(v, 1000, ['/s', 'k/s', 'M/s', 'G/s']);
    }
    function fmtSI(v, base, units) {
        let i = 0;
        while (Math.abs(v) >= base && i < units.length - 1) { v /= base; i++; }
        return (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + units[i];
    }

    function fmtTime(tsSec, rangeSec) {
        const d = new Date(tsSec * 1000);
        const hm = d.toTimeString().slice(0, 5);
        if (rangeSec <= 26 * 3600) return hm;
        const md = (d.getMonth() + 1) + '/' + d.getDate();
        return rangeSec <= 8 * 86400 ? md + ' ' + hm : md;
    }

    // Round the y max up to 1/2/5 × 10^n so gridlines land on clean numbers.
    function niceMax(v) {
        if (v <= 0) return 1;
        const pow = Math.pow(10, Math.floor(Math.log10(v)));
        for (const m of [1, 2, 5, 10]) if (v <= m * pow) return m * pow;
        return 10 * pow;
    }

    function xTicks(from, to) {
        const range = to - from;
        const steps = [300, 900, 1800, 3600, 7200, 14400, 43200, 86400, 2 * 86400, 7 * 86400, 14 * 86400, 30 * 86400];
        const step = steps.find((s) => range / s <= 8) || 30 * 86400;
        const ticks = [];
        for (let t = Math.ceil(from / step) * step; t <= to; t += step) ticks.push(t);
        return ticks;
    }

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function render(container, opts) {
        const { series, from, to, unit } = opts;
        let max = 0;
        for (const s of series) for (const [, v] of s.data) if (v != null && v > max) max = v;
        const yMax = opts.yMax || niceMax(max * 1.05);

        const x = (t) => PAD.l + (t - from) / (to - from) * (W - PAD.l - PAD.r);
        const y = (v) => H - PAD.b - (v / yMax) * (H - PAD.t - PAD.b);

        let g = '';
        // horizontal gridlines + y labels
        for (let i = 0; i <= 4; i++) {
            const v = yMax * i / 4;
            const yy = y(v);
            g += `<line class="chart-grid-line" x1="${PAD.l}" y1="${yy}" x2="${W - PAD.r}" y2="${yy}"/>`;
            g += `<text class="chart-axis-label" x="${PAD.l - 6}" y="${yy + 3}" text-anchor="end">${esc(fmtValue(v, unit))}</text>`;
        }
        // x ticks
        for (const t of xTicks(from, to)) {
            const xx = x(t);
            g += `<line class="chart-grid-line" x1="${xx}" y1="${PAD.t}" x2="${xx}" y2="${H - PAD.b}"/>`;
            g += `<text class="chart-axis-label" x="${xx}" y="${H - PAD.b + 14}" text-anchor="middle">${esc(fmtTime(t, to - from))}</text>`;
        }

        // horizontal reference lines (e.g. 95th percentile), drawn under the series
        for (const h of opts.hlines || []) {
            if (h.value == null || h.value <= 0 || h.value > yMax) continue;
            const hy = y(h.value);
            g += `<line class="chart-hline chart-line-${h.cls}" x1="${PAD.l}" y1="${hy}" x2="${W - PAD.r}" y2="${hy}"/>`;
            g += `<text class="chart-axis-label" x="${W - PAD.r - 4}" y="${hy - 4}" text-anchor="end">${esc(h.label)} ${esc(fmtValue(h.value, unit))}</text>`;
        }

        // series paths — null values (and gaps in time) break the line
        for (const s of series) {
            let line = '', area = '', run = [];
            const flush = () => {
                if (run.length === 0) return;
                line += 'M' + run.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join('L');
                if (s.area) {
                    const y0 = y(0);
                    area += `M${run[0][0].toFixed(1)},${y0}L` +
                        run.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join('L') +
                        `L${run[run.length - 1][0].toFixed(1)},${y0}Z`;
                }
                run = [];
            };
            let prevT = null;
            const maxGap = (opts.bucketSec || 300) * 2.5;
            for (const [t, v] of s.data) {
                if (v == null || (prevT != null && t - prevT > maxGap)) flush();
                if (v != null) run.push([x(t), y(Math.min(v, yMax))]);
                prevT = t;
            }
            flush();
            if (area) g += `<path class="chart-area-${s.cls}" d="${area}"/>`;
            if (line) g += `<path class="chart-line-${s.cls}" d="${line}"/>`;
        }

        container.style.position = 'relative';
        container.innerHTML =
            `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${g}` +
            `<line class="chart-cursor" x1="-10" y1="${PAD.t}" x2="-10" y2="${H - PAD.b}"/></svg>` +
            `<div class="chart-legend">` +
            series.map((s) => `<span><span class="swatch chart-line-${s.cls}" style="background:currentColor;border:0"></span>${esc(s.label)}</span>`).join('') +
            `</div>`;

        // hover crosshair + tooltip
        const svg = container.querySelector('svg');
        const cursor = svg.querySelector('.chart-cursor');
        let tip = null;
        svg.addEventListener('mousemove', (ev) => {
            const rect = svg.getBoundingClientRect();
            const fx = (ev.clientX - rect.left) / rect.width * W;
            if (fx < PAD.l || fx > W - PAD.r) { hide(); return; }
            const t = from + (fx - PAD.l) / (W - PAD.l - PAD.r) * (to - from);
            cursor.setAttribute('x1', fx); cursor.setAttribute('x2', fx);
            if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; container.appendChild(tip); }
            let html = `<strong>${esc(fmtTime(t, 0))} ${new Date(t * 1000).toLocaleDateString()}</strong>`;
            for (const s of series) {
                const pt = nearest(s.data, t, (opts.bucketSec || 300) * 1.5);
                html += `<br>${esc(s.label)}: ${esc(fmtValue(pt, unit))}`;
            }
            tip.innerHTML = html;
            const left = ev.clientX - rect.left;
            tip.style.left = Math.min(left + 12, rect.width - tip.offsetWidth - 4) + 'px';
            tip.style.top = '8px';
        });
        svg.addEventListener('mouseleave', hide);
        function hide() {
            cursor.setAttribute('x1', -10); cursor.setAttribute('x2', -10);
            if (tip) { tip.remove(); tip = null; }
        }
    }

    function nearest(data, t, tolerance) {
        let best = null, bestD = Infinity;
        for (const [pt, v] of data) {
            const d = Math.abs(pt - t);
            if (d < bestD) { bestD = d; best = v; }
        }
        return bestD <= tolerance ? best : null;
    }

    // Up/down strip from bucketed status values (1=up, else down; null=gap).
    function statusStrip(container, points, from, to, bucketSec) {
        const byT = new Map(points.map((p) => [p[0], p[9]]));
        let html = '';
        for (let t = Math.floor(from / bucketSec) * bucketSec; t <= to; t += bucketSec) {
            const st = byT.get(t);
            html += `<i class="${st == null ? 'gap' : st === 1 ? 'up' : 'down'}" title="${new Date(t * 1000).toLocaleString()}"></i>`;
        }
        container.innerHTML = html;
    }

    window.Charts = { render, statusStrip, fmtValue };
})();
