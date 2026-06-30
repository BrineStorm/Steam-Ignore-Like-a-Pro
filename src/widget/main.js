// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // On-page surface for the popup. The browser-toolbar action popup is
    // unreachable inside the Steam desktop client, so the same popup component is
    // hosted here in a shadow root: an icon launcher pinned top-right that expands
    // the panel. Both surfaces are views over chrome.storage.local.

    if (window.__ilapWidgetMounted) return;
    window.__ilapWidgetMounted = true;

    const ICON = 34;
    const TOP = Math.round(ICON * 1.5); // sit ~1.5 icon-heights below the top, clear of Steam's header

    const SPARED = '#45A1FA'; // EQ "Spared" outline colour
    const SPARED_DIM = 'rgba(69, 161, 250, .4)'; // paler idle outline for the launcher
    const FONT = '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif';

    const LAUNCHER_CSS = `
        /* Force the popup font across the whole widget via a direct rule (beats
           popup.css inheritance, so labels like "Your Discovery Queue" can't fall
           back to Steam's page font), and don't depend on the linked stylesheet
           having loaded yet. */
        :host, :host * { font-family: ${FONT}; }
        .ilap-launcher {
            width: ${ICON}px; height: ${ICON}px; padding: 0;
            display: flex; align-items: center; justify-content: center;
            background: #1a2735; border: 1px solid ${SPARED_DIM}; border-radius: 8px;
            cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.5);
            transition: border-color .15s ease, box-shadow .15s ease;
        }
        .ilap-launcher:hover, .ilap-launcher.active { border-color: ${SPARED}; box-shadow: 0 2px 12px rgba(0,0,0,.6); }
        /* One-shot highlight blink, fired when a curator ignore-queue job finishes. */
        @keyframes ilap-launcher-pulse {
            0%   { border-color: ${SPARED_DIM}; box-shadow: 0 2px 8px rgba(0,0,0,.5); }
            35%  { border-color: ${SPARED}; box-shadow: 0 0 0 3px rgba(69,161,250,.55), 0 2px 12px rgba(0,0,0,.6); }
            100% { border-color: ${SPARED_DIM}; box-shadow: 0 2px 8px rgba(0,0,0,.5); }
        }
        .ilap-launcher.pulse { animation: ilap-launcher-pulse .9s ease-in-out 1; }
        .ilap-launcher img { width: 26px; height: 26px; border-radius: 5px; display: block; pointer-events: none; }
        .ilap-panel { display: none; position: absolute; top: ${ICON + 8}px; right: 0; }
        .ilap-panel.open { display: block; }
        /* 1px Spared-coloured outline + smoothed corners on the panel itself. */
        .ilap-panel #popup-root { outline: none; border: 1px solid ${SPARED}; border-radius: 10px; }
    `;

    function mount() {
        const host = document.createElement('div');
        host.id = 'ilap-widget-host';
        Object.assign(host.style, {
            position: 'fixed',
            top: TOP + 'px',
            right: '12px',
            width: ICON + 'px',
            height: ICON + 'px',
            zIndex: '2147483000'
        });

        const shadow = host.attachShadow({ mode: 'open' });

        const sheet = document.createElement('link');
        sheet.rel = 'stylesheet';
        sheet.href = chrome.runtime.getURL('ui/popup.css');
        shadow.appendChild(sheet);

        const style = document.createElement('style');
        style.textContent = LAUNCHER_CSS;
        shadow.appendChild(style);

        const launcher = document.createElement('button');
        launcher.type = 'button';
        launcher.className = 'ilap-launcher';
        launcher.setAttribute('aria-label', 'Steam Ignore Like A Pro');
        launcher.innerHTML = `<img src="${chrome.runtime.getURL('assets/icons/icon48.png')}" alt="">`;
        shadow.appendChild(launcher);

        const panel = document.createElement('div');
        panel.className = 'ilap-panel';
        panel.innerHTML = window.ILAP_PopupMarkup;
        shadow.appendChild(panel);

        document.body.appendChild(host);

        let inited = false;
        const setOpen = (open) => {
            panel.classList.toggle('open', open);
            launcher.classList.toggle('active', open); // keep the hover-style highlight while open
            if (open && !inited) {
                inited = true;
                window.ILAP_Popup.init(shadow);
            }
        };

        launcher.addEventListener('click', (e) => {
            e.stopPropagation();
            setOpen(!panel.classList.contains('open'));
        });

        // Collapse when clicking elsewhere on the page. Clicks inside the shadow
        // are retargeted to the host, so host.contains(target) stays true for them.
        // Capture phase so it still fires when another extension control (e.g. the
        // curator "Add to ignore queue" button) calls stopPropagation in the bubble phase.
        document.addEventListener('click', (e) => {
            if (panel.classList.contains('open') && !host.contains(e.target)) setOpen(false);
        }, true);

        // Blink the launcher once whenever a curator queue job finishes. The drainer
        // writes ilap_curator_pulse on completion; onChanged fires in every tab.
        launcher.addEventListener('animationend', () => launcher.classList.remove('pulse'));
        const blink = () => {
            launcher.classList.remove('pulse');
            void launcher.offsetWidth; // reflow so re-adding restarts the animation
            launcher.classList.add('pulse');
        };
        chrome.storage.onChanged.addListener((changes, area) => {
            if ((!area || area === 'local') && changes.ilap_curator_pulse) blink();
        });
    }

    if (document.body) {
        mount();
    } else {
        document.addEventListener('DOMContentLoaded', mount);
    }
})();
