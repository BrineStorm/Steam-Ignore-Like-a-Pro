// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const path = require('path');

var DIST_DIR = path.join(__dirname, 'dist');
var PLATFORM_DIR = path.join(__dirname, 'platform');

var COMMON_ASSETS = [
    'ui',
    'src',
    'assets',
    'styles'
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
        manifest.background = { service_worker: TEST_SW_REL_PATH };
        fs.writeFileSync(
            path.join(outputDir, 'manifest.json'),
            JSON.stringify(manifest, null, 2)
        );
        fs.writeFileSync(path.join(outputDir, TEST_SW_REL_PATH), TEST_SW_CONTENT);
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