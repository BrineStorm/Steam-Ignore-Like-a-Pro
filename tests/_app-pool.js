// Pool of store app pages for tests that just need "any real app page".
// Randomized per call so E2E runs don't open the same game page every time —
// a fixed /app/730/ visit before every automated ignore burst is a trivially
// machine-like pattern in Steam-side logs. Every entry is a huge evergreen
// title with no age gate.
const APP_POOL = [
    '730',     // Counter-Strike 2
    '570',     // Dota 2
    '440',     // Team Fortress 2
    '400',     // Portal
    '620',     // Portal 2
    '236390',  // War Thunder
    '252950',  // Rocket League
    '304930',  // Unturned
    '413150',  // Stardew Valley
    '105600',  // Terraria
    '945360',  // Among Us
];

function randomAppid() {
    return APP_POOL[Math.floor(Math.random() * APP_POOL.length)];
}

function randomAppPage() {
    return `/app/${randomAppid()}/`;
}

module.exports = { APP_POOL, randomAppPage };
