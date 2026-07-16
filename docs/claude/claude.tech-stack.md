# Tech Stack

| Concern | Tool |
|---------|------|
| Language | Vanilla JS (ES2020+) |
| Build | `node build.js` → copies assets to `dist/chromium` and `dist/firefox` |
| Tests | Playwright E2E (`npm test`, `npm run test:e2e`, `npm run test:auth`) |
| Storage | `chrome.storage.local` (persistent), `sessionStorage` (per-tab) |
| API | Steam `POST /recommended/ignorerecommendation/` |
