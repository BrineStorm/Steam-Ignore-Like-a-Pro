// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// The queue panel is injected into Steam's own modal, so the page can reach its
// controls and press them. Both matter:
//
//   Start  — begins an unattended ignore run. The master switch and the rate
//            gate are checked later, inside the loop, so on an enabled
//            extension with a live session a forged click gets a real run.
//   Keep High Score — decides WHICH games that run ignores. A forged `change`
//            unticks the filter without the user seeing anything move.
//
// Asserted from the source rather than through a fake DOM: what has to hold is
// that no control is EVER wired bare, and a DOM stub only proves it for the
// paths the stub happens to reach. The E2E suite cannot prove it at all —
// Playwright's clicks are trusted, which is the whole point of the guard.

const vm = require('vm');

const UI_SRC = path.join(__dirname, '..', '..', 'src', 'discovery-queue', 'ui.js');
const ESCAPE_SRC = path.join(__dirname, '..', '..', 'src', 'escape.js');

test.describe('Discovery Queue panel — contract with the page it lives in (unit)', () => {

    test('every control is wired behind the real-input guard', () => {
        const src = fs.readFileSync(UI_SRC, 'utf8');

        const handlers = [...src.matchAll(/addEventListener\(\s*'(click|change|input|keydown)'\s*,\s*([^\n]+)/g)]
            .map(m => ({ event: m[1], arg: m[2].trim() }));

        expect(handlers.length, 'no panel controls found — did the panel move?').toBeGreaterThan(1);
        expect(handlers.filter(h => !h.arg.startsWith('real(')).map(h => h.event),
            'a panel control was wired without the real-input guard').toEqual([]);
    });

    test('the guard it uses actually refuses a forged event', () => {
        // The assertion above only proves the controls go THROUGH `real`: here,
        // that `real` is the shared guard (src/escape.js), and that it refuses.
        const src = fs.readFileSync(UI_SRC, 'utf8');
        expect(src, 'the panel no longer takes the shared real-input guard')
            .toMatch(/const real = window\.ILAP\.realInput;/);

        const sandbox = { window: {}, Promise };
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(ESCAPE_SRC, 'utf8'), sandbox, { filename: 'escape.js' });
        const real = sandbox.window.ILAP.realInput;
        const seen = [];
        const wrapped = real((e) => seen.push(e));
        wrapped({ isTrusted: false });
        wrapped({});
        wrapped(undefined);
        expect(seen).toEqual([]);
        const trusted = { isTrusted: true };
        wrapped(trusted);
        expect(seen).toEqual([trusted]);
    });
});
