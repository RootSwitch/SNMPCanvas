'use strict';
// Theme system in the CrossCanvas mold: each theme is a plain object of
// --se-* values applied to :root. Palettes are carried over from CrossCanvas
// (its THEMES map), trimmed to the chrome variables SNMPCanvas uses, plus
// per-theme status/series colors where the defaults would clash.

(function () {
    const THEME_VARS = ['--se-panel', '--se-panel-2', '--se-input', '--se-border',
        '--se-txt', '--se-txt-dim', '--se-accent', '--se-active',
        '--se-up', '--se-down', '--se-unknown', '--se-series-out',
        '--se-logo-a', '--se-logo-b'];

    const THEMES = {
        classic: { label: 'Classic', vars: {} }, // style.css :root defaults
        slate: {
            label: 'Slate',
            vars: { '--se-panel': '#23272b', '--se-panel-2': '#2c3136', '--se-input': '#17191c',
                    '--se-border': '#3d4349', '--se-txt': '#e8eaec', '--se-txt-dim': '#9aa1a8',
                    '--se-accent': '#7d97ad', '--se-active': '#546a7e' }
        },
        glacier: {
            label: 'Glacier',
            vars: { '--se-panel': '#e9edf2', '--se-panel-2': '#dbe1ea', '--se-input': '#ffffff',
                    '--se-border': '#c3ccd8', '--se-txt': '#1f2a37', '--se-txt-dim': '#5c6672',
                    '--se-accent': '#2f6fd0', '--se-active': '#2f6fd0',
                    '--se-up': '#1e7a43', '--se-down': '#c23934', '--se-series-out': '#1e7a43' }
        },
        blueprint: {
            label: 'Blueprint',
            vars: { '--se-panel': '#142c47', '--se-panel-2': '#1a3a5c', '--se-input': '#0e2136',
                    '--se-border': '#2a4d73', '--se-txt': '#dfe9f5', '--se-txt-dim': '#93aecb',
                    '--se-accent': '#7fd4ff', '--se-active': '#2e6da4',
                    '--se-series-out': '#6be59a', '--se-logo-a': '#dcc296', '--se-logo-b': '#b3945f' }
        },
        ink: {
            label: 'Ink',
            vars: { '--se-panel': '#211d1a', '--se-panel-2': '#2a2521', '--se-input': '#161311',
                    '--se-border': '#3d362f', '--se-txt': '#ede7dc', '--se-txt-dim': '#a89e8f',
                    '--se-accent': '#c98f4e', '--se-active': '#96683a',
                    '--se-series-out': '#8aab6d', '--se-logo-a': '#d3a866', '--se-logo-b': '#9c7847' }
        },
        evergreen: {
            label: 'Evergreen',
            vars: { '--se-panel': '#173726', '--se-panel-2': '#1f4a33', '--se-input': '#10281c',
                    '--se-border': '#2c5c40', '--se-txt': '#e7efe9', '--se-txt-dim': '#9db8a7',
                    '--se-accent': '#58b380', '--se-active': '#2d7a4f',
                    '--se-series-out': '#d9c34f' }
        },
        midnight: {
            label: 'Midnight',
            vars: { '--se-panel': '#1e1b3a', '--se-panel-2': '#272248', '--se-input': '#141126',
                    '--se-border': '#383163', '--se-txt': '#eae8f4', '--se-txt-dim': '#a29cc4',
                    '--se-accent': '#8b7cf8', '--se-active': '#5b4bc4',
                    '--se-series-out': '#4fc9a8' }
        },
        ember: {
            label: 'Ember',
            vars: { '--se-panel': '#1a1a1c', '--se-panel-2': '#242427', '--se-input': '#101012',
                    '--se-border': '#3a3a3e', '--se-txt': '#ecebe9', '--se-txt-dim': '#a09d99',
                    '--se-accent': '#ff8c1a', '--se-active': '#d97528',
                    '--se-series-out': '#7fb26a' }
        },
        phosphor: {
            label: 'Phosphor',
            vars: { '--se-panel': '#0d1a0d', '--se-panel-2': '#12240f', '--se-input': '#071007',
                    '--se-border': '#1e3a1a', '--se-txt': '#a8f0a0', '--se-txt-dim': '#5c9e57',
                    '--se-accent': '#39ff14', '--se-active': '#2bcc10',
                    '--se-up': '#39ff14', '--se-down': '#ff5544', '--se-series-out': '#c8f04f' }
        }
    };

    const KEY = 'snmpcanvas-theme';

    function applyTheme(name) {
        const theme = THEMES[name] || THEMES.classic;
        const root = document.documentElement.style;
        for (const v of THEME_VARS) root.removeProperty(v);
        for (const [k, val] of Object.entries(theme.vars)) root.setProperty(k, val);
        try { localStorage.setItem(KEY, name); } catch (_) { /* private mode */ }
    }

    function currentTheme() {
        try { return localStorage.getItem(KEY) || 'classic'; } catch (_) { return 'classic'; }
    }

    window.Themes = { THEMES, applyTheme, currentTheme };
    applyTheme(currentTheme());
})();
