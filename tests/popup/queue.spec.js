const { test, expect } = require('../_fixtures.js');
const {
    getExtensionId,
    setExtensionStorage,
    getExtensionStorage,
    clearExtensionStorage,
    popupUrl,
} = require('../_extension.js');

// Phase-2 curator ignore-queue applet, popup/widget side. These tests drive the
// `ui/popup_queue.js` view through the popup window (ui/popup.html) — no Steam
// login or live page needed. They cover the SCAFFOLDING the user asked for:
// hidden-when-empty restriction, the jobs-count chip, per-job pause/remove
// buttons, the running indicator, category colours and accordion mutual
// exclusion. Draining/enumeration is not wired yet, so nothing here ignores a
// real game — every job is a hand-seeded storage entry.

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

async function readQueue(context) {
    const res = await getExtensionStorage(context, 'ilap_curator_queue');
    return Array.isArray(res.ilap_curator_queue) ? res.ilap_curator_queue : [];
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

test.describe('Popup — ignore-queue applet', () => {

    test('Applet is hidden when the queue is empty', async ({ page, context }) => {
        await openPopup(page, context);
        await expect(page.locator('#queue-accordion')).toBeHidden();
    });

    test('Applet stays hidden when the queue is empty even with the master locked OFF', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_master_enabled: false });
        await openPopup(page, context);

        // UI is locked (wrapper dimmed) but the queue applet must NOT appear.
        await expect(page.locator('#ui-wrapper')).toHaveClass(/disabled/);
        await expect(page.locator('#queue-accordion')).toBeHidden();
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
        await expect(page.locator('#queue-accordion')).toBeVisible();
        await expect(page.locator('#queue-jobs-chip')).toHaveText('3');

        // The applet is exempt from the panel lock — but only half of it. Remove
        // acts; Pause/Resume is blocked, because a disabled extension must not let
        // you ask for a run it cannot perform.
        await page.locator('#queue-accordion summary').click();
        for (const row of await page.locator('.queue-act[data-act="pause"]').all()) {
            await expect(row).toBeDisabled();
        }
        await page.locator('.queue-act-del').first().click();
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
        await page.locator('#queue-accordion summary').click();

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

    test('Applet appears once there are jobs; the chip shows the job count', async ({ page, context }) => {
        await seedQueue(context, [makeJob(), makeJob()]);
        await openPopup(page, context);

        await expect(page.locator('#queue-accordion')).toBeVisible();
        await expect(page.locator('#queue-jobs-chip')).toHaveText('2');
    });

    test('A job row renders its curator name and filter label', async ({ page, context }) => {
        await seedQueue(context, [makeJob({ curatorName: 'No AI', filter: 'not_recommended' })]);
        await openPopup(page, context);
        await page.locator('#queue-accordion summary').click();

        const row = page.locator('.queue-job').first();
        await expect(row.locator('.queue-job-name')).toHaveText('No AI');
        await expect(row.locator('.queue-job-sub')).toContainText('Not Recommended only');
    });

    test('Chip count updates live as jobs are added/removed via storage', async ({ page, context }) => {
        await seedQueue(context, [makeJob()]);
        await openPopup(page, context);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('1');

        await seedQueue(context, [makeJob(), makeJob()]);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('2');

        await seedQueue(context, []);
        await expect(page.locator('#queue-accordion')).toBeHidden();
    });

    test('Pause button flips a drainable job to paused in storage', async ({ page, context }) => {
        await seedQueue(context, [makeJob({ status: 'pending' })]);
        await openPopup(page, context);
        await page.locator('#queue-accordion summary').click();

        await page.locator('.queue-act.is-pause').first().click();

        await expect.poll(async () => (await readQueue(context))[0].status).toBe('paused');
    });

    test('Resume (play) button flips a paused job back to pending (running is never stored)', async ({ page, context }) => {
        await seedQueue(context, [makeJob({ status: 'paused' })]);
        await openPopup(page, context);
        await page.locator('#queue-accordion summary').click();

        await page.locator('.queue-act.is-play').first().click();

        await expect.poll(async () => (await readQueue(context))[0].status).toBe('pending');
    });

    test('Remove (trash) button deletes the job from the queue', async ({ page, context }) => {
        const keep = makeJob({ curatorId: '777', curatorName: 'Keep me' });
        const drop = makeJob({ curatorId: '888', curatorName: 'Drop me' });
        await seedQueue(context, [drop, keep]);
        await openPopup(page, context);
        await page.locator('#queue-accordion summary').click();

        // Remove the first row (Drop me).
        await page.locator('.queue-act-del').first().click();

        await expect.poll(async () => (await readQueue(context)).map(j => j.curatorName)).toEqual(['Keep me']);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('1');
    });

    test('Removing the last job hides the applet again', async ({ page, context }) => {
        await seedQueue(context, [makeJob()]);
        await openPopup(page, context);
        await page.locator('#queue-accordion summary').click();

        await page.locator('.queue-act-del').first().click();

        await expect(page.locator('#queue-accordion')).toBeHidden();
        await expect.poll(async () => (await readQueue(context)).length).toBe(0);
    });

    test('Removing an MI job un-badges its undrained tail (ilap_unignored pulse)', async ({ page, context }) => {
        // The `mi_queue_stuck` card tells the user in so many words to remove
        // the MI job — and every entry the drainer never reached was badged
        // optimistically at swipe time, for a POST that now never fires. The
        // badges have to go with the job, or they lie until the tab reloads.
        const mi = makeJob({
            id: 'job_mi', type: 'mi', curatorId: 'mi', curatorName: '',
            appids: ['10', '11', '12'], meta: {}, total: 3,
        });
        await setExtensionStorage(context, {
            ilap_curator_queue: [mi],
            ilap_curator_cursor_job_mi: 1,   // '10' was really ignored
        });
        await openPopup(page, context);
        await page.locator('#queue-accordion summary').click();
        await page.locator('.queue-act-del').first().click();

        // '10' keeps its badge (honest); the undrained tail loses its own —
        // silently ('removed'), because the user asked for exactly this. Only
        // 'failed' raises a card, and Steam refused nothing here.
        await expect.poll(async () =>
            (await getExtensionStorage(context, 'ilap_unignored')).ilap_unignored
        ).toMatchObject({ appids: ['11', '12'], reason: 'removed' });
    });

    test('Barber-pole running indicator: .has-running only while a job holds a live drain lease', async ({ page, context }) => {
        // Pending job, no lease → not running.
        await seedQueue(context, [makeJob()]);
        await openPopup(page, context);
        await expect(page.locator('#queue-accordion')).not.toHaveClass(/has-running/);

        // Same job with a live lease → running (derived, not stored).
        const running = makeJob();
        await setExtensionStorage(context, Object.assign({ ilap_curator_queue: [running] }, liveLease(running)));
        await expect(page.locator('#queue-accordion')).toHaveClass(/has-running/);

        // A paused job is never shown running, even with a live lease.
        const paused = makeJob({ status: 'paused' });
        await setExtensionStorage(context, Object.assign({ ilap_curator_queue: [paused] }, liveLease(paused)));
        await expect(page.locator('#queue-accordion')).not.toHaveClass(/has-running/);
    });

    test('Status label is coloured green for running (live lease) and yellow for paused', async ({ page, context }) => {
        const running = makeJob();
        await setExtensionStorage(context, Object.assign({ ilap_curator_queue: [running] }, liveLease(running)));
        await openPopup(page, context);
        await expect(page.locator('.queue-job-status')).toHaveAttribute('style', /#7ad13f/i);

        await seedQueue(context, [makeJob({ status: 'paused' })]);
        await expect(page.locator('.queue-job-status')).toHaveAttribute('style', /#ffd21a/i);
    });

    test('Progress count reads the drainer-owned cursor key', async ({ page, context }) => {
        const job = makeJob({ total: 10, appids: Array.from({ length: 10 }, (_, i) => String(i + 1)) });
        await setExtensionStorage(context, {
            ilap_curator_queue: [job],
            ['ilap_curator_cursor_' + job.id]: 4,
        });
        await openPopup(page, context);
        // The count carries the inline percent badge (.queue-job-pct).
        await expect(page.locator('.queue-job-count')).toHaveText('4 / 10 40%');
        await expect(page.locator('.queue-job-pct')).toHaveText('40%');
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
        await expect(page.locator('.queue-job-count')).toHaveText('0 / 10 0%');

        for (let i = 1; i <= 8; i++) {
            await setExtensionStorage(context, { ['ilap_curator_cursor_' + job.id]: i });
        }

        await expect(page.locator('.queue-job-count')).toHaveText('8 / 10 80%');
    });

    test('...and that burst costs far fewer rebuilds than it has writes', async ({ page, context }) => {
        // The other half of the throttle: the trailing edge landing is worth
        // nothing if every write still rebuilt the list on its way there. Count
        // the rebuilds rather than trust the clock — one innerHTML assignment is
        // one childList batch on #queue-list, and the i18n pass that follows
        // touches descendants only (no subtree: true here, so it is not counted).
        const job = makeJob({ total: 10, appids: Array.from({ length: 10 }, (_, i) => String(i + 1)) });
        await setExtensionStorage(context, {
            ilap_curator_queue: [job],
            ['ilap_curator_cursor_' + job.id]: 0,
        });
        await openPopup(page, context);
        await expect(page.locator('.queue-job-count')).toHaveText('0 / 10 0%');

        await page.evaluate(() => {
            window.__ilapRebuilds = 0;
            new MutationObserver(() => { window.__ilapRebuilds += 1; })
                .observe(document.getElementById('queue-list'), { childList: true });
        });

        const WRITES = 8;
        for (let i = 1; i <= WRITES; i++) {
            await setExtensionStorage(context, { ['ilap_curator_cursor_' + job.id]: i });
        }
        await expect(page.locator('.queue-job-count')).toHaveText('8 / 10 80%');

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
        // on a fresh swipe — it shows a live "In queue: N" count instead, gets the
        // distinct .mi highlight, and (like undo) has no filter sub-line.
        const job = makeJob({
            id: 'job_mi', type: 'mi', curatorId: 'mi', curatorName: '',
            total: 5, appids: ['1', '2', '3', '4', '5'],
        });
        await setExtensionStorage(context, {
            ilap_curator_queue: [job],
            ['ilap_curator_cursor_' + job.id]: 2,   // 2 drained → 3 remaining
        });
        await openPopup(page, context);
        await page.locator('#queue-accordion summary').click();

        const row = page.locator('.queue-job.mi');
        await expect(row).toBeVisible();
        await expect(row.locator('.queue-job-name')).toHaveText('Manual ignores');
        await expect(row.locator('.queue-job-count')).toHaveText('In queue: 3');
        await expect(row.locator('.queue-job-sub')).toHaveCount(0);   // no filter line
        await expect(row.locator('.queue-bar')).toHaveCount(0);       // no percent bar
        await expect(row.locator('.queue-job-pct')).toHaveCount(0);
        // Still a normal job: pause/remove controls present.
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
        await page.locator('#queue-accordion summary').click();

        const row = page.locator('.queue-job.mi');
        await expect(row).toBeVisible();
        await expect(row.locator('.queue-job-name')).toHaveText('Manual un-ignores');
        await expect(row.locator('.queue-job-count')).toHaveText('In queue: 3');
        await expect(row.locator('.queue-job-sub')).toHaveCount(0);
        await expect(row.locator('.queue-bar')).toHaveCount(0);
        await expect(row.locator('.queue-act[data-act="remove"]')).toBeVisible();
    });

    test('Both gesture jobs show side by side, each named for its own direction', async ({ page, context }) => {
        // They coexist by construction (separate jobs, separate leases, separate
        // caps), so the applet has to tell them apart on screen too.
        await seedQueue(context, [
            makeJob({ id: 'job_mi', type: 'mi', curatorId: 'mi', curatorName: '', total: 2, appids: ['1', '2'] }),
            makeJob({ id: 'job_mi_undo', type: 'miundo', curatorId: 'miundo', curatorName: '', total: 1, appids: ['3'] }),
        ]);
        await openPopup(page, context);
        await page.locator('#queue-accordion summary').click();

        await expect(page.locator('.queue-job.mi')).toHaveCount(2);
        await expect(page.locator('.queue-job-name')).toHaveText(
            ['Manual ignores', 'Manual un-ignores']);
    });

    test('Removing an un-ignore job with work left reports the stranded rollbacks', async ({ page, context }) => {
        // The mirror of the MI removal above: nothing on the page is wrong (the
        // games stay ignored), but the pending marks those gestures left have to
        // come off — silently, since the user dropped the job themselves.
        const job = makeJob({
            id: 'job_mi_undo', type: 'miundo', curatorId: 'miundo', curatorName: '',
            total: 3, appids: ['20', '21', '22'],
        });
        await setExtensionStorage(context, {
            ilap_curator_queue: [job],
            ilap_curator_cursor_job_mi_undo: 1,
        });
        await openPopup(page, context);
        await page.locator('#queue-accordion summary').click();
        await page.locator('.queue-act-del').first().click();

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
        const unknown = makeJob({ type: 'from-a-newer-build', curatorId: 'newer', curatorName: 'Newer job' });
        const normal = makeJob({ curatorName: 'Normal' });
        await seedQueue(context, [unknown, normal]);
        await openPopup(page, context);
        await page.locator('#queue-accordion summary').click();

        const rows = page.locator('.queue-job');
        await expect(rows).toHaveCount(2);
        const row = rows.first();
        await expect(row.locator('.queue-job-name')).toHaveText('Newer job');
        await expect(row.locator('.queue-job-sub')).toHaveCount(0);   // no curator filter to name
        await expect(row).not.toHaveClass(/\bmi\b/);                // not drawn as a gesture job
        await expect(rows.nth(1).locator('.queue-job-name')).toHaveText('Normal');

        await row.locator('.queue-act-del').click();
        await expect.poll(async () => (await readQueue(context)).map(j => j.curatorName)).toEqual(['Normal']);
    });

    test('Filter label uses the Steam category colour (orange for Not Recommended)', async ({ page, context }) => {
        await seedQueue(context, [makeJob({ filter: 'not_recommended' })]);
        await openPopup(page, context);
        await expect(page.locator('.queue-job-sub')).toHaveAttribute('style', /#ec976c/i);
    });

    test('"All except Recommended" filter label is rendered as a gradient', async ({ page, context }) => {
        await seedQueue(context, [makeJob({ filter: 'all_but_recommended' })]);
        await openPopup(page, context);

        const sub = page.locator('.queue-job-sub');
        await expect(sub).toContainText('All except Recommended');
        await expect(sub).toHaveAttribute('style', /linear-gradient/i);
    });

    test('Queue applet sits ABOVE the Settings applet', async ({ page, context }) => {
        await seedQueue(context, [makeJob()]);
        await openPopup(page, context);

        const order = await page.evaluate(() => {
            const q = document.getElementById('queue-accordion');
            const s = document.getElementById('settings-accordion');
            return (q.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'queue-first' : 'settings-first';
        });
        expect(order).toBe('queue-first');
    });

    test('Queue and Settings applets are mutually exclusive', async ({ page, context }) => {
        await seedQueue(context, [makeJob()]);
        await openPopup(page, context);

        const queueAcc = page.locator('#queue-accordion');
        const settingsAcc = page.locator('#settings-accordion');
        // Settings now nests subcategory <summary>s; target its own summary only.
        const settingsSummary = page.locator('#settings-accordion > summary');

        // Open Settings first.
        await settingsSummary.click();
        await expect(settingsAcc).toHaveJSProperty('open', true);

        // Opening the Queue collapses Settings.
        await queueAcc.locator('summary').click();
        await expect(queueAcc).toHaveJSProperty('open', true);
        await expect(settingsAcc).toHaveJSProperty('open', false);

        // Re-opening Settings collapses the Queue.
        await settingsSummary.click();
        await expect(settingsAcc).toHaveJSProperty('open', true);
        await expect(queueAcc).toHaveJSProperty('open', false);
    });

    // The Queue↔Settings collapse must happen in ONE synchronous frame so the tall
    // SETTINGS panel never flashes to full height before snapping shut. These cover
    // the two states the panel can be in when the Queue is opened over it.
    test('Opening the Queue collapses SETTINGS in the same frame with a subcategory expanded (and restores it on reopen)', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_settings_open: true, ilap_mi_open: true });
        await seedQueue(context, [makeJob()]);
        await openPopup(page, context);
        await page.locator('#mi-section').waitFor();
        await expect(page.locator('#settings-accordion')).toHaveJSProperty('open', true);
        await expect(page.locator('#mi-section')).toHaveJSProperty('open', true);

        // Click the queue summary and read both open states WITHOUT yielding a paint.
        const states = await page.evaluate(() => {
            const s = document.getElementById('settings-accordion');
            const q = document.getElementById('queue-accordion');
            q.querySelector(':scope > summary').click();
            return { settingsOpen: s.open, queueOpen: q.open, settingsSolo: s.classList.contains('solo-collapse') };
        });
        // Never a both-open frame; and a concurrent collapse is NOT marked solo (snaps, no anim).
        expect(states).toEqual({ settingsOpen: false, queueOpen: true, settingsSolo: false });

        // Reopening SETTINGS restores the previously-expanded subcategory.
        await page.locator('#settings-accordion > summary').click();
        await expect(page.locator('#settings-accordion')).toHaveJSProperty('open', true);
        await expect(page.locator('#mi-section')).toHaveJSProperty('open', true);
    });

    test('Opening the Queue collapses SETTINGS in the same frame with both subcategories collapsed', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_settings_open: true });
        await seedQueue(context, [makeJob()]);
        await openPopup(page, context);
        await expect(page.locator('#settings-accordion')).toHaveJSProperty('open', true);
        await expect(page.locator('#dq-section')).toHaveJSProperty('open', false);
        await expect(page.locator('#mi-section')).toHaveJSProperty('open', false);

        const states = await page.evaluate(() => {
            const s = document.getElementById('settings-accordion');
            const q = document.getElementById('queue-accordion');
            q.querySelector(':scope > summary').click();
            return { settingsOpen: s.open, queueOpen: q.open };
        });
        expect(states).toEqual({ settingsOpen: false, queueOpen: true });
    });

    test('Closing SETTINGS on its own marks it .solo-collapse (animated close)', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_settings_open: true });
        await seedQueue(context, [makeJob()]);
        await openPopup(page, context);
        await expect(page.locator('#settings-accordion')).toHaveJSProperty('open', true);

        await page.locator('#settings-accordion > summary').click();
        await expect(page.locator('#settings-accordion')).toHaveJSProperty('open', false);
        await expect(page.locator('#settings-accordion')).toHaveClass(/solo-collapse/);
    });
});
