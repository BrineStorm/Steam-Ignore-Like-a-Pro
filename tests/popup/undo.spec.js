const { test, expect } = require('../_fixtures.js');
const {
    getExtensionId,
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');

// Undo applet (ui/popup_undo.js) through the popup window — no Steam login or
// live page. Staging works from either surface since the SW drain landed (the
// popup-mode lock is gone), so the droplist's full stage flow is drivable right
// here; the snapshot semantics stay covered by the UndoService/IgnoreLog units.

function undoJob(over = {}) {
    return Object.assign({
        id: 'job_undo_' + Date.now(),
        type: 'undo',
        curatorId: 'undo',
        curatorName: '',
        appids: ['10', '20', '30'],
        total: 3,
        status: 'pending',
        snapshotTs: Date.now(),
        addedAt: Date.now(),
    }, over);
}

const logEntry = (appid) => ({ appid: String(appid), ts: Date.now(), source: 'mi' });

async function openPopup(page, context) {
    const extId = await getExtensionId(context);
    await page.goto(popupUrl(extId));
    await page.locator('#popup-root').waitFor({ timeout: 5000 });
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
    await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Popup — undo applet', () => {

    test('The undo button is enabled in popup surface mode and stages an undo job', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ignore_log: [logEntry(1), logEntry(2)] });
        await openPopup(page, context);

        const btn = page.locator('#undo-btn');
        await expect(btn).toBeVisible();
        // No popup-mode lock anymore: with undoable entries the droplist opens
        // and stages — the SW drains the job with no Steam tab needed.
        await expect(btn).toBeEnabled();
        await btn.click();
        await expect(page.locator('#undo-menu')).toHaveClass(/open/);

        await page.locator('.undo-chip[data-n="10"]').click();
        await page.locator('#undo-go-count').click();

        await expect.poll(async () => {
            const res = await getExtensionStorage(context, 'ilap_curator_queue');
            return (res.ilap_curator_queue || []).length;
        }).toBe(1);
        const res = await getExtensionStorage(context, 'ilap_curator_queue');
        const job = res.ilap_curator_queue[0];
        expect(job.type).toBe('undo');
        expect(job.appids.sort()).toEqual(['1', '2']);   // both log entries, clamped to the log
    });

    test('The undo button is disabled (empty tooltip contract) when there is nothing to undo', async ({ page, context }) => {
        await openPopup(page, context);
        const btn = page.locator('#undo-btn');
        await expect(btn).toBeDisabled();
        // Custom tooltip (not the browser title): text lives in #undo-tip, and
        // aria-label mirrors it for accessibility.
        await expect(page.locator('#undo-tip')).toHaveText(/nothing to undo/i);
        await expect(btn).toHaveAttribute('aria-label', /nothing to undo/i);
        await expect(page.locator('#undo-menu')).not.toHaveClass(/open/);
    });

    test('A staged undo job renders localized, without a filter line, and can be removed', async ({ page, context }) => {
        const job = undoJob();
        await setExtensionStorage(context, { ilap_curator_queue: [job] });
        await openPopup(page, context);

        await expect(page.locator('#queue-accordion')).toBeVisible();
        await page.locator('#queue-accordion summary').click();

        const row = page.locator('.queue-job').first();
        await expect(row.locator('.queue-job-name')).toHaveText('Undo ignores');
        await expect(row.locator('.queue-job-sub')).toHaveCount(0);   // no curator filter line
        await expect(row.locator('.queue-job-count')).toContainText('0 / 3');

        await row.locator('[data-act="remove"]').click();
        await expect(page.locator('#queue-accordion')).toBeHidden();
        const res = await getExtensionStorage(context, 'ilap_curator_queue');
        expect(res.ilap_curator_queue).toEqual([]);
    });

    test('When the last job finishes while the queue is open, the applet collapses smoothly, then hides', async ({ page, context }) => {
        // Open with one job, then drain to empty (what the drainer does on
        // completion: removeJob → queue becomes []). The applet must animate the
        // solo collapse instead of snapping shut, so it briefly carries the
        // .solo-collapse class before it finally hides.
        await setExtensionStorage(context, { ilap_curator_queue: [undoJob()] });
        await openPopup(page, context);
        await page.locator('#queue-accordion summary').click();
        await expect(page.locator('#queue-accordion')).toHaveAttribute('open', '');

        // Record whether the smooth-collapse class is ever applied — the ~500ms
        // animation window is too short to catch by polling from the test side.
        await page.evaluate(() => {
            window.__soloSeen = false;
            const el = document.getElementById('queue-accordion');
            new MutationObserver(() => {
                if (el.classList.contains('solo-collapse')) window.__soloSeen = true;
            }).observe(el, { attributes: true, attributeFilter: ['class'] });
        });

        await setExtensionStorage(context, { ilap_curator_queue: [] });

        // Settles hidden once the animation ends, and it got there via the smooth
        // solo-collapse rather than a hard snap.
        await expect(page.locator('#queue-accordion')).toBeHidden();
        expect(await page.evaluate(() => window.__soloSeen)).toBe(true);
        await expect(page.locator('#queue-accordion')).not.toHaveClass(/solo-collapse/);
    });

    test('An undo job pauses and resumes through the applet like any job', async ({ page, context }) => {
        const job = undoJob();
        await setExtensionStorage(context, { ilap_curator_queue: [job] });
        await openPopup(page, context);
        await page.locator('#queue-accordion summary').click();

        const row = page.locator('.queue-job').first();
        await row.locator('[data-act="pause"]').click();
        await expect.poll(async () => {
            const res = await getExtensionStorage(context, 'ilap_curator_queue');
            return res.ilap_curator_queue[0].status;
        }).toBe('paused');

        await row.locator('[data-act="pause"]').click();
        await expect.poll(async () => {
            const res = await getExtensionStorage(context, 'ilap_curator_queue');
            return res.ilap_curator_queue[0].status;
        }).toBe('pending');
    });
});
