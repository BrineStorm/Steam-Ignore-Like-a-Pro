// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // Pure helpers for all three worlds (loaded first everywhere): escaping, name
    // sanitizing, the lease owner id, the per-context write chain, and the
    // real-input guard.
    function escapeHTML(str) {
        // Only null/undefined become '': a count of 0 must still render.
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Names from Steam's DOM, before storage: render paths escape anyway, but a
    // path that forgets cannot become a stored-XSS sink, and length is bounded.
    const NAME_MAX_LEN = 120;
    function sanitizeName(str, maxLen) {
        return String(str == null ? '' : str)
            .replace(/[<>]/g, '')                    // no tag delimiters survive
            .replace(/\p{Cc}/gu, ' ')                 // drop control chars
            // Bidi embeddings, overrides and isolates. A name is third-party
            // text that lands in the popup history and the badge tooltip, and
            // an unterminated RLO reverses the text AROUND it. Deliberately not
            // all of \p{Cf}: ZWJ/ZWNJ live there too and are load-bearing in
            // Indic and Persian scripts and in emoji sequences, so the cut is
            // the bidi set alone. Removed, not spaced — invisible either way.
            .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
            .replace(/\s+/g, ' ')                    // collapse runs of whitespace
            .trim()
            .slice(0, maxLen || NAME_MAX_LEN);
    }

    // Collision-resistant per-context owner id for storage leases/slots (the
    // curator drain lease, the DQ registry slot); the prefix names the subsystem.
    const newOwnerId = (prefix) =>
        prefix + Math.random().toString(36).slice(2) + Date.now().toString(36);

    // A write chain for one context: each fn starts once the previous one has
    // settled, so overlapping read-modify-writes cannot lose an update. The
    // returned promise is fn's own, rejection included; a failure does not wedge
    // the chain. Across contexts there is no CAS, so this is per context only.
    function serialChain() {
        let chain = Promise.resolve();
        return (fn) => {
            const run = chain.then(fn);
            chain = run.catch(() => {});
            return run;
        };
    }

    // Wraps a handler for controls that sit in the page's DOM, where a page
    // script can .click() them: only real user input gets through.
    const realInput = (fn) => (e) => { if (e && e.isTrusted) fn(e); };

    window.ILAP = window.ILAP || {};
    window.ILAP.Sanitizer = window.ILAP.Sanitizer || {};
    window.ILAP.Sanitizer.escapeHTML = escapeHTML;
    window.ILAP.Sanitizer.sanitizeName = sanitizeName;
    window.ILAP.newOwnerId = newOwnerId;
    window.ILAP.serialChain = serialChain;
    window.ILAP.realInput = realInput;

})();
