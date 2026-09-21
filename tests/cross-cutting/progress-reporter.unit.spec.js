// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ProgressReporter = require('../_progress-reporter.js');

// tests/_progress-reporter.js, the per-test log a cut-off run leaves behind. Its
// footer once counted ATTEMPTS: a test that failed and passed on retry added a
// failure and a pass, so the totals overstated failures and did not add up to
// the number of tests. It counts tests by their final outcome now.

function fakeTest(title, results, outcome) {
    return {
        title,
        parent: { title: 'suite' },
        location: { file: path.join(process.cwd(), 'tests', 'x.spec.js'), line: 1 },
        results,
        outcome: () => outcome,
    };
}

test.describe('Progress reporter (unit)', () => {

    test('the footer counts each test once, by its final outcome', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilap-progress-'));
        try {
            const tests = [
                fakeTest('passes', [{ status: 'passed' }], 'expected'),
                fakeTest('fails then passes', [{ status: 'failed' }, { status: 'passed' }], 'flaky'),
                fakeTest('fails twice', [{ status: 'failed' }, { status: 'failed' }], 'unexpected'),
                fakeTest('skipped', [{ status: 'skipped' }], 'skipped'),
                fakeTest('never reached', [], 'skipped'),
            ];
            const r = new ProgressReporter({ outputDir: dir });
            r.onBegin({}, { allTests: () => tests });
            for (const t of tests) for (const res of t.results) r.onTestEnd(t, { ...res, duration: 5 });
            r.onEnd({ status: 'failed' });

            const lines = fs.readFileSync(path.join(dir, 'run.log'), 'utf8').trim().split('\n');
            expect(lines[0]).toContain('5 tests');
            // One line per ATTEMPT above the footer…
            expect(lines.filter(l => !l.startsWith('#'))).toHaveLength(6);
            // …but the footer adds up to the five tests.
            expect(lines[lines.length - 1])
                .toMatch(/1 passed, 1 flaky, 1 failed, 1 skipped, 1 not run/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
