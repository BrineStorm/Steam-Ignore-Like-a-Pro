# Site changelog

The text of the website's changelog page, built from this file. Each release is one
version heading, newest first, followed by plain bullets. A plain line before the
bullets becomes that release's one-line lede. Bullets are one line each, with no
markdown inside.

## 1.3.2
- The extension's tagline and description are now in all 19 interface languages.
- The extension's IGNORED badge no longer appears on games Steam already greys out as ignored.
- Added a swipe or click that changes the ignore type on games Steam greys out as ignored, shown in color on Steam's own IGNORED flag.
- Hover Total Ignored to see how many games your whole Steam ignore list contains.
- The right-click swipe now works on macOS and Linux.
- Optimized how the extension works with Steam while you browse the store.

## 1.3.1
- Better alignment with the Steam Subscriber Agreement: queue helpers no longer earn sale rewards for you.
- During a sale, go through one queue yourself before the queue helpers move on their own.
- Fast Forward removed from the Classic Discovery Queue.
- A one-time Subscriber Agreement notice on the first queue helper start.

## 1.3.0
- The Explore Queue is now the Classic Discovery Queue.
- Turning the extension off now clears everything it drew on the page, and puts them all back when you turn it on.
- Your ignore queue survives the switch: jobs keep their progress, and you can still drop them.
- A queue running in the background recovers from a network drop by itself instead of waiting for you.
- Swipes can no longer get lost on the way to Steam.
- Covers of ignored games are blurred by default.
- The undo menu counts for you: a stepper that speeds up as you hold it, and the total you can roll back shown in the field.

## 1.2.2
- Fixed Keep High Score ignoring nothing: Steam repainted the review-score colours and the automator was still matching the old shades.
- Ignoring now survives a Steam recolour — the review filters recognise the previous palettes too.

## 1.2.1
- Un-ignore a single game by gesture: right-click and draw a circle or a zigzag on its cover.
- A toast when Steam refuses to roll an ignore back.
- A hotkey, and a shift-click on its corner tab, to bring the on-page widget back.
- Tooltips on the undo button and the language picker.
- The privacy policy now covers the curator lists cached on your device.
- Fixed Total Ignored leaving out the un-ignore queue.
- Fixed the extension calling you signed out when it simply could not ask Steam.
- Fixed the popup overflowing its 600px window.
- Fixed the Discovery Queue automator acting on games either side of the centred slot.
- Fixed the extension failing to start on Firefox when it missed the page load.
- Fixed a cancelled Manual Ignore job un-badging games it never sent.
- Fixed Firefox swallowing your next right-click menu after a gesture.
- Fixed misplaced widget tooltips, and the Explore Queue losing track of the page you were on.

## 1.2
- A curator ignore queue that keeps working in the background — on Chrome and Edge, with no Steam tab open at all.
- Undo: roll back your recent ignores, in bulk and in the background.
- A switch that moves the interface between the on-page widget and the toolbar popup.
- One shared speed limit on every ignore the extension sends, so it never hammers Steam — and at most two Discovery Queue runs at once.
- On-page alerts when a swiped ignore gets stuck or fails to send.
- All curator and queue strings translated into the other 18 locales.

## 1.1
- An opt-in blur over the covers of ignored games.
- The popup moved onto the Steam page itself as a widget.
- A curator ignore queue, with its progress in the popup.
- Fixed IGNORED badge placement, Explore Queue labels, and the Discovery Queue buttons breaking on a Steam language change.

## 1.0.1
- Internationalization across 19 locales, with a language selector.

## 1.0.0
First public release of Steam Ignore Like a Pro.
- Hold Right-Click and swipe right to ignore any game capsule, on every Steam page and widget.
- Swipe left to mark a game as 'Already Played' without opening its store page.
- Auto-ignore runs for the Discovery Queue, including genre and category queues.
- Review filters that skip games rated 'Mixed' or 'Negative'.
- Configurable gestures and shortcuts, per-module toggles, and ignore history in the popup.
