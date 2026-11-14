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

        // Double-clicking the empty field takes the whole undoable list (2 entries),
        // and leaves it selected so a smaller number can be typed straight over it.
        await page.locator('#undo-count').dblclick();
        await expect(page.locator('#undo-count')).toHaveValue('2');
        expect(await page.evaluate(() => {
            const el = document.getElementById('undo-count');
            return el.value.slice(el.selectionStart, el.selectionEnd);
        })).toBe('2');
        await page.locator('#undo-go').click();

        await expect.poll(async () => {
            const res = await getExtensionStorage(context, 'ilap_curator_queue');
            return (res.ilap_curator_queue || []).length;
        }).toBe(1);
        const res = await getExtensionStorage(context, 'ilap_curator_queue');
        const job = res.ilap_curator_queue[0];
        expect(job.type).toBe('undo');
        // The list is stored under its own key (Store.getList).
        const listKey = 'ilap_curator_appids_' + job.id;
        const appids = (await getExtensionStorage(context, listKey))[listKey];
        expect(appids.sort()).toEqual(['1', '2']);       // both log entries, clamped to the log
        expect(job.scope).toEqual({ n: 2 });             // what was asked, for the job's name

        // The staged rollback shows up in the queue, whose drawer opens for it.
        await expect(page.locator('#queue-btn')).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('#queue-drawer')).toHaveClass(/open/);
        await expect(page.locator('#queue-list')).toBeVisible();
    });

    test('A staged rollback flies its row into the job count: no message under the menu, the menu shuts, the queue opens after', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ignore_log: [logEntry(1), logEntry(2)] });
        await openPopup(page, context);
        await page.locator('#undo-btn').click();
        await page.locator('#undo-count').dblclick();
        await expect(page.locator('#undo-count')).toHaveValue('2');
        await page.locator('#undo-go').click();
        // The row's copy, with its number, flies; the count holds 0 until it lands.
        const ghost = page.locator('#ilap-shell > .list-ghost');
        await expect(ghost).toHaveCount(1);
        expect(await ghost.locator('input').getAttribute('value')).toBe('2');
        // It flies with the field's own look, not a white browser field.
        const field = await page.locator('#undo-count').evaluate(el => getComputedStyle(el).backgroundColor);
        expect(await ghost.locator('input').evaluate(el => getComputedStyle(el).backgroundColor)).toBe(field);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('0');
        await expect(page.locator('#undo-menu')).not.toHaveClass(/open/);
        await expect(ghost).toHaveCount(0);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('1');
        await expect(page.locator('#queue-drawer')).toHaveClass(/open/);
        await expect(page.locator('#undo-msg')).toBeHidden();
    });

    test('A job staged by time is named for its window in the queue', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ignore_log: [logEntry(1), logEntry(2)] });
        await openPopup(page, context);

        await page.locator('#undo-btn').click();
        await page.locator('#undo-time').fill('2');
        await page.locator('#undo-unit-d').click();
        await page.locator('#undo-go').click();

        await expect.poll(async () => {
            const res = await getExtensionStorage(context, 'ilap_curator_queue');
            return (res.ilap_curator_queue || [])[0];
        }).toMatchObject({ type: 'undo', scope: { n: 2, unit: 'd' } });
        // Staging opened the queue's drawer already.
        await expect(page.locator('#queue-drawer')).toHaveClass(/open/);
        await expect(page.locator('.queue-job .queue-job-name')).toHaveText('Undo last 2 d');
    });

    test('The -[ ]+ stepper counts up and down and never goes negative', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ignore_log: [1, 2, 3].map(logEntry) });
        await openPopup(page, context);
        await page.locator('#undo-btn').click();

        const field = page.locator('#undo-count');
        const plus = page.locator('#undo-plus');
        const minus = page.locator('#undo-minus');

        // Empty field: nothing to step down from, and Go has nothing to stage.
        await expect(field).toHaveValue('');
        await expect(minus).toBeDisabled();
        await expect(page.locator('#undo-go')).toBeDisabled();

        await plus.click();
        await expect(field).toHaveValue('1');
        await expect(minus).toBeEnabled();
        await plus.click();
        await plus.click();
        await expect(field).toHaveValue('3');
        // Ceiling is the undoable total — the log holds 3 entries.
        await expect(plus).toBeDisabled();

        await minus.click();
        await expect(field).toHaveValue('2');
        await expect(plus).toBeEnabled();
        await minus.click();
        await minus.click();
        // Stepping past 1 empties the field instead of going to 0 or below.
        await expect(field).toHaveValue('');
        await expect(minus).toBeDisabled();
    });

    test('The stepper and its field have localized accessible names that follow the language', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ignore_log: [1, 2].map(logEntry) });
        await openPopup(page, context);

        await expect(page.locator('#undo-count')).toHaveAttribute('aria-label', 'Number of games to un-ignore');
        await expect(page.locator('#undo-minus')).toHaveAttribute('aria-label', 'Fewer');
        await expect(page.locator('#undo-plus')).toHaveAttribute('aria-label', 'More');

        await setExtensionStorage(context, { ilap_lang: 'de' });
        await expect(page.locator('#undo-minus')).toHaveAttribute('aria-label', 'Weniger');
        await expect(page.locator('#undo-plus')).toHaveAttribute('aria-label', 'Mehr');
        await expect(page.locator('#undo-count')).toHaveAttribute('aria-label', /Anzahl der Spiele/);
    });

    test('The count field still takes typed digits, clamped and never negative', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ignore_log: [1, 2, 3, 4, 5].map(logEntry) });
        await openPopup(page, context);
        await page.locator('#undo-btn').click();

        const field = page.locator('#undo-count');
        // The undoable total is the field's own pale hint — the bare number, with
        // no wording around it — not a separate label beside the field.
        await expect(field).toHaveAttribute('placeholder', '5');

        await field.fill('');
        await field.pressSequentially('4');
        await expect(field).toHaveValue('4');
        // A typed minus is dropped with every other non-digit.
        await field.fill('');
        await field.pressSequentially('-3');
        await expect(field).toHaveValue('3');
        // Above the ceiling clamps down to what the log can undo.
        await field.fill('');
        await field.pressSequentially('99');
        await expect(field).toHaveValue('5');
        await expect(page.locator('#undo-plus')).toBeDisabled();
    });

    test('Double-clicking the empty field takes the whole undoable list', async ({ page, context }) => {
        // The pale hint is the total, so the field doubles as its own "select
        // all" — the shortcut that keeps a five-digit rollback off the stepper.
        await setExtensionStorage(context, { ilap_ignore_log: [1, 2, 3, 4, 5].map(logEntry) });
        await openPopup(page, context);
        await page.locator('#undo-btn').click();

        const field = page.locator('#undo-count');
        await expect(field).toHaveValue('');
        // A single click is how you click in to type: it must not fill the field
        // and arm Go for a rollback of everything.
        await field.click();
        await expect(field).toHaveValue('');
        await expect(page.locator('#undo-go')).toBeDisabled();

        await field.dblclick();
        await expect(field).toHaveValue('5');
        await expect(page.locator('#undo-go')).toBeEnabled();

        // A field that already holds a number is left alone — double-clicking it
        // selects what you typed, as in any other field.
        await field.fill('2');
        await field.dblclick();
        await expect(field).toHaveValue('2');
    });

    test('Holding a stepper auto-repeats with a growing step, and stops on release', async ({ page, context }) => {
        // A five-digit total must be reachable without clicking 300 times.
        const log = Array.from({ length: 300 }, (_, i) => logEntry(i + 1));
        await setExtensionStorage(context, { ilap_ignore_log: log });
        await openPopup(page, context);
        await page.locator('#undo-btn').click();

        const field = page.locator('#undo-count');
        await page.locator('#undo-plus').hover();
        await page.mouse.down();
        await page.waitForTimeout(1500);   // 400ms before the first repeat, then ~70ms ticks
        await page.mouse.up();

        const held = parseInt(await field.inputValue(), 10);
        expect(held).toBeGreaterThan(5);   // a single click would have left 1
        expect(held).toBeLessThanOrEqual(300);

        // Release stops the repeat: the value is settled, not still climbing.
        await page.waitForTimeout(400);
        expect(parseInt(await field.inputValue(), 10)).toBe(held);
    });

    test('A second press on a held stepper does not leave the first one repeating', async ({ page, context }) => {
        // Two pointerdowns with no release between them (a second finger on the
        // same button) used to overwrite the first press's timers, and the release
        // stopped only the second: the count kept climbing on its own.
        const log = Array.from({ length: 300 }, (_, i) => logEntry(i + 1));
        await setExtensionStorage(context, { ilap_ignore_log: log });
        await openPopup(page, context);
        await page.locator('#undo-btn').click();

        const press = (type) => page.locator('#undo-plus').evaluate((btn, t) =>
            btn.dispatchEvent(new PointerEvent(t, { button: 0, bubbles: true })), type);
        await press('pointerdown');
        await page.waitForTimeout(600);     // the first press is repeating by now
        await press('pointerdown');
        await page.waitForTimeout(600);
        await press('pointerup');

        const field = page.locator('#undo-count');
        const settled = parseInt(await field.inputValue(), 10);
        await page.waitForTimeout(600);
        expect(parseInt(await field.inputValue(), 10)).toBe(settled);
    });

    test('Dragging across the droplist selects nothing — the pale hint included', async ({ page, context }) => {
        // The droplist is a control panel, not prose: a drag across it used to
        // paint a page selection over every label and over what both number
        // fields show, the pale hint included, with the caret nowhere near them.
        await setExtensionStorage(context, { ilap_ignore_log: [1, 2].map(logEntry) });
        await openPopup(page, context);
        await page.locator('#undo-btn').click();

        const box = await page.locator('#undo-menu').boundingBox();
        await page.mouse.move(box.x + 4, box.y + 6);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 4, box.y + box.height - 6, { steps: 12 });
        await page.mouse.up();
        expect(await page.evaluate(() => String(document.getSelection()))).toBe('');

        // Selecting inside a field still works — that is what editing needs.
        const field = page.locator('#undo-count');
        await field.dblclick();                    // double-click-to-fill leaves it selected
        await expect(field).toHaveValue('2');
        expect(await page.evaluate(() => {
            const el = document.getElementById('undo-count');
            return el.selectionEnd - el.selectionStart;
        })).toBe(1);
    });

    test('One Un-ignore acts on the row picked last; typing in a row picks it and empties the other', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ignore_log: [1, 2, 3].map(logEntry) });
        await openPopup(page, context);
        await page.locator('#undo-btn').click();

        await expect(page.locator('#undo-pick-count')).toBeChecked();
        await page.locator('#undo-count').fill('2');
        await page.locator('#undo-time').fill('5');
        await expect(page.locator('#undo-pick-time')).toBeChecked();
        await expect(page.locator('#undo-count')).toHaveValue('');
        await expect(page.locator('#undo-go')).toBeEnabled();

        // Picking the count row by its mark keeps the time's number, and with an
        // empty count there is nothing for the button to do.
        await page.locator('#undo-pick-count').check();
        await expect(page.locator('#undo-time')).toHaveValue('5');
        await expect(page.locator('#undo-go')).toBeDisabled();

        await page.locator('#undo-pick-time').check();
        await page.locator('#undo-go').click();
        await expect.poll(async () => {
            const res = await getExtensionStorage(context, 'ilap_curator_queue');
            return (res.ilap_curator_queue || [])[0];
        }).toMatchObject({ type: 'undo', scope: { n: 5, unit: 'h' } });
    });

    test('The Creators tab shows only while the account ignores a creator, and queues its rollback', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_ignore_log: [logEntry(1)] });
        await openPopup(page, context);
        await page.locator('#undo-btn').click();
        await expect(page.locator('#undo-tabs')).toBeHidden();

        // A store tab's sync: one creator with its name, one whose name is not read yet.
        await setExtensionStorage(context, { ilap_creators: { ignored: { 4: 'Valve', 33019580: '' }, followed: [] } });
        await expect(page.locator('#undo-tabs')).toBeVisible();
        await page.locator('#undo-tab-creators').click();
        await expect(page.locator('#undo-pane-games')).toBeHidden();
        await expect(page.locator('#undo-pane-creators')).toBeVisible();
        // Sorted by name, the unnamed one by its id.
        await expect(page.locator('#undo-creator option')).toHaveText(['33019580', 'Valve']);

        await page.locator('#undo-creator-display').click();
        await page.locator('.undo-creator-shell .select-opt', { hasText: 'Valve' }).click();
        await expect(page.locator('#undo-creator-display')).toHaveText('Valve');
        await page.locator('#undo-go-creator').click();
        await expect.poll(async () => {
            const res = await getExtensionStorage(context, 'ilap_curator_queue');
            return (res.ilap_curator_queue || [])[0];
        }).toMatchObject({ type: 'creator', appids: ['4'], meta: { 4: { name: 'Valve', ignore: false } } });
        // The waiting rollback already counts: Valve leaves the list.
        await expect(page.locator('#undo-creator option')).toHaveText(['33019580']);
    });

    test('Creators alone keep the undo button live', async ({ page, context }) => {
        await setExtensionStorage(context, { ilap_creators: { ignored: { 4: 'Valve' }, followed: [] } });
        await openPopup(page, context);
        await expect(page.locator('#undo-btn')).toBeEnabled();
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
        const job = undoJob({ status: 'paused' });   // Remove shows on a paused job
        await setExtensionStorage(context, { ilap_curator_queue: [job] });
        await openPopup(page, context);

        await page.locator('#queue-btn').click();

        // Staged before the job kept its scope: the plain name.
        const row = page.locator('.queue-job').first();
        await expect(row.locator('.queue-job-name')).toHaveText('Undo ignores');
        await expect(row.locator('.queue-mini')).toHaveAttribute('aria-label', /0 \/ 3/);

        await row.locator('[data-act="remove"]').click();
        await row.locator('[data-act="confirm"]').click();   // Remove asks first
        await expect(page.locator('#queue-list .queue-empty-hint')).toBeVisible();
        const res = await getExtensionStorage(context, 'ilap_curator_queue');
        expect(res.ilap_curator_queue).toEqual([]);
    });

    test('When the last job finishes while the queue is open, the strip gives way to the hint and the block height follows', async ({ page, context }) => {
        // Open with one job, then drain to empty (what the drainer does on
        // completion: removeJob → queue becomes []). The queue stays open on
        // the empty hint, and its block moves to its new height
        // (QueueManager.resize marks it .moving while it does) instead of jumping.
        await setExtensionStorage(context, { ilap_curator_queue: [undoJob()] });
        await openPopup(page, context);
        await page.locator('#queue-btn').click();
        await expect(page.locator('.queue-job')).toHaveCount(1);
        await page.waitForTimeout(400);

        // The motion is too short to catch by polling from the test side.
        await page.evaluate(() => {
            window.__movingSeen = false;
            const el = document.querySelector('#queue-drawer .drawer-inner');
            new MutationObserver(() => {
                if (el.classList.contains('moving')) window.__movingSeen = true;
            }).observe(el, { attributes: true, attributeFilter: ['class'] });
        });

        await setExtensionStorage(context, { ilap_curator_queue: [] });

        await expect(page.locator('#queue-list .queue-empty-hint')).toBeVisible();
        await expect(page.locator('#queue-drawer')).toHaveClass(/open/);
        await expect(page.locator('#queue-jobs-chip')).toHaveText('0');
        expect(await page.evaluate(() => window.__movingSeen)).toBe(true);
        await expect(page.locator('#queue-drawer .drawer-inner')).not.toHaveClass(/moving/);
    });

    test('An undo job pauses and resumes through the applet like any job', async ({ page, context }) => {
        const job = undoJob();
        await setExtensionStorage(context, { ilap_curator_queue: [job] });
        await openPopup(page, context);
        await page.locator('#queue-btn').click();
        await expect(page.locator('#queue-drawer')).not.toHaveClass(/sliding/);

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
