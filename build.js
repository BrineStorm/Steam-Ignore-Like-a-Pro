// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

var DIST_DIR = path.join(__dirname, 'dist');
var PLATFORM_DIR = path.join(__dirname, 'platform');
var PKG_BASENAME = 'steam-ignore-like-a-pro';

// LICENSE ships because GPL-3 requires the text to travel with the binary.
// LICENSE.MPL deliberately does NOT: no shipped file is MPL-covered any more
// (every source carries GPL-3.0-or-later), so in the package it would only be a
// second licence text with nothing to apply to. It stays in the repo, where it
// documents what releases up to v1.1 went out under.
var COMMON_ASSETS = [
    'ui',
    'src',
    'assets',
    'styles',
    'LICENSE'
];

// Source files that belong to ONE platform. The tree above is copied wholesale,
// so a file the other platform's manifest never references would ride along into
// its package: dead weight in the upload, and an unreferenced background script
// is one more thing for a store reviewer to ask about. Removed after the copy
// rather than filtered during it, so the rule is one list in one place.
// Chromium ships everything.
var PLATFORM_EXCLUDES = {
    firefox: [
        'src/background.js',   // the MV3 service worker; Firefox loads migrate.js alone
        'src/sw-handoff.js'    // caches the sessionid FOR that worker (see the file)
    ]
};

// `--test` produces a parallel test-flavor build into dist/<platform>-test/
// with an empty MV3 service worker patched into the manifest. This gives
// Playwright a handle to read the extension ID via context.serviceWorkers().
// The production manifest and dist/<platform>/ are NOT touched.
var TEST_MODE = process.argv.slice(2).includes('--test');
var TEST_SW_REL_PATH = 'src/background-test.js';
var TEST_SW_CONTENT = '// Test-only MV3 service worker. Empty placeholder.\n'
    + '// Exists so Playwright can read context.serviceWorkers() and resolve\n'
    + '// the extension ID for chrome-extension:// URLs and storage access.\n';
// Firefox has no service-worker handle and cannot navigate a tab to a
// moz-extension:// page, so storage helpers cannot evaluate chrome.storage in
// an extension context the way the chromium SW allows. Instead the firefox-test
// build injects this content script: it bridges chrome.storage.local to the
// page's main world over window.postMessage, and the helpers drive it from a
// store.steampowered.com bridge tab (see tests/_extension.js).
var TEST_BRIDGE_REL_PATH = 'src/test-storage-bridge.js';
var TEST_BRIDGE_CONTENT =
      '// TEST-ONLY (firefox-test build). Bridges chrome.storage.local to the\n'
    + '// page main world over window.postMessage so Playwright page.evaluate can\n'
    + '// seed/read extension storage on Firefox.\n'
    + '(function () {\n'
    + '    window.addEventListener(\'message\', function (e) {\n'
    + '        // Same frame only. This hands the whole of chrome.storage.local to\n'
    + '        // whoever can post to this window, and an embedded frame on the\n'
    + '        // store page is such a sender; the test driver is always this one.\n'
    + '        if (e.source !== window) return;\n'
    + '        var d = e.data;\n'
    + '        if (!d || d.__ilapStore !== \'req\') return;\n'
    + '        function reply(result, error) {\n'
    + '            window.postMessage({ __ilapStore: \'res\', id: d.id, result: result, error: error }, \'*\');\n'
    + '        }\n'
    + '        try {\n'
    + '            if (d.op === \'get\') {\n'
    + '                chrome.storage.local.get(d.keys, function (r) { reply(r); });\n'
    + '            } else if (d.op === \'set\') {\n'
    + '                chrome.storage.local.set(d.payload, function () { reply(true); });\n'
    + '            } else if (d.op === \'clear\') {\n'
    + '                chrome.storage.local.clear(function () { reply(true); });\n'
    + '            } else {\n'
    + '                reply(undefined, \'unknown op \' + d.op);\n'
    + '            }\n'
    + '        } catch (err) {\n'
    + '            reply(undefined, String(err));\n'
    + '        }\n'
    + '    });\n'
    + '})();\n';

function copyRecursiveSync(src, dest) {
    if (!fs.existsSync(src)) {
        console.log('Warning: Source not found: ' + src);
        return;
    }

    var stats = fs.statSync(src);
    var baseName = path.basename(src);

    if (stats.isDirectory() && baseName === 'badges') {
        return;
    }

    if (stats.isDirectory()) {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
        
        var entries = fs.readdirSync(src);
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            copyRecursiveSync(path.join(src, entry), path.join(dest, entry));
        }
    } else {
        if (src.toLowerCase().endsWith('.gif')) {
            return;
        }
        fs.copyFileSync(src, dest);
    }
}

