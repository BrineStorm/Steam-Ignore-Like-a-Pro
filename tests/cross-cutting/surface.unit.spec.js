const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Surface-mode contract (src/surface.js) as a Node unit — no browser. Guards
// the pure pieces the E2E specs build on: the Steam-desktop-client UA
// detection, the stored-value → effective-mode resolution (client always
// forces the widget), and the escape-hotkey matcher.

function loadSurface() {
    const code = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'surface.js'),
        'utf8'
    );
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ILAP.Surface;
}

// Chrome on Windows (a browser) vs the Steam client's CEF views. The client
// signature is the /Valve Steam/i candidate pending the live probe — these
// strings mirror the known "Valve Steam Client" / "Valve Steam GameOverlay"
// suffixes.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CLIENT_UA = BROWSER_UA + ' Valve Steam Client';
const OVERLAY_UA = BROWSER_UA + ' Valve Steam GameOverlay';

test.describe('surface mode (unit)', () => {
    const Surface = loadSurface();

    test('exports the storage key and the escape-hotkey label', () => {
        expect(Surface.KEY).toBe('ilap_surface_mode');
        expect(Surface.ESCAPE_HOTKEY_LABEL).toBe('Ctrl+Alt+Shift+I');
    });

    test('isSteamClientUA: matches the client/overlay signatures, not browsers', () => {
        expect(Surface.isSteamClientUA(CLIENT_UA)).toBe(true);
        expect(Surface.isSteamClientUA(OVERLAY_UA)).toBe(true);
        expect(Surface.isSteamClientUA(BROWSER_UA)).toBe(false);
        expect(Surface.isSteamClientUA('')).toBe(false);
        expect(Surface.isSteamClientUA(undefined)).toBe(false);
    });

    test('resolve: popup only when stored AND not in the client; widget otherwise', () => {
        expect(Surface.resolve('popup', BROWSER_UA)).toBe('popup');
        expect(Surface.resolve('popup', CLIENT_UA)).toBe('widget');   // client override, key untouched
        expect(Surface.resolve('widget', BROWSER_UA)).toBe('widget');
        expect(Surface.resolve('widget', CLIENT_UA)).toBe('widget');
        expect(Surface.resolve(undefined, BROWSER_UA)).toBe('widget'); // default
        expect(Surface.resolve('garbage', BROWSER_UA)).toBe('widget'); // fail-safe
    });

    test('isEscapeHotkey: Ctrl+Alt+Shift+I only', () => {
        expect(Surface.isEscapeHotkey({ ctrlKey: true, altKey: true, shiftKey: true, code: 'KeyI' })).toBe(true);
        expect(Surface.isEscapeHotkey({ ctrlKey: false, altKey: true, shiftKey: true, code: 'KeyI' })).toBe(false);
        expect(Surface.isEscapeHotkey({ ctrlKey: true, altKey: false, shiftKey: true, code: 'KeyI' })).toBe(false);
        expect(Surface.isEscapeHotkey({ ctrlKey: true, altKey: true, shiftKey: false, code: 'KeyI' })).toBe(false);
        expect(Surface.isEscapeHotkey({ ctrlKey: true, altKey: true, shiftKey: true, code: 'KeyJ' })).toBe(false);
        expect(Surface.isEscapeHotkey(null)).toBe(false);
    });
});
