// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // What the marks on a capsule share, whoever owns them (the IGNORED badge,
    // ui.js; the AI flag and its blur, ai-marks.js): going off the page, the size
    // of the capsule, a place to stand in it, and the blurred cover.

    window.ILAP = window.ILAP || {};
    window.ILAP.ManualIgnore = window.ILAP.ManualIgnore || {};

    // A mark taken off the page fades out first, or goes at once with reduced
    // motion. It is already off for the code, which looks marks up by their
    // data-ilap-* attributes, and for the pointer.
    const UNMARK_MS = 200;

    const still = (el) => !el.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function fadeOut(el) {
        if (still(el)) { el.remove(); return; }
        el.style.pointerEvents = 'none';
        el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }],
            { duration: UNMARK_MS, easing: 'ease', fill: 'forwards' })
            .finished.then(() => el.remove(), () => el.remove());
    }

    // A cover whose blur class just came off: it sharpens as its mark fades.
    function sharpen(el) {
        if (!still(el)) el.animate([{ filter: 'blur(5px)' }, { filter: 'blur(0px)' }], { duration: UNMARK_MS, easing: 'ease' });
    }

    // The IGNORED badge and the crossed AI mark grow with their capsule
    // (styles.css --ilap-k): this gives `mark` the side of a square as big as
    // `capsule`, in px, read once as the mark goes on. One not laid out yet
    // gives none, and the mark keeps its base size.
    function sizeToCapsule(mark, capsule) {
        const side = Math.round(Math.sqrt(capsule.offsetWidth * capsule.offsetHeight));
        if (side) mark.style.setProperty('--ilap-side', String(side));
    }

    function ensurePositioning(element) {
        const style = getComputedStyle(element);
        if (style.position === 'static') {
            element.dataset.ilapAnchor = '';
        }
        if (style.display === 'inline') {
            element.style.display = 'inline-block';
        }
    }

    // True when the badge target paints its own cover as a background-image —
    // the case filter:blur can't serve (it shares the box with the badge). A
    // size gate keeps an incidental small background (e.g. a decorative badge)
    // from hijacking capsules whose real cover is an <img> we can blur directly.
    function hasOwnCoverBackground(host) {
        if (getComputedStyle(host).backgroundImage === 'none') return false;
        return host.clientWidth * host.clientHeight > 20000;
    }

    // A blur veil under the badge: backdrop-filter blurs whatever art is painted
    // behind it (background, video, screenshots) while the badge (z-index:50)
    // sits above it. Idempotent so a re-render / syncMasks doesn't stack veils.
    // The AI tab's veil and the badge's may meet on one capsule: the later
    // one blurs nothing (styles.css), and either goes on its own.
    function applyBackdrop(host, appid, ai) {
        if (host.querySelector(`:scope > .ilap-blur-backdrop[${ai ? 'data-ilap-ai-blur' : 'data-ilap-blur'}]`)) return;
        const veil = document.createElement('div');
        veil.className = 'ilap-blur-backdrop';
        veil.dataset[ai ? 'ilapAiBlur' : 'ilapBlur'] = appid;
        host.appendChild(veil);
    }

    // The real cover art inside the badge target. A plain querySelector picks
    // the FIRST media, which on some surfaces is Steam's transparent blank.gif
    // spacer (e.g. .tab_item's overlay anchor) rather than the visible capsule
    // (.tab_item_cap_img). Drop those spacers and our own badge's tooltip icon,
    // then keep every element rendered at (near) the largest media's size — the
    // cover plus any full-bleed microtrailer overlay — while excluding small
    // decorative media (platform/discount icons) so blur stays on the art.
    function pickArts(container) {
        const media = Array.from(container.querySelectorAll('img, video')).filter(el => {
            if ((el.getAttribute('src') || '').includes('blank.gif')) return false;
            if (el.closest('.ilap-ignored-overlay')) return false;
            return true;
        });
        if (!media.length) return [];

        const areas = media.map(el => el.clientWidth * el.clientHeight);
        const bestArea = Math.max(...areas);
        // No layout yet (e.g. pre-render): fall back to the prior single-pick.
        if (bestArea <= 0) return [media[0]];
        // Keep the cover and any full-bleed microtrailer overlay (>= 50% of the
        // largest media); drop small decorative icons well under that.
        return media.filter((_, i) => areas[i] >= bestArea * 0.5);
    }

    // Blur the cover art itself: the filter rides its exact box, so an image
    // that overflows onto a sibling video is blurred where it actually renders
    // (an inset:0 overlay on the parent would miss that overhang). A capsule
    // can hold TWO views of the same art — the resting <img> and a hover
    // microtrailer <video> that overlays it 1:1 — and either can be on screen,
    // so both must be blurred; blurring only the largest left the resting
    // image sharp (the video, preload="none", won on area but is invisible).
    //
    // When the resting cover is a CSS background on the badge's OWN element
    // (the Featured & Recommended main capsule), filter:blur can't touch it
    // without smearing the badge — lay a backdrop veil under the badge instead.
    // `ai`: the AI tab's own blur (AiMarks.tag).
    function applyBlur(targetForBadge, appid, ai) {
        if (hasOwnCoverBackground(targetForBadge)) {
            applyBackdrop(targetForBadge, appid, ai);
            return;
        }
        for (const art of pickArts(targetForBadge)) {
            art.classList.add(ai ? 'ilap-ai-blur' : 'ilap-ignored-blur');
            art.dataset[ai ? 'ilapAiBlur' : 'ilapBlur'] = appid;
        }
    }

    window.ILAP.ManualIgnore.MarkDom = { fadeOut, sharpen, sizeToCapsule, ensurePositioning, applyBlur };
})();
