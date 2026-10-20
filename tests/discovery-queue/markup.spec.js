// SPDX-License-Identifier: GPL-3.0-or-later
//
// Live guard for the Steam markup the Discovery Queue automator reads inside the
// modal. The canary does this job for the public surfaces, but the modal is
// behind a login, so this half lives in the local run schedule, like
// palette.spec.js.
//
// Each anchor here has a hash-free fallback in src/discovery-queue/logic.js, and
// every heuristic fails safe. That is why no other spec goes red when one of
// them moves: the fallback takes over, or the run quietly does less. These
// tests check the PRIMARY paths one by one, so a drift is heard while the
// fallback still covers for it. The anchors are read out of the product
// (tests/discovery-queue/_modal.js), never retyped here.
//
// The first test ignores nothing. The second ignores one real game on the test
// account, and globalSetup/globalTeardown remove it afterwards (tests/_cleanup.js).

const { test, expect } = require('../_fixtures.js');
const { SEL, NEXT_ARROW, IGNORE_ICON, CONFIRM_PRIMARY_MS, openQueueModal } = require('./_modal.js');
const { randomTag } = require('../_tags.js');
const { readUserdata, pollUserdata } = require('../_steam-live.js');

// A tag whose queue is spent shows the end-of-queue panel instead of a card.
const MAX_TAGS = 3;
// The card paints in stages after the modal opens (see waitForCard in _modal.js).
const PAINT_MS = 9000;

// What the automator's primary paths find in the modal right now, mirroring
// SlideScanner in src/discovery-queue/logic.js.
const PROBE = ({ S, IGNORE, NEXT }) => {
    const dialog = document.querySelector(S.modal);
    if (!dialog) return null;
    const paths = (root, d) => [...root.querySelectorAll('path')]
        .filter((p) => (p.getAttribute('d') || '').startsWith(d));
    const focusable = (p) => (p ? p.closest('div[class*="Focusable"]') : null);
    const carousel = dialog.querySelector(S.carousel);
    const slot = carousel && carousel.children.length > 2 ? carousel.children[2] : null;
    const link = slot && slot.querySelector('a[href*="/app/"]');
    const ignoreBtn = slot ? focusable(paths(slot, IGNORE)[0]) : null;
    const next = paths(dialog, NEXT);
    return {
        // Hash-free: the modal shows a game at all.
        anyGame: !!dialog.querySelector('a[href*="/app/"]'),
        carousel: !!carousel,
        children: carousel ? carousel.children.length : 0,
        appid: link ? ((link.getAttribute('href').match(/\/app\/(\d+)/) || [])[1] || null) : null,
        ignoreButton: !!ignoreBtn,
        ignoreHashed: ignoreBtn ? [...ignoreBtn.classList].filter((c) => c.startsWith('_')).length : null,
        nextButton: !!focusable(next[next.length - 1]),
    };
};
const ARGS = { S: SEL, IGNORE: IGNORE_ICON, NEXT: NEXT_ARROW };
const probe = (page) => page.evaluate(PROBE, ARGS).catch(() => null);
const allFound = (p) => p && p.appid && p.ignoreButton && p.nextButton;

// Open queues on fresh tags until one shows a game. The probe is then polled
// until every primary path resolves or the card has had PAINT_MS to paint, and
// the last reading is returned for the assertions to judge.
async function openOnCard(page) {
    const tags = [];
    for (let i = 0; i < MAX_TAGS; i++) {
        let tag = randomTag();
        while (tags.includes(tag)) tag = randomTag();
        tags.push(tag);
        await openQueueModal(page, `/tags/en/${encodeURIComponent(tag)}`);

        const deadline = Date.now() + PAINT_MS;
        let last = await probe(page);
        while (!allFound(last) && Date.now() < deadline) {
            await page.waitForTimeout(350);
            last = await probe(page);
        }
        // A full carousel with no game in the centre slot is the end-of-queue
        // panel, the same reading the automator makes. A missing or short
        // carousel may be the drift itself, so that reading goes to the
        // assertions.
        if (last && last.carousel && last.children > 2 && !last.appid) continue;
        if (last && last.anyGame) return { probe: last, tag };
    }
    throw new Error(`no game in the centre slot of ${tags.length} queues (${tags.join(', ')}). Usually spent ` +
        `queues, so re-run it. If it repeats, children[2] of ${SEL.carousel} is no longer the centred card.`);
}

