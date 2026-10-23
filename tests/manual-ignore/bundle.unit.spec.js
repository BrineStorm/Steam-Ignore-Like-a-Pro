// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadSettingsSchema } = require('../_settings-schema.js');
const { loadEscape } = require('../_escape.js');

// A gesture on a bundle or package capsule: the intent the
// parser builds from the link, the confirm-by-a-second-swipe flow, and the read
// of the bundle's apps from Steam. Node only, like bindings.unit.spec.js.

const src = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', ...p), 'utf8');

function loadMI(extra) {
    const sandbox = Object.assign({ window: {}, chrome: { runtime: { id: 'ilap-test' } },
        Math, Set, Map, Array, Object, String, Number, JSON, Date, Promise, TypeError, encodeURIComponent },
    extra);
    vm.createContext(sandbox);
    loadSettingsSchema(sandbox);
    loadEscape(sandbox);
    vm.runInContext(src('manual-ignore', 'gestures.js'), sandbox);
    vm.runInContext(src('manual-ignore', 'bundle.js'), sandbox);
    return { MI: sandbox.window.ILAP.ManualIgnore, sandbox };
}

// An element whose nearest link is `href`, of the kind the selector asks for.
const inLink = (href, art = true) => ({
    closest: (sel) => {
        const isApp = href.includes('/app/');
        const wantsApp = sel.includes('/app/');
        const wantsBundle = sel.includes('/bundle/');
        if ((isApp && wantsApp) || (!isApp && wantsBundle)) return { getAttribute: () => href, querySelector: () => (art ? {} : null) };
        return null;
    },
});

test.describe('Bundle intent (unit)', () => {

    test('a /bundle/ or /sub/ link becomes a bundle intent with its store id', () => {
        const { MI } = loadMI();
        const parser = new MI.EventParser({ get: () => ({ enabled: true }) });
        const b = parser.createIntent(inLink('https://store.steampowered.com/bundle/232/Valve_Complete_Pack/'), 0);
        expect(b.bundle).toEqual({ kind: 'bundle', id: '232' });
        expect(b.appid).toBeUndefined();
        const s = parser.createIntent(inLink('/sub/648168/?snr=1'), 2);
        expect(s.bundle).toEqual({ kind: 'sub', id: '648168' });
        expect(s.reason).toBe(2);
    });

    test('a game link wins, and a link with no id is no intent', () => {
        const { MI } = loadMI();
        const parser = new MI.EventParser({ get: () => ({ enabled: true }) });
        expect(parser.createIntent(inLink('/app/440/'), 0).appid).toBe('440');
        expect(parser.createIntent(inLink('/bundle/abc/'), 0)).toBe(null);
    });

    test('a bundle link with no art in it (a text link, a "Bundle info" button) is no target', () => {
        const { MI } = loadMI();
        const parser = new MI.EventParser({ get: () => ({ enabled: true }) });
        expect(parser.createIntent(inLink('/sub/469/', false), 0)).toBe(null);
    });
});

