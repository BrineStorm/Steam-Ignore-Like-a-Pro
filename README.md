# Steam Ignore Like A Pro

![alt text](assets/icons/icon128.png)

<p align="left">
  <a href="https://chromewebstore.google.com/detail/odammmlfgeicckclecklaidnogfibanj">
    <img src="assets/badges/chrome.png" alt="Chrome Web Store" height="54">
  </a>
  &nbsp;
  <a href="https://addons.mozilla.org/firefox/addon/steam-ignore-like-a-pro/">
    <img src="assets/badges/firefox.svg" alt="Get the Add-on" height="54">
  </a>
</p>

A browser extension that allows you to ignore Steam games directly from the storefront - no extra clicks to open a menu, and no need to open individual game pages.
**Steam Ignore Like A Pro** replaces this with a single gesture or hotkey, available on every Steam page.

<p align="left">
  <img src="assets/demo.gif" alt="Extension Demo" width="600">
</p>

## What's New

**v1.2**

- **Curator ignore queue** - stage an entire curator's list into a queue and let the extension work through it, paced so it never hammers Steam. Pause, resume, or drop individual jobs from the curator page or the queue view.
- **Background draining** - on Chrome/Edge the queue keeps going with no Steam tab open at all; close the window and come back to a finished list.
- **Undo** - a built-in undo applet reverses recent ignores, either by time ("the last hour") or by count ("the last 20"), from the settings interface.
- **Deferred manual ignore** - swipes and hotkeys now enqueue instead of firing a request immediately, so a burst of ignores is paced like the rest of the queue and the badge still appears instantly.
- **Ignore-rate governor** - every ignore request from every part of the extension passes through one shared pacer, and stops on its own if you sign out of Steam or switch the extension off.
- **On-page interface** - the settings/history panel now lives in a launcher on the Steam page itself (with a toolbar-popup mode still available), which also makes it usable inside the Steam desktop client.
- **19 interface languages**, up from 17.

**v1.1**

- **Multi-language interface** - the popup and on-page UI are now localized, with a language selector in the popup (17 languages).
- **Opt-in blur for ignored covers** - optionally blur the cover art of ignored games so they read as visually "crossed out"; toggle it in the popup settings (off by default).
- **Better coverage across Steam pages** - fixed the IGNORED badge placement on tag/sale pages and hardened the Discovery Queue automation so it keeps working when Steam's UI is in a non-English language.
- **Bug fixes** - corrected the wrong game name being saved from the popup, fixed a popup frame glitch, and fixed a page-reload issue in the Your Discovery Queue helper.
- **Hardened test suite** - full Playwright E2E suites stabilized with automatic cleanup of test-ignored games, and pure-logic checks moved to fast Node unit tests.

## What it does

