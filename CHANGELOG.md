# Changelog

What changed in each released version, newest first. Versions follow the two
manifests (`platform/chromium/manifest.json`, `platform/firefox/manifest.json`),
which are the only place the version number lives.

No release dates here on purpose: the store listings carry them, and a date in a
tracked file is one more thing that can quietly stop being true.

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
- The login check no longer trusts the `sessionid` cookie (Steam hands one to
  anonymous visitors too) — it reads the signed-in header and falls back to a
  cached probe, so "signed out" stays distinguishable from "couldn't ask".
- Popup UI fits the 600px window; own tooltips for undo and the language chip.
- The Discovery Queue automator acts strictly on the centred slot, and both
  content modules boot off a `readyState` guard instead of a bare `load`
  listener — on Firefox they could otherwise miss the event entirely.
- `LICENSE.MPL` no longer ships inside the package; it stays in the repository,
  where it documents what releases up to 1.1 went out under.
- Privacy policy: disclosed the local curator staging cache.
- A cancelled Manual Ignore job no longer un-badges games it never sent.
- The Firefox context-menu latch, the widget tooltip placement, and Explore Queue
  URL tracking (now polled).

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

First release: ignore games from the store by gesture, through the Explore Queue,
or automatically through Your Discovery Queue, with a settings popup, an AI
disclosure, a privacy policy and a readme.

---

Commits before 1.0.0 carry a `1.3.0` version string in the manifest. It was never
released and never meant anything; the numbering restarts at 1.0.0.
