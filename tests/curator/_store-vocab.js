// SPDX-License-Identifier: GPL-3.0-or-later
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadEscape } = require('../_escape.js');

// The job-type vocabulary of src/curator/store.js, for the stub stores unit specs
// hand to the drainer and the staging services. Those read it through the store
// they are given (`store.JOB_TYPE`, `store.jobType`, `store.jobTraits`,
// `store.cappedCount`); taking it from the REAL file keeps a stub from drifting
// off the vocabulary it stands in for.
let cached = null;
function storeVocab() {
    if (cached) return Object.assign({}, cached);
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    loadEscape(sandbox);
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'curator', 'store.js'), 'utf8'), sandbox);
    const { JOB_TYPE, jobType, jobTraits, cappedCount } = sandbox.window.ILAP.Curator.Store;
    cached = { JOB_TYPE, jobType, jobTraits, cappedCount };
    return Object.assign({}, cached);
}

// Adds the vocabulary to a stub store in place (identity kept) and returns it.
function withVocab(store) {
    return Object.assign(store, storeVocab());
}

module.exports = { storeVocab, withVocab };
