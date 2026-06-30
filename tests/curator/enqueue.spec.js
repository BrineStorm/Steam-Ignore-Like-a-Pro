const { test, expect } = require('../_fixtures.js');
const {
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
} = require('../_extension.js');
const { interceptIgnoreApi } = require('./_helpers.js');

// Phase-2 curator "Add to ignore queue" button (src/curator/main.js), driven on
// a LIVE curator page. Curator pages are public; picking a filter stages a job
// into chrome.storage.local and kicks off enumeration (read-only ajax). The
// drainer then runs — so we intercept the ignore endpoint (interceptIgnoreApi)
// and auto-accept the over-threshold confirm dialog: no real game is ever
// ignored. Covers injection + logo, the drop-out filter menu, staging a job,
// the already-added state, switch-in-place, and the 3-job cap restriction.

// Known public anti-AI curators. Steam redirects the
// bare /curator/<id>/ to the full slug URL; curatorId() matches either form.
const CURATOR_ID = '45186708';          // "No AI"
const CURATOR_PATH = `/curator/${CURATOR_ID}/`;
const BTN = '#ilap-curator-enqueue';

function makeJob(curatorId, filter = 'not_recommended') {
    return {
        id: 'job_' + curatorId + '_' + Date.now() + '_' + curatorId,
        curatorId: String(curatorId),
        curatorName: 'Curator ' + curatorId,
        curatorUrl: 'https://store.steampowered.com/curator/' + curatorId + '/',
        filter,
        appids: [],
        cursor: 0,
        total: 0,
        status: 'pending',
        addedAt: Date.now(),
    };
}

async function readQueue(context) {
    const res = await getExtensionStorage(context, 'ilap_curator_queue');
    return Array.isArray(res.ilap_curator_queue) ? res.ilap_curator_queue : [];
}

async function openCurator(page) {
    await page.goto(CURATOR_PATH);
    // The button injects on load or once the curator chrome renders (MutationObserver
    // up to 10s in src/curator/main.js) — give it room.
    await page.locator(BTN).waitFor({ timeout: 20000 });
}

test.beforeEach(async ({ context, page }) => {
    await clearExtensionStorage(context);
    // The staged job auto-enumerates and the drainer starts — keep every ignore
    // faked, and accept the "ignore N games?" confirm so staging completes.
    await interceptIgnoreApi(context);
    page.on('dialog', (d) => d.accept().catch(() => {}));
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Curator — enqueue button', () => {

    test('Injects the enqueue button (with ILAP logo) before the Options gear', async ({ page }) => {
        await openCurator(page);

        const btn = page.locator(BTN);
        await expect(btn).toBeVisible();
        await expect(btn.locator('.ilap-cur-logo')).toBeVisible();

        // The control wrapper must come before the first <a> (the Options gear) in
        // the curator report nav.
        const order = await page.evaluate(() => {
            const report = document.querySelector('.nav_right_side > .curator_report');
            const ctl = report.querySelector('.ilap-curator-ctl');
            const gear = report.querySelector('a');
            if (!ctl || !gear) return 'missing';
            return (ctl.compareDocumentPosition(gear) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'ctl-first' : 'gear-first';
        });
        expect(order).toBe('ctl-first');
    });

    test('Clicking the button drops its own filter menu with all three options', async ({ page }) => {
        await openCurator(page);

        await page.locator(BTN).click();

        const menu = page.locator('.ilap-curator-menu.open');
        await expect(menu).toBeVisible();
        await expect(menu.locator('.ilap-curator-opt')).toHaveCount(3);
        await expect(menu.locator('[data-value="not_recommended"]')).toBeVisible();
        await expect(menu.locator('[data-value="informational"]')).toBeVisible();
        await expect(menu.locator('[data-value="all_but_recommended"]')).toBeVisible();
    });

    test('Picking a filter stages a job into ilap_curator_queue and shows a toast', async ({ page, context }) => {
        await openCurator(page);

        await page.locator(BTN).click();
        await page.locator('.ilap-curator-menu.open [data-value="not_recommended"]').click();

        await expect.poll(async () => await readQueue(context)).toHaveLength(1);
        const [job] = await readQueue(context);
        expect(job.curatorId).toBe(CURATOR_ID);
        expect(job.filter).toBe('not_recommended');
        // Staged as 'enumerating', then resolved → leaves the transient state.
        await expect.poll(async () => (await readQueue(context))[0].status)
            .not.toBe('enumerating');

        await expect(page.locator('.ilap-curator-toast')).toContainText(/added to queue/i);
    });

    test('An already-queued curator shows the "Added" state and an Active tag on its filter', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_curator_queue: [makeJob(CURATOR_ID, 'informational')] });
        await openCurator(page);

        // Button label reflects the queued state.
        await expect(page.locator(`${BTN} .ilap-cur-label`)).toHaveText(/added to ignore queue/i);

        // The queued filter is marked Active; others offer a Switch hint.
        await page.locator(BTN).click();
        const active = page.locator('.ilap-curator-menu.open .ilap-curator-opt.active');
        await expect(active).toHaveAttribute('data-value', 'informational');
        await expect(active.locator('.ilap-opt-tag.is-active')).toContainText(/active/i);
        await expect(page.locator('.ilap-curator-menu.open [data-value="not_recommended"] .ilap-opt-tag.is-switch')).toHaveCount(1);
    });

    test('Switching the filter in place updates the job without adding a new one', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_curator_queue: [makeJob(CURATOR_ID, 'not_recommended')] });
        await openCurator(page);

        await page.locator(BTN).click();
        await page.locator('.ilap-curator-menu.open [data-value="informational"]').click();

        const queue = await readQueue(context);
        expect(queue).toHaveLength(1);
        expect(queue[0].curatorId).toBe(CURATOR_ID);
        expect(queue[0].filter).toBe('informational');

        await expect(page.locator('.ilap-curator-toast')).toContainText(/switched to/i);
    });

    test('3-job cap: a 4th curator is refused with a "queue full" toast', async ({ page, context }) => {
        // Fill the queue with three OTHER curators.
        await setExtensionStorage(context, {
            ilap_curator_queue: [makeJob('111'), makeJob('222'), makeJob('333')],
        });
        await openCurator(page);

        await page.locator(BTN).click();
        await page.locator('.ilap-curator-menu.open [data-value="not_recommended"]').click();

        // Nothing was added: still three jobs, none for this curator.
        await expect(page.locator('.ilap-curator-toast')).toContainText(/queue is full/i);
        const queue = await readQueue(context);
        expect(queue).toHaveLength(3);
        expect(queue.some(j => j.curatorId === CURATOR_ID)).toBe(false);
    });
});
