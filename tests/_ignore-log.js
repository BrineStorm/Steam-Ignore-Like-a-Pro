// SPDX-License-Identifier: GPL-3.0-or-later
// The ignore log as one oldest → newest array, from a raw storage object.
//
// src/ignore-log.js stores it in chunks (ilap_ignore_log_index + ilap_ignore_log_c<seq>),
// so a spec that inspects storage directly — a Node stub's backing object, or a
// get(null) from the extension — reassembles it here. An unmigrated legacy array
// (seeded by a spec and not read by the extension yet) is still the head of the log.
function logFromStorage(data) {
    const index = data.ilap_ignore_log_index || { first: 0, last: 0 };
    const legacy = Array.isArray(data.ilap_ignore_log) ? data.ilap_ignore_log : [];
    const chunks = [];
    for (let seq = index.first; seq <= index.last; seq++) {
        const chunk = data['ilap_ignore_log_c' + seq];
        if (Array.isArray(chunk)) chunks.push(...chunk);
    }
    return legacy.concat(chunks);
}

module.exports = { logFromStorage };
