const { test, expect } = require('../_fixtures.js');
const { setExtensionStorage, getExtensionStorage } = require('../_extension.js');
const { interceptIgnoreApi } = require('../curator/_helpers.js');
const { tagUrl } = require('../_tags.js'); // random tag page per navigation

const SEL = {
    // The "Explore Your Discovery Queue" widget on a tag page; clicking it opens
    // the modal. role="button" is the focusable opener inside the widget.
    queueSection: '.SaleSectionCtn.discoveryqueue',
    queueWidget: '.SaleSectionCtn.discoveryqueue div[role="button"]',
    modal: '.FullModalOverlay div[role="dialog"]',
    panel: '#ilap-queue-controls',
    button: '#queue-auto-ignore-btn',
    checkbox: '#ilap-queue-controls .ilap-checkbox',
    closeBtn: '.FullModalOverlay div[aria-label="Close"]',
};

// The Discovery Queue modal (.FullModalOverlay div[role="dialog"]) — the one the
// DQ module injects #ilap-queue-controls into — is NOT the /explore/next/ page
// (that's the Explore Queue / "Queue Helper" toast surface). The modal opens
// from the "Explore Your Discovery Queue" widget that Steam renders below the
// fold on tag pages. Navigate to a tag, scroll the widget in, click it. The
// section is lazy-rendered, so scroll until it attaches before waiting.
// The tag is random per call — see tests/_tags.js for why a fixed one starves
// the queue.
async function openQueueModal(page) {
    await page.goto(tagUrl(), { waitUntil: 'domcontentloaded' });

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

test.describe('Discovery Queue UI', () => {

    test('Panel injects inside the queue modal with button + checkbox', async ({ page }) => {
        const modal = await openQueueModal(page);

        const panel = modal.locator(SEL.panel);
        await expect(panel).toBeVisible({ timeout: 10000 });

        await expect(panel.locator(SEL.button)).toBeVisible();
        await expect(panel.locator('.ilap-checkbox')).toBeAttached();
        await expect(panel.locator('.ilap-checkbox-label')).toContainText(/keep high score/i);
    });

    test('Button initial state: idle (no running class, "Start Auto Ignore")', async ({ page }) => {
        await openQueueModal(page);

        const btn = page.locator(SEL.button);
        await expect(btn).toBeVisible({ timeout: 10000 });
        await expect(btn).not.toHaveClass(/running/);
        await expect(btn).toContainText(/start auto ignore/i);
    });

    test('Keep High Score checkbox is interactive and toggles state', async ({ page }) => {
        await openQueueModal(page);

        const checkbox = page.locator(SEL.checkbox);
        await expect(checkbox).toBeAttached({ timeout: 10000 });
        await expect(checkbox).not.toBeChecked();

        // Click via label so we cover both label text and the input itself
        await page.locator('#ilap-queue-controls .ilap-checkbox-label').click();
        await expect(checkbox).toBeChecked();

        await page.locator('#ilap-queue-controls .ilap-checkbox-label').click();
        await expect(checkbox).not.toBeChecked();
    });

    // DQ automator ignores by a LIVE click on Steam's in-page Ignore button —
    // our code sends no POST, but Steam's page JS fires one in response to the
    // click, so DQ is an ignore-POST source too and paces through the rate gate
    // like the drainer and EQ. This DOES ignore real games on the test account —
    // accepted: globalSetup/globalTeardown remove strictly the diff afterwards
    // (see tests/_cleanup.js). The target is deliberately PAST one served queue:
    // a queue holds exactly 12 games (probed live — twelve slides, then a
    // "Done / Continue" interstitial), so a run of 14 cannot finish unless the
    // automator clicks "Continue" and keeps going on the fresh queue. That makes
    // the infinite-feed path guaranteed coverage rather than luck-of-the-pool,
    // and it is the end-to-end guard on the stale-card regression that used to
    // wedge the loop here (unit-covered in automator.unit.spec.js).
    test('Start runs the loop, ignores 14 games across a queue boundary (Continue), Stop → idle', async ({ page, context }) => {
        test.setTimeout(190_000);   // must clear the 150s counter poll below plus the modal open and the Stop assertions
        await openQueueModal(page);

        const btn = page.locator(SEL.button);
        await expect(btn).toBeVisible({ timeout: 10000 });
        await expect(btn).not.toHaveClass(/running/);

        // The active slide (and its Ignore button) renders a beat after the modal;
        // wait for the current game's app link so the very first iteration has a
        // slide to act on.
        await page.locator(`${SEL.modal} a[href*="/app/"]`).first()
            .waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});

        await btn.click();

        // Loop engaged.
        await expect(btn).toHaveClass(/running/, { timeout: 5000 });
        await expect(btn).toContainText(/stop/i);

        // The running button label carries the processed (ignored) counter. Wait
        // until it reaches the target.
        const TARGET = 14;   // > the 12 a single served queue holds — forces one Continue
        await expect.poll(async () => {
            const txt = (await btn.textContent()) || '';
            const m = txt.match(/(\d+)/);
            return m ? Number(m[1]) : 0;
        // Generous on purpose. A run on an untouched tag pool spends ~1.5 s per
        // ignore (loop pause + a paced gate slot + the button-signal confirm +
        // the slide advance) and lands all twelve in well under half a minute;
        // the budget covers the slow shape instead — a pool the automator has
        // already been through, where most iterations are Continue interstitials
        // and confirms fall back to the userdata poll.
        }, { timeout: 150_000, intervals: [1500] }).toBeGreaterThanOrEqual(TARGET);

        // Stop → back to idle.
        await btn.click();
        await expect(btn).not.toHaveClass(/running/, { timeout: 10000 });
        await expect(btn).toContainText(/start auto ignore/i);

        // Stopping frees this tab's registry slot (the UI observer's isRunning=false
        // transition → _releaseSlot), so no live owner should remain in ilap_dq_active.
        await expect.poll(async () => {
            const map = (await getExtensionStorage(context, 'ilap_dq_active')).ilap_dq_active || {};
            const now = Date.now();
            return Object.values(map).filter(exp => exp > now).length;
        }, { timeout: 6000 }).toBe(0);
    });

    // Cross-tab cap: two OTHER live registry slots fill the cap (2), so this tab's
    // Start is refused — it flashes the "already running" message and never starts
    // the loop (no ignore fires). Simulating the other tabs via a seeded
    // ilap_dq_active keeps it a pure UI-path check with zero real ignores.
    test('Start is refused when the concurrent-DQ cap is already filled by other tabs', async ({ page, context }) => {
        const calls = await interceptIgnoreApi(context); // guarantee no real ignore even if it slipped
        await openQueueModal(page);

        const btn = page.locator(SEL.button);
        await expect(btn).toBeVisible({ timeout: 10000 });

        const future = Date.now() + 60000;
        await setExtensionStorage(context, { ilap_dq_active: { other1: future, other2: future } });

        await btn.click();

        // Refused look, never entered the running state, and nothing was ignored.
        await expect(btn).toHaveClass(/refused/, { timeout: 5000 });
        await expect(btn).not.toHaveClass(/running/);
        await expect(btn).toContainText(/\d/); // localized "Max {n} …" carries the numeral
        expect(calls).toHaveLength(0);

        // The message auto-reverts to the idle Start button.
        await expect(btn).not.toHaveClass(/refused/, { timeout: 6000 });
        await expect(btn).toContainText(/start auto ignore/i);
    });

    test('Panel unmounts when the queue modal closes', async ({ page }) => {
        await openQueueModal(page);

        const panel = page.locator(SEL.panel);
        await expect(panel).toBeVisible({ timeout: 10000 });

        // Prefer Steam's own close button; fall back to Escape.
        const close = page.locator(SEL.closeBtn).first();
        if (await close.isVisible().catch(() => false)) {
            await close.click({ force: true });
        } else {
            await page.keyboard.press('Escape');
        }

        await expect(panel).toBeHidden({ timeout: 10000 });
    });
});
