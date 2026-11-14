// SPDX-License-Identifier: GPL-3.0-or-later
// Builds data/presets.json, the built-in ignore lists, from the store-page scan
// (results.jsonl: one JSON row per game, written by the scraper that reads each
// game's English store page).
//
//   node scripts/build-presets.js <results.jsonl> [--today YYYY-MM-DD] [--verdicts <file>] [--manual <file>] [--changes <file>] [--list <key>=<file>]...
//
// --verdicts: the reviewed answers for aikeep,
// one JSON row per game { appid, hash, t, l }, the last row per appid wins. A
// verdict stands while the game's disclosure text still has its hash, and
// takes the place of the word rules for that game.
//
// --manual: AI games picked by hand that the scan does not flag, one JSON row
// per game { appid, name, date, note }, the last row per appid wins. Such a
// game goes in the AI list of its release date, the scan's date when the scan
// has its page, else the row's own, and in `aimanual`. A page the scan saw go
// away drops it.
//
// --changes: the scan's change log (changes.jsonl, one row per changed field).
// An AI game whose developer took the disclosure off stays in the AI lists, filed
// by its release date and sorted for aikeep by the last text it had, and goes in
// `airemoved`. The log rather than the scan's older rows, since compacting the
// scan drops those. A page the scan saw go away drops the game.
//
// --list: a list kept by reviewers, one JSON row per game { appid, in }, the last row per appid wins. The games
// whose last row is `in: true` and whose page the scan has as 'ok' make list
// <key>, or join it when the scan fills it too (anticheat). Repeatable.
//
// Output:
//   ai     { "upcoming_2026": [appid...], "upcoming_2027": [...], "upcoming_2028+": [...],
//            tba: [...], "2026": [...], "2025": [...], "2024": [...], "earlier_2023": [...] }
//          games whose page shows Steam's AI Generated Content Disclosure, by
//          release date (see bucketOf; the years move with --today)
//   aikeep { translation: [appid...], ingame: [appid...] }  AI games the AI tab's
//          checkboxes can keep out of the AI lists, by their disclosure's
//          words (src/ai-disclosure.js): AI only for translation, and live
//          AI inside the game
//   aimanual  [appid...]  the --manual games in the AI lists, whose page note
//                         says they were marked by hand
//   airemoved [appid...]  the --changes games in the AI lists, whose flag's tooltip on
//                         their page says the developer removed the disclosure
//   denuvo   [appid...]  games whose page names Denuvo's DRM among its DRM notices
//   anticheat [appid...]  games whose page says they use kernel-level anti-cheat,
//                         Denuvo's among them
//   iap       [appid...]  games in Steam's In-App Purchases category
//   vr        [appid...]  games in Steam's VR Only category
//   <key>     [appid...]  each --list: bad (Known bad games), eula (invasive
//                         EULA), eularetro (EULA that can change at any time)
//   lesser    [appid...]  the bad games under 200 reviews, with negative reviews
//                         or named a simulator, that no verdict marks `known: true`,
//                         out of bad (Lesser-known bad games)
//   rev      { "<preset key>": "<hash>" }  one per list, see revOf
//
// Appids keep the scan's order (newest release first) and are numbers, to keep
// the file small. The popup reads `rev` to tell whether a list changed since
// the user ran it, so a list whose games did not change keeps its rev.
//
// The scan re-reads known pages and appends a row for each, so the LAST row of
// an appid is the page as it is now (a page that went away ends on a row that
// is not 'ok', which drops the game). The game keeps the place of its first row.
const fs = require('fs');
const path = require('path');
const { translationOnly, liveAI } = require('../src/ai-disclosure.js');

var OUT = path.join(__dirname, '..', 'data', 'presets.json');
// The review count that makes a bad game a known one (user's call).
var KNOWN_REVIEWS = 200;
var NEGATIVE = ['Mostly Negative', 'Negative', 'Very Negative', 'Overwhelmingly Negative'];

var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// "Feb 24, 2022" (the English page) and "24 Feb, 2022".
var MDY = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})$/;
var DMY = /^(\d{1,2}) ([A-Za-z]{3})[a-z]*\.?, (\d{4})$/;
var YEAR = /\b(\d{4})\b/;

