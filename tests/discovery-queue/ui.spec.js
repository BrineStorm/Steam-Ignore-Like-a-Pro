const { test, expect } = require('../_fixtures.js');
const { setExtensionStorage, getExtensionStorage } = require('../_extension.js');
const { interceptIgnoreApi } = require('../curator/_helpers.js');

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
async function openQueueModal(page) {
    await page.goto('/tags/en/Collectathon', { waitUntil: 'domcontentloaded' });

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

    // DQ automator clicks Steam's in-page Ignore button (no API calls / no rate
    // limit). This DOES ignore real games on the test account — accepted: a
    // future cleanup test will undo ignores by date via the popup's ignored-games
    // link (see CLAUDE.local.md). Driving ~12 real ignores also forces the queue
    // to run out at least once, exercising the "Continue" interstitial that spins
    // up a fresh queue (the infinite-feed path).
    test('Start runs the loop, ignores ~12 games across a queue boundary (Continue), Stop → idle', async ({ page, context }) => {
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
        // until it reaches the target — a single served queue is short, so this
        // can only happen if the automator clicked "Continue" to start a new one.
        const TARGET = 12;
        await expect.poll(async () => {
            const txt = (await btn.textContent()) || '';
            const m = txt.match(/(\d+)/);
            return m ? Number(m[1]) : 0;
        // 150s, not 100s: one confirmed ignore costs ~9s of real time (loop pause
        // + a paced gate slot + the confirm poll + the slide advance), so twelve
        // of them plus a Continue interstitial land right on the old budget — a
        // clean run reached 11, and a run following the rest of the suite only 6.
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
