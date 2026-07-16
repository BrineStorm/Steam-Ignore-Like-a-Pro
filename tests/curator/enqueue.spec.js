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
// menu, staging a job, the already-added state, switch-in-place, and the 3-job
// cap restriction.

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

    test('Added state: the droplist carries Pause/Resume — toggling flips the stored job intent', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_curator_queue: [makeJob(CURATOR_ID, 'informational')] });
        await openCurator(page);

        // Post-add variant: the filter options gain the job-action rows.
        await page.locator(BTN).click();
        const menu = page.locator('.ilap-curator-menu.open');
        await expect(menu.locator('[data-act="pause"]')).toContainText(/pause/i);
        await expect(menu.locator('[data-act="remove"]')).toBeVisible();
        const w0 = (await page.locator(BTN).boundingBox()).width;

        // Pause flips the stored intent (paused — same write as the applet).
        await menu.locator('[data-act="pause"]').click();
        await expect.poll(async () => (await readQueue(context))[0].status).toBe('paused');

        // Reopen: the same row now offers Resume; clicking returns to pending.
        await page.locator(BTN).click();
        await expect(menu.locator('[data-act="pause"]')).toContainText(/resume/i);
        await menu.locator('[data-act="pause"]').click();
        await expect.poll(async () => (await readQueue(context))[0].status).toBe('pending');

        // Back in the exact starting state, the button width must be back to
        // its starting value: every open→sync cycle used to feed the menu's
        // min-width (button-derived, +2px of borders) back into the button,
        // ratcheting both wider on each toggle.
        await expect.poll(async () => (await page.locator(BTN).boundingBox()).width).toBe(w0);
    });

    test('Added state: Remove in the droplist drops the job and the button returns to the Add state', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_curator_queue: [makeJob(CURATOR_ID, 'informational')] });
        await openCurator(page);

        await page.locator(BTN).click();
        await page.locator('.ilap-curator-menu.open [data-act="remove"]').click();

        await expect.poll(async () => await readQueue(context)).toHaveLength(0);
        // The button falls back to the add-variant everywhere the queue is watched.
        await expect(page.locator(`${BTN} .ilap-cur-label`)).toHaveText(/add to ignore queue/i);
    });

    test('Cross-window sync: an OPEN droplist swaps add-/added-variant live when the queue changes elsewhere', async ({ page, context }) => {
        await openCurator(page);

        // Open the menu in its add-variant (filters only, no job actions).
        await page.locator(BTN).click();
        const menu = page.locator('.ilap-curator-menu.open');
        await expect(menu.locator('.ilap-curator-opt')).toHaveCount(3);
        await expect(menu.locator('[data-act]')).toHaveCount(0);

        // Another window stages a job for this curator (external storage write):
        // the OPEN menu re-renders in place to the post-add variant — no window
        // can keep showing the add-droplist next to another's added-droplist.
        await setExtensionStorage(context, { ilap_curator_queue: [makeJob(CURATOR_ID, 'informational')] });
        await expect(menu.locator('[data-act="pause"]')).toBeVisible();
        await expect(menu.locator('[data-act="remove"]')).toBeVisible();
        await expect(menu.locator('.ilap-curator-opt.active')).toHaveAttribute('data-value', 'informational');

        // A pause landed elsewhere (the applet in another window): the open
        // menu's action row flips to Resume without reopening.
        const paused = Object.assign(makeJob(CURATOR_ID, 'informational'), { status: 'paused' });
        await setExtensionStorage(context, { ilap_curator_queue: [paused] });
        await expect(menu.locator('[data-act="pause"]')).toContainText(/resume/i);

        // And the job removed elsewhere: the same open menu drops the action rows.
        await setExtensionStorage(context, { ilap_curator_queue: [] });
        await expect(menu.locator('[data-act]')).toHaveCount(0);
        await expect(menu.locator('.ilap-curator-opt.active')).toHaveCount(0);
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

    test('Popup surface mode: the button is injected but locked (greyed + tooltip); flipping back unlocks it live', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
        await openCurator(page);

        // In popup mode the control stays in place but is locked: visible, greyed
        // (.ilap-locked), disabled, with our own inline tooltip (not the browser
        // title). It is NOT removed.
        const btn = page.locator(BTN);
        await expect(btn).toBeVisible();
        await expect(btn).toHaveClass(/ilap-locked/);
        await expect(btn).toBeDisabled();
        await expect(btn).not.toHaveAttribute('title');
        // The tip must actually REVEAL on hover (hover the wrap — the locked
        // button is pointer-events:none), not merely carry hidden text.
        const tip = page.locator('.ilap-curator-ctl.ilap-locked-ctl .ilap-locked-tip');
        await expect(tip).toBeHidden();
        await page.locator('.ilap-curator-ctl.ilap-locked-ctl').hover();
        await expect(tip).toBeVisible();
        await expect(tip).toHaveText(/.+/);
        // Screen readers reach the same text through the aria link.
        await expect(btn).toHaveAttribute('aria-describedby', 'ilap-locked-tip');

        // A locked button can't open its dropdown.
        await btn.click({ force: true });
        await expect(page.locator('.ilap-curator-menu.open')).toHaveCount(0);

        // Switching back to the widget unlocks it in place — no reload.
        await setExtensionStorage(context, { ilap_surface_mode: 'widget' });
        await expect(btn).not.toHaveClass(/ilap-locked/);
        await expect(btn).toBeEnabled();
    });

    test('Live switch to popup mode locks the injected button (and back)', async ({ page, context }) => {
        await openCurator(page);
        const btn = page.locator(BTN);
        await expect(btn).toBeVisible();
        await expect(btn).not.toHaveClass(/ilap-locked/);

        await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
        await expect(btn).toHaveClass(/ilap-locked/);
        await expect(btn).toBeDisabled();

        await setExtensionStorage(context, { ilap_surface_mode: 'widget' });
        await expect(btn).not.toHaveClass(/ilap-locked/);
        await expect(btn).toBeEnabled();
    });

    test('Open-dropdown race: flipping to popup mid-open forces the menu shut and refuses the stage', async ({ page, context }) => {
        await openCurator(page);

        // Open the dropdown while still in widget mode.
        await page.locator(BTN).click();
        await expect(page.locator('.ilap-curator-menu.open')).toBeVisible();

        // Now the surface flips to popup (could be this or another browser window):
        // the menu must be force-closed and the button locked.
        await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
        await expect(page.locator(BTN)).toHaveClass(/ilap-locked/);
        await expect(page.locator('.ilap-curator-menu.open')).toHaveCount(0);

        // Belt-and-suspenders: dispatch a raw click on the (now hidden) option —
        // this models the race where the DOM event fires just as the lock lands.
        // The menu handler re-checks the lock at click time, so no job is staged.
        await page.locator('.ilap-curator-menu [data-value="not_recommended"]').dispatchEvent('click');
        await page.waitForTimeout(500);
        expect(await readQueue(context)).toHaveLength(0);
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
