// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const path = require('path');

// A progress log written AS the run goes, one line per finished test.
//
// The `list` reporter only reaches the terminal, so a run that dies mid-way —
// an OS kill under memory pressure, a closed shell, a pipe that buffered its
// output and lost all of it — leaves no record of how far it got, and the only
// way back to a known state is running the whole suite again. None of the
// built-in file reporters (json, junit, blob, html) helps: every one of them
// writes once, at the end, which is exactly the moment an interrupted run never
// reaches. This one appends and flushes per test, so the last line is always the
// last test that finished, and a missing footer is what says the run was cut off.
//
// Lands in test-results/ — gitignored, and already the directory the canary
// workflow uploads when it goes red, so on CI it rides along at no cost and
// tells the reader what ran before the failure.
class ProgressReporter {
    constructor(options = {}) {
        this.file = path.join(options.outputDir || 'test-results', options.fileName || 'run.log');
        this.suite = null;
        this.started = Date.now();
    }

    // Playwright clears the output directory at run start; a write must not fail
    // on a directory that went with it (mkdir is a no-op once it is back).
    _write(line, append = true) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        (append ? fs.appendFileSync : fs.writeFileSync)(this.file, line + '\n');
    }

    onBegin(config, suite) {
        this.started = Date.now();
        this.suite = suite;
        this._write(`# started ${new Date().toISOString()} — ${suite.allTests().length} tests`, false);
    }

    onTestEnd(test, result) {
        const mark = {
            passed: 'ok', failed: 'FAIL', timedOut: 'TIMEOUT',
            skipped: 'skip', interrupted: 'CUT',
        }[result.status] || result.status;

        const file = path.relative(process.cwd(), test.location.file).split(path.sep).join('/');
        // The file suite's own title IS the path, which the location already
        // carries — so only a real describe block is worth prefixing with.
        const parent = test.parent && test.parent.title;
        const name = parent && !parent.endsWith('.spec.js') ? `${parent} › ${test.title}` : test.title;
        this._write(`${mark}\t${file}:${test.location.line}\t${name}\t${result.duration}ms`);
    }

    // The footer counts TESTS, not attempts: a retried test logs one line per
    // attempt above, but is one test here, judged by its final outcome — so the
    // totals add up to the header's count. A test the run never reached (cut
    // off) has no result at all and is counted apart from a real skip.
    onEnd(result) {
        const secs = Math.round((Date.now() - this.started) / 1000);
        const c = { passed: 0, flaky: 0, failed: 0, skipped: 0, notRun: 0 };
        for (const t of this.suite ? this.suite.allTests() : []) {
            if (t.results.length === 0) { c.notRun++; continue; }
            const outcome = t.outcome();
            if (outcome === 'expected') c.passed++;
            else if (outcome === 'flaky') c.flaky++;
            else if (outcome === 'skipped') c.skipped++;
            else c.failed++;
        }
        this._write(`# ${result.status} — ${c.passed} passed, ${c.flaky} flaky, `
            + `${c.failed} failed, ${c.skipped} skipped, ${c.notRun} not run, ${secs}s`);
    }
}

module.exports = ProgressReporter;
