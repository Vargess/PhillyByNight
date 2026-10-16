# PhillyByNight

Custom Tampermonkey scripts and tools for **[Philadelphia by Night](https://philadelphiabynight.net)**,
a browser-based Vampire: The Masquerade (V20) MUSH.

## PbN Mapper

A userscript that draws a live map of the city as you play. It watches the game's
WebSocket traffic, records every room you enter along with its exits, havens, features
and neighbourhood, and renders the result as a floor-by-floor map in a panel you can
drag, resize and dock. Nothing is sent anywhere — the map lives in your own browser.

It runs only on `https://philadelphiabynight.net/play*`.

| File | What it is |
| --- | --- |
| `PbN-Mapper.user.js` | The userscript. This is the thing you install. |
| `map-viewer.html` | A standalone offline viewer for an exported map file. Open it in any browser and drag a JSON onto it. |

---

## Installing

### 1. Install Tampermonkey

**Firefox** — install [Tampermonkey from addons.mozilla.org](https://addons.mozilla.org/firefox/addon/tampermonkey/).
Nothing else is needed.

**Chrome** — install [Tampermonkey from the Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo),
then give it permission to run userscripts, which Chrome disables by default:

1. Go to `chrome://extensions`
2. Find Tampermonkey and click **Details**
3. Turn on **Allow User Scripts**

If you don't see that toggle, you're on an older Chrome — enable **Developer mode**
with the switch at the top right of `chrome://extensions` instead.

### 2. Install the script

Open the raw script link and Tampermonkey will offer to install it:

**[Install PbN-Mapper.user.js](https://raw.githubusercontent.com/Vargess/PhillyByNight/main/PbN-Mapper.user.js)**

Click **Install** on the page that appears. Then load the game — the map panel appears
in the bottom-right corner once you're on the play page.

If the link opens as plain text instead, Tampermonkey isn't intercepting `.user.js`
files. Copy the whole file, open the Tampermonkey dashboard, press **+** to create a
new script, select all, paste over it and save.

### Verifying what you downloaded

[CHECKSUMS.md](CHECKSUMS.md) lists SHA-256 hashes for the two files that execute, so
you can confirm your copy matches the published one:

```powershell
Get-FileHash .\PbN-Mapper.user.js -Algorithm SHA256
```

Hash the file as downloaded from the raw link — a `git clone` on Windows rewrites
line endings, which changes the hash. CHECKSUMS.md explains how to check a clone.

### Updating

The script carries no auto-update URL, so Tampermonkey won't update it for you.
To upgrade, open the install link again and let it overwrite the existing script.
**Your map data survives** — it's stored separately from the script itself.

---

## Using it

The panel starts bottom-right. Drag the header to move it, drag the bottom-right
corner to resize, and use the toolbar:

| Button | What it does |
| --- | --- |
| *(dropdown)* | Pick which floor to display |
| `Explore` | Search every exit direction in this room, then inspect |
| `⌖` | Recentre on the room you're standing in, at 1× zoom |
| `⛶` | Zoom out until the whole of the current floor fits |
| `↗` | Dock to the top-right corner at the default size |
| `⋯` | Everything else (see below) |
| `_` | Collapse to just the header |

Drag inside the map to pan, scroll to zoom, and right-click a room to delete it.
Hover any room for its full details — tags, features, haven status, neighbourhood,
coordinates, unexplored exits and where its stairs lead.

### The `⋯` menu

| Item | What it does |
| --- | --- |
| Export map JSON | Save the whole map to a file |
| Import map JSON… | Merge a saved file into the current map |
| Autosaves… | Browse the rolling backups; restore or save one to disk |
| Discard estimated-position rooms | Throw away rooms whose position is only a guess, keeping everything confirmed |
| Clear saved map | Wipe everything (recoverable from an autosave) |
| ☑ Minimise while a game window is open | Collapse the panel whenever `/char`, `/inv`, `/mail` etc. are open |
| ☑ Explore each new room automatically | Run the Explore sweep every time you arrive somewhere |
| Log to file | Export the activity log for diagnosing a problem |
| ☑ Record activity log | Whether to record activity at all |
| ☑ Include chat text in the log | Off by default — see [Privacy](#privacy) |
| Clear activity log | Discard the recorded log |

---

## Reading the map

Rooms are squares; vehicles (trains) are circles. Colour tells you what a room *is*:

| Colour | Meaning |
| --- | --- |
| 🟡 Yellow | The room you're standing in |
| 🟧 Dark orange | A haven, claimed |
| 🟠 Light orange | A haven site, unclaimed |
| 🔵 Bright cyan | Connects both up **and** down |
| 🔷 Dark cyan | Connects one direction only |
| 🟦 Plain blue | Nothing special |
| ⚪ Dashed grey | Known to exist, not yet visited |

An orange ring marks a haven — solid if claimed and open, dashed if unclaimed or
locked. `▲`/`▼` show stairs up and down, and an amber number is the count of exits
that lead somewhere unknown and can't be drawn (sewer "passage 1" and friends).

Exit lines run solid to rooms you know and stop half-way as a stub where you
haven't been. Red dashes mean locked or broken. Dotted coloured lines are transit
routes learned from riding the train; a small coloured dot means that line continues
on another floor.

### Where rooms get placed

Most rooms arrive with real coordinates from the server. Some — sewers, steam tunnels —
are addressed only by a numeric id, and those are placed by working out their true cell
from the exits of neighbouring rooms that *do* have coordinates. Anything that still
can't be tied to the grid is laid out by dead reckoning on its own estimated floor and
labelled as such, rather than being guessed into a real position.

Floors are named rather than numbered: `Street level`, `Sublevel 1`, `Level +1`,
`In transit`. Note that one floor can span the whole city — sublevel 1 runs from
University City to Kensington — so `⛶` is often more useful than scrolling.

---

## Explore

Sends `search north`, `search south` … `search southwest`, then `inspect`, pacing
them 1.5 seconds apart so the game keeps up. Useful for turning up exits a room
description doesn't mention.

Press the button to sweep the current room; the button becomes a progress and stop
control while it runs. Turn on **Explore each new room automatically** and it fires on
every arrival, with the button held visibly depressed to show it's armed. Walking out
mid-sweep abandons the rest rather than firing searches into the room you've just
reached.

A full sweep takes about 16 seconds.

---

## Backups and diagnostics

**Autosaves** run every 30 minutes and keep the newest four, stored in your browser
rather than on disk. The Autosaves panel lists each one with its timestamp and room
count, and can either write it out as a file or roll the live map back to it — which
also makes *Clear saved map* recoverable.

**The activity log** records what the game sent, what the script made of it and
anything that threw, keeping the newest 5,000 entries. If something misbehaves, press
**Log to file** and send the resulting JSON — it carries the script version, your map's
shape and the traffic leading up to the problem.

### Privacy

Everything stays in your browser. The script makes no network requests of its own.

The activity log **does not record chat**. System messages are kept verbatim because
the mapper reads them, but every other chat line has its text replaced with a
`[n chars withheld]` marker, so a log you share doesn't carry your private
conversations. The *Include chat text* toggle turns that off if a chat-related bug
genuinely needs it, and every exported log states which mode produced it.

---

## Where your data lives

| Where | What |
| --- | --- |
| `localStorage` | The map itself, transit lines, and your panel preferences |
| `IndexedDB` (`pbn_mapper`) | Autosaves and the activity log |

Clearing site data for philadelphiabynight.net erases all of it, so export
occasionally if your map matters to you.

---

## Licence

[GPL-3.0](LICENSE).