// The list a game's release date puts it in. A released game goes under its
// year, the last three years each in a list of their own and the older ones in
// 'earlier_<year>'. A game still ahead of `today` goes under
// 'upcoming_<year>', this year and the next each in a list of their own and the
// later ones in 'upcoming_<year>+'. A page with no year ("Coming soon", "To be
// announced") goes under 'tba'. A bare past year counts as released that year,
// a bare year from this one on ("2026", "Q1 2027") as upcoming.
function bucketOf(date, today) {
    var now = today.getUTCFullYear();
    var released = function (y) { return y >= now - 2 ? String(y) : 'earlier_' + (now - 3); };
    var upcoming = function (y) { return y >= now + 2 ? 'upcoming_' + (now + 2) + '+' : 'upcoming_' + y; };
    var s = String(date || '').trim();
    var m = MDY.exec(s);
    var day = m ? [m[3], m[1], m[2]] : null;
    if (!day) {
        m = DMY.exec(s);
        if (m) day = [m[3], m[2], m[1]];
    }
    if (day) {
        var month = MONTHS[day[1].toLowerCase()];
        if (month !== undefined) {
            var at = Date.UTC(+day[0], month, +day[2]);
            return at > today.getTime() ? upcoming(+day[0]) : released(+day[0]);
        }
    }
    var y = YEAR.exec(s);
    if (y) return +y[1] < now ? released(+y[1]) : upcoming(+y[1]);
    return 'tba';
}

// FNV-1a over the sorted list, as 8 hex digits. Sorted, so a rescan that
// lists the same games in another order keeps the rev.
function revOf(appids) {
    var h = 0x811c9dc5;
    var s = appids.slice().sort(function (a, b) { return a - b; }).join(',');
    for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
}

// FNV-1a over a disclosure text, as 8 hex digits: a verdict holds while the
// text it was given for is still the page's.
function textHash(text) {
    var h = 0x811c9dc5;
    var s = String(text || '');
    for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
}

// The last row per appid, in the order the appids first came.
function lastRows(rows) {
    var last = new Map();
    rows.forEach(function (row) {
        if (!row) return;
        // A row with no usable appid would ship as null and be POSTed as "null".
        var appid = Number(row.appid);
        if (!Number.isInteger(appid) || appid <= 0) return;
        last.set(appid, row);
    });
    return last;
}

// The games whose last AI change in the log took their disclosure off, as a Map
// appid → the text they last had.
function removedAi(changes) {
    var off = new Set();
    var text = new Map();
    changes.forEach(function (c) {
        if (!c) return;
        var appid = Number(c.appid);
        if (c.field === 'text' && c.was) text.set(appid, c.was);
        if (c.field !== 'ai') return;
        if (c.was === true && c.now === false) off.add(appid);
        else off.delete(appid);
    });
    var removed = new Map();
    off.forEach(function (appid) { removed.set(appid, text.get(appid) || ''); });
    return removed;
}

function strings(v) { return Array.isArray(v) ? v : []; }

// The lists that ship whole, each with the test a scanned row passes to join it.
var FLAT = {
    // Denuvo's DRM only. Its anti-cheat goes by the anti-cheat test below, so a
    // DRM notice that names nothing but "Denuvo Anti-Cheat" is left out.
    denuvo: function (row) { return strings(row.drm).some(function (d) { return /denuvo(?!\s*anti-?cheat)/i.test(d); }); },
    // The scan also keeps anti-cheat that runs outside the kernel.
    anticheat: function (row) { return strings(row.anticheat).some(function (a) { return /kernel level/i.test(a); }); },
    iap: function (row) { return strings(row.cats).indexOf('In-App Purchases') >= 0; },
    vr: function (row) { return strings(row.cats).indexOf('VR Only') >= 0; },
};

