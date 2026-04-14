# Steam Ignore Like A Pro

[![Chrome Web Store](https://img.shields.io/badge/Chrome-Under_Review-blue.svg?logo=googlechrome)](#)
[![Firefox Add-ons](https://img.shields.io/badge/Firefox-Under_Review-blue.svg?logo=firefoxbrowser)](#)

![alt text](assets/icons/icon128.png)

A browser extension that allows you to ignore Steam games directly from the storefront - no extra clicks to open a menu, and no need to open individual game pages.
**Steam Ignore Like A Pro** replaces this with a single gesture or hotkey, available on every Steam page.

<video src="assets/demo.mp4" autoplay loop muted playsinline width="33%"></video>

## What it does

- **One-Click Ignore** - Hold `Right-Click` + `Swipe Right` over any game capsule to ignore the game. This adds a red badge ![IGNORED](https://img.shields.io/badge/IGNORED-red) on each appearance of the game on the page and requests Steam to stop suggesting these titles.
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

### Automation Helpers

- **Your Discovery Queue Helper** - Automate ignoring while browsing through your daily Discovery Queue. 
Configurable to automatically ignore games that meet your criteria (e.g., Mixed/Negative reviews, or every game), or ignore and scroll forward for you.
- **Game Genre/Category Discovery Queue Auto-Ignore** - Bypass the standard Steam 10-tag ignore limit. 
By navigating to a specific tag, genre, or category page (such as Racing, VR or etc.) and opening its Discovery Queue, you can run the automator to quickly ignore **all** games from that list, or only those with bad reviews.

## Privacy

No tracking, no analytics, no external servers.  

- Runs exclusively on https://store.steampowered.com/*
- Your settings and ignore history are stored locally in `chrome.storage` and never leave your browser.
- API calls go directly to Steam's official endpoints.
- **No personal Steam API tokens are stored or copied.** It strictly uses your active session data.
- It does not send data to third-party servers, inject remote code, or use analytics.

See [PRIVACY.md](./PRIVACY.md) for the full privacy policy.

## Install locally

Store listings are currently under review. In the meantime, you can install manually by building the extension from source:

1. Clone or download the repository.
2. Open a terminal in the project root and run `npm install`.
3. Run `npm run build.js` (or `node build`) to generate the `dist/` folders.

### <img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/chrome/chrome_24x24.png" width="20" height="20" align="center"> Chrome | <img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/edge/edge_24x24.png" width="20" height="20" align="center"> Edge
1. Open *chrome://extensions* or *edge://extensions*
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select the `dist/chromium` folder from the built project.

### <img src="https://raw.githubusercontent.com/alrra/browser-logos/main/src/firefox/firefox_24x24.png" width="20" height="20" align="center"> Firefox
1. Open *about:debugging#/runtime/this-firefox*
2. Click **Load Temporary Add-on**
3. Select the `manifest.json` file located inside the `dist/firefox` folder.

## FAQ

- **Why doesn't the game disappear or dim immediately?**  
The ignore request is sent via the Steam API rather than the UI (since native UI buttons aren't available on all storefront elements). 
Additionally, Steam caching can be slow and might temporarily continue displaying ignored games.

- **Is this compliant with Steam's policies?**  
Yes. The extension automates standard Steam actions (the same clicks or requests you would make manually). It does not use exploits, backdoors, or undocumented APIs.

- **Can I undo an ignore?**  
Yes. Steam Ignore Like A Pro applies a standard Steam ignore. You can remove it anytime from the game's store page.

- **Does it work with non-English Steam?**  
Yes. The extension interacts with page elements and structural DOM classes, not localized text labels, so language settings do not affect it.

## Project structure

- `manifest.json` - MV3 extension manifest.
- `build.js` - Node script to compile platform-specific distributions (Chromium/Firefox).
- `styles/styles.css` - Global CSS for injected badges and tooltips.
- `ui/` - Contains the popup interface (HTML, CSS, JS).
- `assets/` - Extension icons and other media files.
- `src/utils.js` - Shared utilities, stats management, and game name extraction logic.
- `src/manual-ignore/` - Modules for handling swipe gestures, hotkeys, and rendering badges on the storefront.
- `src/discovery-queue/` - Automation logic for the daily modal Discovery Queue.
- `src/explore-queue/` - Automation logic for tag, genre, and category queues.
- `PRIVACY.md` - Privacy policy for users and the Chrome Web Store.

## Notes
- Steam Ignore Like A Pro is not affiliated with, endorsed by, or sponsored by Valve Corporation or Steam.
- The ignore action cannot be applied to capsule elements that represent bundles of multiple games. To ignore them, you must visit the bundle's store page and swipe or click to ignore each game individually.

## License

Mozilla Public License 2.0 - see [LICENSE](./LICENSE).