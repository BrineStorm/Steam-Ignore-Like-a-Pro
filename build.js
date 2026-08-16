// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const path = require('path');

var DIST_DIR = path.join(__dirname, 'dist');
var PLATFORM_DIR = path.join(__dirname, 'platform');

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

    if (TEST_MODE) {
        // strip optional UTF-8 BOM (regex matches a literal U+FEFF)
        var raw = fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, '');
        var manifest = JSON.parse(raw);
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
}

console.log('Starting Build Process' + (TEST_MODE ? ' (TEST MODE)' : '') + '...');

if (fs.existsSync(PLATFORM_DIR)) {
    buildPlatform('chromium');
    buildPlatform('firefox');
} else {
    console.error('CRITICAL: platform folder is missing in project root!');
    process.exit(1);
}