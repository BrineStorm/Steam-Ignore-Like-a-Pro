const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// build.js packs each platform for store upload. Both store back-ends reject a
// zip whose entries are '\'-separated or whose manifest.json sits one level down,
// and neither says so clearly — which is the whole reason build.js reaches for
// System32's bsdtar instead of PowerShell 5.1's Compress-Archive, and passes the
// top-level entries explicitly instead of a bare '.'. That reasoning lives in a
// comment and was asserted nowhere; this is the assertion.
//
// Node unit — no browser. A real prod build runs in beforeAll, so this spec
// provisions the packages it inspects and needs no build step ahead of it.
// SIDE EFFECT: that build rewrites dist/chromium and dist/firefox and replaces
// every package in dist/ — do not run it while a release package there matters.

const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const BASENAME = 'steam-ignore-like-a-pro';
const PLATFORMS = ['chromium', 'firefox'];

const TAR = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';

// The two manifests are the only carriers of the version (package.json has none
// on purpose), so the expected filename is derived the same way build.js does.
function manifestVersion(platform) {
    const raw = fs.readFileSync(path.join(ROOT, 'platform', platform, 'manifest.json'), 'utf8')
        .replace(/^\uFEFF/, '');
    return JSON.parse(raw).version;
}

function packagePath(platform, version) {
    return path.join(DIST, `${BASENAME}-${version || manifestVersion(platform)}-${platform}.zip`);
}

function entries(zip) {
    return execFileSync(TAR, ['-tf', zip], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
}

const STALE = packagePath('chromium', '0.0.1-stale');

// Its own describe, outside the win32-only block below: this one needs neither a
// build nor a packer, so it must also run on the CI runner. The two manifests
// are the only version carriers and both are bumped by hand, so they can drift —
// and a drift is invisible until two packages with different numbers on them sit
// in dist/ waiting to be uploaded.
test.describe('build.js — version (unit)', () => {
    test('both manifests carry the same version', () => {
        expect(manifestVersion('firefox'), 'manifest version drift')
            .toBe(manifestVersion('chromium'));
    });
});

test.describe('build.js — store packages (unit)', () => {

    // Packaging is pinned to System32's bsdtar. Another host's tar may have no
    // zip writer (GNU tar on the ubuntu CI runner writes a plain tar and exits 0),
    // and build.js then skips packaging — there is no package here to inspect.
    test.skip(process.platform !== 'win32', 'packages are built with the Windows bsdtar');

    // The build runs ONCE, here, rather than in the first test with the other two
    // reading what it left behind: a spec whose later cases only pass after an
    // earlier case ran cannot be reached by --grep, and says "missing package"
    // when the truth is "you skipped the test that writes it". dist/ is created
    // rather than assumed — the stale package is planted before any build has
    // necessarily happened in this checkout.
    test.beforeAll(() => {
        fs.mkdirSync(DIST, { recursive: true });
        fs.writeFileSync(STALE, 'not a real zip');
        execFileSync('node', ['build.js'], { cwd: ROOT, stdio: 'pipe' });
    });

    test('a prod build clears stale packages before writing the fresh ones', () => {
        // A version bump must not leave the previous package sitting next to the
        // new one, where it can be uploaded by mistake.
        expect(fs.existsSync(STALE)).toBe(false);
        for (const platform of PLATFORMS) {
            expect(fs.existsSync(packagePath(platform)), `${platform} package was not written`).toBe(true);
        }
    });

    test('every package is store-shaped: manifest.json at the root, / separators', () => {
        for (const platform of PLATFORMS) {
            // A real zip, not just a file named like one: `tar -tf` below lists a
            // plain tar just as happily, so a tar under a .zip name would pass it.
            const head = fs.readFileSync(packagePath(platform)).subarray(0, 4);
            expect(head.equals(Buffer.from('PK\x03\x04', 'latin1')), `${platform}: not a zip`).toBe(true);

            const list = entries(packagePath(platform));

            // At the ROOT — a nested manifest is the classic "zipped the folder,
            // not its contents" upload rejection.
            expect(list, `${platform}: manifest.json is not at the archive root`).toContain('manifest.json');

            // Compress-Archive on PS 5.1 writes 'src\main.js'; a bare '.' passed to
            // tar prefixes every entry with './'. Both are silent upload failures.
            expect(list.filter(e => e.includes('\\')), `${platform}: backslash-separated entries`).toEqual([]);
            expect(list.filter(e => e.startsWith('./')), `${platform}: './'-prefixed entries`).toEqual([]);
        }
    });

    test('each package ships only what its own manifest can load', () => {
        // The source tree is copied wholesale, so a file belonging to the other
        // platform rides along unless build.js drops it. Derived from the
        // manifests rather than hard-coded, so a script that stops being
        // referenced is caught too — the two the Firefox build drops today are
        // the MV3 worker and the sessionid hand-off that exists for it.
        for (const platform of PLATFORMS) {
            const manifest = JSON.parse(fs.readFileSync(
                path.join(ROOT, 'platform', platform, 'manifest.json'), 'utf8').replace(/^﻿/, ''));
            const loadable = new Set([
                ...(manifest.content_scripts || []).flatMap(cs => cs.js || []),
                ...((manifest.background && manifest.background.scripts) || []),
                manifest.background && manifest.background.service_worker,
            ].filter(Boolean));
            // popup.html pulls its own, and those are shared by both platforms.
            const html = fs.readFileSync(path.join(ROOT, 'ui', 'popup.html'), 'utf8');
            for (const m of html.matchAll(/<script src="([^"]+)"/g)) {
                loadable.add(path.posix.normalize(path.posix.join('ui', m[1])));
            }
            // migrate.js is imported by the worker rather than listed on Chromium.
            loadable.add('src/migrate.js');

            const shipped = entries(packagePath(platform))
                .filter(e => e.startsWith('src/') && e.endsWith('.js'));
            expect(shipped.filter(e => !loadable.has(e)), `${platform}: ships src/ files it never loads`)
                .toEqual([]);
        }
    });

    test('LICENSE ships and LICENSE.MPL does not', () => {
        // GPL-3 requires its text to travel with the binary; no shipped file is
        // MPL-covered any more, so that one stays in the repo only.
        for (const platform of PLATFORMS) {
            const list = entries(packagePath(platform));
            expect(list, `${platform}: LICENSE missing`).toContain('LICENSE');
            expect(list.filter(e => e.startsWith('LICENSE.MPL')), `${platform}: LICENSE.MPL shipped`).toEqual([]);
        }
    });
});