// `verdicts`: an optional Map appid → { hash, t, l } (see --verdicts).
// `manual`: an optional Map appid → { date } (see --manual).
// `lists`: an optional { key: Map appid → { in } } (see --list).
// `removed`: an optional Map appid → text (removedAi, see --changes).
function buildPresets(rows, today, verdicts, manual, lists, removed) {
    var last = lastRows(rows);
    var ai = {};
    var aikeep = { translation: [], ingame: [] };
    var aimanual = [];
    var airemoved = [];
    var flat = {};
    Object.keys(FLAT).forEach(function (k) { flat[k] = []; });
    last.forEach(function (row, appid) {
        if (row.status !== 'ok') return;
        var off = row.ai !== true && !!removed && removed.has(appid);
        if (row.ai === true || off) {
            var text = off ? removed.get(appid) : row.text;
            var bucket = bucketOf(row.date, today);
            (ai[bucket] = ai[bucket] || []).push(appid);
            var v = verdicts && verdicts.get(appid);
            if (v && v.hash !== textHash(text)) v = null;   // given for an older text
            if (v ? v.t : translationOnly(text, row.name)) aikeep.translation.push(appid);
            if (v ? v.l : liveAI(text)) aikeep.ingame.push(appid);
            if (off) airemoved.push(appid);
        }
        Object.keys(FLAT).forEach(function (k) {
            if (FLAT[k](row)) flat[k].push(appid);
        });
    });
    if (manual) manual.forEach(function (m, appid) {
        var row = last.get(appid);
        if (row && (row.status !== 'ok' || row.ai === true || airemoved.indexOf(appid) >= 0)) return;   // page gone, or in the lists already
        var bucket = bucketOf(row ? row.date : m.date, today);
        (ai[bucket] = ai[bucket] || []).push(appid);
        aimanual.push(appid);
    });
    Object.keys(lists || {}).forEach(function (k) {
        var list = flat[k] = flat[k] || [];
        last.forEach(function (row, appid) {
            var v = lists[k].get(appid);
            if (v && v.in === true && row.status === 'ok' && list.indexOf(appid) < 0) list.push(appid);
        });
    });
    // Known bad games keeps the games picked by hand (`known: true`) and the ones
    // with KNOWN_REVIEWS reviews or more, unless their reviews are negative or
    // they are simulators. The rest make Lesser-known bad games (user's call).
    if (flat.bad) {
        var lesser = flat.lesser = [];
        flat.bad = flat.bad.filter(function (appid) {
            var row = last.get(appid);
            var known = lists.bad.get(appid).known === true || ((row.nrev || 0) >= KNOWN_REVIEWS
                && NEGATIVE.indexOf(row.reviews) < 0 && !/simulator/i.test(row.name || ''));
            if (!known) lesser.push(appid);
            return known;
        });
    }

    // No key order here: JSON keys that look like integers come back sorted
    // ascending whatever the order written, so the popup orders the menu itself.
    var rev = {};
    Object.keys(ai).forEach(function (k) { rev['ai_' + k] = revOf(ai[k]); });
    var out = { ai: ai, aikeep: aikeep, aimanual: aimanual, airemoved: airemoved };
    Object.keys(flat).forEach(function (k) {
        out[k] = flat[k];
        rev[k] = revOf(flat[k]);
    });
    out.rev = rev;
    return out;
}

function readRows(file) {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(function (line) {
        if (!line.trim()) return null;
        try { return JSON.parse(line); } catch (e) { return null; } // a half-written last line
    });
}

// The verdicts or manual file as a Map appid → its last row, with the same
// appid check as the scan's rows: a hand-written row is no safer.
function readVerdicts(file) {
    return lastRows(readRows(file));
}

function main(argv) {
    var file = argv[0];
    if (!file) {
        console.error('Usage: node scripts/build-presets.js <results.jsonl> [--today YYYY-MM-DD] [--verdicts <file>] [--manual <file>] [--changes <file>]');
        process.exit(1);
    }
    var at = argv.indexOf('--today');
    var today = at >= 0 ? new Date(argv[at + 1] + 'T00:00:00Z') : new Date();
    // An unreadable date would put every game in 'tba' without a word.
    if (isNaN(today.getTime())) {
        console.error('--today wants YYYY-MM-DD, got: ' + argv[at + 1]);
        process.exit(1);
    }
    var vat = argv.indexOf('--verdicts');
    var verdicts = vat >= 0 ? readVerdicts(argv[vat + 1]) : null;
    var mat = argv.indexOf('--manual');
    var manual = mat >= 0 ? readVerdicts(argv[mat + 1]) : null;
    var cat = argv.indexOf('--changes');
    var removed = cat >= 0 ? removedAi(readRows(argv[cat + 1])) : null;
    var lists = {};
    argv.forEach(function (a, i) {
        if (a !== '--list') return;
        var m = /^([a-z]+)=(.+)$/.exec(argv[i + 1] || '');
        if (!m) {
            console.error('--list wants <key>=<file>, got: ' + argv[i + 1]);
            process.exit(1);
        }
        lists[m[1]] = readVerdicts(m[2]);
    });
    var out = buildPresets(readRows(file), today, verdicts, manual, lists, removed);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
    var counts = Object.keys(out.ai).map(function (k) { return k + ' ' + out.ai[k].length; });
    console.log('AI: ' + counts.join(', '));
    console.log('AI only for translation: ' + out.aikeep.translation.length + ', live AI inside the game: ' + out.aikeep.ingame.length);
    console.log('Disclosure removed, kept in the AI lists: ' + out.airemoved.length);
    Object.keys(FLAT).concat(Object.keys(lists), out.lesser ? ['lesser'] : []).forEach(function (k, i, all) {
        if (all.indexOf(k) === i) console.log(k + ': ' + out[k].length);
    });
    console.log('Wrote ' + path.relative(process.cwd(), OUT) + ' (' + fs.statSync(OUT).size + ' bytes)');
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
    bucketOf: bucketOf, revOf: revOf, textHash: textHash, lastRows: lastRows, removedAi: removedAi,
    buildPresets: buildPresets, readRows: readRows, readVerdicts: readVerdicts,
};
