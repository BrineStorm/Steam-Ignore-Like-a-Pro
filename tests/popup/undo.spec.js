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
        await expect(page.locator('#undo-go-count')).toBeDisabled();

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

    test('The stepper and its field carry localized accessible names that follow the language', async ({ page, context }) => {
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
        await expect(page.locator('#undo-go-count')).toBeDisabled();

        await field.dblclick();
        await expect(field).toHaveValue('5');
        await expect(page.locator('#undo-go-count')).toBeEnabled();

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
