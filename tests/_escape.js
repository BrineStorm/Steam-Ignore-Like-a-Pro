// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// src/escape.js, run into a unit sandbox. The extension loads it first in every
// world, and the storage modules take their write chain (ILAP.serialChain) from it
// at load time.
function loadEscape(sandbox) {
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', 'src', 'escape.js'), 'utf8'), sandbox);
}

module.exports = { loadEscape };
