# Changelog

What changed in each released version, newest first. Versions follow the two
manifests (`platform/chromium/manifest.json`, `platform/firefox/manifest.json`),
which are the only place the version number lives.

No release dates here on purpose. The store listings show them, and a date in a
tracked file is one more thing that can quietly stop being true.

## 1.3.3

- **Built-in ignore lists.** Add a whole list to the ignore queue with the lists icon
  on the Ignore Tasks Queue panel. The lists cover games with AI-generated content by
  release year, Denuvo DRM, kernel-level anti-cheat, In-App Purchases and every VR
  game. They are built from what Steam shows on each game's store page and come with
  the extension.
- **Ignore a whole bundle with one gesture.** Swipe over a bundle's capsule, then once
  more to confirm, and every game and DLC in it goes to the ignore queue. The bundle
  gets its IGNORED badge once the queue is through with it.
- **Games on your wishlist are kept.** Curator lists, built-in lists, bundles and both
  Discovery Queue helpers skip them, and the queue shows how many it skipped. A
  gesture on a single game still ignores it.
- **A curator's two review types queue as two jobs.** With one of them in the queue,
  picking the other one or "All except Recommended" adds it as a job that waits its
  turn. The curator page button shows what is queued as a colour square. In its menu
  each queued filter has an "In queue" mark and a cross that takes it out of the queue.
- **Recent history shows ignores and un-ignores together.** Each entry has an icon of
  where it came from, a bulk undo shows up as one entry, and a click opens the game,
  curator or bundle.
- **Four new interface languages,** Simplified Chinese, Latin American Spanish,
  Indonesian and Vietnamese, 23 in all.
- Minor bug fixes, UI/UX improvements, refactoring and optimizations.

## 1.3.2

- **The extension's tagline and description are translated** into all 19 interface
  languages, in the browser and in the store.
- Change the reason on a game Steam already shows as ignored. A gesture on the
  cover Steam greys out switches it between Default Ignore and Already Played and
  tints Steam's IGNORED flag red or blue. Hover the flag to see what changed. Such
  a change is not counted, and Undo does not bring the old reason back.
- **Hover Total Ignored to see how many games your whole Steam ignore list contains,**
  as read from Steam, and when the list was last read.
- **Fixed the right-click swipe on macOS and Linux,** where the context menu opened
  on press and swallowed the gesture. While a gesture is bound, it now replaces
  the menu on game covers. A one-time card explains how to keep the menu.
- Reading a curator's list now shares the request pace with the ignores, so staging
  one curator while another is being ignored adds no extra burst of requests.
- While you browse Steam yourself, ignores from curator lists and Undo go out at a
  slower pace. When Steam asks to slow down after you press its own Ignore button,
  the queue backs off too.
- Improved translations.
- Minor bug fixes, UI/UX improvements, refactoring and optimizations.

## 1.3.1

- **Sale rewards stay yours to earn.** During a Steam sale that rewards going
  through the Discovery Queue, the Discovery Queue helper runs, and the Classic
  Discovery Queue moves on by itself, only once you have earned that reward by
  going through one queue yourself. Until then the Classic Discovery Queue still
  ignores, and you press Next.
- **Removed Fast Forward** from the Classic Discovery Queue.
- **A one-time notice** about Steam's Subscriber Agreement the first time you
  start a queue helper.
- Ignore requests are now sent at a fixed pace instead of a slightly varied one.
- Refactoring, optimizations and security improvements.

## 1.3.0

- **The *Explore Queue* is now the *Classic Discovery Queue*,** and so is its
  settings section (formerly *Your Discovery Queue*). Its switch no longer hides the
  Discovery Queue panel. Older entries below keep the old name.
- **Off now means off.** The master switch now removes everything the extension
  draws on the page and brings it back without a reload (the Classic Discovery
  Queue toast on the next queue page). Turning it back on never resumes a run by
  itself.
- **The master switch keeps your queue.** Off stops the drain only: jobs keep their
  progress and can still be removed, and they resume when the switch is back on.
- **Fixed a background queue that could stop for good after a network blip.** With
  no Steam tab open it now retries once an hour instead of waiting for you to open
  a Steam page.
- **Fixed swipes that could be quietly lost:** the game kept its IGNORED badge
  while nothing was sent to Steam.
- **Cover blur is on by default**, including on upgrade if you never changed the
  setting.
- **Undo menu:** a −/+ stepper instead of the 10/25/100 presets, clearer headings,
  and the number of ignores you can roll back shown in the field.
- Calmer tooltips: the undo button and the language chip wait 2.5 s before
  appearing, the Classic Discovery Queue switch uses the panel's own tooltip, and
  the *Un-ignore* row no longer shows one.
- Minor bug fixes, refactoring, optimizations and security improvements.

## 1.2.2

- **Fixed Keep High Score ignoring nothing.** Steam repainted the review-score
  colours on Discovery Queue cards, so every card read as well-reviewed.
- Both review classifiers (Discovery Queue and the Explore Queue's *ignore badly
  reviewed games* mode) now read one shared palette, which also keeps Steam's
  previous shades, so a rollback can't silently switch ignoring off.
- Live checks for the review palette and Keep High Score, and a weekly canary on
  the store markup the extension depends on.

## 1.2.1

- Un-ignore a single game by gesture: right-click and draw a circle or a zigzag
  on its cover, with its own shortcut selector in the settings.
- A toast when Steam refuses to roll an ignore back.
- Hotkey and shift-click on the widget chevron.
- Total Ignored counts both the ignore and the un-ignore queues.
- A more reliable check of whether you are signed in to Steam.
- Popup UI fits the 600px window; own tooltips for undo and the language chip.
- The Discovery Queue automator acts only on the game in the centre.
- Manual Ignore and the Discovery Queue automator now always start on Firefox.
- `LICENSE.MPL` no longer ships inside the package.
- Privacy policy: disclosed the local curator staging cache.
- A cancelled Manual Ignore job no longer un-badges games it never sent.
- Fixed the Firefox context menu, the widget tooltip placement and Explore Queue
  page tracking.

## 1.2

- **Curator ignore queue drained in the background.** On Chromium the MV3 service
  worker drains it with no Steam tab open at all.
- **Undo**: recent ignores can be rolled back, including as jobs the drainer
  works through, with a warning when a curator's ignores were undone recently.
- **Surface switch**: the interface moves between the on-page widget and the
  toolbar popup, with the widget parking to a ghost chevron.
- **An ignore-rate governor** shared by every source of ignores, plus a cap of
  two concurrent Discovery Queue runs across tabs.
- Push notifications for the Manual Ignore queue.
- Relicensed to GPL-3.0-or-later, with SPDX headers across the sources.
- All curator and queue strings translated into the other 18 locales.

## 1.1

- Opt-in blur over the covers of ignored games.
- The popup moved onto the page as a shadow-DOM widget; the toolbar popup was
  removed (it came back as a choice in 1.2).
- A curator ignore queue: enumerator, retention cache and a drainer that holds a
  lease, plus a queue applet in the popup.
- IGNORED badge placement on tag pages, badge size and labels in the Explore
  Queue, the wrong game name being saved, and the Discovery Queue buttons no
  longer break when Steam's interface language changes.

## 1.0.1

- Internationalization across 19 locales, with a language selector.

## 1.0.0

- First release: ignore games from the store by gesture, through the Explore Queue,
  or automatically through Your Discovery Queue, with a settings popup, an AI
  disclosure, a privacy policy and a readme.

---

Commits before 1.0.0 have a `1.3.0` version string in the manifest. It was never
released and never meant anything. The numbering restarts at 1.0.0.
