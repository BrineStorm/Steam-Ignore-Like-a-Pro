// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The one-time heads-up before a queue automator's first run: Steam's
    // Subscriber Agreement (4.C) restricts automated interaction with Steam, and
    // the Discovery Queue and Classic Discovery Queue helpers are the parts of
    // this extension that act without a gesture per game. Shown on the first
    // Start / Run only, never at install — someone who only uses the gestures
    // never sees it — and once accepted it stays accepted (ACK_KEY).
    //
    // A native modal <dialog>: Steam's Discovery Queue is itself a modal dialog
    // in the top layer, where no z-index reaches and the rest of the page is
    // inert. Opened after it, this one stacks above it and takes the input.

    window.ILAP = window.ILAP || {};

    const ACK_KEY = 'ilap_automation_ack';
    const SSA_URL = 'https://store.steampowered.com/subscriber_agreement/';
    const STYLE_ID = 'ilap-notice-style';
    // Ours, not Steam's: the icon and the name say who is asking.
    const ICON_URL = chrome.runtime.getURL('assets/icons/icon48.png');
    const APP_NAME = 'Steam Ignore Like A Pro';

    const t = window.ILAP.t;
    const esc = window.ILAP.Sanitizer.escapeHTML;
    const real = window.ILAP.realInput;

    // Storage shim, duplicated per world on purpose (see src/curator/store.js).
    const get = (query) => new Promise(r => chrome.storage.local.get(query, r));
    const set = (obj) => new Promise(r => chrome.storage.local.set(obj, r));

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            /* Centred explicitly: Steam's own dialog styles move the browser's
               default placement, and outrank a plain class selector. */
            dialog.ilap-notice {
                position: fixed !important; inset: 0 !important; margin: auto !important;
                width: fit-content !important; height: fit-content !important;
                max-width: 380px; padding: 0;
                background: #16202d; color: #c7d5e0; border: 1px solid #45A1FA; border-radius: 8px;
                box-shadow: 0 12px 36px rgba(0,0,0,.7);
                font: 13px/1.5 "Motiva Sans", Arial, sans-serif;
            }
            .ilap-notice::backdrop { background: rgba(0,0,0,.55); }
            /* The padding lives here, so a click that lands on the dialog itself
               is a click on the backdrop. */
            .ilap-notice-card { padding: 16px 18px; }
            .ilap-notice-head {
                display: flex; align-items: center; gap: 10px; margin-bottom: 10px;
                color: #fff; font-weight: 700; font-size: 14px;
            }
            .ilap-notice-head img { width: 28px; height: 28px; border-radius: 6px; display: block; }
            .ilap-notice a { color: #45A1FA; }
            .ilap-notice-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
            .ilap-notice-actions button {
                border: none; border-radius: 3px; padding: 6px 14px; cursor: pointer;
                font: 600 13px "Motiva Sans", Arial, sans-serif;
            }
            .ilap-notice-cancel { background: #3d4a5d; color: #fff; }
            .ilap-notice-go { background: #5c7e10; color: #fff; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    // Resolves true on Start, false on Cancel, Esc, a click outside the card, or
    // the dialog going any other way.
    // One dialog at a time: a second ask while one is open shares its answer.
    let pending = null;
    function ask() {
        if (pending) return pending;
        pending = new Promise((resolve) => {
            ensureStyle();
            const dialog = document.createElement('dialog');
            dialog.className = 'ilap-notice';
            dialog.innerHTML = `
                <div class="ilap-notice-card">
                    <div class="ilap-notice-head"><img src="${ICON_URL}" alt=""><span>${esc(APP_NAME)}</span></div>
                    <div>${esc(t('notice_body'))}</div>
                    <div><a href="${SSA_URL}" target="_blank" rel="noopener noreferrer">${esc(t('notice_link'))}</a></div>
                    <div class="ilap-notice-actions">
                        <button type="button" class="ilap-notice-cancel" autofocus>${esc(t('notice_cancel'))}</button>
                        <button type="button" class="ilap-notice-go">${esc(t('notice_continue'))}</button>
                    </div>
                </div>`;
            // Settles once, however the dialog goes: our buttons, Esc, or a page
            // script closing it or taking it out of the DOM. A promise left
            // hanging would hold the Start latches waiting on it until a reload.
            let settled = false;
            const gone = new MutationObserver(() => { if (!dialog.isConnected) done(false); });
            const done = (answer) => {
                if (settled) return;
                settled = true;
                gone.disconnect();
                if (dialog.open) dialog.close();
                dialog.remove();
                pending = null;
                resolve(answer);
            };
            // Real input only, like every other control this extension puts on a
            // Steam page: a page script must not accept this for the user. Esc
            // and a close need no such check: all they can do is decline.
            dialog.querySelector('.ilap-notice-go').addEventListener('click', real(() => done(true)));
            dialog.querySelector('.ilap-notice-cancel').addEventListener('click', real(() => done(false)));
            // A click outside the card declines, but only one that began there
            // too: a press on the card released over the backdrop also lands on
            // the dialog itself.
            let pressedOutside = false;
            dialog.addEventListener('pointerdown', (e) => { pressedOutside = e.target === dialog; });
            dialog.addEventListener('click', real((e) => { if (e.target === dialog && pressedOutside) done(false); }));
            dialog.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
            dialog.addEventListener('close', () => done(false));
            // showModal() focuses Cancel (autofocus), not the first focusable
            // element, which is the agreement link: an Enter pressed right after
            // the Start click must neither open a tab nor accept.
            document.body.appendChild(dialog);
            gone.observe(document.body, { childList: true });
            dialog.showModal();
        });
        return pending;
    }

    // true once the user has accepted the notice, now or on an earlier run.
    async function confirmOnce() {
        if ((await get({ [ACK_KEY]: false }))[ACK_KEY] === true) return true;
        if (!(await ask())) return false;
        await set({ [ACK_KEY]: true });
        return true;
    }

    window.ILAP.AutomationNotice = Object.freeze({ confirmOnce, ACK_KEY });
})();
