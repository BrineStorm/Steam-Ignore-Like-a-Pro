// Shared random tag-page helper. Two suites navigate to a /tags/en/<Tag> sale
// page: Discovery Queue (the "Explore Your Discovery Queue" widget that opens
// the DQ modal lives there) and Manual Ignore (its stacked capsule blocks).
//
// Why the tag is random, and why every tag here is a BIG one. The queue that
// widget serves is drawn from the tag's pool, and Steam counts every game the
// automator lands on as SEEN — whether the ignore stuck or the teardown rolled
// it back. Run the DQ suite against one fixed tag often enough and its pool
// runs dry: the queue ends after a handful of games, the automator spends its
// budget on "Continue" interstitials, and MAX_CONTINUE_STREAK stops the loop
// (observed: end-of-queue at game 7, then a stalled run).
//
// Rotating tags spreads that consumption, but only if the tags are deep to
// begin with. Measured catalogue sizes (store search total_count) for the tags
// that actually starved: Collectathon 6.3k, Racing 8.8k, Sports 10k — with
// smaller ones (Farming 653, Trivia 837, Fishing 1.8k) squarely in the same
// band or worse. So the pool below is drawn from the other end of the scale:
// every tag carries ≥19k titles, and most 40k–140k. Catalogue size is a proxy,
// not the mechanism (Steam does not publish how it slices a tag's queue), but
// it orders the tags the right way and the failures cluster at the small end.
//
// Every tag below was probed live: the page renders
// .SaleSectionCtn.discoveryqueue with a clickable widget inside.

const TAGS = [
    'Singleplayer', 'Indie', 'Action', 'Casual', 'Adventure', '2D', '3D',
    'Strategy', 'Simulation', 'RPG', 'Atmospheric', 'Exploration',
    'Story Rich', 'Pixel Graphics', 'Fantasy', 'Puzzle', 'Cute',
    'First-Person', 'Multiplayer', 'Arcade', 'Relaxing', 'Funny', 'Horror',
    'Sci-fi', 'Roguelike',
];

function randomTag() {
    return TAGS[Math.floor(Math.random() * TAGS.length)];
}

// A /tags/en/<Tag> URL with a random tag (encoded — some names carry a space).
function tagUrl() {
    return `/tags/en/${encodeURIComponent(randomTag())}`;
}

module.exports = { TAGS, randomTag, tagUrl };
