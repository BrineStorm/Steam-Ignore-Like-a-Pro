# Changelog

What changed in each released version, newest first. Versions follow the two
manifests (`platform/chromium/manifest.json`, `platform/firefox/manifest.json`),
which are the only place the version number lives.

No release dates here on purpose: the store listings carry them, and a date in a
tracked file is one more thing that can quietly stop being true.

## 1.2.2

### Fixed

- **Keep High Score ignored nothing.** Steam repainted the review-score colours
  on the Discovery Queue card, and the automator was still comparing against the
  old shades. Because an unrecognised colour is treated as well-reviewed — the
  fail-safe that keeps a redesign from mass-ignoring your library — every slide
  read as a keeper: with the box ticked a run walked the whole queue, ignored
  nothing, threw nothing and logged nothing. The only symptom was a counter that
  never moved.

### Changed

- Both classifiers now read **one** palette instead of keeping private copies that
  drifted apart: the Discovery Queue cards and the Explore Queue's *ignore badly
  reviewed games* mode, which reads the review rows on the store page. The
  Explore Queue was never broken — its copy happened to hold the colours Steam
  actually paints, and that is the whole point: the same shades were written down
  twice and only one copy was ever corrected. Each review band now also holds the
  colours Steam painted *before* the current ones, so a rollback, a staged
  rollout or a stale cached stylesheet can no longer switch ignoring off without
  a word.

### Added

- Guards for the failure above, since the reason it shipped is that nothing was
  watching: a live check that the Discovery Queue modal still paints the bands
  the classifier looks for, a live check on what Keep High Score actually does
  (that it still ignores, never ignores a well-reviewed game, and does spare
  one), and a scheduled canary that opens the anonymous store pages every week
  and checks the markup the extension depends on, review colours included. It
  reads those colours out of the product rather than from a copy of its own —
  deliberately only today's shades, so a rollback the extension survives is
  still reported.

## 1.2.1

### Added

- Un-ignore a single game by gesture: right-click and draw a circle or a zigzag
  on its cover, with its own shortcut selector in the settings.
- A toast when Steam refuses to roll an ignore back.
- Hotkey and shift-click on the widget chevron.

### Changed

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

### Fixed

- A cancelled Manual Ignore job no longer un-badges games it never sent.
- The Firefox context-menu latch, the widget tooltip placement, and Explore Queue
  URL tracking (now polled).

## 1.2

### Added

- **Curator ignore queue drained in the background.** On Chromium the MV3 service
  worker drains it with no Steam tab open at all.
- **Undo**: recent ignores can be rolled back, including as jobs the drainer
  works through, with a warning when a curator's ignores were undone recently.
- **Surface switch**: the interface moves between the on-page widget and the
  toolbar popup, with the widget parking to a ghost chevron.
- **An ignore-rate governor** shared by every source of ignores, plus a cap of
  two concurrent Discovery Queue runs across tabs.
- Push notifications for the Manual Ignore queue.

### Changed

- Relicensed to GPL-3.0-or-later, with SPDX headers across the sources.
- All curator and queue strings translated into the other 18 locales.

## 1.1

### Added

- Opt-in blur over the covers of ignored games.
- The popup moved onto the page as a shadow-DOM widget; the toolbar popup was
  removed (it came back as a choice in 1.2).
- A curator ignore queue: enumerator, retention cache and a drainer that holds a
  lease, plus a queue applet in the popup.

### Fixed

- IGNORED badge placement on tag pages, badge size and labels in the Explore
  Queue, the wrong game name being saved, and the Discovery Queue buttons no
  longer break when Steam's interface language changes.

## 1.0.1

### Added

- Internationalization across 19 locales, with a language selector.

## 1.0.0

First release: ignore games from the store by gesture, through the Explore Queue,
or automatically through Your Discovery Queue, with a settings popup, an AI
disclosure, a privacy policy and a readme.

---

Commits before 1.0.0 carry a `1.3.0` version string in the manifest. It was never
released and never meant anything; the numbering restarts at 1.0.0.