- **One-Click Ignore** - Hold `Right-Click` + `Swipe Right` over any game capsule to ignore the game. This adds a red badge ![IGNORED](https://img.shields.io/badge/IGNORED-red) on each appearance of the game on the page and requests Steam to **ignore** these titles.
- **Alternative Hotkeys** - Configure to hold `Ctrl`, `Shift`, or `Alt` + `Left-Click` instead of swiping.
- **Already Played Mode** - Mark games you played on other platforms as **Already Played** by `swiping Left` or clicking. This adds a blue badge ![IGNORED](https://img.shields.io/badge/IGNORED-blue) and Steam stops suggesting these titles while **keeping** your recommendations relevant.

## Why not just use Steam's built-in ignore?

Native ignore is missing from many widgets and requires multiple clicks. 
Steam also lacks an "Already Played" feature outside of the game's full store page, and offers no way to automate ignoring during feed browsing. 
This extension allows this.

## Additional Features

### Popup & History

- **Quick Settings** - Customize gestures or hotkeys, configure ignore modes to suit your browsing style, and toggle specific features or the entire extension directly from the popup.
- **Ignore History Tracking** - View your recently ignored game titles instantly from the extension popup.
- **Undo** - Reverse recent ignores without hunting down each store page, either by time (everything from the last hour) or by count (the last N titles).

### Interface surface

The extension's settings/history interface can live in one of two places:

- **On the page** (default) - a small launcher docked in the top-right of every Steam Store page, so it works everywhere, including the Steam desktop client where the browser toolbar isn't available.
- **In the toolbar popup** - the classic browser action popup. Switch to it from the interface toggle in the settings. In this mode the on-page launcher steps aside to a faint beacon in the corner. (The toolbar popup is unavailable inside the Steam desktop client, so this mode is disabled there.)

**Escape hatch:** press **`Ctrl+Alt+Shift+I`** on any Steam Store page to force the interface back onto the page at any time.

### Automation Helpers

- **Your Discovery Queue Helper** - Automate ignoring while browsing through your daily Discovery Queue. 
Configurable to automatically ignore games that meet your criteria (e.g., Mixed/Negative reviews, or every game), or ignore and scroll forward for you.
<p align="left">
  <img src="assets/demo-queue2.gif" alt="Demo Your Discovery Queue" width="600">
</p>

- **Game Genre/Category Discovery Queue Auto-Ignore** - Bypass the standard Steam 10-tag ignore limit. 
By navigating to a specific tag, genre, or category page (such as Racing, VR or etc.) and opening its Discovery Queue, you can run the automator to quickly ignore **all** games from that list, or only those with bad reviews.
<p align="left">
  <img src="assets/demo-queue.gif" alt="Demo Discovery Queue" width="600">
</p>

- **Curator Ignore Queue** - Stage a whole curator's list into an ignore queue from the curator page, optionally filtered, and let the extension work through it at a measured pace. Jobs can be paused, resumed, or dropped while they run, and progress is visible in the interface.
On Chrome/Edge the queue keeps draining in the background with no Steam tab open; on Firefox it advances while a Steam Store page is open.

## Privacy

No tracking, no analytics, no external servers.  

- Runs exclusively on https://store.steampowered.com/*
- Your settings and ignore history are stored locally in `chrome.storage` and never leave your browser.
- API calls go directly to Steam's official endpoints.
- **No personal Steam API tokens are stored or copied.** It strictly uses your active session data.
- It does not send data to third-party servers, inject remote code, or use analytics.

See [PRIVACY.md](./PRIVACY.md) for the full privacy policy.

## Install

The extension is published on both stores - this is the recommended way to install it:

- **Chrome | Edge** - [Chrome Web Store](https://chromewebstore.google.com/detail/odammmlfgeicckclecklaidnogfibanj)
- **Firefox** - [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/steam-ignore-like-a-pro/)

### From source

For development, or to run a build ahead of the store release:

1. Clone or download the repository.
2. Open a terminal in the project root and run `npm install`.
3. Run `npm run build` (or `node build.js`) to generate the `dist/` folders.

**Chrome | Edge**

1. Open *chrome://extensions* or *edge://extensions*
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select the `dist/chromium` folder from the built project.

**Firefox**

1. Open *about:debugging#/runtime/this-firefox*
2. Click **Load Temporary Add-on**
3. Select the `manifest.json` file located inside the `dist/firefox` folder.

## FAQ

- **Why doesn't the game disappear or dim immediately?**  
The ignore request is sent via the Steam API rather than the UI (since native UI buttons aren't available on all storefront elements). 
Additionally, Steam caching can be slow and might temporarily continue displaying ignored games.

- **Why don't my ignores fire instantly?**  
Ignores are placed in a queue and sent at a deliberate pace, so a large batch never looks like a flood of requests to Steam. The badge appears immediately; the request follows shortly after.

- **Is this compliant with Steam's policies?**  
Yes. The extension automates standard Steam actions (the same clicks or requests you would make manually). It does not use exploits, backdoors, or undocumented APIs.

- **Can I undo an ignore?**  
Yes. Use the undo applet in the extension's interface to reverse the last N ignores or everything from a recent stretch of time. Since Steam Ignore Like A Pro applies a standard Steam ignore, you can also remove it anytime from the game's own store page.

- **Does it work with non-English Steam?**  
Yes. The extension interacts with page elements and structural DOM classes, not localized text labels, so language settings do not affect it.

## Project structure

- `platform/` - MV3 manifests, one per target (`chromium/manifest.json`, `firefox/manifest.json`).
- `build.js` - Node script to compile platform-specific distributions (Chromium/Firefox).
- `styles/styles.css` - Global CSS for injected badges and tooltips.
- `ui/` - Contains the popup interface (HTML, CSS, JS).
- `assets/` - Extension icons and other media files.
- `src/utils.js` - Shared utilities, stats management, and game name extraction logic.
- `src/manual-ignore/` - Modules for handling swipe gestures, hotkeys, and rendering badges on the storefront.
- `src/discovery-queue/` - Automation logic for the daily modal Discovery Queue.
- `src/explore-queue/` - Automation logic for tag, genre, and category queues.
- `src/curator/` - Curator list enumeration, the ignore queue store, and the drainer that works through it.
- `src/widget/` - The on-page interface launcher and its panel.
- `src/background.js` - Chromium service worker that drains the queue with no Steam tab open.
- `src/gate.js` - Shared ignore-rate governor every request passes through.
- `src/ignore-log.js`, `src/undo-service.js` - Ignore journal and the undo path built on it.
- `PRIVACY.md` - Privacy policy for users and the Chrome Web Store.

## Notes
- Steam Ignore Like A Pro is not affiliated with, endorsed by, or sponsored by Valve Corporation or Steam.
- The ignore action cannot be applied to capsule elements that represent bundles of multiple games. To ignore them, you must visit the bundle's store page and swipe or click to ignore each game individually.

## Testing

See [TESTING.md](./TESTING.md) for the full test suite overview, setup instructions, and per-module coverage.

## License

GNU General Public License v3.0 or later (`GPL-3.0-or-later`) - see [LICENSE](./LICENSE).

Releases up to and including v1.1 were distributed under the Mozilla Public License 2.0; that text is kept at [LICENSE.MPL](./LICENSE.MPL) for reference. Version 1.2 onward is GPL-3.0-or-later.

## Disclaimer

This extension is provided "as is", without warranty of any kind. Use it at your own risk. Automated and bulk actions (for example the curator ignore queue) interact with Steam on your behalf — you are responsible for your own account and for respecting Steam's Terms of Service. The authors are not liable for any consequences arising from its use.