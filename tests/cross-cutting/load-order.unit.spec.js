// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// Static guards over how the extension's scripts are wired. None of these
// fail a unit harness, because a harness loads files one by one into its own
// sandbox — they fail in the real extension, on a Steam page, where a module
// read before its provider loaded is `undefined` and throws at boot:
//   - a module now reads its collaborators without an existence check
//     (`const t = window.ILAP.t`), so the provider has to come first in
//     every list that loads both;
//   - the two manifests must list the same content scripts in the same order,
//     but for the declared per-platform exceptions (FIREFOX_OMITS);
//   - a bare window 'load' listener never fires when the script is injected
//     after load (Firefox document_idle), which is the boot bug that once
//     left MI and DQ dead on Firefox;
//   - the popup never reads storage with get(null): the ignore log and the
//     curator cache are most of it;
//   - a UI's styles have ONE owner: the manifest stylesheet and a module that
//     injects its own <style> must not both declare the same selector.

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// Facade member → the file that defines it. A member left out of this table is
// simply not guarded, so the list has to keep up with the facade: everything a
// module captures at MODULE SCOPE belongs here, including the `ILAP_*` globals
// and the per-feature namespaces. What does NOT belong is a namespace object
// several files open with `= ... || {}` (ILAP.Curator, ILAP.Discovery,
// ILAP.Explore, ILAP.ManualIgnore): those have no single provider, so the guard
// tracks their MEMBERS instead, which is what a reader actually dereferences.
const PROVIDERS = [
    [/ILAP\.Sanitizer\b/, 'src/escape.js'],
    [/ILAP\.newOwnerId\b/, 'src/escape.js'],
    [/ILAP\.serialChain\b/, 'src/escape.js'],
    [/ILAP\.Settings\b/, 'src/settings-schema.js'],
    [/ILAP\.SteamPalette\b/, 'src/steam-palette.js'],
    [/ILAP\.StatsLogic\b/, 'src/stats.js'],
    [/ILAP\.SteamNet\b/, 'src/steam-net.js'],
    [/ILAP\.MasterSwitch\b/, 'src/master-switch.js'],
    [/ILAP\.IgnoreGate\b/, 'src/gate.js'],
    [/ILAP\.IgnoreLog\b/, 'src/ignore-log.js'],
    [/ILAP\.Surface\b/, 'src/surface.js'],
    [/ILAP\.(t|i18n)\b/, 'src/i18n.js'],
    [/ILAP\.showToast\b/, 'src/toast.js'],
    [/ILAP\.SaleReward\b/, 'src/sale-reward.js'],
    [/ILAP\.AutomationNotice\b/, 'src/automation-notice.js'],
    [/Curator\.Lease\b/, 'src/curator/lease.js'],
    [/Curator\.Store\b/, 'src/curator/store.js'],
    [/Curator\.Enumerator\b/, 'src/curator/enumerate.js'],
    [/Curator\.EnqueueService\b/, 'src/curator/enqueue-service.js'],
    [/Curator\.CuratorQueueDrainer\b/, 'src/curator/drainer.js'],
    // The content script's own Steam layer. sw-handoff.js calls getSessionID at
    // TOP LEVEL, so a reorder here is a boot throw, not a late undefined.
    [/ILAP\.(getSessionID|apiIgnoreGame|apiUnignoreGame|SteamAuth|saveStats|bumpIgnoredCount|dropIgnoredCount|fetchIgnoredApps|classifyRefusal|SessionStateService|ResourceService)\b/,
        'src/utils.js'],
    [/ILAP\.(getGameName|resolveGameName)\b/, 'src/game-name.js'],
    [/ILAP\.UndoService\b/, 'src/undo-service.js'],
    [/ILAP_Filters\b/, 'src/curator/filters.js'],
    [/Explore\.(Context|NavigationGuard|QueueSettings|Analyzer|DecisionEngine|COLORS|KEYS)\b/,
        'src/explore-queue/utils.js'],
    [/Explore\.AutomatorClass\b/, 'src/explore-queue/automator.js'],
    [/Explore\.UI\b/, 'src/explore-queue/ui.js'],
    [/Discovery\.Automator\b/, 'src/discovery-queue/logic.js'],
    [/Discovery\.Registry\b/, 'src/discovery-queue/registry.js'],
    [/Discovery\.UI\b/, 'src/discovery-queue/ui.js'],
    [/ILAP_Icons\b/, 'ui/icons.js'],
    [/ILAP_PopupMarkup\b/, 'ui/popup_markup.js'],
    [/ILAP_Queue\b/, 'ui/popup_queue.js'],
    [/ILAP_Settings\b/, 'ui/popup_settings.js'],
    [/ILAP_Undo\b/, 'ui/popup_undo.js'],
    [/ILAP_Popup\b/, 'ui/popup_main.js'],
];

// Reads the guard must NOT count. The guard exists for a MODULE-SCOPE capture
// (`const t = window.ILAP.t`), which is `undefined` forever if its provider
// loads late. These two dereference lazily, inside a function, behind an
// explicit absence branch — so a list without the provider is their contract,
// not a bug. Both are files the service worker shares with the content script,
// and the worker has no utils.js.
const LAZY_READS = [
    // defaultHasSession() answers `false` when SteamAuth is absent, and the
    // worker replaces the resolver outright via IgnoreGate.configure().
    ['src/gate.js', 'src/utils.js'],
    // The tab-host block at the tail is wrapped in `if (window.ILAP.apiIgnoreGame)`;
    // in the worker it never runs, because background.js builds its own drainer.
    ['src/curator/drainer.js', 'src/utils.js'],
];
const isLazy = (file, provider) => LAZY_READS.some(([f, p]) => f === file && p === provider);

