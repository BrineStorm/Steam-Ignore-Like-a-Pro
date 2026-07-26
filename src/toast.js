// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The bottom-right push card, shared by the two fire-and-forget notifiers:
    // the curator page button (job added / switched / queue full / enumerate
    // error) and Manual Ignore (the MI queue is stuck at its cap). It slides in,
    // then fades out on its own — no buttons, no state.
    //
    // EQ/DQ deliberately keep their own toasts: those are interactive surfaces
    // (Run/Fast-Forward/Disable buttons, live mode badge, mount/unmount against
    // Steam's DOM) that happen to look like cards. Sharing this one would mean
    // rewriting them, not de-duplicating them. The widget's sign-in push
    // (`.ilap-push`, src/widget/main.js) is the same call: it looks like this
    // card but lives inside the widget's shadow root and is click-dismissable.
    //
    // Callers pass READY HTML (the curator toast highlights the filter name in
    // bold), so nothing is escaped here — a text-only caller escapes its own
    // string through window.ILAP.Sanitizer.escapeHTML first.

    const STYLE_ID = 'ilap-toast-style';
    const ICON_URL = chrome.runtime.getURL('assets/icons/icon48.png');
    const DEFAULT_MS = 3100;

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .ilap-toast {
                position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
                display: flex; align-items: center; gap: 10px; max-width: 320px;
                background: #16202d; color: #fff; border: 1px solid #45A1FA; border-left: 3px solid #45A1FA;
                border-radius: 8px; padding: 12px 15px; box-shadow: 0 8px 24px rgba(0,0,0,.6);
                font: 600 13px "Motiva Sans", Arial, sans-serif; line-height: 1.4;
                transform: translateY(16px); opacity: 0;
                transition: transform .3s cubic-bezier(.2,.9,.3,1), opacity .3s ease;
            }
            .ilap-toast.show { transform: translateY(0); opacity: 1; }
            .ilap-toast img { width: 22px; height: 22px; border-radius: 4px; display: block; flex-shrink: 0; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function showToast(html, duration) {
        ensureStyle();
        const toast = document.createElement('div');
        toast.className = 'ilap-toast';
        toast.innerHTML = `<img src="${ICON_URL}" alt=""><span>${html}</span>`;
        document.body.appendChild(toast);
        requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 350);
        }, duration || DEFAULT_MS);
    }

    window.ILAP = window.ILAP || {};
    window.ILAP.showToast = showToast;

})();
