# Privacy Policy for Steam Ignore Like a Pro

**Effective Date:** November 14, 2026

Steam Ignore Like a Pro is a free, open-source browser extension. This Privacy Policy explains our commitment to your privacy — in the extension and on its website.

### Data Collection & Usage
This extension **does not** collect, transmit, or share any personal data or user information. Anything it saves stays on your own device (see Permissions & Local Storage below).

Specifically:
* **No browsing history** is collected or transmitted.
* **No personal information (PII)** is collected or transmitted.
* **No usage statistics or analytics** are collected.
* **No cookies** are created by the extension. Requests to Steam include your existing Steam session cookies, exactly as your browser sends them when you use the site yourself. The extension reads one value from them, your Steam `sessionid`, because Steam requires it on every ignore request.
* **No data** is sent to us or to any third-party server. The extension communicates only with Steam's own servers, such as `store.steampowered.com` and `api.steampowered.com`. It does so only to perform the ignore and un-ignore actions you start or turn on in the extension, to read the state of your Steam account that these actions depend on (for example your ignore list and whether you are signed in), and to read public Steam Store information.

### Permissions & Local Storage
The extension requires the `storage` browser permission to function. This permission is used **solely** to keep the extension's own data locally on your device. This data includes your settings, your history of ignores and un-ignores, the tasks you started in the extension and their progress, and copies of what the extension last read from Steam (your account state and public store information), so it does not have to ask Steam again. It also includes the Steam session token and the activity times described below. All of it stays in your browser and is never transmitted to us or to any third party.

While the extension is turned on, it notices on Steam Store pages when the page itself sends an ignore request, for example when you press Steam's own Ignore button, and whether Steam accepted it. It keeps only the time of that request, together with the time of your last click or key press on the page, so the queue can slow down while you browse and back off when Steam asks for fewer requests. Both stay in local storage.

On Chrome and Edge the extension additionally requires the `alarms` permission. It is used **solely** to wake the extension's own background worker on a timer, so a queued list of ignores keeps progressing while no Steam tab is open. It grants no access to your data.

On Chrome and Edge, so the queue can keep progressing with no Steam tab open, the extension caches a copy of your Steam `sessionid` in that same local storage — the background worker cannot read cookies itself. The copy is refreshed whenever you open a Steam store page, the worker clears it once it finds that session has ended, and it is sent only back to Steam, with the ignore requests you queued, exactly as your browser sends it when you use the site yourself. On Firefox nothing of the kind is stored: the queue is worked by the Steam page itself there, so there is no copy to keep — and a copy left behind by a version before 1.3.0, which did store one there, is deleted when you update.

During a Steam sale that rewards going through the Discovery Queue, the queue helpers do not move through a queue on their own until you have earned that reward yourself. To check, the extension reads your Steam web API token from the Steam store page you have open and sends it to Steam's own API (`api.steampowered.com`) with that one request — exactly as the store page itself does. The token is not stored. Only the answer is kept in local storage, together with your public Steam account ID (read from that token) so that the answer is never reused for another account signed into the same browser, and with how long it stays valid — until the sale ends once the reward is earned, briefly otherwise — so the check is not repeated on every click.

### Third Parties
This extension does not integrate with any third-party services, analytics platforms, or advertising networks.

### The Website
The website, [steamignorelikeapro.com](https://steamignorelikeapro.com), sets **no cookies**, runs **no analytics, tracking or ads**, and loads nothing from third parties. It is hosted on Cloudflare. To deliver each page, Cloudflare necessarily receives technical connection data — your IP address, browser type and the page requested — and processes it on our behalf as our hosting provider, including to protect the site against abuse. We keep visitor logs and analytics switched off, so we **do not receive, log or store** that data, and it is never used to identify or track anyone. Cloudflare's handling of it is covered by [Cloudflare's Privacy Policy](https://www.cloudflare.com/privacypolicy/). This processing rests on our legitimate interest in delivering the website securely (Art. 6(1)(f) GDPR).

### Your Rights (GDPR & CCPA)
We hold no personal data about you, so there is nothing of yours for us to provide, correct or delete. Your rights under the GDPR and CCPA still apply — including access, erasure and objection, and the right to lodge a complaint with a data protection authority — and you can raise any of them with us at the address below.

### Contact
The extension and its website are run by their developer, BrineStorm, who is responsible for them under data protection law. For questions about this Privacy Policy or your data, write to [brinestormdev@gmail.com](mailto:brinestormdev@gmail.com) or open an issue on our [GitHub repository](https://github.com/BrineStorm/Steam-Ignore-Like-a-Pro/issues). The same address takes notices from rights holders about any material shown on the website.
