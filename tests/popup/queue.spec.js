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
        await expect(page.locator('.queue-job-count')).toHaveText('4 / 10');
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

        // Open Settings first.
        await settingsAcc.locator('summary').click();
        await expect(settingsAcc).toHaveJSProperty('open', true);

        // Opening the Queue collapses Settings.
        await queueAcc.locator('summary').click();
        await expect(queueAcc).toHaveJSProperty('open', true);
        await expect(settingsAcc).toHaveJSProperty('open', false);

        // Re-opening Settings collapses the Queue.
        await settingsAcc.locator('summary').click();
        await expect(settingsAcc).toHaveJSProperty('open', true);
        await expect(queueAcc).toHaveJSProperty('open', false);
    });
});