// Store uploads want a zip whose entries are '/'-separated with manifest.json
// at the root. PowerShell's Compress-Archive writes 'src\main.js' on PS 5.1,
// so pack with the bsdtar that ships in System32 instead, and pass the
// top-level entries explicitly: a bare '.' prefixes every path with './'.
// Elsewhere tar may have no zip writer, and not every one says so: GNU tar exits
// 0 and writes a plain tar under the .zip name. So the result is judged by its
// magic bytes, not the exit code, and anything that is not a zip is removed.
// On Windows the packer is a known quantity, so a failure there fails the build
// (a release must not go out without its package); elsewhere it only warns.
function zipPlatform(outputDir, browser) {
    var version = readManifest(path.join(outputDir, 'manifest.json')).version;
    var zipName = PKG_BASENAME + '-' + version + '-' + browser + '.zip';
    var tarBin = process.platform === 'win32'
        ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar';
    var zipPath = path.join(DIST_DIR, zipName);
    var args = ['-a', '-c', '-f', zipPath]
        .concat(fs.readdirSync(outputDir));

    try {
        execFileSync(tarBin, args, { cwd: outputDir, stdio: 'pipe' });
    } catch (e) {
        // A packer that died mid-write leaves a truncated archive under the
        // release name; it must not sit in dist/ waiting to be uploaded.
        fs.rmSync(zipPath, { force: true });
        packagingFailed(tarBin + ' failed: ' + e.message);
        return;
    }

    if (!fs.existsSync(zipPath) || !isZip(zipPath)) {
        fs.rmSync(zipPath, { force: true });
        packagingFailed(tarBin + ' did not write a zip');
        return;
    }

    console.log('Packaged: ./dist/' + zipName);
}

function packagingFailed(reason) {
    if (process.platform === 'win32') {
        console.error('Error: packaging failed, ' + reason);
        process.exitCode = 1;
    } else {
        console.log('Warning: packaging skipped, ' + reason);
    }
}

// Strips an optional UTF-8 BOM (escaped: a literal one is invisible in editors).
function readManifest(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

// Local file header signature: every non-empty zip starts with 'PK\x03\x04'.
function isZip(file) {
    var fd = fs.openSync(file, 'r');
    var head = Buffer.alloc(4);
    try {
        fs.readSync(fd, head, 0, 4, 0);
    } finally {
        fs.closeSync(fd);
    }
    return head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
}

// Every prod build replaces the packages, so a stale version number can never
// linger in dist/ next to the fresh one and get uploaded by mistake.
function cleanPackages() {
    if (!fs.existsSync(DIST_DIR)) {
        return;
    }
    var entries = fs.readdirSync(DIST_DIR);
    for (var i = 0; i < entries.length; i++) {
        if (entries[i].indexOf(PKG_BASENAME) === 0 && entries[i].endsWith('.zip')) {
            fs.rmSync(path.join(DIST_DIR, entries[i]), { force: true });
            console.log('Removed stale package: ' + entries[i]);
        }
    }
}

function buildPlatform(browser) {
    var flavorSuffix = TEST_MODE ? '-test' : '';
    var outputDirName = browser + flavorSuffix;

    console.log('Building for: ' + outputDirName);

    var outputDir = path.join(DIST_DIR, outputDirName);
    var manifestPath = path.join(PLATFORM_DIR, browser, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
        console.error('Error: Manifest not found at: ' + manifestPath);
        return;
    }

    if (fs.existsSync(outputDir)) {
        try {
            fs.rmSync(outputDir, { recursive: true, force: true });
        } catch (e) {
            console.error('Error cleaning dir: ' + e.message);
        }
    }
    fs.mkdirSync(outputDir, { recursive: true });

    for (const asset of COMMON_ASSETS) {
        const srcPath = path.join(__dirname, asset);
        const destPath = path.join(outputDir, path.basename(asset));
        copyRecursiveSync(srcPath, destPath);
    }

    for (const rel of PLATFORM_EXCLUDES[browser] || []) {
        fs.rmSync(path.join(outputDir, rel), { force: true });
    }

    if (TEST_MODE) {
        var manifest = readManifest(manifestPath);
        if (browser === 'chromium') {
            manifest.background = { service_worker: TEST_SW_REL_PATH };
            fs.writeFileSync(path.join(outputDir, TEST_SW_REL_PATH), TEST_SW_CONTENT);
        } else {
            // Firefox loads via RDP installTemporaryAddon — no SW handle needed.
            // Drop the background (event page) entirely for parity with the
            // chromium test flavor, where the stub SW replaces src/background.js:
            // otherwise migrate.js fires onInstalled on EVERY temporary install
            // and its ilap_surface_mode write races the tests' storage seeding.
            delete manifest.background;
            // Inject the storage bridge as the first content script so the
            // helpers can reach chrome.storage from a store-page bridge tab.
            manifest.content_scripts[0].js.unshift(TEST_BRIDGE_REL_PATH);
            fs.writeFileSync(
                path.join(outputDir, TEST_BRIDGE_REL_PATH),
                TEST_BRIDGE_CONTENT
            );
        }
        fs.writeFileSync(
            path.join(outputDir, 'manifest.json'),
            JSON.stringify(manifest, null, 2)
        );
    } else {
        fs.copyFileSync(manifestPath, path.join(outputDir, 'manifest.json'));
    }

    console.log('Build complete: ./dist/' + outputDirName + (TEST_MODE ? ' (TEST)' : ''));

    if (!TEST_MODE) {
        zipPlatform(outputDir, browser);
    }
}

console.log('Starting Build Process' + (TEST_MODE ? ' (TEST MODE)' : '') + '...');

if (fs.existsSync(PLATFORM_DIR)) {
    if (!TEST_MODE) {
        cleanPackages();
    }
    buildPlatform('chromium');
    buildPlatform('firefox');
} else {
    console.error('CRITICAL: platform folder is missing in project root!');
    process.exit(1);
}