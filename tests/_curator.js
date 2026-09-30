// SPDX-License-Identifier: GPL-3.0-or-later
//
// The curator surface the live guards drive, plus the product's own URL builder
// — loaded through `vm` the way tests/_palette.js loads the palette, so the
// canary calls the endpoint src/curator/enumerate.js calls rather than a
// retyped copy of it. A guard with its own copy of the thing it guards guards
// nothing.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// PINNED, not discovered. The /curators/ landing builds its list from a
// session-backed API and hands an anonymous reader no /curator/<id> link at all
// (probed: zero matches after networkidle, on the landing and on an app page),
// so there is nothing for a bare CI runner to scrape. The cost is that a
// curator going away turns the canary red for an innocent reason; the exchange
// is a guard on the quietest failure path in the extension, which otherwise has
// none. Same curator the live enqueue spec drives.
const CURATOR_ID = '45186708';   // "No AI" — public, long-lived, small catalogue

const curatorPath = (id) => `/curator/${id || CURATOR_ID}/`;

function loadEnumerator() {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '..', 'src', 'curator', 'enumerate.js'), 'utf8'),
        sandbox);
    return sandbox.window.ILAP.Curator.Enumerator;
}

// The recommendations URL as the product builds it, made relative so a spec can
// hand it straight to a same-origin fetch on a store page.
function recommendationsPath(id, start, count) {
    const url = loadEnumerator().buildUrl(id || CURATOR_ID, start || 0, count || 10);
    return url.replace('https://store.steampowered.com', '');
}

module.exports = { CURATOR_ID, curatorPath, recommendationsPath, loadEnumerator };