test.describe('BundleRequests (unit)', () => {

    function make(over) {
        const { MI } = loadMI();
        const toasts = [];
        const staged = [];
        const reads = [];
        const req = new MI.BundleRequests(Object.assign({
            read: async (ref) => { reads.push(ref); return { name: 'Pack', apps: [{ appid: '1' }, { appid: '2' }] }; },
            stage: async (spec) => { staged.push(spec); return { kind: 'added' }; },
            isDone: () => false,
            isLoggedIn: async () => true,
            toast: (key, params) => toasts.push(params ? [key, params] : key),
        }, over));
        return { req, toasts, staged, reads, MI };
    }
    const intent = (id, reason = 0) => ({ bundle: { kind: 'bundle', id }, reason });

    test('the first swipe only asks for a second one; the second stages the bundle', async () => {
        const { req, toasts, staged, reads } = make();
        await req.request(intent('232'));
        expect(toasts).toEqual(['bundle_swipe_again']);
        expect(reads).toEqual([]);
        await req.request(intent('232', 2));
        expect(staged).toEqual([{ kind: 'bundle', id: '232', name: 'Pack',
            apps: [{ appid: '1' }, { appid: '2' }], reason: 2 }]);
        expect(toasts[1]).toEqual(['bundle_queued', { name: 'Pack', n: 2 }]);
    });

    test('a swipe on another bundle, or one past the window, asks again', async () => {
        const { req, toasts, staged, MI } = make();
        await req.request(intent('1'));
        await req.request(intent('2'));
        expect(staged).toEqual([]);
        expect(toasts).toEqual(['bundle_swipe_again', 'bundle_swipe_again']);
        req._armed.at -= MI.BUNDLE_CONFIRM_MS + 1;
        await req.request(intent('2'));
        expect(staged).toEqual([]);
    });

    test('each outcome has its card; nothing to read says so', async () => {
        for (const [kind, card] of [['merged', 'bundle_queued'], ['queued', 'bundle_already_queued'],
            ['full', 'bundle_queue_full'], ['empty', 'bundle_unreadable']]) {
            const { req, toasts } = make({ stage: async () => ({ kind }) });
            await req.request(intent('9'));
            await req.request(intent('9'));
            expect([].concat(toasts[1])[0], kind).toBe(card);
        }
        const { req, toasts, staged } = make({ read: async () => null });
        await req.request(intent('9'));
        await req.request(intent('9'));
        expect(staged).toEqual([]);
        expect(toasts[1]).toBe('bundle_unreadable');
    });

    test('a bundle already badged IGNORED takes no swipe at all', async () => {
        const asked = [];
        const { req, toasts, staged } = make({ isDone: (key) => { asked.push(key); return true; } });
        await req.request(intent('232'));
        await req.request(intent('232'));
        expect(asked).toEqual(['bundle_232', 'bundle_232']);
        expect(toasts).toEqual([]);
        expect(staged).toEqual([]);
    });

    test('signed out, a swipe does nothing at all', async () => {
        const { req, toasts } = make({ isLoggedIn: async () => false });
        await req.request(intent('9'));
        await req.request(intent('9'));
        expect(toasts).toEqual([]);
    });
});

test.describe('fetchBundle (unit)', () => {

    function load(answer) {
        const asked = [];
        const paced = [];
        const { MI, sandbox } = loadMI({
            document: { cookie: 'Steam_Language=russian', getElementById: () => ({ dataset: { config: '{"COUNTRY":"RU"}' } }) },
        });
        sandbox.window.ILAP.IgnoreGate = { paceRead: async () => { paced.push(1); } };
        sandbox.window.ILAP.SteamNet = { fetchWithTimeout: async (url) => { asked.push(url); return answer; } };
        return { fetchBundle: MI.fetchBundle, asked, paced };
    }

    test('games and DLC with their names, the bundle name, one paced read', async () => {
        const body = { response: { store_items: [{ name: 'Middle-earth', included_items: { included_apps: [
            { appid: 356190, type: 0, name: 'Shadow of War' }, { appid: 716270, type: 4, name: 'Expansion Pass' }] } }] } };
        const { fetchBundle, asked, paced } = load({ ok: true, json: async () => body });
        const got = await fetchBundle({ kind: 'sub', id: '648168' });
        expect(got).toEqual({ name: 'Middle-earth', apps: [
            { appid: '356190', name: 'Shadow of War' }, { appid: '716270', name: 'Expansion Pass' }] });
        expect(paced).toEqual([1]);
        const input = JSON.parse(decodeURIComponent(asked[0].split('input_json=')[1]));
        expect(input.ids).toEqual([{ packageid: 648168 }]);
        expect(input.context).toEqual({ language: 'russian', country_code: 'RU' });
        expect(input.data_request).toEqual({ include_included_items: true });
    });

    test('a bare appid list is taken too; a refused or empty answer is null', async () => {
        const bare = load({ ok: true, json: async () => ({ response: { store_items: [{ name: 'V', included_appids: [10, 20] }] } }) });
        expect(await bare.fetchBundle({ kind: 'bundle', id: '232' }))
            .toEqual({ name: 'V', apps: [{ appid: '10', name: '' }, { appid: '20', name: '' }] });
        expect(await load({ ok: false }).fetchBundle({ kind: 'bundle', id: '1' })).toBe(null);
        expect(await load({ ok: true, json: async () => ({ response: {} }) }).fetchBundle({ kind: 'bundle', id: '1' })).toBe(null);
    });
});
