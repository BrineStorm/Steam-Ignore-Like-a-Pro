# Tech Stack

| Concern | Tool |
|---------|------|
| Language | Vanilla JS (ES2020+) |
| Build | `node build.js` → copies assets to `dist/chromium` and `dist/firefox`, then packs each into `dist/steam-ignore-like-a-pro-<version>-<platform>.zip` (stale packages are removed first; `--test` skips packing). The tree is copied wholesale, so `PLATFORM_EXCLUDES` drops the files one platform's manifest can never load — today `src/background.js` and `src/sw-handoff.js` out of the Firefox build |
| Tests | Playwright E2E (`npm test`, `npm run test:e2e`, `npm run test:auth`) |
| Storage | `chrome.storage.local` (persistent), `sessionStorage` (per-tab) |
| API | Steam `POST /recommended/ignorerecommendation/` |
