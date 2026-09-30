// SPDX-License-Identifier: GPL-3.0-or-later
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// window.ILAP.getSessionID (src/utils.js) reads Steam's `sessionid` cookie — the
// CSRF token that goes into the body of every ignore and every rollback. The
// isolated world cannot see the page's own g_sessionID, so the cookie string is
// the only source, and picking the WRONG cookie out of it is invisible: Steam
// answers a bad token with a plain 400, which the drainer spends its retries on
// and the service worker counts toward its halt.
//
// The cookie string is a flat `a=1; b=2` list, so a substring match is not a
// name match: any cookie whose name merely ENDS in "sessionid" would win if it
// came first. Steam serves *.steampowered.com, and nothing stops a sibling host
// from setting one.
function loadSession(cookie) {
    const sandbox = {
        window: {}, console,
        document: { cookie, querySelector: () => null, getElementById: () => null },
        fetch: () => Promise.reject(new Error('no network in this unit')),
        AbortController, setTimeout, clearTimeout,
        Date, Math, Object, Promise, Set, String, RegExp, JSON,
    };
    vm.createContext(sandbox);
    for (const f of ['escape.js', 'stats.js', 'steam-net.js', 'utils.js']) {
        vm.runInContext(fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', f), 'utf8'), sandbox);
    }
    return sandbox.window.ILAP.getSessionID;
}

test.describe('getSessionID (unit)', () => {

    test('reads the sessionid cookie wherever it sits in the string', () => {
        expect(loadSession('sessionid=abc123')()).toBe('abc123');
        expect(loadSession('browserid=9; sessionid=abc123; timezoneOffset=0')()).toBe('abc123');
        expect(loadSession('browserid=9;sessionid=abc123')()).toBe('abc123');
    });

    test('a cookie whose NAME merely ends in sessionid is not the sessionid', () => {
        // The bug this guards: an unanchored match takes `foo_sessionid`'s value
        // and puts it in the CSRF field of every POST.
        expect(loadSession('partner_sessionid=WRONG; sessionid=right')()).toBe('right');
        expect(loadSession('x_sessionid=WRONG')()).toBeNull();
    });

    test('no sessionid cookie at all is null, not an empty token', () => {
        expect(loadSession('')()).toBeNull();
        expect(loadSession('browserid=9; steamCountry=DE')()).toBeNull();
    });

    test('the value stops at the cookie separator', () => {
        expect(loadSession('sessionid=abc123; steamLoginSecure=secret')()).toBe('abc123');
    });
});
