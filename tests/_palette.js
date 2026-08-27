// SPDX-License-Identifier: GPL-3.0-or-later
//
// The product's review palette, loaded the way the unit specs load any src
// module: through `vm` with a window stub. Every live guard on Steam's colours
// reads it from HERE rather than retyping the shades — the first version of the
// canary kept its own copy, the copy was one surface's palette, and it stayed
// green through a repaint that had silently switched a feature off.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadPalette() {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '..', 'src', 'steam-palette.js'), 'utf8'), sandbox);
    return sandbox.window.ILAP.SteamPalette;
}

// Which band a rating IN WORDS belongs to. Steam's wording is graded
// ("Overwhelmingly Positive", "Mostly Negative"); the palette has three.
function bandOf(words) {
    if (/mixed/i.test(words)) return 'MIXED';
    if (/negative/i.test(words)) return 'NEGATIVE';
    if (/positive/i.test(words)) return 'BLUE';
    return null;
}

module.exports = { loadPalette, bandOf, PALETTE: loadPalette() };
