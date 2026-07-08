// Shared random search-term helper. Tests that only need "a Steam store search
// page" (to host the on-page widget, or to land a manual-ignore swipe on a
// result row) used to hammer a single fixed term (portal / action). Hitting the
// exact same URL over and over with automation is both a needless fingerprint
// for Steam and thin coverage — one term's result layout. searchUrl() returns a
// fresh random term on every call, so each navigation lands on a different
// results page. All terms are common words that reliably return many /app/ game
// rows, so the manual-ignore row-picking helpers keep working.

const TERMS = [
    'action', 'adventure', 'strategy', 'puzzle', 'racing', 'shooter', 'horror',
    'pixel', 'hollow', 'dragon', 'ninja', 'robot', 'zombie', 'fantasy',
    'survival', 'space', 'indie', 'roguelike', 'platformer', 'sandbox',
];

function randomTerm() {
    return TERMS[Math.floor(Math.random() * TERMS.length)];
}

// A /search/ URL with a random term. Params match what the old fixed URLs used
// (a bare term already renders server-side result rows).
function searchUrl() {
    return `/search/?term=${randomTerm()}`;
}

module.exports = { TERMS, randomTerm, searchUrl };
