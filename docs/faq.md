# FAQ

The one source for the FAQ. The FAQ in `README.md` and in the store listings is copied from here
by hand. Edit a question here first, then copy it to both places, in the same order. The website
reads its FAQ out of the listings in `docs/store-listing/`, synced by
`.github/workflows/site-sync.yml`.

- The first question is always "Why use this instead of Steam's native ignore?".
- Each question is a `##` heading, its answer one or more plain paragraphs under it.
- README wraps each item in `<details><summary><strong>…</strong></summary>`. The listing
  writes `Q:` / `A:` in plain text, with ` - ` for a dash and `->` for an arrow, and drops
  links. The site's sync stops on a listing whose FAQ paragraph is anything but those two lines,
  has a link, repeats a question, or has another number of questions than the other languages.

## Why use this instead of Steam's native ignore?

Steam's native "Ignore" button is missing on many Steam pages and widgets, and where it exists, ignoring takes several clicks (hover over the game's capsule → click ▪▪▪ → click "Ignore"), with no "Played on Another Platform" option in that menu. Steam also has no way to ignore a list of games at once. The extension gives you one-gesture ignore on any Steam page and widget, plus bulk ignore from built-in lists and ignore automation.

## How do I ignore many games on Steam at once?

Steam itself ignores one game at a time. With the extension you can, for example, add a built-in list to the ignore queue (games with AI content, Denuvo, kernel access, invasive EULA terms, known bad games and more), add a curator's whole list to the ignore queue, ignore a whole bundle with one gesture, ignore a creator, turn on the high AI filter level, run the Discovery Queue helper on a tag or genre, or simply swipe away unwanted games' capsules as you browse the store.

## Does using this extension comply with Steam's rules?

Yes, as far as ignores and un-ignores by gesture, button or hotkey go. Each one fires once per action you take, like a click on Steam's "Ignore" button. The queue helpers, the high AI filter level, the ignore queue (curator lists, built-in lists and bundles) and bulk undo are automation. Section 4.C of the [Steam Subscriber Agreement](https://store.steampowered.com/subscriber_agreement/) prohibits non-human-controlled interaction with Steam, including earning rewards or progress without genuine user input, so use the automation features at your own discretion and with the risk in mind. The extension doesn't earn sale rewards for you and isn't designed to. It also has a built-in safeguard that paces the requests it sends to Steam, one at a time. The final word, however, belongs to Valve, along with the company's stance on and measures against this or any other Steam automation extension.

## Can I undo an ignore?

Yes, at any time. Steam's Ignore button on the game's page keeps working alongside the extension. You can also draw a circle or a zigzag over a game's capsule, or click the IGNORED badge on it, to take a single ignore back. Or open the extension's popup, click the undo button (↩️) and choose which recent ignores to roll back, the last N games or everything from the last N hours or days. Ignored creators can be brought back in the same place, on the "Creators" tab.

## Does it work if my Steam interface is not in English?

Yes. The extension is language-agnostic. It works regardless of the language settings you have chosen in your Steam account.

## Does it work on macOS and Linux?

Yes. On macOS and Linux the right-click menu opens as soon as the right button is pressed, so the extension holds that menu back on a click over a game's capsule when ignore or undo is set to a gesture. You can also assign the ignore to other keys (for example Shift + Left-Click) in SETTINGS → Manual Ignore.

## Can I ignore a bundle or a set of several games?

Yes. Swipe over the bundle's capsule, then swipe over it once more to confirm. Every game and DLC in the bundle goes to the ignore queue and is ignored at the usual pace. Games in your library and on your wishlist are skipped.
