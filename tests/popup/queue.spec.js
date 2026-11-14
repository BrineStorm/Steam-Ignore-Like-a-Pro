const { test, expect } = require('../_fixtures.js');
const {
    getExtensionId,
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');

// The ignore queue in the toolbar popup (ui/popup_queue.js), driven through
// the popup window (ui/popup.html) — no Steam login or live page needed. The
// extension's icon in the header unrolls the queue over the panel as a small
// framed window and wears the job count and a ring of the queue's progress.
// One slim strip per job, as in 1.3.5, so three jobs fit the window. The widget's queue
// window beside its panel is in tests/widget/queue-window.spec.js. Nothing
// here ignores a real game — every job is a hand-seeded storage entry.

let jobSeq = 0;
function makeJob(over = {}) {
    jobSeq += 1;
    const curatorId = String(over.curatorId || (100 + jobSeq));
    return Object.assign({
        id: 'job_' + curatorId + '_' + jobSeq,
        curatorId,
        curatorName: 'Curator ' + curatorId,
        curatorUrl: 'https://store.steampowered.com/curator/' + curatorId + '/',
        filter: 'not_recommended',
        appids: [],
        total: 0,
        status: 'pending',
        addedAt: Date.now(),
    }, over);
}

// A live drain lease for a job's curator — the applet derives "running" from it
// ('running' is never stored in the job record).
function liveLease(job) {
    return { ['ilap_curator_lock_' + job.curatorId]: { owner: 'test', expiresAt: Date.now() + 60000 } };
}

async function seedQueue(context, jobs) {
    await setExtensionStorage(context, { ilap_curator_queue: jobs });
}

async function openPopup(page, context) {
    const extId = await getExtensionId(context);
    await page.goto(popupUrl(extId));
    await page.locator('#popup-root').waitFor({ timeout: 5000 });
}

// Opens the queue's drawer and waits out its slide: the block is covered or
// clipped while it moves, and a hover that lands in that window never takes,
// as Chromium re-tests hover only on the next mouse move.
async function openApplet(page) {
    await page.locator('#queue-btn').click();
    await expect(page.locator('#queue-drawer')).toHaveClass(/open/);
    await expect(page.locator('#queue-drawer')).not.toHaveClass(/sliding/);
    await expect(page.locator('#queue-list')).toBeVisible();
}

async function readQueue(context) {
    const res = await getExtensionStorage(context, 'ilap_curator_queue');
    return Array.isArray(res.ilap_curator_queue) ? res.ilap_curator_queue : [];
}

// Remove asks first: the trash, then the ✓ that takes Pause's place.
async function removeRow(row) {
    await row.locator('[data-act="remove"]').click();
    await row.locator('[data-act="confirm"]').click();
}

test.beforeEach(async ({ context }) => {
    await clearExtensionStorage(context);
    // popup.html renders the full UI only in popup surface mode (widget mode
    // shows the signpost stub — covered by surface-stub.spec.js).
    await setExtensionStorage(context, { ilap_surface_mode: 'popup' });
});

test.afterEach(async ({ context }) => {
    await clearExtensionStorage(context);
});

test.describe('Popup — ignore queue', () => {

    test('An empty queue shows no count or ring and opens on a hint that points at the lists button', async ({ page, context }) => {
        await openPopup(page, context);
        await expect(page.locator('#queue-btn')).toBeVisible();
        await expect(page.locator('#queue-btn')).toHaveClass(/is-empty/);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('0');
        await expect.poll(() => page.locator('.queue-badge').evaluate(el => getComputedStyle(el).opacity)).toBe('0');
        await expect(page.locator('#lists-btn')).toBeVisible();
        await openApplet(page);
        await expect(page.locator('#queue-btn')).toHaveAttribute('aria-expanded', 'true');
        const hint = page.locator('.queue-empty-hint');
        await expect(hint).toContainText("Add a curator's list on the curator's page");
        await expect(hint.locator('.queue-empty-icon svg')).toBeVisible();
    });

    test('Master OFF: the queue stays open to the icon, the lists offer nothing', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_master_enabled: false });
        await openPopup(page, context);

        // UI is locked (wrapper dimmed); the icon still opens the queue, but a
        // disabled extension takes no new jobs, for the same reason Pause is dead.
        await expect(page.locator('#ui-wrapper')).toHaveClass(/disabled/);
        await expect(page.locator('#queue-btn')).toBeEnabled();
        await expect(page.locator('#lists-btn')).toHaveAttribute('aria-disabled', 'true');
        // force: Playwright would wait forever on an aria-disabled button.
        await page.locator('#lists-btn').click({ force: true });
        await page.waitForTimeout(400);
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/open/);
    });

    test('Master OFF: the queue survives the flip and stays manageable', async ({ page, context }) => {
        // Turning the extension off stops the DRAIN. It must not delete a single
        // staged job — curator, MI or solo un-ignore alike — and it must not lock
        // the user out of managing them either: this applet is the only surface
        // that can pause or remove a job, so it stays live inside the dimmed panel.
        const curator = makeJob({ curatorId: '901', curatorName: 'Curator job' });
        const mi = makeJob({ id: 'job_mi', type: 'mi', curatorId: 'mi', curatorName: '', appids: ['10', '11'], meta: {}, total: 2 });
        const miundo = makeJob({ id: 'job_miundo', type: 'miundo', curatorId: 'miundo', curatorName: '', appids: ['12'], meta: {}, total: 1 });
        await seedQueue(context, [curator, mi, miundo]);
        await setExtensionStorage(context, { ilap_master_enabled: false });
        await openPopup(page, context);

        // The panel is locked…
        await expect(page.locator('#ui-wrapper')).toHaveClass(/disabled/);
        // …and nothing was dropped by the flip.
        await expect(page.locator('#queue-btn')).toBeVisible();
        await expect(page.locator('#queue-jobs-chip')).toHaveText('3');

        // The queue is exempt from the panel lock — but only half of it. Remove
        // acts; Pause/Resume is blocked, because a disabled extension must not let
        // you ask for a run it cannot perform.
        await openApplet(page);
        for (const row of await page.locator('.queue-act[data-act="pause"]').all()) {
            await expect(row).toBeDisabled();
        }
        await removeRow(page.locator('.queue-job').first());
        await expect.poll(async () => (await readQueue(context)).map(j => j.id)).toEqual([mi.id, miundo.id]);
    });

    test('The master toggle never writes the queue; Pause/Resume is dead while off', async ({ page, context }) => {
        // Driven through the REAL toggle. It writes its own key only: the queue
        // array belongs to its serialized writers, and a drainer in another
        // context (the SW) may be rewriting it at the same moment — a whole-array
        // write from here could resurrect a job that drainer just finished.
        const pending = makeJob({ curatorId: '903' });
        const byHand = makeJob({ curatorId: '904', status: 'paused' });
        await seedQueue(context, [pending, byHand]);
        await openPopup(page, context);
        await openApplet(page);

        await page.locator('#master-toggle + .slider').click();   // OFF
        await expect.poll(async () => getExtensionStorage(context, 'ilap_master_enabled'))
            .toEqual({ ilap_master_enabled: false });

        // Both pause/play buttons are dead — a real click cannot reach either of them,
        // which is the whole assertion. (Forcing one past the attribute was tried
        // and dropped: the list re-renders under it, and the synthetic click it
        // would land tests the isTrusted guard rather than the master one. The
        // `_onAction` master guard behind the attribute covers the narrow race
        // where another surface flips the switch between a render and a click,
        // which is not reachable from a single popup either way.)
        const plays = page.locator('.queue-act[data-act="pause"]');
        await expect(plays.first()).toBeDisabled();
        await expect(plays.last()).toBeDisabled();
        await page.waitForTimeout(500);
        // The flip left every stored status exactly as it was.
        expect((await readQueue(context)).map(j => j.status)).toEqual(['pending', 'paused']);

        // Back on: the buttons come back to life, the statuses still untouched.
        await page.locator('#master-toggle + .slider').click();   // ON
        await expect(plays.first()).toBeEnabled();
        expect((await readQueue(context)).map(j => j.status)).toEqual(['pending', 'paused']);
    });

    test('The icon shows the job count on its lower right corner, and a ring of the games done', async ({ page, context }) => {
        const half = makeJob({ total: 10, appids: Array.from({ length: 10 }, (_, i) => String(i + 1)) });
        const fresh = makeJob({ total: 10, appids: Array.from({ length: 10 }, (_, i) => String(i + 11)) });
        await setExtensionStorage(context, { ilap_curator_queue: [half, fresh], ['ilap_curator_cursor_' + half.id]: 5 });
        await openPopup(page, context);

        const btn = page.locator('#queue-btn');
        await expect(btn).not.toHaveClass(/is-empty/);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('2');
        // 5 of the queue's 20 games: a quarter of the ring.
        await expect.poll(() => btn.evaluate(el => el.style.getPropertyValue('--ring'))).toBe('25.0');
        // The badge sits on the icon's lower right corner.
        const icon = await page.locator('#ilap-header-icon').boundingBox();
        const chip = await page.locator('#queue-jobs-chip').boundingBox();
        expect(chip.x + chip.width).toBeGreaterThan(icon.x + icon.width);
        expect(chip.y + chip.height).toBeGreaterThan(icon.y + icon.height);
        expect(chip.x).toBeLessThan(icon.x + icon.width);
        expect(chip.y).toBeLessThan(icon.y + icon.height);
    });

    test('The icon unrolls the queue over the panel and back; Escape shuts it and hands focus back', async ({ page, context }) => {
        await seedQueue(context, [makeJob()]);
        await openPopup(page, context);
        const drawer = page.locator('#queue-drawer');
        await expect(drawer).toBeHidden();

        // A click from page script is untrusted and opens nothing.
        await page.evaluate(() => document.getElementById('queue-btn').click());
        await page.waitForTimeout(400);
        await expect(drawer).not.toHaveClass(/open/);

        const size = () => page.evaluate(() => [document.documentElement.scrollWidth, document.body.scrollHeight]);
        const before = await size();
        await openApplet(page);
        // A small window of its own over the panel: under the header, off the
        // window's edges, framed in blue. The window keeps its size.
        const inner = page.locator('#queue-drawer .drawer-inner');
        const box = await inner.boundingBox();
        const panel = await page.locator('#popup-root').boundingBox();
        const header = await page.locator('#popup-root > h3').boundingBox();
        expect(Math.abs(box.y - (header.y + header.height))).toBeLessThan(1);
        expect(box.x).toBeGreaterThanOrEqual(panel.x + 7.5);
        expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width - 7.5);
        expect(box.y + box.height).toBeLessThanOrEqual(panel.y + panel.height - 7.5);
        expect(await inner.evaluate(el => getComputedStyle(el).borderLeftColor)).toBe('rgb(69, 161, 250)');
        expect(await size()).toEqual(before);

        await page.locator('#queue-list .queue-act').first().focus();
        await page.keyboard.press('Escape');
        await expect(drawer).not.toHaveClass(/open/);
        await expect(page.locator('#queue-btn')).toBeFocused();
        await expect(page.locator('#queue-btn')).toHaveAttribute('aria-expanded', 'false');
        await expect(drawer).toBeHidden();
    });

    test('Three jobs fit the toolbar window with no scroll, with Already Played off too', async ({ page, context }) => {
        const job = (n) => makeJob({ curatorName: 'A curator with a long name ' + n, total: 2, appids: ['1', '2'], status: 'paused' });
        await setExtensionStorage(context, { ilap_platform_key: 'off', ilap_curator_queue: [job(1), job(2), job(3)] });
        await openPopup(page, context);
        await openApplet(page);
        const m = await page.evaluate(() => ({
            inner: (el => el.scrollHeight > el.clientHeight)(document.querySelector('#queue-drawer .drawer-inner')),
            page: document.documentElement.scrollHeight > document.documentElement.clientHeight,
            h: document.body.scrollHeight,
        }));
        expect(m.inner, 'the queue does not scroll').toBe(false);
        expect(m.page, 'the window does not scroll').toBe(false);
        expect(m.h).toBeLessThanOrEqual(600);
    });

    test('Five jobs stay inside the window and scroll inside the queue\'s block', async ({ page, context }) => {
        const job = (n) => makeJob({ curatorName: 'A curator with a long name ' + n, total: 2, appids: ['1', '2'], status: 'paused' });
        await seedQueue(context, [1, 2, 3, 4, 5].map(job));
        await openPopup(page, context);
        const h = await page.evaluate(() => document.body.scrollHeight);
        await openApplet(page);
        const m = await page.evaluate(() => {
            const el = document.querySelector('#queue-drawer .drawer-inner');
            return { scrolls: el.scrollHeight > el.clientHeight, bottom: el.getBoundingClientRect().bottom, h: document.body.scrollHeight };
        });
        expect(m.scrolls).toBe(true);
        expect(m.h, 'the window keeps its height').toBe(h);
        expect(m.bottom).toBeLessThanOrEqual(h - 7.5);
    });

    test('The last job finished: its strip stays, empties with a ✓, then the hint takes its place, the block never shrinking', async ({ page, context }) => {
        const job = makeJob({ appids: ['1', '2', '3'], total: 3 });
        await setExtensionStorage(context, { ilap_curator_queue: [job], ['ilap_curator_cursor_' + job.id]: 3 });
        await openPopup(page, context);
        await openApplet(page);
        const row = page.locator('#queue-list .queue-job');
        await expect(row).toHaveCount(1);
        // The block's height, sampled every frame from just before the job goes.
        await page.evaluate(() => {
            const box = document.querySelector('#queue-drawer .drawer-inner');
            window.__h = [];
            const tick = () => { window.__h.push(box.getBoundingClientRect().height); window.__raf = requestAnimationFrame(tick); };
            tick();
        });
        const before = await page.locator('#queue-drawer .drawer-inner').evaluate(el => el.getBoundingClientRect().height);
        await seedQueue(context, []);
        await expect(row.locator('.queue-done-check')).toBeVisible();
        await expect(row).toHaveClass(/is-done/);
        await expect(page.locator('.queue-empty-hint')).toBeVisible();
        await expect(page.locator('#queue-list .queue-job')).toHaveCount(0);
        await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
        const heights = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__h; });
        expect(Math.min(...heights), 'the block never shrinks').toBeGreaterThanOrEqual(before - 0.5);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('0');
    });

    test('The stack\'s bars drop in as a queue with jobs opens, and stay still on an empty one', async ({ page, context }) => {
        // The rule the drawer's state applies, read while it slides.
        const bars = () => page.locator('.queue-ico rect').evaluateAll(els => els.map(el => getComputedStyle(el).animationName));
        await openPopup(page, context);
        await page.locator('#queue-btn').click();
        await expect(page.locator('#queue-drawer')).toHaveClass(/sliding/);
        expect(await bars()).toEqual(['none', 'none', 'none']);
        await expect(page.locator('#queue-drawer')).not.toHaveClass(/sliding/);
        await page.locator('#queue-btn').click();
        await expect(page.locator('#queue-drawer')).toBeHidden();

        await seedQueue(context, [makeJob()]);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('1');
        await page.locator('#queue-btn').click();
        await expect(page.locator('#queue-drawer')).toHaveClass(/sliding/);
        expect(await bars()).toEqual(['ilap-queue-drop', 'ilap-queue-drop', 'ilap-queue-drop']);
    });

    test('Opened from the keyboard, the drawer takes the focus', async ({ page, context }) => {
        await seedQueue(context, [makeJob()]);
        await openPopup(page, context);
        await page.locator('#queue-btn').focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#queue-drawer')).toHaveClass(/open/);
        await expect(page.locator('#queue-list .queue-act').first()).toBeFocused();
    });

    test('The queue opens over the lists or a tab and leaves them be', async ({ page, context }) => {
        await seedQueue(context, [makeJob()]);
        await openPopup(page, context);

        await page.locator('#lists-btn').click();
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
        await page.locator('#queue-btn').click();
        await expect(page.locator('#queue-drawer')).toHaveClass(/open/);
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
        await page.locator('#queue-btn').click();
        await expect(page.locator('#queue-drawer')).not.toHaveClass(/open/);
        await expect(page.locator('#lists-drawer')).toHaveClass(/open/);
        await page.locator('#lists-btn').click();
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/open/);

        await page.locator('#tab-settings').click();
        await expect(page.locator('#settings-placeholder')).toBeVisible();
        await page.locator('#queue-btn').click();
        await expect(page.locator('#queue-drawer')).toHaveClass(/open/);
        await expect(page.locator('#tab-settings')).toHaveAttribute('aria-selected', 'true');
        await page.locator('#queue-btn').click();
        await expect(page.locator('#queue-drawer')).not.toHaveClass(/open/);
    });

    test('The panel dims and blurs under the open queue, the header stays clear, and a click on the dim shuts the queue alone', async ({ page, context }) => {
        await seedQueue(context, [makeJob()]);
        await openPopup(page, context);
        const dim = () => page.evaluate(() => {
            const s = getComputedStyle(document.getElementById('ilap-shell'), '::after');
            return { opacity: s.opacity, blur: s.backdropFilter, top: s.top };
        });
        // Hidden, it has no backdrop filter: one left on made the panel's own
        // height moves drop frames.
        expect(await dim()).toMatchObject({ opacity: '0', blur: 'none' });
        await openApplet(page);
        const header = await page.locator('#popup-root > h3').boundingBox();
        const shell = await page.locator('#ilap-shell').boundingBox();
        await expect.poll(async () => (await dim()).opacity).toBe('1');
        const d = await dim();
        expect(d.blur).toContain('blur');
        expect(Math.abs(parseFloat(d.top) - (header.y + header.height - shell.y))).toBeLessThan(1);
        // The header's switch is still the top element at its point; the
        // lists button under the dim is not.
        const topAt = (sel) => page.evaluate((s) => {
            const r = document.querySelector(s).getBoundingClientRect();
            return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2).id;
        }, sel);
        expect(await topAt('#lists-btn')).toBe('ilap-shell');
        expect(await page.evaluate(() => {
            const r = document.querySelector('.switch').getBoundingClientRect();
            return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2).closest('.switch');
        })).toBe(true);
        const btn = await page.locator('#lists-btn').boundingBox();
        await page.mouse.click(btn.x + btn.width / 2, btn.y + btn.height / 2);
        await expect(page.locator('#queue-drawer')).not.toHaveClass(/open/);
        await expect(page.locator('#lists-drawer')).not.toHaveClass(/open/);
        await expect.poll(async () => (await dim()).opacity).toBe('0');
        await expect.poll(async () => (await dim()).blur).toBe('none');
    });

    test('A job row renders its curator name on one line, with no glyph in front', async ({ page, context }) => {
        await seedQueue(context, [makeJob({ curatorName: 'No AI', filter: 'not_recommended' })]);
        await openPopup(page, context);
        await openApplet(page);

        const row = page.locator('.queue-job').first();
        await expect(row.locator('.queue-job-name')).toHaveText('No AI');
        await expect(row.locator('.queue-job-glyph')).toHaveCount(0);   // only list jobs have one
        await expect(row.locator('.queue-mini')).toBeVisible();
        // A square in the filter's colour in front of the name (orange for Not
        // Recommended), naming the filter on hover. The strip keeps a plain outline.
        const bar = row.locator('.queue-job-filter');
        await expect(bar).toHaveAttribute('style', /background:#ec976c/i);
        await expect(row).not.toHaveAttribute('style', /./);
        await bar.hover();
        const tip = row.locator('.queue-filter-tip');
        await expect(tip).toBeVisible();
        await expect(tip).toHaveText(await page.evaluate(() => window.ILAP.t('filter_not_recommended')));
    });

    test('A double click on the filter square opens the curator in a new tab', async ({ page, context }) => {
        await seedQueue(context, [makeJob({ curatorId: '4777282', curatorName: 'Open me' })]);
        await openPopup(page, context);
        await openApplet(page);

        // The curator page itself is not loaded: an empty stand-in answers it.
        await context.route('https://store.steampowered.com/curator/4777282/**',
            (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' }));
        const opened = context.waitForEvent('page');
        await page.locator('.queue-job-filter').first().dblclick();
        const tab = await opened;
        await expect.poll(() => tab.url()).toMatch(/^https:\/\/store\.steampowered\.com\/curator\/4777282\//);
        await tab.close();
        // The tip under the square is not left selected by the double click.
        expect(await page.evaluate(() => String(window.getSelection()))).toBe('');
    });

    test('A cut name shows whole on hover, in the same type; a name that fits does not', async ({ page, context }) => {
        const long = 'A curator whose name is far too long for the column';
        await seedQueue(context, [makeJob({ curatorName: long }), makeJob({ curatorName: 'Hi' })]);
        await openPopup(page, context);
        await openApplet(page);
        const [cut, short] = [page.locator('.queue-job').nth(0), page.locator('.queue-job').nth(1)];

        await cut.locator('.queue-job-name').hover();
        const full = cut.locator('.queue-name-full');
        await expect(full).toBeVisible();
        await expect(full).toHaveText(long);
        const font = (loc) => loc.evaluate(el => { const c = getComputedStyle(el); return c.fontSize + ' ' + c.fontWeight; });
        expect(await font(full)).toBe(await font(cut.locator('.queue-job-name')));

        await short.locator('.queue-job-name').hover();
        await page.waitForTimeout(700);
        await expect(short.locator('.queue-name-full')).toBeHidden();
    });

    test('Every strip starts its mini bar at the same place, whatever the name, the glyph or the skip count', async ({ page, context }) => {
        // The middle strip is the widest a row gets: a name too long for its
        // column, 100% and the ⚠ skip mark (its count of 128 in the tooltip).
        // They must not squeeze its name column. The un-ignore job has its
        // arrow in front, the built-in list its lists glyph. The statuses are
        // mixed on purpose: a pending job shows the clock in the ⚠ slot, so with
        // every job pending the slot is full on all strips and this test passes
        // with the bars out of line on any real mix.
        const skipping = makeJob({ curatorName: 'A curator whose name is far too long for the column', total: 1000, status: 'paused' });
        await seedQueue(context, [
            makeJob({ id: 'job_preset_ai_2026_1', type: 'preset', curatorId: 'preset_ai_2026', presetKey: 'ai_2026', curatorName: '', status: 'paused' }),
            skipping,
            makeJob({ id: 'job_undo_1', type: 'undo', curatorId: 'undo', curatorName: '', total: 40, scope: { n: 40 } }),
            makeJob({ curatorName: 'Hi', status: 'paused' }),
        ]);
        await setExtensionStorage(context, {
            ['ilap_curator_cursor_' + skipping.id]: 1000,
            ['ilap_curator_skipped_' + skipping.id]: 128,
        });
        await openPopup(page, context);
        await openApplet(page);
        await expect(page.locator('.queue-job-pct').nth(1)).toHaveText('100%');
        const xs = [];
        for (const bar of await page.locator('.queue-mini').all()) xs.push(Math.round((await bar.boundingBox()).x));
        expect(xs).toHaveLength(4);
        expect(new Set(xs).size, `bars start at ${xs.join(', ')}`).toBe(1);
        // The percent keeps the width of "100%", so a job reaching its end moves nothing.
        const widths = await page.locator('.queue-job-pct').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().width)));
        expect(new Set(widths).size, `percent widths ${widths.join(', ')}`).toBe(1);
    });

    test('The skip mark is the ⚠ alone, next to Pause, its count in its tooltip', async ({ page, context }) => {
        // Running: a pending job shows its clock in this slot instead.
        const job = makeJob({ curatorName: 'Skips', total: 100 });
        await setExtensionStorage(context, Object.assign({ ilap_curator_queue: [job], ['ilap_curator_skipped_' + job.id]: 12 }, liveLease(job)));
        await openPopup(page, context);
        await openApplet(page);
        const mark = page.locator('.queue-job-skip');
        // A drawn triangle, as on the widget's cards.
        await expect(mark.locator('svg')).toBeVisible();
        await expect(mark.locator('.queue-skip-tip')).toHaveText(/12/);
        const markBox = await mark.boundingBox();
        const pauseBox = await page.locator('.queue-act.is-pause').boundingBox();
        expect(pauseBox.x - (markBox.x + markBox.width)).toBeLessThan(10);
    });

    test('Games already in the library get their own line under the ⚠, and under a pending job\'s clock', async ({ page, context }) => {
        // The drainer counts a job's owned games on its first pass, so a job
        // still waiting has its count too: the clock's tip shows it.
        const running = makeJob({ curatorName: 'Owned', total: 100 });
        const pending = makeJob({ status: 'pending' });
        await setExtensionStorage(context, Object.assign({
            ilap_curator_queue: [running, pending],
            ['ilap_curator_owned_' + running.id]: 4,
            ['ilap_curator_wishlisted_' + running.id]: 2,
            ['ilap_curator_owned_' + pending.id]: 5,
        }, liveLease(running)));
        await openPopup(page, context);
        await openApplet(page);
        const row = (job) => page.locator(`.queue-job[data-job-id="${job.id}"]`);
        const tip = row(running).locator('.queue-skip-tip');
        await expect(row(running).locator('.queue-job-skip svg')).toBeVisible();
        await expect(tip).toContainText('4 skipped — already in your library');
        await expect(tip).toContainText('2 skipped — on your wishlist');
        const clockTip = row(pending).locator('.queue-job-wait .queue-skip-tip');
        await expect(clockTip).toContainText('Waits for the active task to finish');
        await expect(clockTip).toContainText('5 skipped — already in your library');
        // A later pass's count shows without reopening the panel.
        await setExtensionStorage(context, { ['ilap_curator_owned_' + running.id]: 6 });
        await expect(tip).toContainText('6 skipped — already in your library');
    });

    test('An un-ignore job has the green Undo arrow in front of its name', async ({ page, context }) => {
        await seedQueue(context, [makeJob({ type: 'undo', curatorId: 'undo', curatorName: '', total: 40, scope: { n: 40 } })]);
        await openPopup(page, context);
        await openApplet(page);
        await expect(page.locator('.queue-job-name')).toHaveText('Undo last 40');
        await expect(page.locator('.queue-job-glyph path')).toHaveAttribute('fill', '#4fd64f');
    });

    test('A strip lightens on hover, fading in', async ({ page, context }) => {
        await seedQueue(context, [makeJob({ curatorName: 'Hover me' })]);
        await openPopup(page, context);
        await openApplet(page);
        const row = page.locator('.queue-job').first();
        const bg = () => row.evaluate(el => getComputedStyle(el).backgroundColor);
        const rest = await bg();
        expect(await row.evaluate(el => getComputedStyle(el).transitionProperty)).toContain('background-color');
        await row.locator('.queue-job-name').hover();
        await expect.poll(bg).toBe('rgb(30, 44, 59)');
        expect(rest).not.toBe('rgb(30, 44, 59)');
    });

    test('Chip count updates live as jobs are added/removed via storage', async ({ page, context }) => {
        await seedQueue(context, [makeJob()]);
        await openPopup(page, context);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('1');

        await seedQueue(context, [makeJob(), makeJob()]);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('2');

        await seedQueue(context, []);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('0');
    });

    test('Pause button flips a drainable job to paused in storage', async ({ page, context }) => {
        await seedQueue(context, [makeJob({ status: 'pending' })]);
        await openPopup(page, context);
        await openApplet(page);

        await page.locator('.queue-act.is-pause').first().click();

        await expect.poll(async () => (await readQueue(context))[0].status).toBe('paused');
    });

    test('Enter held on Pause flips the job once, its auto-repeat does nothing', async ({ page, context }) => {
        await seedQueue(context, [makeJob({ status: 'pending' })]);
        await openPopup(page, context);
        await openApplet(page);
        // Every stored status change, counted in the popup itself.
        await page.evaluate(() => {
            window.__flips = 0;
            chrome.storage.onChanged.addListener((ch) => {
                const c = ch.ilap_curator_queue;
                if (c && c.oldValue && c.newValue && c.oldValue[0] && c.newValue[0]
                    && c.oldValue[0].status !== c.newValue[0].status) window.__flips++;
            });
        });

        await page.locator('.queue-act.is-pause').focus();
        for (let i = 0; i < 8; i++) {
            await page.keyboard.down('Enter');
            await page.waitForTimeout(60);
        }
        await page.keyboard.up('Enter');
        await page.waitForTimeout(500);

        expect(await page.evaluate(() => window.__flips)).toBe(1);
        expect((await readQueue(context))[0].status).toBe('paused');
    });

    test('Resume (play) button flips a paused job back to pending (running is never stored)', async ({ page, context }) => {
        await seedQueue(context, [makeJob({ status: 'paused' })]);
        await openPopup(page, context);
        await openApplet(page);

        await page.locator('.queue-act.is-play').first().click();

        await expect.poll(async () => (await readQueue(context))[0].status).toBe('pending');
    });

    test('A removed job\'s strip folds away first, then the job leaves the queue', async ({ page, context }) => {
        const drop = makeJob({ curatorId: '888', curatorName: 'Drop me', status: 'paused' });
        const keep = makeJob({ curatorId: '777', curatorName: 'Keep me' });
        await seedQueue(context, [drop, keep]);
        await openPopup(page, context);
        await openApplet(page);
        const row = page.locator('.queue-job').first();
        await row.locator('[data-act="remove"]').click();
        // The ✕ that keeps the job is green (read with the pointer off it: it
        // pops in under the pointer, and hover lightens it).
        await page.mouse.move(5, 5);
        await expect.poll(() => row.locator('[data-act="cancel"]').evaluate(el => getComputedStyle(el).color)).toBe('rgb(79, 214, 79)');
        await row.locator('[data-act="confirm"]').click();
        // The strip is folding: an animation runs on it, and the job is still stored.
        const folding = await page.locator('.queue-job').first().evaluate(el => el.getAnimations().length);
        expect(folding).toBeGreaterThan(0);
        expect((await readQueue(context)).length).toBe(2);
        await expect.poll(async () => (await readQueue(context)).map(j => j.curatorName)).toEqual(['Keep me']);
        await expect(page.locator('.queue-job')).toHaveCount(1);
    });

    test('Remove (trash) button deletes the job from the queue', async ({ page, context }) => {
        const keep = makeJob({ curatorId: '777', curatorName: 'Keep me' });
        const drop = makeJob({ curatorId: '888', curatorName: 'Drop me', status: 'paused' });
        await seedQueue(context, [drop, keep]);
        await openPopup(page, context);
        await openApplet(page);

        // Remove the first row (Drop me).
        await removeRow(page.locator('.queue-job').first());

        await expect.poll(async () => (await readQueue(context)).map(j => j.curatorName)).toEqual(['Keep me']);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('1');
    });

    test('Removing the last job leaves the drawer open on the empty hint', async ({ page, context }) => {
        await seedQueue(context, [makeJob({ status: 'paused' })]);
        await openPopup(page, context);
        await openApplet(page);

        await removeRow(page.locator('.queue-job').first());

        await expect(page.locator('#queue-list .queue-empty-hint')).toBeVisible();
        await expect(page.locator('#queue-drawer')).toHaveClass(/open/);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('0');
        await expect.poll(async () => (await readQueue(context)).length).toBe(0);
    });

    test('Removing an MI job un-badges its undrained tail (ilap_unignored pulse)', async ({ page, context }) => {
        // The `mi_queue_stuck` card tells the user in so many words to remove
        // the MI job — and every entry the drainer never reached was badged
        // optimistically at swipe time, for a POST that now never fires. The
        // badges have to go with the job, or they lie until the tab reloads.
        const mi = makeJob({
            id: 'job_mi', type: 'mi', curatorId: 'mi', curatorName: '',
            appids: ['10', '11', '12'], meta: {}, total: 3, status: 'paused',
        });
        await setExtensionStorage(context, {
            ilap_curator_queue: [mi],
            ilap_curator_cursor_job_mi: 1,   // '10' was really ignored
        });
        await openPopup(page, context);
        await openApplet(page);
        await removeRow(page.locator('.queue-job').first());

        // '10' keeps its badge (honest); the undrained tail loses its own —
        // silently ('removed'), because the user asked for exactly this. Only
        // 'failed' raises a card, and Steam refused nothing here.
        await expect.poll(async () =>
            (await getExtensionStorage(context, 'ilap_unignored')).ilap_unignored
        ).toMatchObject({ appids: ['11', '12'], reason: 'removed' });
    });

    test('Running indicator: .has-running only while a job holds a live drain lease', async ({ page, context }) => {
        // Pending job, no lease → not running.
        await seedQueue(context, [makeJob()]);
        await openPopup(page, context);
        const btn = page.locator('#queue-btn');
        await expect(btn).not.toHaveClass(/has-running/);

        // Same job with a live lease → running (derived, not stored): a
        // barber pole runs round the icon and the count's outline goes lime.
        const running = makeJob();
        await setExtensionStorage(context, Object.assign({ ilap_curator_queue: [running] }, liveLease(running)));
        await expect(btn).toHaveClass(/has-running/);
        await expect.poll(() => page.locator('.queue-ring-fill').evaluate(el => getComputedStyle(el).stroke)).toBe('rgb(72, 255, 0)');
        expect(await page.locator('.queue-barber').evaluate(el => getComputedStyle(el).animationName)).toBe('ilap-queue-barber');
        await expect.poll(() => page.locator('.queue-barber').evaluate(el => getComputedStyle(el).opacity)).toBe('1');

        // A paused job is never shown running, even with a live lease.
        const paused = makeJob({ status: 'paused' });
        await setExtensionStorage(context, Object.assign({ ilap_curator_queue: [paused] }, liveLease(paused)));
        await expect(btn).not.toHaveClass(/has-running/);
    });

    test('With every job paused the count gives way to a yellow dot, and comes back when one resumes', async ({ page, context }) => {
        const a = makeJob({ status: 'paused' });
        const b = makeJob({ status: 'paused' });
        await seedQueue(context, [a, b]);
        await openPopup(page, context);
        const btn = page.locator('#queue-btn');
        const chip = page.locator('#queue-jobs-chip');
        const dot = (prop) => page.locator('.queue-badge').evaluate((el, p) => getComputedStyle(el, '::after')[p], prop);
        await expect(btn).toHaveClass(/all-paused/);
        await expect.poll(() => chip.evaluate(el => getComputedStyle(el).opacity)).toBe('0');
        await expect.poll(() => dot('opacity')).toBe('1');
        // The Pause key's yellow.
        expect(await dot('backgroundImage')).toContain('rgb(247, 181, 0)');

        // One job waiting again: the count is back, the dot goes.
        await seedQueue(context, [a, Object.assign({}, b, { status: 'pending' })]);
        await expect(btn).not.toHaveClass(/all-paused/);
        await expect(chip).toHaveText('2');
        await expect.poll(() => chip.evaluate(el => getComputedStyle(el).opacity)).toBe('1');
        await expect.poll(() => dot('opacity')).toBe('0');
    });

    test('The mini bar is lime while running (live lease) and while pending, yellow when paused, on a pale track', async ({ page, context }) => {
        const running = makeJob();
        await setExtensionStorage(context, Object.assign({ ilap_curator_queue: [running] }, liveLease(running)));
        await openPopup(page, context);
        await expect(page.locator('.queue-mini-fill')).toHaveAttribute('style', /#48ff00/i);

        await seedQueue(context, [makeJob({ status: 'paused' })]);
        await expect(page.locator('.queue-mini-fill')).toHaveAttribute('style', /#fff44f/i);

        await seedQueue(context, [makeJob({ status: 'pending' })]);
        await expect(page.locator('.queue-mini-fill')).toHaveAttribute('style', /#48ff00/i);
        await expect(page.locator('.queue-mini-line')).toHaveCSS('background-color', 'rgb(147, 169, 194)');
    });

    test('The mini bar stretches left over the name on hover, and the strip keeps its height', async ({ page, context }) => {
        const job = makeJob({ curatorName: 'No AI', total: 4, appids: ['1', '2', '3', '4'], status: 'paused' });
        await setExtensionStorage(context, { ilap_curator_queue: [job], ['ilap_curator_cursor_' + job.id]: 3 });
        await openPopup(page, context);
        await openApplet(page);
        const row = page.locator('.queue-job').first();
        const track = row.locator('.queue-mini-track');
        const before = await track.boundingBox();
        const rowBefore = await row.boundingBox();

        await row.locator('.queue-mini').hover();
        const name = await row.locator('.queue-job-name').boundingBox();
        // Polled: the stretch is a .2s transition.
        await expect.poll(async () => (await track.boundingBox()).x).toBeLessThanOrEqual(name.x + 1);   // over the name
        const after = await track.boundingBox();
        expect(after.x + after.width).toBeCloseTo(before.x + before.width, 0);   // grew to the left
        expect((await row.boundingBox()).height).toBe(rowBefore.height);
        // Paused: the progress made before the pause, in yellow.
        await expect(row.locator('.queue-mini-fill')).toHaveAttribute('style', /width:75%.*#fff44f/i);
    });

    test('A pending job shows a white clock in the ⚠ slot with its tooltip; the ⚠ comes back once it runs', async ({ page, context }) => {
        const running = makeJob();
        const pending = makeJob({ status: 'pending' });
        const paused = makeJob({ status: 'paused' });
        const skips = { ['ilap_curator_skipped_' + pending.id]: 3 };
        await setExtensionStorage(context, Object.assign({ ilap_curator_queue: [running, pending, paused] }, skips, liveLease(running)));
        await openPopup(page, context);
        await openApplet(page);
        const row = (job) => page.locator(`.queue-job[data-job-id="${job.id}"]`);
        await expect(row(running).locator('.queue-job-wait')).toHaveCount(0);
        await expect(row(paused).locator('.queue-job-wait')).toHaveCount(0);
        const clock = row(pending).locator('.queue-job-wait');
        await expect(clock).toBeVisible();
        await expect(clock).toHaveCSS('color', 'rgb(255, 255, 255)');
        await expect(row(pending).locator('.queue-job-skip')).toHaveCount(1);
        await expect(clock.locator('.queue-skip-tip')).toContainText('Waits for the active task to finish');
        // The clock is larger than the ⚠ but takes its width, so the bar stays put.
        const runningSkips = { ['ilap_curator_skipped_' + running.id]: 1 };
        await setExtensionStorage(context, runningSkips);
        await expect(row(running).locator('.queue-job-skip svg')).toBeVisible();
        const barX = async (job) => Math.round((await row(job).locator('.queue-mini').boundingBox()).x);
        expect(await barX(pending)).toBe(await barX(running));
        // A strip with nothing in that slot keeps the same room.
        expect(await barX(paused)).toBe(await barX(pending));

        await setExtensionStorage(context, Object.assign({ ilap_curator_queue: [pending] }, liveLease(pending)));
        await expect(row(pending).locator('.queue-job-wait')).toHaveCount(0);
        await expect(row(pending).locator('.queue-job-skip .queue-skip-tip')).toHaveText(/3/);
    });

    test('Drain progress keeps an open tooltip and the ✓ ✕ of the strips it does not change', async ({ page, context }) => {
        // A drain re-renders the list about once a second. A rebuilt strip
        // would start unhovered, so the clock's tooltip waited out its delay
        // again each time and ✓ ✕ popped in again: both blinked.
        const running = makeJob({ total: 10, appids: Array.from({ length: 10 }, (_, i) => String(i + 1)) });
        const pending = makeJob({ status: 'pending' });
        const cursor = (n) => ({ ['ilap_curator_cursor_' + running.id]: n });
        await setExtensionStorage(context, Object.assign({ ilap_curator_queue: [running, pending] }, cursor(0), liveLease(running)));
        await openPopup(page, context);
        await openApplet(page);
        const row = (job) => page.locator(`.queue-job[data-job-id="${job.id}"]`);
        const tip = row(pending).locator('.queue-skip-tip');
        await row(pending).locator('.queue-job-wait').hover();
        await expect(tip).toHaveCSS('opacity', '1');
        await tip.evaluate(el => { el.__kept = true; });

        await setExtensionStorage(context, cursor(3));
        await expect(row(running).locator('.queue-job-pct')).toHaveText('30%');
        expect(await tip.evaluate(el => el.__kept)).toBe(true);
        await expect(tip).toHaveCSS('opacity', '1');

        await row(running).locator('[data-act="remove"]').click();
        const ok = row(running).locator('[data-act="confirm"]');
        await ok.evaluate(el => { el.__kept = true; });
        await setExtensionStorage(context, cursor(6));
        await expect(row(running).locator('.queue-job-pct')).toHaveText('60%');
        expect(await ok.evaluate(el => el.__kept)).toBe(true);
    });

    test('Drain progress keeps the halt hint in place, with no fade-in on each tick', async ({ page, context }) => {
        // A rebuilt hint counted as a new row and faded in again every second.
        const running = makeJob({ total: 10, appids: Array.from({ length: 10 }, (_, i) => String(i + 1)) });
        const cursor = (n) => ({ ['ilap_curator_cursor_' + running.id]: n });
        await setExtensionStorage(context, Object.assign({ ilap_curator_queue: [running], ilap_sw_halt: true },
            cursor(0), liveLease(running)));
        await openPopup(page, context);
        await openApplet(page);
        const hint = page.locator('.queue-halt-hint');
        await expect(hint).toBeVisible();
        await hint.evaluate(el => { el.__kept = true; });

        await setExtensionStorage(context, cursor(4));
        await expect(page.locator('.queue-job-pct')).toHaveText('40%');
        expect(await hint.evaluate(el => el.__kept)).toBe(true);
        expect(await hint.evaluate(el => el.getAnimations().length)).toBe(0);
    });

    test('Progress count reads the drainer-owned cursor key', async ({ page, context }) => {
        const job = makeJob({ total: 10, appids: Array.from({ length: 10 }, (_, i) => String(i + 1)) });
        await setExtensionStorage(context, {
            ilap_curator_queue: [job],
            ['ilap_curator_cursor_' + job.id]: 4,
        });
        await openPopup(page, context);
        // The strip shows the percent; the bar names the count for screen readers.
        await expect(page.locator('.queue-job-pct')).toHaveText('40%');
        await expect(page.locator('.queue-mini')).toHaveAttribute('aria-label', /4 \/ 10/);
        await expect(page.locator('.queue-mini')).toHaveAttribute('aria-valuenow', '4');
    });

    test('A burst of drain progress collapses into renders, and the LAST one lands', async ({ page, context }) => {
        // Cursor writes are the one storage write this panel cannot keep up with:
        // a dedupe skip sends no POST, so it is not paced by the rate gate and the
        // cursor advances as fast as storage answers. Those renders are throttled
        // to one a second — and a throttle that drops its trailing edge would be
        // worse than none, because the row would then sit on a stale number until
        // something else happened to move.
        const job = makeJob({ total: 10, appids: Array.from({ length: 10 }, (_, i) => String(i + 1)) });
        await setExtensionStorage(context, {
            ilap_curator_queue: [job],
            ['ilap_curator_cursor_' + job.id]: 0,
        });
        await openPopup(page, context);
        await expect(page.locator('.queue-job-pct')).toHaveText('0%');

        for (let i = 1; i <= 8; i++) {
            await setExtensionStorage(context, { ['ilap_curator_cursor_' + job.id]: i });
        }

        await expect(page.locator('.queue-job-pct')).toHaveText('80%');
    });

    test('...and that burst costs far fewer rebuilds than it has writes', async ({ page, context }) => {
        // The other half of the throttle: the trailing edge landing is worth
        // nothing if every write still rebuilt the list on its way there. Count
        // the rebuilds rather than trust the clock — a render patches the list
        // in one synchronous pass, which the observer delivers as one batch.
        const job = makeJob({ total: 10, appids: Array.from({ length: 10 }, (_, i) => String(i + 1)) });
        await setExtensionStorage(context, {
            ilap_curator_queue: [job],
            ['ilap_curator_cursor_' + job.id]: 0,
        });
        await openPopup(page, context);
        await expect(page.locator('.queue-job-pct')).toHaveText('0%');

        await page.evaluate(() => {
            window.__ilapRebuilds = 0;
            new MutationObserver(() => { window.__ilapRebuilds += 1; })
                .observe(document.getElementById('queue-list'), { childList: true, subtree: true, characterData: true, attributes: true });
        });

        const WRITES = 8;
        for (let i = 1; i <= WRITES; i++) {
            await setExtensionStorage(context, { ['ilap_curator_cursor_' + job.id]: i });
        }
        await expect(page.locator('.queue-job-pct')).toHaveText('80%');

        const rebuilds = await page.evaluate(() => window.__ilapRebuilds);
        expect(rebuilds).toBeGreaterThan(0);
        // One trailing render a second. The ceiling is generous on purpose — a
        // slow machine may stretch the burst over a few windows — but an
        // unthrottled path costs one rebuild per write and blows straight past it.
        expect(rebuilds, `${WRITES} cursor writes must not cost ${WRITES} rebuilds`)
            .toBeLessThanOrEqual(4);
    });

    test('A Manual-Ignore job renders highlighted with a remaining COUNT (no filter, no bar)', async ({ page, context }) => {
        // The MI job auto-fills while it drains, so a percent would jump backward
        // on a fresh swipe — it shows a live remaining count instead, gets the
        // distinct .mi highlight, and (like undo) has no filter square.
        const job = makeJob({
            id: 'job_mi', type: 'mi', curatorId: 'mi', curatorName: '',
            total: 5, appids: ['1', '2', '3', '4', '5'],
        });
        await setExtensionStorage(context, {
            ilap_curator_queue: [job],
            ['ilap_curator_cursor_' + job.id]: 2,   // 2 drained → 3 remaining
        });
        await openPopup(page, context);
        await openApplet(page);

        const row = page.locator('.queue-job.mi');
        await expect(row).toBeVisible();
        await expect(row.locator('.queue-job-name')).toHaveText('Manual ignores');
        await expect(row.locator('.queue-job-count')).toHaveText('3');
        await expect(row.locator('.queue-job-count')).toHaveAttribute('aria-label', /In queue: 3/);
        await expect(row.locator('.queue-mini')).toHaveCount(0);       // no percent bar
        await expect(row.locator('.queue-job-filter')).toHaveCount(0);
        // Still a normal job: Pause and Remove.
        await expect(row.locator('.queue-act[data-act="pause"]')).toBeVisible();
        await expect(row.locator('.queue-act[data-act="remove"]')).toBeVisible();
    });

    test('The un-ignore job renders like its twin but under its OWN name', async ({ page, context }) => {
        // Both gesture jobs auto-fill and share the .mi treatment (the drainer
        // calls the same bucket `isForeground`) — the name is what has to differ,
        // because the two rows are what the user picks between when a "queue is
        // stuck" card tells them to remove one.
        const job = makeJob({
            id: 'job_mi_undo', type: 'miundo', curatorId: 'miundo', curatorName: '',
            total: 4, appids: ['1', '2', '3', '4'],
        });
        await setExtensionStorage(context, {
            ilap_curator_queue: [job],
            ['ilap_curator_cursor_' + job.id]: 1,   // 1 rolled back → 3 remaining
        });
        await openPopup(page, context);
        await openApplet(page);

        const row = page.locator('.queue-job.mi');
        await expect(row).toBeVisible();
        await expect(row.locator('.queue-job-name')).toHaveText('Manual un-ignores');
        await expect(row.locator('.queue-job-count')).toHaveText('3');
        await expect(row.locator('.queue-job-count')).toHaveAttribute('aria-label', /In queue: 3/);
        await expect(row.locator('.queue-mini')).toHaveCount(0);
        await expect(row.locator('.queue-act[data-act="pause"]')).toBeVisible();
    });

    test('Remove stays in place whether the job runs or is paused, well apart from Pause', async ({ page, context }) => {
        await seedQueue(context, [makeJob({ curatorName: 'Live' })]);
        await openPopup(page, context);
        await openApplet(page);
        const row = page.locator('.queue-job').first();
        const del = row.locator('[data-act="remove"]');
        await expect(del).toBeVisible();
        const before = await del.boundingBox();
        const gap = async () => {
            const play = await row.locator('[data-act="pause"]').boundingBox();
            return (await del.boundingBox()).x - (play.x + play.width);
        };
        // 10px with the rule between them: room enough that a slip meant for
        // Pause misses Remove, while a strip with 100% and the ⚠ still fits.
        expect(await gap()).toBeGreaterThanOrEqual(10);

        await row.locator('[data-act="pause"]').click();
        await expect(row.locator('.queue-act.is-play')).toBeVisible();
        await expect(del).toBeVisible();
        expect(Math.round((await del.boundingBox()).x)).toBe(Math.round(before.x));
        expect(await gap()).toBeGreaterThanOrEqual(10);
    });

    test('A running job can be removed too, after the same ✓', async ({ page, context }) => {
        const running = makeJob({ curatorName: 'Running' });
        await setExtensionStorage(context, Object.assign({ ilap_curator_queue: [running] }, liveLease(running)));
        await openPopup(page, context);
        await openApplet(page);
        const row = page.locator('.queue-job').first();
        await expect(row.locator('.queue-act.is-pause')).toBeVisible();
        // A running job's strip has the moving sheen and its relief (lit top
        // edge, shaded bottom), as in 1.3.5.
        await expect(row).toHaveClass(/\brunning\b/);
        expect(await row.evaluate(el => getComputedStyle(el).animationName)).toBe('ilap-job-sheen');
        expect(await row.evaluate(el => getComputedStyle(el).boxShadow)).toContain('inset');

        await row.locator('[data-act="remove"]').click();
        expect((await readQueue(context)).map(j => j.curatorName)).toEqual(['Running']);
        await row.locator('[data-act="confirm"]').click();
        await expect.poll(async () => (await readQueue(context)).length).toBe(0);
    });

    test('The running strip\'s sheen keeps its phase across drain ticks, and stays still under reduced motion', async ({ page, context }) => {
        const running = makeJob({ curatorName: 'Sheen', total: 100 });
        const pending = makeJob({ status: 'pending' });
        await setExtensionStorage(context, Object.assign({ ilap_curator_queue: [running, pending] }, liveLease(running)));
        await openPopup(page, context);
        await openApplet(page);
        const row = (job) => page.locator(`.queue-job[data-job-id="${job.id}"]`);
        const tip = row(running).locator('.queue-skip-tip');
        // Only the running strip sweeps, the one waiting its turn is still.
        expect(await row(pending).evaluate(el => getComputedStyle(el).animationName)).toBe('none');
        const delay = await row(running).evaluate(el => { window.__strip = el; return el.style.animationDelay; });
        expect(delay).toMatch(/^-\d+ms$/);
        // A tick re-renders the list. The strip stays the same node with the
        // same delay, so the sweep goes on where it was.
        await setExtensionStorage(context, { ['ilap_curator_owned_' + running.id]: 3 });
        await expect(tip).toContainText('3 skipped — already in your library');
        expect(await row(running).evaluate(el => el === window.__strip && el.style.animationDelay)).toBe(delay);

        await page.emulateMedia({ reducedMotion: 'reduce' });
        expect(await row(running).evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    });

    test('Remove asks first: ✓ in Pause\'s place removes, ✕ in Remove\'s place keeps the job', async ({ page, context }) => {
        await seedQueue(context, [makeJob({ curatorName: 'Asked', status: 'paused' })]);
        await openPopup(page, context);
        await openApplet(page);
        const row = page.locator('.queue-job').first();
        const slots = () => Promise.all(['pause', 'remove'].map(a => row.locator(`[data-act="${a}"]`).boundingBox()));
        const [playBox, delBox] = await slots();

        await row.locator('[data-act="remove"]').click();
        const ok = row.locator('[data-act="confirm"]');
        const no = row.locator('[data-act="cancel"]');
        await expect(row.locator('[data-act="pause"], [data-act="remove"]')).toHaveCount(0);
        // Polled: both pop in scaled down.
        await expect.poll(async () => Math.round((await ok.boundingBox()).x)).toBe(Math.round(playBox.x));
        await expect.poll(async () => Math.round((await no.boundingBox()).x)).toBe(Math.round(delBox.x));
        // Nothing was removed by the trash alone.
        expect((await readQueue(context)).map(j => j.curatorName)).toEqual(['Asked']);

        await no.click();
        await expect(row.locator('[data-act="remove"]')).toBeVisible();
        await expect(ok).toHaveCount(0);
        expect((await readQueue(context)).map(j => j.curatorName)).toEqual(['Asked']);

        await removeRow(row);
        await expect.poll(async () => (await readQueue(context)).length).toBe(0);
    });

    test('Both gesture jobs show side by side, each named for its own direction', async ({ page, context }) => {
        // They coexist by construction (separate jobs, separate leases, separate
        // caps), so the applet has to tell them apart on screen too.
        await seedQueue(context, [
            makeJob({ id: 'job_mi', type: 'mi', curatorId: 'mi', curatorName: '', total: 2, appids: ['1', '2'] }),
            makeJob({ id: 'job_mi_undo', type: 'miundo', curatorId: 'miundo', curatorName: '', total: 1, appids: ['3'] }),
        ]);
        await openPopup(page, context);
        await openApplet(page);

        await expect(page.locator('.queue-job.mi')).toHaveCount(2);
        await expect(page.locator('.queue-job-name')).toHaveText(
            ['Manual ignores', 'Manual un-ignores']);
    });

    test('Gesture jobs always show at the bottom, whatever their place in the queue', async ({ page, context }) => {
        await seedQueue(context, [
            makeJob({ id: 'job_mi', type: 'mi', curatorId: 'mi', curatorName: '', total: 2, appids: ['1', '2'] }),
            makeJob({ curatorName: 'First curator' }),
            makeJob({ id: 'job_mi_undo', type: 'miundo', curatorId: 'miundo', curatorName: '', total: 1, appids: ['3'] }),
            makeJob({ curatorName: 'Second curator' }),
        ]);
        await openPopup(page, context);
        await openApplet(page);

        await expect(page.locator('.queue-job-name')).toHaveText(
            ['First curator', 'Second curator', 'Manual ignores', 'Manual un-ignores']);
    });

    test('Removing an un-ignore job with work left reports the stranded rollbacks', async ({ page, context }) => {
        // The mirror of the MI removal above: nothing on the page is wrong (the
        // games stay ignored), but the pending marks those gestures left have to
        // come off — silently, since the user dropped the job themselves.
        const job = makeJob({
            id: 'job_mi_undo', type: 'miundo', curatorId: 'miundo', curatorName: '',
            total: 3, appids: ['20', '21', '22'], status: 'paused',
        });
        await setExtensionStorage(context, {
            ilap_curator_queue: [job],
            ilap_curator_cursor_job_mi_undo: 1,
        });
        await openPopup(page, context);
        await openApplet(page);
        await removeRow(page.locator('.queue-job').first());

        await expect.poll(async () =>
            (await getExtensionStorage(context, 'ilap_undo_failed')).ilap_undo_failed
        ).toMatchObject({ reason: 'removed' });
        // No un-badge pulse: an un-ignore job never badged anything.
        expect((await getExtensionStorage(context, 'ilap_unignored')).ilap_unignored)
            .toBeUndefined();
    });

    test('A job of a type this build does not know renders under its record name and can be removed', async ({ page, context }) => {
        // What a downgrade leaves behind. The drainer skips it (it could be a
        // rollback); the applet must still show it, not break on it, and let the
        // user get rid of it — next to a normal job that renders as usual.
        const unknown = makeJob({ type: 'from-a-newer-build', curatorId: 'newer', curatorName: 'Newer job', status: 'paused' });
        const normal = makeJob({ curatorName: 'Normal' });
        await seedQueue(context, [unknown, normal]);
        await openPopup(page, context);
        await openApplet(page);

        const rows = page.locator('.queue-job');
        await expect(rows).toHaveCount(2);
        const row = rows.first();
        await expect(row.locator('.queue-job-name')).toHaveText('Newer job');
        await expect(row).not.toHaveClass(/\bmi\b/);                // not drawn as a gesture job
        await expect(rows.nth(1).locator('.queue-job-name')).toHaveText('Normal');

        await removeRow(row);
        await expect.poll(async () => (await readQueue(context)).map(j => j.curatorName)).toEqual(['Normal']);
    });
});
