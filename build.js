const fs = require('fs');
const path = require('path');

var DIST_DIR = path.join(__dirname, 'dist');
var PLATFORM_DIR = path.join(__dirname, 'platform');

var COMMON_FILES = [
    'popup.html',
    'popup.js',
    'styles.css',
    'src',
    'icons'
];

function copyRecursiveSync(src, dest) {
    if (!fs.existsSync(src)) {
        console.log('Warning: Source not found: ' + src);
        return;
    }

    var stats = fs.statSync(src);

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
        fs.copyFileSync(src, dest);
    }
}

function buildPlatform(browser) {
    console.log('Building for: ' + browser);

    var outputDir = path.join(DIST_DIR, browser);
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

    for (var i = 0; i < COMMON_FILES.length; i++) {
        var file = COMMON_FILES[i];
        copyRecursiveSync(
            path.join(__dirname, file),
            path.join(outputDir, file)
        );
    }

    fs.copyFileSync(manifestPath, path.join(outputDir, 'manifest.json'));

    console.log('Build complete: ./dist/' + browser);
}

console.log('Starting Build Process...');

if (fs.existsSync(PLATFORM_DIR)) {
    buildPlatform('chromium');
    buildPlatform('firefox');
} else {
    console.error('CRITICAL: platform folder is missing in project root!');
    process.exit(1);
}