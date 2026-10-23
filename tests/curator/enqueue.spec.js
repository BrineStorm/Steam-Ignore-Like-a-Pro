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
// drainer then runs — so we intercept the ignore endpoint (interceptIgnoreApi):
// no real game is ever ignored. Covers injection + logo, the drop-out filter
// menu, staging a job, the already-added state (the square of what is queued,
// its tip, the "In queue" and locked rows), the other review type added as a
// job of its own, and the 3-job cap restriction.

// Known public anti-AI curators. Steam redirects the
// bare /curator/<id>/ to the full slug URL; curatorId() matches either form.
const CURATOR_ID = '45186708';          // "No AI"
const CURATOR_PATH = `/curator/${CURATOR_ID}/`;
const BTN = '#ilap-curator-enqueue';

// A seeded job stands in for one the user already staged, purely to put the
// button in its Added state — but it has to carry REAL work to survive: the
// drainer collects a zero-appid pending job as an unfinished completion the
// moment it runs (CuratorQueueDrainer._collectDrained), which would yank the
// button back to the add-variant mid-test. So the list is:
//  - synthetic (9_000_001+, no such app), so the drain-time userdata dedupe
//    reads the real account's ignores and can never skip these — a skipped
//    appid advances the cursor with no POST, i.e. with no pacing at all;
//  - long enough that the gate's 0.65 s pace (src/gate.js MIN_GAP) cannot walk
//    it to the end inside the 75 s per-test limit, whatever a spec does.
// Every POST is route-faked by interceptIgnoreApi, so none of it reaches Steam.
const FAKE_APPIDS = Array.from({ length: 150 }, (_, i) => String(9000001 + i));

function makeJob(curatorId, filter = 'not_recommended') {
    return {
        id: 'job_' + curatorId + '_' + filter + '_' + Date.now(),
        curatorId: String(curatorId),
        curatorName: 'Curator ' + curatorId,
        curatorUrl: 'https://store.steampowered.com/curator/' + curatorId + '/',
        filter,
        appids: FAKE_APPIDS.slice(),
        cursor: 0,
        total: FAKE_APPIDS.length,
        status: 'pending',
        addedAt: Date.now(),
    };
}

async function readQueue(context) {
    const res = await getExtensionStorage(context, 'ilap_curator_queue');
    return Array.isArray(res.ilap_curator_queue) ? res.ilap_curator_queue : [];
}

// Steam intermittently answers this public page with a transient 5xx under
// bursty test traffic (verified: reproduced during back-to-back
// full-spec runs, then 200s anonymously via curl minutes later — a server-side
// throttle, NOT an account signal; all test ignores are route-intercepted and
// never reach Steam). Retry with a backoff so a one-off 500 doesn't fail a spec.
async function gotoCurator(page) {
    for (let attempt = 0; ; attempt++) {
        const resp = await page.goto(CURATOR_PATH);
        if (!resp || resp.status() < 500 || attempt >= 2) return;
        await page.waitForTimeout(3000 * (attempt + 1));
    }
}

async function openCurator(page) {
    await gotoCurator(page);
    // The button injects on load or once the curator chrome renders (MutationObserver
    // up to 10s in src/curator/main.js) — give it room.
    await page.locator(BTN).waitFor({ timeout: 20000 });
}