// Every provider that a file in `list` reads must be in `list`, and earlier.
function misorderedReads(list) {
    const problems = [];
    list.forEach((file, i) => {
        const src = read(file);
        for (const [re, provider] of PROVIDERS) {
            if (provider === file || isLazy(file, provider) || !re.test(src)) continue;
            const at = list.indexOf(provider);
            if (at === -1) problems.push(`${file} reads ${re.source} but ${provider} is not loaded`);
            else if (at > i) problems.push(`${file} reads ${re.source} but ${provider} loads after it`);
        }
    });
    return problems;
}

const manifestScripts = (browser) =>
    JSON.parse(read('platform', browser, 'manifest.json')).content_scripts
        .flatMap(cs => cs.js || []);

// The only content scripts the two manifests may differ by, each with a reason.
// Listed explicitly so a file that drifts out of one list by accident still
// fails the guard below.
const FIREFOX_OMITS = [
    // Feeds the Chromium service worker's drain (it caches the sessionid the
    // worker cannot read). Firefox drains from the content script: nothing there
    // would read the value, and nothing would clear it. See src/sw-handoff.js.
    'src/sw-handoff.js',
];

const popupScripts = () => [...read('ui', 'popup.html').matchAll(/<script src="([^"]+)"/g)]
    .map(m => path.posix.normalize(path.posix.join('ui', m[1])));

const swScripts = () => {
    const call = read('src', 'background.js').match(/importScripts\(([\s\S]*?)\);/)[1];
    return [...call.matchAll(/'([^']+)'/g)].map(m => 'src/' + m[1]);
};

const sourceFiles = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap(e => (e.isDirectory() ? sourceFiles(path.posix.join(dir, e.name))
        : e.name.endsWith('.js') ? [path.posix.join(dir, e.name)] : []));

test.describe('Script wiring (unit)', () => {

    test('both manifests load the same content scripts in the same order', () => {
        expect(manifestScripts('firefox'))
            .toEqual(manifestScripts('chromium').filter(f => !FIREFOX_OMITS.includes(f)));
    });

    test('every Chromium-only content script is one of the declared exceptions', () => {
        const chromium = manifestScripts('chromium');
        const firefox = manifestScripts('firefox');
        expect(chromium.filter(f => !firefox.includes(f))).toEqual(FIREFOX_OMITS);
    });

    test('every listed script exists', () => {
        for (const f of [...manifestScripts('chromium'), ...popupScripts(), ...swScripts()]) {
            expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
        }
    });

    test('content scripts: every facade member is defined before a script reads it', () => {
        expect(misorderedReads(manifestScripts('chromium'))).toEqual([]);
        // Its own pass, now that the list is not the same one: dropping a file
        // for one platform can leave a reader there without its provider.
        expect(misorderedReads(manifestScripts('firefox'))).toEqual([]);
    });

    test('popup.html: every facade member is defined before a script reads it', () => {
        expect(misorderedReads(popupScripts())).toEqual([]);
    });

    test('service worker importScripts: every facade member is defined before a script reads it', () => {
        expect(misorderedReads(swScripts())).toEqual([]);
    });

    test('the guard itself catches a misordered or a missing provider', () => {
        // The real popup list with i18n.js moved to the end…
        const list = popupScripts().filter(f => f !== 'src/i18n.js');
        const i18nReads = (problems) => problems.filter(p => p.startsWith('ui/popup_undo.js') && p.includes('src/i18n.js'));
        expect(i18nReads(misorderedReads(list.concat('src/i18n.js'))))
            .toEqual([expect.stringMatching(/src\/i18n\.js loads after it$/)]);
        // …or left out.
        expect(i18nReads(misorderedReads(list)))
            .toEqual([expect.stringMatching(/src\/i18n\.js is not loaded$/)]);
    });

    test('no content-script boot waits on a bare window load event', () => {
        const bare = [];
        for (const file of manifestScripts('chromium')) {
            const lines = read(file).split('\n');
            lines.forEach((line, i) => {
                if (!/addEventListener\(\s*['"]load['"]/.test(line)) return;
                // A load listener is fine only as the fallback of a readyState check.
                const context = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
                if (!/document\.readyState/.test(context)) bare.push(`${file}:${i + 1}`);
            });
        }
        expect(bare).toEqual([]);
    });

    test('no selector is declared by both the manifest stylesheet and an injected <style>', () => {
        // The Discovery Queue panel was styled from BOTH styles/styles.css and
        // src/discovery-queue/ui.js, with different values for the same
        // properties — which of them won came down to injection order, and
        // neither half could be read on its own. Whoever injects a rule owns it.
        // Comments are stripped first: a note naming the selector and saying who
        // owns it is exactly what should be left behind when a rule moves out.
        const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');
        const declared = (text) =>
            new Set([...strip(text).matchAll(/(?:^|\n)\s*(\.[\w-]+)[^{;\n]*\{/g)].map(m => m[1]));

        const sheetText = read('styles', 'styles.css');
        const sheet = declared(sheetText);
        const clashes = [];
        for (const file of sourceFiles('src')) {
            for (const sel of declared(read(file))) {
                if (sheet.has(sel)) clashes.push(`${sel} (styles.css + ${file})`);
            }
        }
        expect(clashes).toEqual([]);

        // The panel's button is selected as `#${IDS.BUTTON}` in the injected
        // sheet, so the interpolation hides it from the scan above: name it.
        expect(strip(sheetText)).not.toContain('queue-auto-ignore-btn');
    });

    test('nothing reads the whole of storage with get(null)', () => {
        const hits = [...sourceFiles('src'), ...sourceFiles('ui')]
            .filter(f => /\.get\(\s*null\b/.test(read(f)));
        expect(hits).toEqual([]);
    });
});
