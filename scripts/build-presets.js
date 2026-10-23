// SPDX-License-Identifier: GPL-3.0-or-later
// Builds data/presets.json, the built-in ignore lists, from the store-page scan
// (results.jsonl: one JSON row per game, written by the scraper that reads each
// game's English store page).
//
//   node scripts/build-presets.js <results.jsonl> [--today YYYY-MM-DD]
//
// Output:
//   ai     { "upcoming_2026": [appid...], "upcoming_2027": [...], "upcoming_2028+": [...],
//            tba: [...], "2026": [...], "2025": [...], "2024": [...], "earlier_2023": [...] }
//          games whose page shows Steam's AI Generated Content Disclosure, by
//          release date (see bucketOf; the years move with --today)
//   denuvo    [appid...]  games whose page names Denuvo's DRM among its DRM notices
//   anticheat [appid...]  games whose page says they use kernel-level anti-cheat,
//                         Denuvo's among them
//   iap       [appid...]  games in Steam's In-App Purchases category
//   vr        [appid...]  games in Steam's VR Only category
//   rev       { "<preset key>": "<hash>" }  one per list, see revOf
//
// Appids keep the scan's order (newest release first) and are numbers, to keep
// the file small. The popup reads `rev` to tell whether a list changed since
// the user ran it, so a list whose games did not change keeps its rev.
const fs = require('fs');
const path = require('path');

var OUT = path.join(__dirname, '..', 'data', 'presets.json');

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

function buildPresets(rows, today) {
    var ai = {};
    var flat = {};
    var seen = { ai: new Set() };
    Object.keys(FLAT).forEach(function (k) { flat[k] = []; seen[k] = new Set(); });
    rows.forEach(function (row) {
        if (!row || row.status !== 'ok') return;
        // A row with no usable appid would ship as null and be POSTed as "null".
        var appid = Number(row.appid);
        if (!Number.isInteger(appid) || appid <= 0) return;
        if (row.ai === true && !seen.ai.has(appid)) {
            seen.ai.add(appid);
            var bucket = bucketOf(row.date, today);
            (ai[bucket] = ai[bucket] || []).push(appid);
        }
        Object.keys(FLAT).forEach(function (k) {
            if (seen[k].has(appid) || !FLAT[k](row)) return;
            seen[k].add(appid);
            flat[k].push(appid);
        });
    });

    // No key order here: JSON keys that look like integers come back sorted
    // ascending whatever the order written, so the popup orders the menu itself.
    var rev = {};
    Object.keys(ai).forEach(function (k) { rev['ai_' + k] = revOf(ai[k]); });
    var out = { ai: ai };
    Object.keys(FLAT).forEach(function (k) {
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

function main(argv) {
    var file = argv[0];
    if (!file) {
        console.error('Usage: node scripts/build-presets.js <results.jsonl> [--today YYYY-MM-DD]');
        process.exit(1);
    }
    var at = argv.indexOf('--today');
    var today = at >= 0 ? new Date(argv[at + 1] + 'T00:00:00Z') : new Date();
    // An unreadable date would put every game in 'tba' without a word.
    if (isNaN(today.getTime())) {
        console.error('--today wants YYYY-MM-DD, got: ' + argv[at + 1]);
        process.exit(1);
    }
    var out = buildPresets(readRows(file), today);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
    var counts = Object.keys(out.ai).map(function (k) { return k + ' ' + out.ai[k].length; });
    console.log('AI: ' + counts.join(', '));
    Object.keys(FLAT).forEach(function (k) { console.log(k + ': ' + out[k].length); });
    console.log('Wrote ' + path.relative(process.cwd(), OUT) + ' (' + fs.statSync(OUT).size + ' bytes)');
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { bucketOf: bucketOf, revOf: revOf, buildPresets: buildPresets };
