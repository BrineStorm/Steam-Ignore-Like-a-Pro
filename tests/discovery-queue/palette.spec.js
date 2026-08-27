// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Discovery Queue arm of the palette guard. The canary owns the same check
// for the app page, but it runs anonymously on a bare runner and the DQ modal is
// behind a login, so this half can only live in the local run schedule.
//
// It exists because the drift it watches for is invisible in every other layer.
// The unit specs stub the DOM and compare our constants against themselves. The
// live DQ spec drives a real run with Keep High Score OFF. So when Steam
// repainted Mixed in the modal, nothing went red: classification does not throw
// on an unrecognised colour, it fails SAFE and spares the game — a feature that
// silently stops working reads exactly like one with nothing to do.
//
// Nothing here is ignored: the walk only clicks the chevron. It does SPEND the
// served queue, same as any run does.

const { test, expect } = require('../_fixtures.js');
const { openQueueModal, waitForCard, nextSlide } = require('./_modal.js');
const { PALETTE, bandOf } = require('../_palette.js');
const { randomTag } = require('../_tags.js');

// A queue can serve twelve slides without a single Mixed one (measured: two of
// six tags came back entirely blue), and a run that only ever saw blue would
// have missed the drift that started all this. So walk fresh tags until a
// non-positive rating turns up, and only then stop.
const MAX_TAGS = 4;
const MAX_SLIDES = 14;

test.describe('Discovery Queue — review palette (live)', () => {

    test('the modal still paints the bands the classifier looks for', async ({ page }) => {
        test.setTimeout(300_000);

        const seen = [];
        const tags = [];
        for (let t = 0; t < MAX_TAGS && !seen.some((s) => s.key !== 'BLUE'); t++) {
            let tag = randomTag();
            while (tags.includes(tag)) tag = randomTag();
            tags.push(tag);
            await openQueueModal(page, `/tags/en/${encodeURIComponent(tag)}`);

            for (let i = 0; i < MAX_SLIDES; i++) {
                const card = await waitForCard(page);
                if (card.kind !== 'card') break;          // the end-of-queue interstitial
                const key = card.band ? bandOf(card.band) : null;
                // A colour that never left the link's inherited white inside the
                // settle budget is a paint that has not arrived, not a drift —
                // the classifier would read it late too, but a guard that called
                // it a failure would be red for the wrong reason.
                if (key && card.color && card.color !== 'rgba(255, 255, 255, 0.9)') {
                    seen.push({ key, ...card, tag });
                    // Assert per card rather than at the end: the failure message
                    // should name the game and the tag it was read on.
                    expect(card.color,
                        `${tag} / "${card.name}" reads "${card.band}" but Steam paints it ${card.color}, ` +
                        `not ${PALETTE.current(key)}. The classifier matches on colour alone and treats an ` +
                        `unrecognised one as well-reviewed, so Keep High Score would spare this game ` +
                        `silently. Fix src/steam-palette.js: put the new shade first, keep the old one behind it.`)
                        .toBe(PALETTE.current(key));
                }
                if (!(await nextSlide(page))) break;
                await page.waitForTimeout(800);
            }
        }

        // Positives alone do not prove much: the shade that drifted was Mixed,
        // and Positive sat still through the whole thing.
        expect(seen.length, `no rated card in ${tags.length} queues (${tags.join(', ')})`).toBeGreaterThan(0);
        expect(seen.some((s) => s.key !== 'BLUE'),
            `${tags.length} queues (${tags.join(', ')}) served only well-reviewed games, so the shades that ` +
            `actually trigger an ignore went unchecked. Not a product failure — re-run it.`)
            .toBe(true);
    });
});