test.describe('Discovery Queue — Steam markup (live)', () => {

    test('the primary paths still resolve on a live card', async ({ page }) => {
        test.setTimeout(180_000);
        const { probe: p, tag } = await openOnCard(page);
        const where = `on a ${tag} queue card`;

        expect(p.carousel,
            `${SEL.carousel} is gone from the modal ${where}. The automator falls back to finding the carousel ` +
            `from the Ignore icon. Put Steam's new class into HASHED.CAROUSEL in src/discovery-queue/logic.js.`)
            .toBe(true);
        expect(p.children,
            `${SEL.carousel} has ${p.children} children ${where}. The automator takes children[2] as the centred card.`)
            .toBeGreaterThan(2);
        expect(p.appid,
            `children[2] of ${SEL.carousel} holds no /app/ link ${where}. The centred card has moved, and ` +
            `getActiveSlide reads "no slide" and stops the run.`)
            .toBeTruthy();
        expect(p.ignoreButton,
            `no path starting "${IGNORE_ICON}" inside a Focusable ${where}. getIgnoreButton falls back to an ` +
            `English-only aria-label. Update SVG_PATHS.IGNORE_ICON in src/discovery-queue/logic.js.`)
            .toBe(true);
        // Exactly one, so that the second one Steam adds on an ignore means the
        // ignore. With two already there, every click would read as confirmed.
        expect(p.ignoreHashed,
            `the Ignore button of a card nobody ignored has ${p.ignoreHashed} hashed classes ${where}. ` +
            `_isButtonActive confirms an ignore at two or more, so this breaks the ignore confirmation.`)
            .toBe(1);
        expect(p.nextButton,
            `no path starting "${NEXT_ARROW}" inside a Focusable ${where}. getNextButton falls back to the ` +
            `rightmost icon button. Update SVG_PATHS.NEXT_ARROW in src/discovery-queue/logic.js.`)
            .toBe(true);
    });

    // The one signal here that only an ignore can show. It is what lets the
    // automator confirm a typical ignore with no request. Without it each
    // ignore costs up to three userdata reads, and processedCount still moves.
    test('an ignore still adds the second hashed class to the Ignore button', async ({ page }) => {
        test.setTimeout(180_000);
        const { probe: p, tag } = await openOnCard(page);
        expect(allFound(p), `the primary paths did not resolve on a ${tag} card; the test above names which`)
            .toBeTruthy();

        const before = await readUserdata(page);
        expect(before, 'userdata could not be read; the session may be gone (npm run test:auth)').toBeTruthy();
        expect(before.ids.includes(p.appid), `the queue served ${p.appid}, which is already ignored. Re-run it.`)
            .toBe(false);

        // Found the way getIgnoreButton finds it, then a real click on it.
        const btn = (await page.evaluateHandle(({ S, IGNORE }) => {
            const slot = document.querySelector(S.modal).querySelector(S.carousel).children[2];
            const path = [...slot.querySelectorAll('path')]
                .find((el) => (el.getAttribute('d') || '').startsWith(IGNORE));
            return path.closest('div[class*="Focusable"]');
        }, ARGS)).asElement();
        await btn.click();

        // The automator's own wait starts after its click, so this one does too.
        const readClasses = () => btn.evaluate((el) => el.className).catch(() => '(detached)');
        const hashedIn = (cls) => cls.split(/\s+/).filter((c) => c.startsWith('_')).length;
        const deadline = Date.now() + CONFIRM_PRIMARY_MS;
        let classes = await readClasses();
        while (hashedIn(classes) < 2 && Date.now() < deadline) {
            await page.waitForTimeout(50);
            classes = await readClasses();
        }
        const signalled = hashedIn(classes) >= 2;
        const landed = await pollUserdata(page, (ids) => ids.has(p.appid), 20000);

        expect(landed && landed.ids.includes(p.appid),
            `a click on the Ignore button of ${p.appid} (${tag}) did not ignore it. The button the automator ` +
            `finds is no longer the one that ignores.`)
            .toBe(true);
        expect(signalled,
            `${p.appid} was ignored, but its Ignore button did not reach two hashed classes within ` +
            `${CONFIRM_PRIMARY_MS} ms (classes: "${classes}"). _isButtonActive no longer sees the ignore, so every DQ ignore falls back ` +
            `to userdata reads. Find Steam's new ignored state and update _isButtonActive.`)
            .toBe(true);
    });
});
