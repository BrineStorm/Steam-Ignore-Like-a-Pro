// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// src/settings-schema.js, run into a unit sandbox. Every module that reads a
// setting takes its keys and defaults from it at load time, as the extension
// loads it first wherever it runs.
function loadSettingsSchema(sandbox) {
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', 'src', 'settings-schema.js'), 'utf8'), sandbox);
}

module.exports = { loadSettingsSchema };