test.beforeEach(async ({ context, page }) => {
    await clearExtensionStorage(context);
    // The staged job auto-enumerates and the drainer starts — keep every ignore
    // faked so no real game is ignored.
    await interceptIgnoreApi(context);
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
        // all_but_recommended, NOT not_recommended: a job that resolves to ZERO
        // appids is legitimately removed as already-finished by the drainer,
        // which empties the queue mid-poll. This curator flipped its marking
        // style to informational-only (0 not_recommended rows at the time of writing),
        // and the broad filter stays valid whichever negative style it uses.
        await page.locator('.ilap-curator-menu.open [data-value="all_but_recommended"]').click();

        await expect.poll(async () => await readQueue(context)).toHaveLength(1);
        const [job] = await readQueue(context);
        expect(job.curatorId).toBe(CURATOR_ID);
        expect(job.filter).toBe('all_but_recommended');
        // Staged as 'enumerating', then resolved → leaves the transient state.
        await expect.poll(async () => (await readQueue(context))[0].status)
            .not.toBe('enumerating');

        await expect(page.locator('.ilap-toast')).toContainText(/added to queue/i);
    });

    // The square before "Added": its fill, the filter its tip names, and whether
    // it shows at all. Gradient = both review types.
    const squareOf = (page) => page.evaluate((btn) => {
        const sq = document.querySelector(btn + ' .ilap-cur-sq');
        const cs = getComputedStyle(sq);
        return { shown: !sq.hidden, color: cs.backgroundColor, gradient: cs.backgroundImage.includes('gradient') };
    }, BTN);
    const YELLOW = 'rgb(241, 222, 116)';   // filters.js COLORS.informational
    // Each row's state in the open menu: 'queued' (highlighted), 'locked', or '',
    // and '+tag' for the "In queue" pill.
    const rowStates = (page) => page.evaluate(() => {
        const out = {};
        for (const r of document.querySelectorAll('.ilap-curator-menu .ilap-curator-opt')) {
            const state = r.classList.contains('active') ? 'queued' : r.classList.contains('locked') ? 'locked' : '';
            out[r.dataset.value] = state + (r.querySelector('.ilap-opt-pill') ? '+tag' : '');
        }
        return out;
    });

    test('An already-queued curator shows "Added" with its filter\'s square, tip and "In queue" row', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_curator_queue: [makeJob(CURATOR_ID, 'informational')] });
        await openCurator(page);

        await expect(page.locator(`${BTN} .ilap-cur-label`)).toHaveText(/added to ignore queue/i);
        expect(await squareOf(page)).toMatchObject({ shown: true, color: YELLOW, gradient: false });

        // The square's tip names the filter, as the queue applet's does.
        await page.locator(`${BTN} .ilap-cur-sq`).hover();
        await expect(page.locator('.ilap-cur-tip.show')).toHaveText(/informational only/i);

        // The queued filter wears the pill and its cross; the other type and "All
        // except Recommended" can still be picked.
        await page.locator(BTN).click();
        expect(await rowStates(page)).toEqual({
            not_recommended: '', informational: 'queued+tag', all_but_recommended: ''
        });
        await expect(page.locator('.ilap-curator-menu.open .ilap-opt-pill')).toHaveText(/in queue/i);
        await expect(page.locator('.ilap-curator-menu.open [data-act="remove"]')).toHaveCount(1);
        // Pause lives in the queue applet only.
        await expect(page.locator('.ilap-curator-menu.open [data-act="pause"]')).toHaveCount(0);
    });

    test('The cross on a queued row removes that job and frees what it locked; the menu stays open', async ({ page, context }) => {
        const nr = makeJob(CURATOR_ID, 'not_recommended');
        const inf = makeJob(CURATOR_ID, 'informational');
        await setExtensionStorage(context, { ilap_curator_queue: [nr, inf] });
        await openCurator(page);

        await page.locator(BTN).click();
        await page.locator('.ilap-curator-menu.open [data-value="not_recommended"] [data-act="remove"]').click();

        await expect.poll(async () => (await readQueue(context)).map(j => j.id)).toEqual([inf.id]);
        await expect(page.locator('.ilap-curator-menu.open')).toBeVisible();
        await expect.poll(() => rowStates(page)).toEqual({
            not_recommended: '', informational: 'queued+tag', all_but_recommended: ''
        });
        await expect.poll(async () => (await squareOf(page)).color).toBe(YELLOW);
    });

    test('"All except Recommended" with one type queued adds the other type as a job of its own', async ({ page, context }) => {
        const first = makeJob(CURATOR_ID, 'not_recommended');
        await setExtensionStorage(context, { ilap_curator_queue: [first] });
        await openCurator(page);

        await page.locator(BTN).click();
        await page.locator('.ilap-curator-menu.open [data-value="all_but_recommended"]').click();

        // The first job is left as it was; the Informational half waits behind it.
        await expect.poll(async () => (await readQueue(context)).length).toBe(2);
        const queue = await readQueue(context);
        expect(queue[0]).toMatchObject({ id: first.id, filter: 'not_recommended' });
        expect(queue[1]).toMatchObject({ curatorId: CURATOR_ID, filter: 'informational' });
        await expect(page.locator('.ilap-toast')).toContainText(/added to queue/i);

        // Both types queued: the square turns to the gradient, everything is in the queue.
        await expect.poll(async () => (await squareOf(page)).gradient).toBe(true);
        await page.locator(BTN).click();
        expect(await rowStates(page)).toEqual({
            not_recommended: 'queued+tag', informational: 'queued+tag', all_but_recommended: 'locked'
        });
    });

    test('A job of both locks the two others: a click on one changes nothing and keeps the menu open', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_curator_queue: [makeJob(CURATOR_ID, 'all_but_recommended')] });
        await openCurator(page);
        expect(await squareOf(page)).toMatchObject({ shown: true, gradient: true });

        await page.locator(BTN).click();
        expect(await rowStates(page)).toEqual({
            not_recommended: 'locked', informational: 'locked', all_but_recommended: 'queued+tag'
        });
        await page.locator('.ilap-curator-menu.open [data-value="informational"]').click();
        await expect(page.locator('.ilap-curator-menu.open')).toBeVisible();
        expect(await readQueue(context)).toHaveLength(1);
    });

    test('A job removed or finished elsewhere: the square and the locks follow the queue', async ({ page, context }) => {
        const nr = makeJob(CURATOR_ID, 'not_recommended');
        const inf = makeJob(CURATOR_ID, 'informational');
        await setExtensionStorage(context, { ilap_curator_queue: [nr, inf] });
        await openCurator(page);
        expect(await squareOf(page)).toMatchObject({ shown: true, gradient: true });

        // The menu stays open through it: another window's write redraws it in place.
        await page.locator(BTN).click();

        // Not Recommended leaves the queue: the gradient goes yellow, and "All
        // except Recommended" is free again.
        await setExtensionStorage(context, { ilap_curator_queue: [inf] });
        await expect.poll(async () => (await squareOf(page)).color).toBe(YELLOW);
        expect((await squareOf(page)).gradient).toBe(false);
        expect(await rowStates(page)).toEqual({
            not_recommended: '', informational: 'queued+tag', all_but_recommended: ''
        });

        // And the last one: the button is back to Add, with no square.
        await setExtensionStorage(context, { ilap_curator_queue: [] });
        await expect(page.locator(`${BTN} .ilap-cur-label`)).toHaveText(/add to ignore queue/i);
        expect((await squareOf(page)).shown).toBe(false);
        await expect(page.locator('.ilap-curator-menu.open .ilap-opt-pill')).toHaveCount(0);
    });

    test('Re-renders do not grow the button (the width ratchet)', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_curator_queue: [makeJob(CURATOR_ID, 'informational')] });
        await openCurator(page);
        // Measured only once Steam's webfont has settled: the label is the
        // button's width, and a measurement taken while it is still laid out in
        // the fallback face compares two different fonts.
        await page.evaluate(() => document.fonts.ready);
        const w0 = (await page.locator(BTN).boundingBox()).width;
        const label0 = await page.locator(`${BTN} .ilap-cur-label`).textContent();

        // Open → queue write → close, twice: every sync re-measures the menu.
        for (const status of ['paused', 'pending']) {
            await page.locator(BTN).click();
            const job = Object.assign(makeJob(CURATOR_ID, 'informational'), { status });
            await setExtensionStorage(context, { ilap_curator_queue: [job] });
            await expect.poll(async () => (await readQueue(context))[0].status).toBe(status);
            await page.locator(BTN).click();
        }

        // Every open→sync cycle used to feed the menu's min-width (button-derived,
        // +2px of borders) back into the button, ratcheting both wider. Direction,
        // not exact equality: a full run once produced 276.00006 → 275.00006 here,
        // a pixel moved by Steam's own rendering, not by this control. The floor
        // still catches a collapse.
        await expect.poll(async () => (await page.locator(BTN).boundingBox()).width)
            .toBeLessThanOrEqual(w0);
        expect((await page.locator(BTN).boundingBox()).width).toBeGreaterThan(w0 - 4);
        expect(await page.locator(`${BTN} .ilap-cur-label`).textContent()).toBe(label0);
    });

    test('Cross-window sync: an OPEN droplist redraws live when the queue changes elsewhere', async ({ page, context }) => {
        await openCurator(page);

        // Open the menu with nothing queued: three free filters.
        await page.locator(BTN).click();
        const menu = page.locator('.ilap-curator-menu.open');
        await expect(menu.locator('.ilap-curator-opt')).toHaveCount(3);
        await expect(menu.locator('.ilap-opt-pill')).toHaveCount(0);

        // Another window stages a job of both for this curator: the OPEN menu
        // re-renders in place, its row queued and the two others locked.
        await setExtensionStorage(context, { ilap_curator_queue: [makeJob(CURATOR_ID, 'all_but_recommended')] });
        await expect(menu.locator('.ilap-curator-opt.active')).toHaveAttribute('data-value', 'all_but_recommended');
        await expect(menu.locator('.ilap-curator-opt.locked')).toHaveCount(2);

        // And the job removed elsewhere: the same open menu drops every tag.
        await setExtensionStorage(context, { ilap_curator_queue: [] });
        await expect(menu.locator('.ilap-opt-pill')).toHaveCount(0);
        await expect(menu.locator('.ilap-curator-opt.active, .ilap-curator-opt.locked')).toHaveCount(0);
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
        await expect(page.locator('.ilap-toast')).toContainText(/queue is full/i);
        const queue = await readQueue(context);
        expect(queue).toHaveLength(3);
        expect(queue.some(j => j.curatorId === CURATOR_ID)).toBe(false);
    });

    test('Popup surface mode: the button works the same — staging is not surface-gated anymore', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
        await openCurator(page);

        // Since the SW drain landed, the queue is stageable and manageable from
        // either surface — popup mode no longer greys the button out.
        const btn = page.locator(BTN);
        await expect(btn).toBeVisible();
        await expect(btn).toBeEnabled();

        await btn.click();
        await expect(page.locator('.ilap-curator-menu.open')).toBeVisible();
        // Same broad-filter choice as the staging test above (a zero-appid
        // resolve would legitimately drop the job as already-finished).
        await page.locator('.ilap-curator-menu.open [data-value="all_but_recommended"]').click();

        await expect.poll(async () => await readQueue(context)).toHaveLength(1);
        const [job] = await readQueue(context);
        expect(job.curatorId).toBe(CURATOR_ID);

        // A live flip back to widget mode changes nothing about the button.
        await setExtensionStorage(context, { ilap_surface_mode: 'widget' });
        await page.waitForTimeout(300);
        await expect(btn).toBeEnabled();
    });

    test('Live language switch relabels the injected button in place', async ({ page, context }) => {
        // The i18n onLangChange subscriber (audit altitude finding):
        // a live ilap_lang change must redraw the content-script UI's labels,
        // not just the popup's.
        await openCurator(page);
        const label = page.locator(`${BTN} .ilap-cur-label`);
        await expect(label).toHaveText('Add to ignore queue');

        await setExtensionStorage(context, { ilap_lang: 'ru' });
        await expect(label).toHaveText('Добавить в очередь скрытия');

        // And back — the subscriber keeps firing, not a one-shot.
        await setExtensionStorage(context, { ilap_lang: 'en' });
        await expect(label).toHaveText('Add to ignore queue');
    });

    test('Master OFF: the button is not injected; flipping it live removes and restores it', async ({ page, context }) => {
        // A disabled extension leaves no control of its own on a Steam page. What
        // is already STAGED is a different question and stays put — the toggle
        // stops new work, it does not throw the queue away.
        await setExtensionStorage(context, { ilap_master_enabled: false, ilap_curator_queue: [makeJob(CURATOR_ID)] });
        await gotoCurator(page);
        await page.locator('#global_action_menu').waitFor({ timeout: 20000 });
        await page.waitForTimeout(2500);
        await expect(page.locator(BTN)).toHaveCount(0);
        // The seeded job is untouched by the flip.
        await expect.poll(async () => (await readQueue(context)).length).toBe(1);

        // Live re-enable puts the control back without a reload…
        await setExtensionStorage(context, { ilap_master_enabled: true });
        await expect(page.locator(BTN)).toBeVisible({ timeout: 20000 });
        // …in its Added state, i.e. the storage sync of the fresh injection works.
        await expect(page.locator(`${BTN} .ilap-cur-label`)).toHaveText('Added to ignore queue');

        // …and turning it off again takes the button AND its <body>-level menu.
        await expect(page.locator('#ilap-curator-style')).toHaveCount(1);
        await setExtensionStorage(context, { ilap_master_enabled: false });
        await expect(page.locator(BTN)).toHaveCount(0, { timeout: 5000 });
        await expect(page.locator('.ilap-curator-menu')).toHaveCount(0);
        // Nothing of the button outlives the switch, its stylesheet included.
        await expect(page.locator('#ilap-curator-style')).toHaveCount(0);
        await expect.poll(async () => (await readQueue(context)).length).toBe(1);
    });

    test('Logged out: the button is not injected at all', async ({ page, context }) => {
        await context.clearCookies();
        await gotoCurator(page); // same transient-5xx retry as openCurator

        // Curator pages are public, so the page itself renders; boot() must bail
        // on the login gate before ever reaching tryInject. Injection is
        // synchronous once the curator chrome exists, so a short settle after
        // the header is enough to prove the button never appears.
        await page.locator('#global_action_menu').waitFor({ timeout: 20000 });
        await page.waitForTimeout(2500);
        await expect(page.locator(BTN)).toHaveCount(0);
    });
});
