// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared rig for the three live Discovery Queue specs: open the modal, and read
// the card the automator is looking at. Lived inside ui.spec.js until the
// palette guard and the Keep High Score spec needed the same twenty lines.

const fs = require('fs');
const path = require('path');
const { tagUrl } = require('../_tags.js');

const SEL = {
    // The "Explore Your Discovery Queue" widget on a tag page; clicking it opens
    // the modal. role="button" is the focusable opener inside the widget.
    queueSection: '.SaleSectionCtn.discoveryqueue',
    queueWidget: '.SaleSectionCtn.discoveryqueue div[role="button"]',
    modal: '.FullModalOverlay div[role="dialog"]',
    panel: '#ilap-queue-controls',
    button: '#queue-auto-ignore-btn',
    checkbox: '#ilap-queue-controls .ilap-checkbox',
    label: '#ilap-queue-controls .ilap-checkbox-label',
    closeBtn: '.FullModalOverlay div[aria-label="Close"]',
    review: 'a[href*="#app_reviews_hash"]',
};

// The chevron the automator itself clicks, read out of the product so a spec
// cannot walk the queue by a path the product no longer recognises.
const LOGIC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'discovery-queue', 'logic.js'), 'utf8');
const NEXT_ARROW = LOGIC.match(/NEXT_ARROW:\s*"([^"]+)"/)[1];

// The Discovery Queue modal (.FullModalOverlay div[role="dialog"]) — the one the
// DQ module injects #ilap-queue-controls into — is NOT the /explore/next/ page
// (that's the Explore Queue / "Queue Helper" toast surface). The modal opens
// from the "Explore Your Discovery Queue" widget that Steam renders below the
// fold on tag pages. Navigate to a tag, scroll the widget in, click it. The
// section is lazy-rendered, so scroll until it attaches before waiting.
// The tag is random per call — see tests/_tags.js for why a fixed one starves
// the queue.
async function openQueueModal(page, url) {
    await page.goto(url || tagUrl(), { waitUntil: 'domcontentloaded' });

    const section = page.locator(SEL.queueSection).first();
    for (let i = 0; i < 10 && !(await section.count()); i++) {
        await page.mouse.wheel(0, 1200);
        await page.waitForTimeout(500);
    }
    await section.waitFor({ state: 'attached', timeout: 20000 });
    await section.scrollIntoViewIfNeeded();

    const widget = page.locator(SEL.queueWidget).first();
    await widget.waitFor({ state: 'visible', timeout: 20000 });
    await widget.click();

    const modal = page.locator(SEL.modal).first();
    await modal.waitFor({ state: 'visible', timeout: 15000 });
    return modal;
}

// English band names, longest first so "Mostly Positive" is not read as
// "Positive". The store is opened through /tags/en/, so the words are English
// even on a localized account.
const BANDS = ['Overwhelmingly Positive', 'Very Positive', 'Mostly Positive', 'Positive',
    'Mixed', 'Overwhelmingly Negative', 'Very Negative', 'Mostly Negative', 'Negative'];

// What the centre card says about itself: its rating IN WORDS, and the colour of
// the element carrying those words. The product classifies on the colour alone,
// so reading both is the whole point — a guard that read the colour and called
// it "Mixed" because the constant said so would be circular.
const READ_CARD = ({ S, BB }) => {
    const dialog = document.querySelector(S.modal);
    const hashed = dialog && dialog.querySelector('._3q6eNRFBrPSFSGEn8uRFZ3');
    const slot = hashed && hashed.children.length > 2 ? hashed.children[2] : null;
    if (!slot) return { kind: 'no-slot' };
    const link = slot.querySelector('a[href*="/app/"]');
    if (!link) return { kind: 'interstitial' };

    const appid = (link.getAttribute('href').match(/\/app\/(\d+)/) || [])[1] || null;
    let name = 'Unknown Game';
    for (const a of slot.querySelectorAll('a[href*="/app/"]')) {
        if (a.querySelector('img') || a.querySelector('video')) continue;
        const t = a.textContent.trim();
        if (t.length > 1 && t.length < 150) { name = t; break; }
    }

    const rev = slot.querySelector(S.review);
    if (!rev) return { kind: 'card', appid, name, band: null, color: null };

    const words = rev.textContent.trim().replace(/\s+/g, ' ');
    const band = BB.find((b) => new RegExp(`\\b${b}\\b`, 'i').test(words)) || null;
    // The node whose own text IS the band words carries the band colour; its
    // siblings hold the review count in a different shade.
    const node = band
        ? [rev, ...rev.querySelectorAll('*')].find((el) =>
            el.textContent.trim().replace(/\s+/g, ' ').toLowerCase() === band.toLowerCase())
        : null;
    return {
        kind: 'card', appid, name, band,
        color: node ? getComputedStyle(node).color : null,
        words: words.slice(0, 60),
    };
};

const readCard = (page) => page.evaluate(READ_CARD, { S: SEL, BB: BANDS });

// The card paints in stages: the slot arrives a beat after the modal, the words
// after that, and the band COLOUR later still — measured at 1500 ms a Mixed
// rating still reads as the link's inherited white. Reading too early is how a
// palette guard invents a failure, so wait for the colour to settle: the same
// non-inherited value twice in a row.
const INHERITED = 'rgba(255, 255, 255, 0.9)';
// A slot that has not painted yet is INDISTINGUISHABLE from the end-of-queue
// interstitial — both are a centre slot holding no app link — so a negative
// verdict is only believed after the slot has had time to fill. Read too eagerly
// and every walk stops on slide one.
const MIN_SETTLE_MS = 3000;
async function waitForCard(page, timeout = 9000) {
    const start = Date.now();
    let last = null;
    let previousColor = null;
    while (Date.now() - start < timeout) {
        const card = await readCard(page).catch(() => null);
        if (card) {
            last = card;
            // A rating counts once its colour has stopped moving: same
            // non-inherited value on two consecutive reads.
            if (card.kind === 'card' && card.band && card.color
                && card.color !== INHERITED && card.color === previousColor) return card;
            previousColor = card.kind === 'card' ? card.color : null;
            const negative = card.kind === 'interstitial' || (card.kind === 'card' && !card.band);
            if (negative && Date.now() - start > MIN_SETTLE_MS) return card;
        }
        await page.waitForTimeout(350);
    }
    return last || { kind: 'no-slot' };
}

// Advance one slide by the same chevron the automator uses. Walking is how a
// queue is spent, so a spec that walks costs the pool exactly like a run does.
const nextSlide = (page) => page.evaluate(({ S, D }) => {
    const dialog = document.querySelector(S.modal);
    if (!dialog) return false;
    const paths = [...dialog.querySelectorAll('path')].filter((p) => (p.getAttribute('d') || '').startsWith(D));
    const btn = paths.length ? paths[paths.length - 1].closest('div[class*="Focusable"]') : null;
    if (!btn) return false;
    btn.click();
    return true;
}, { S: SEL, D: NEXT_ARROW });

module.exports = { SEL, BANDS, openQueueModal, readCard, waitForCard, nextSlide };
