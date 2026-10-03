// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// AutomationNotice (src/automation-notice.js) as a Node unit, on a minimal fake
// DOM. The notice sits on a Steam page, so two things must hold whatever that
// page does:
//   - only real input accepts it: a page script cannot start a run for the user;
//   - it always settles: a dialog closed or removed by anything but our buttons
//     resolves as a decline, or the Start latches waiting on it (DQ _starting,
//     EQ _startingRun) would hold until a reload.
// The E2E specs click it for real (discovery-queue/ui.spec.js,
// explore-queue/start-prompt.spec.js); what they cannot do is forge an event or
// play the page closing the dialog under us.

const SRC = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', ...p), 'utf8');

function load({ store = {} } = {}) {
    const observers = new Set();
    class El {
        constructor(tag) {
            this.tag = tag; this.listeners = {}; this.found = {};
            this.open = false; this.isConnected = false;
        }
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
        fire(type, e) {
            for (const fn of this.listeners[type] || []) fn(Object.assign({ preventDefault() {} }, e));
        }
        querySelector(sel) { return (this.found[sel] = this.found[sel] || new El('button')); }
        appendChild(child) { child.isConnected = true; this.child = child; }
        showModal() { this.open = true; }
        // As a browser does: `close` is queued, and only for an open dialog.
        close() {
            if (!this.open) return;
            this.open = false;
            setTimeout(() => this.fire('close', {}), 0);
        }
        remove() {
            if (!this.isConnected) return;
            this.isConnected = false;
            for (const o of observers) o.cb([]);
        }
    }
    const body = new El('body');
    const sandbox = {
        window: { ILAP: { t: (k) => k } },
        document: {
            body, head: new El('head'),
            getElementById: () => null,
            createElement: (tag) => new El(tag),
        },
        MutationObserver: class {
            constructor(cb) { this.cb = cb; }
            observe() { observers.add(this); }
            disconnect() { observers.delete(this); }
        },
        chrome: {
            runtime: { getURL: (p) => 'chrome-extension://x/' + p },
            storage: {
                local: {
                    get: (query, cb) => {
                        const out = {};
                        for (const [k, dflt] of Object.entries(query)) out[k] = k in store ? store[k] : dflt;
                        cb(out);
                    },
                    set: (obj, cb) => { Object.assign(store, obj); cb && cb(); },
                },
            },
        },
        Promise, Object, String, setTimeout,
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC('escape.js'), sandbox, { filename: 'escape.js' });
    vm.runInContext(SRC('automation-notice.js'), sandbox, { filename: 'automation-notice.js' });
    return {
        Notice: sandbox.window.ILAP.AutomationNotice,
        store,
        observers,
        dialog: () => body.child,
    };
}

const tick = () => new Promise(r => setTimeout(r, 0));
const REAL = { isTrusted: true };

// Resolves to the answer, or 'open' while the notice is still waiting.
const settled = async (p) => Promise.race([p, tick().then(tick).then(() => 'open')]);

test.describe('AutomationNotice — only real input accepts it (unit)', () => {

    test('Start with real input accepts, and is remembered: the next run asks nothing', async () => {
        const n = load();
        const answer = n.Notice.confirmOnce();
        await tick();
        n.dialog().querySelector('.ilap-notice-go').fire('click', REAL);
        expect(await answer).toBe(true);
        expect(n.store[n.Notice.ACK_KEY]).toBe(true);
        expect(n.dialog().isConnected).toBe(false);

        const first = n.dialog();
        expect(await n.Notice.confirmOnce()).toBe(true);
        expect(n.dialog()).toBe(first);                    // no second dialog
    });

    test('a forged click on Start or Cancel does nothing', async () => {
        const n = load();
        const answer = n.Notice.confirmOnce();
        await tick();
        n.dialog().querySelector('.ilap-notice-go').fire('click', { isTrusted: false });
        n.dialog().querySelector('.ilap-notice-cancel').fire('click', {});
        expect(await settled(answer)).toBe('open');
        expect(n.store[n.Notice.ACK_KEY]).toBeUndefined();
    });

    test('Cancel and Esc decline, and nothing is remembered', async () => {
        for (const decline of [
            (d) => d.querySelector('.ilap-notice-cancel').fire('click', REAL),
            (d) => d.fire('cancel', {}),
        ]) {
            const n = load();
            const answer = n.Notice.confirmOnce();
            await tick();
            decline(n.dialog());
            expect(await answer).toBe(false);
            expect(n.store[n.Notice.ACK_KEY]).toBeUndefined();
        }
    });
});

test.describe('AutomationNotice — a click outside the card (unit)', () => {

    test('pressed and released on the backdrop: declined', async () => {
        const n = load();
        const answer = n.Notice.confirmOnce();
        await tick();
        const d = n.dialog();
        d.fire('pointerdown', { target: d });
        d.fire('click', { isTrusted: true, target: d });
        expect(await answer).toBe(false);
    });

    test('pressed on the card, released on the backdrop: still open', async () => {
        // The click of a drag that ends outside lands on the dialog itself.
        const n = load();
        const answer = n.Notice.confirmOnce();
        await tick();
        const d = n.dialog();
        d.fire('pointerdown', { target: d.querySelector('.ilap-notice-card') });
        d.fire('click', { isTrusted: true, target: d });
        expect(await settled(answer)).toBe('open');
    });
});

test.describe('AutomationNotice — it always settles (unit)', () => {

    test('closed by a page script: declined, and the next run asks again', async () => {
        const n = load();
        const answer = n.Notice.confirmOnce();
        await tick();
        const first = n.dialog();
        first.close();
        expect(await answer).toBe(false);

        const again = n.Notice.confirmOnce();
        await tick();
        expect(n.dialog()).not.toBe(first);                // a new dialog, not the dead one
        n.dialog().querySelector('.ilap-notice-go').fire('click', REAL);
        expect(await again).toBe(true);
    });

    test('taken out of the DOM by a page script: declined, nothing left watching', async () => {
        const n = load();
        const answer = n.Notice.confirmOnce();
        await tick();
        n.dialog().remove();
        expect(await answer).toBe(false);
        expect(n.observers.size).toBe(0);
    });

    test('our own close after an answer does not answer twice', async () => {
        // done() closes the dialog, which queues a `close` that calls it again.
        const n = load();
        const answer = n.Notice.confirmOnce();
        await tick();
        n.dialog().querySelector('.ilap-notice-go').fire('click', REAL);
        expect(await answer).toBe(true);
        await tick();
        expect(n.store[n.Notice.ACK_KEY]).toBe(true);
        expect(n.observers.size).toBe(0);
    });

    test('a second ask while one is open shares its answer', async () => {
        const n = load();
        const a = n.Notice.confirmOnce();
        const b = n.Notice.confirmOnce();
        await tick();
        n.dialog().querySelector('.ilap-notice-cancel').fire('click', REAL);
        expect(await Promise.all([a, b])).toEqual([false, false]);
    });
});
