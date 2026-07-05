const { test, expect } = require('../_fixtures.js');
const { AUTH_FILE, SEL, openExploreQueue } = require('./_helpers');

test.use({ storageState: AUTH_FILE });

const MAX_GAMES_TO_SCAN = 40;
const MAX_QUEUE_RESTARTS = 3;

// "Start another queue" button on /explore/ when the daily queue is finished.
// Stable id; the visible label is localized so we never match by text.
const SEL_REFRESH_QUEUE = '#refresh_queue_btn';

// Read which verdict our extension reached for the current game by inspecting
// the badge text it just rendered.
async function readVerdict(page, timeoutMs = 8000) {
    const badge = page.locator('.ilap-micro-badge');
    try {
        await badge.first().waitFor({ state: 'attached', timeout: timeoutMs });
    } catch {
        return null;
    }
    // Labels are past-tense on the badge (BADGE_LABELS in explore-queue/ui.js):
    // IGNORE renders as "IGNORED", SPARE as "SPARED".
    const text = (await badge.first().textContent().catch(() => '') || '').trim().toUpperCase();
    if (text === 'IGNORED') return 'IGNORE';
    if (text === 'SPARED') return 'SPARE';
    if (text === 'NO REVIEWS') return 'NO_REVIEWS';
    return null;
}

// Click Steam's own next-in-queue button. Our content script's
// _bindManualNextButton listener fires synchronously and re-issues the nav
// token, so the next page resumes ACTIVE automatically.
async function clickSteamNext(page) {
    const next = page.locator(SEL.nextBtn);
    try {
        await next.first().waitFor({ state: 'attached', timeout: 5000 });
    } catch {
        return false;
    }
    await Promise.all([
        page.waitForLoadState('domcontentloaded'),
        next.first().click({ force: true }),
    ]);
    await page.waitForTimeout(1500);
    return true;
}

// Steam redirects to /explore/ with #refresh_queue_btn when the daily queue is done.
async function isQueueExhausted(page) {
    if (page.url().includes('queue=')) return false;
    return (await page.locator(SEL_REFRESH_QUEUE).count()) > 0;
}

// Click "Start another queue" on the empty-queue page to get a fresh batch of games.
async function refreshQueue(page) {
    const refresh = page.locator(SEL_REFRESH_QUEUE);
    await refresh.waitFor({ state: 'visible', timeout: 10000 });
    await refresh.click();
    await page.waitForTimeout(2500);

    // Steam may redirect to /app/X?queue=N or leave us on /explore/ with the
    // queue session refreshed. If the latter, force back into a queue page.
    if (!page.url().includes('queue=')) {
        await openExploreQueue(page);
    }
}

test.describe('Explore Queue — bad mode actually ignores a Mixed/Negative game', () => {

    test('Run in bad mode finds and ignores at least one Mixed/Negative game', async ({ page }) => {
        // The loop can chew through many games; default 30s timeout is too tight.
        test.setTimeout(10 * 60 * 1000);

        await openExploreQueue(page);

        // Default mode is 'bad' unless the popup flipped it. Click Run to set ACTIVE intent.
        await page.locator(SEL.runBtn).click();

        let scanned = 0;
        let restarts = 0;
        let foundIgnore = false;

        while (scanned < MAX_GAMES_TO_SCAN && !foundIgnore) {
            scanned += 1;

            const verdict = await readVerdict(page);

            if (verdict === 'IGNORE') {
                foundIgnore = true;
                break;
            }

            // SPARE / NO_REVIEWS / null — automator left it alone, try to advance.
            const advanced = await clickSteamNext(page);

            if (await isQueueExhausted(page)) {
                if (restarts >= MAX_QUEUE_RESTARTS) break;
                restarts += 1;
                await refreshQueue(page);

                // Fresh queue page → start prompt re-appears; re-arm ACTIVE.
                if ((await page.locator(SEL.runBtn).count()) > 0) {
                    await page.locator(SEL.runBtn).click();
                }
                continue;
            }

            if (!advanced) {
                // Couldn't advance and we aren't on the empty-queue page either — odd state.
                break;
            }
        }

        expect(
            foundIgnore,
            `Did not encounter a Mixed/Negative game after scanning ${scanned} games and ${restarts} queue restarts. Increase limits or verify the queue contents.`
        ).toBe(true);

        // Sanity: the badge that triggered IGNORE is the IGNORE one.
        const badge = page.locator('.ilap-micro-badge').first();
        await expect(badge).toContainText(/^IGNORED$/);
    });
});
