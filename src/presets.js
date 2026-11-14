// SPDX-License-Identifier: GPL-3.0-or-later
(function() {
    'use strict';

    // The built-in lists (data/presets.json, built by scripts/build-presets.js)
    // and the rules read from them, for the content script and the popup.
    //  - loadPresets: the file, read once per context.
    //  - aiGames: what the AI tab counts as AI games, less the kept ones.
    //  - aiKinds: what kind of AI a kept-able game uses, for its flag, or
    //    that it was marked by hand or lost its disclosure, for its page note.

    // The file ships with the build and never changes under it. A failed read
    // is tried again on the next call.
    let presets = null;
    function loadPresets() {
        if (!presets) {
            presets = fetch(chrome.runtime.getURL('data/presets.json'))
                .then(r => r.json())
                .catch((e) => { presets = null; throw e; });
        }
        return presets;
    }

    // The AI games of the built-in lists (data.ai, every year) less the games
    // the AI tab's ticked boxes keep (data.aikeep by kind), as a Set of numbers.
    // keep = { translation, ingame }; no keep gives every listed AI game. The
    // one rule of what the AI tab ignores: the lists' + (popup), the browsing
    // level (manual-ignore/ai-browse.js) and the Classic DQ's HIGH level
    // (explore-queue/utils.js AiVerdict). Built once per data object and boxes.
    const aiMemo = new WeakMap();
    function aiGames(data, keep) {
        const k = keep || {};
        const key = (k.translation === true ? 't' : '') + (k.ingame === true ? 'l' : '');
        let byKey = aiMemo.get(data);
        if (!byKey) aiMemo.set(data, byKey = new Map());
        if (byKey.has(key)) return byKey.get(key);
        const kept = new Set();
        for (const kind of ['translation', 'ingame']) {
            if (k[kind] !== true) continue;
            for (const a of ((data.aikeep || {})[kind] || [])) kept.add(Number(a));
        }
        const set = new Set();
        for (const list of Object.values(data.ai || {})) {
            for (const a of list) if (!kept.has(Number(a))) set.add(Number(a));
        }
        byKey.set(key, set);
        return set;
    }

    // The kind of AI use the lists know a game for, by appid number:
    // 'ingame' (AI runs while the game is played) or 'translation' (AI only
    // translates it). A game in both is 'ingame', the use a player meets. A game
    // in neither has no entry: its AI made something else. A game the lists
    // name by hand (data.aimanual) is 'manual': its page has no disclosure to
    // tell the kind. A game whose developer removed the disclosure
    // (data.airemoved) is 'removed' whatever the removed text said, the boxes
    // still go by data.aikeep. Built once per data.
    const kindMemo = new WeakMap();
    function aiKinds(data) {
        if (!data || typeof data !== 'object') return new Map();
        let kinds = kindMemo.get(data);
        if (kinds) return kinds;
        kinds = new Map();
        const keep = data.aikeep || {};
        for (const a of data.aimanual || []) kinds.set(Number(a), 'manual');
        for (const a of keep.translation || []) kinds.set(Number(a), 'translation');
        for (const a of keep.ingame || []) kinds.set(Number(a), 'ingame');
        for (const a of data.airemoved || []) kinds.set(Number(a), 'removed');
        kindMemo.set(data, kinds);
        return kinds;
    }

    window.ILAP = window.ILAP || {};
    window.ILAP.loadPresets = loadPresets;
    window.ILAP.aiGames = aiGames;
    window.ILAP.aiKinds = aiKinds;
})();
