// Shared helpers for the test-ignore cleanup (globalSetup / globalTeardown).
//
// Strategy: snapshot the account's ignored appids BEFORE the run, snapshot again
// AFTER, and un-ignore exactly the difference (the games the suite ignored). The
// source of truth is dynamicstore/userdata -> rgIgnoredApps (same data the DQ
// automator uses to confirm an ignore). This avoids the notinterested page
// entirely: no dates, no pagination, and we only ever remove the diff — never the
// user's pre-existing ignores.
//
// Un-ignore is the same endpoint as ignore with remove=1; the request shape
// mirrors a real browser un-ignore captured from DevTools (X-Requested-With +
// same-origin Referer are required, snr is the notinterested tracking token).

const { request } = require('@playwright/test');
const os = require('os');
const path = require('path');
const fs = require('fs');

const BASE = 'https://store.steampowered.com';
const USERDATA_PATH = '/dynamicstore/userdata/';
const IGNORE_PATH = '/recommended/ignorerecommendation/';

// Live Steam session cookies (shared with the test fixtures) and the pre-run
// snapshot, both kept OUTSIDE the repo (the tree may be cloud-synced).
const AUTH_FILE = path.join(os.homedir(), '.playwright-states', 'steam.json');
const SNAPSHOT_FILE = path.join(os.homedir(), '.playwright-states', 'ignored-before.json');

// Safety cap: a cleanup run should only ever remove a handful of test ignores.
// If the diff is larger than this, something is wrong (e.g. a bad snapshot) and
// we refuse rather than risk wiping the real ignore list.
const MAX_CLEANUP = 200;

async function newContext() {
    return request.newContext({ storageState: AUTH_FILE, baseURL: BASE });
}

function sessionId() {
    const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    const cookie = (state.cookies || []).find(c => c.name === 'sessionid');
    return cookie ? cookie.value : null;
}

// Returns { ids: string[], ownedCount } or null if userdata is unreadable.
// ownedCount > 0 is our logged-in signal (anonymous userdata has empty lists).
async function fetchIgnored(ctx) {
    const res = await ctx.get(`${USERDATA_PATH}?_=${Date.now()}`, { headers: { Accept: 'application/json' } });
    if (!res.ok()) return null;
    const data = await res.json();
    const ignored = data.rgIgnoredApps;
    if (ignored == null || typeof ignored !== 'object') return null;
    return { ids: Object.keys(ignored).map(String), ownedCount: (data.rgOwnedApps || []).length };
}

// Un-ignore a single appid via remove=1. Returns true on { success: true }.
async function unignore(ctx, sid, appid) {
    const res = await ctx.post(IGNORE_PATH, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'Origin': BASE,
            'Referer': `${BASE}/account/notinterested/`,
        },
        data: `sessionid=${sid}&appid=${appid}&snr=1_account_notinterested_&remove=1`,
    });
    if (!res.ok()) return false;
    try {
        const json = await res.json();
        return json.success === true;
    } catch (e) {
        return false;
    }
}

module.exports = { AUTH_FILE, SNAPSHOT_FILE, MAX_CLEANUP, newContext, sessionId, fetchIgnored, unignore };
