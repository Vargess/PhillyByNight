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
| `map-viewer.html` | A standalone offline viewer for an exported map file. Open it in any browser and drag a JSON onto it. It draws rooms and exits exactly as the mapper does, and adds filtering, search, alternative colouring schemes and [merging](#merging-maps) for picking the map apart. |

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

Updating happens only when you ask: **`⋯` → Open the update page…**, which shows your
running version in the menu. It opens Tampermonkey's install page, which states the
published version, shows what changed, and waits for you to confirm. The script itself
can't install anything.

It opens that page rather than comparing version numbers in the background because the
game's security policy (`connect-src`) forbids the script from contacting GitHub at
all. Tampermonkey's page isn't subject to that policy, so it can tell you what you'd
be getting.

**Your map data survives** updating — it's stored separately from the script.

#### Turning off Tampermonkey's own update checks

Tampermonkey may also check on its own schedule, independently of the button above.
If you'd rather it only happened when you choose:

- **Dashboard → Settings → Check for updates → Never.** You may need to switch
  *Config mode* to *Advanced* to see it.
- Or per script: open the script, go to its **Settings** tab and set updates to
  **Never**. (Labels move around between Tampermonkey versions.)

Worth knowing: the `@updateURL` and `@downloadURL` lines in the script don't decide
this either way. They only say *where* to look. Removing them wouldn't stop automatic
checks — Tampermonkey falls back to whatever URL the script was installed from — so
the setting above is the control that actually matters.

---

## Using it

The panel starts bottom-right. Drag the header to move it, drag the `◢` grip in the
footer bar to resize, and use the toolbar.

The footer shows the room you're standing in and its exits — **green** for open,
**red** for locked, **yellow** for broken — abbreviated `N NE E SE S SW W NW U D`,
with sewer passages as `P1 P2 P3`. Hover an exit for its full direction, its state,
and where it leads if that room is known. On a narrow panel the room name gives way
first so the exits stay readable.

| Button | What it does |
| --- | --- |
| *(dropdown)* | Pick which floor to display |
| `Explore` | Search every exit direction in this room, then inspect |
| `⌖` | Recentre on the room you're standing in, at 1× zoom |
| `⛶` | Zoom out until the whole of the current floor fits |
| `↗` | Dock to the top-right at the default size — see [On a phone or tablet](#on-a-phone-or-tablet) |
| `⋯` | Everything else (see below) |
| `_` | Collapse to just the header |

Drag inside the map to pan, scroll to zoom, and right-click a room to delete it.
Hover any room and a card appears beside the cursor with its name, then its full
details — tags, features, haven status, neighbourhood, coordinates, unexplored exits
and where its stairs lead. It follows the cursor and closes as soon as you leave the
room, pan or zoom.

### The `⋯` menu

| Item | What it does |
| --- | --- |
| Export map JSON | Save the whole map to a file, dated — `pbn-map_20261102.json` |
| Export for MUSH Map (sharing)… | Convert the map to the public MUSH Map site's format — see [Sharing](#sharing-to-mush-map) |
| Import map JSON… | Merge a saved file into the current map |
| Autosaves… | Browse the rolling backups; restore or save one to disk |
| Discard estimated-position rooms | Throw away rooms whose position is only a guess, keeping everything confirmed |
| Clear saved map | Wipe everything (recoverable from an autosave) |
| ☑ Minimise while a game window is open | Collapse the panel whenever `/char`, `/inv`, `/mail` etc. are open |
| Dock inside the game text pane | `auto` / `always` / `never` — where `↗` puts the panel |
| ☑ Explore each new room automatically | Run the Explore sweep every time you arrive somewhere |
| Log to file | Export the activity log for diagnosing a problem |
| ☑ Record activity log | Whether to record activity at all |
| ☑ Include chat text in the log | Off by default — see [Privacy](#privacy) |
| Clear activity log | Discard the recorded log |
| Open the update page… | Show your running version and open Tampermonkey's install page |

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

Exit lines use the same three colours as the footer — **green** open, **red** locked,
**yellow** broken — with locked and broken also dashed. A line that stops half-way is
one the script couldn't tie to a specific destination room; where both ends record
each other, the two half-lines meet and read as a single connection.

Dotted coloured lines are transit routes learned from riding the train; a small
coloured dot means that line continues on another floor.

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

## On a phone or tablet

The game reflows on a small screen: the sidebar drops below the input field as you
scroll, which puts its close button right where a panel docked to the corner of the
window lands. So on a touch device `↗` docks to the top-right **of the game's
scrolling message pane** instead, clearing the menu bar above it. On a desktop it
docks to the window corner exactly as before.

The pane is found by shape rather than class name: the element that genuinely
scrolls vertically, preferring the innermost one. That matters because on mobile the
page scrolls *as well as* the message pane — the room image and tag displays sit
below the input bar — so more than one thing qualifies, and the outer wrapper is the
larger of them.

Having picked a corner, the dock then checks what is actually painted there and
steps down past any control in the way, so it clears the close buttons whether they
sit in a menu bar or float over the message text. The panel is shrunk to fit the
pane, and if the pane can't be found, or only a sliver of it is on screen, the dock
falls back to the window corner rather than putting the panel somewhere you can't
reach.

Detection is by feature, not user agent — **iPadOS Safari reports itself as a
Macintosh**, so looking for `iPad` in the user agent finds nothing on the device this
is for. What's actually tested is a coarse pointer or a real multi-touch digitiser,
*and* a screen whose short edge is 1024px or less; both have to agree, which keeps a
touchscreen desktop monitor and a narrow desktop window out of it. It's re-checked
on every dock, so rotating the tablet is picked up without a reload.

If that guesses wrong on your device, **`⋯` → Dock inside the game text pane**
cycles `auto` → `always` → `never`. In `auto` the menu line says what it decided
("auto (on — mobile layout)"), and every dock is recorded in the activity log with
the geometry it chose, so **Log to file** will show why it went where it did.

One caveat: the panel is dragged and resized with mouse events, which iOS does not
synthesise for a drag gesture — so on an iPad `↗` is likely the only way to move the
panel, not just a shortcut.

---

## Sharing to MUSH Map

[MUSH Map](https://map.stoia.red/) is a public map editor for the game that
otherwise wants every room typed in by hand. **`⋯` → Export for MUSH Map
(sharing)…** converts the whole map into its JSON and writes
`mush-map_YYYYMMDD.json`, ready to import there. It shows you what will and won't
make the trip and waits for you to confirm before writing anything.

| What | What happens |
| --- | --- |
| Rooms, names, positions, layers | Carried over exactly, relative geometry preserved |
| Exits | Carried over wherever they have a compass bearing |
| Neighbourhoods | Become their **areas**, shaped exactly rather than boxed off |
| Transit lines | Become their **transit lines**, in route order; a station with no room becomes one of their "stub" stops |
| Room features | Become their **traits**, with an emoji marker each |
| Room colour | Mapped onto their palette, with their colour legend filled in to match |
| Tags, exposure, haven status | Written into each room's **description**, the only field they survive in |
| Sewer "passage 1" exits | **Dropped** — they carry no compass bearing to translate |
| Vehicles, unplaced rooms | **Dropped** — their grid needs a real cell |

On a 634-room map that comes to 631 rooms, 1,133 exits, 5 areas, 1 transit line and
3 traits, with 173 bearingless passages and 36 exits to rooms that aren't in the map
left behind.

The conversion follows [their editor's own
source](https://github.com/StoiaCode/mush-map-editor) rather than guesswork: their
grid is 1000×1000 with coordinates clamped to it, **their y axis grows downward**
where ours grows north, and their layers are plain integers with no floor at zero.
So the map is flipped vertically, placed around the centre of their grid (where
their editor opens), and keeps street level at `0` with the sewers at `-1`/`-2`.

Room ids are derived from the room's own key rather than from the clock, so
exporting the same map twice produces an identical file. Importing with **Replace**
keeps those ids; their **Merge** reassigns them, which is their behaviour, not ours.

This was tested by running their editor locally and importing the full map into it:
all 631 rooms, 1,133 exits and 130 vertical links survive their own `normalize()`
with the geometry intact, and the areas, transit line and traits all come through.

---

## Merging maps

`map-viewer.html` can combine several exports into one — a map from a second
machine, a friend's export, or a file from before you cleared something by mistake.

Press **⊕ Merge** and pick one or more files, or drop several onto the window at
once. Whatever is already on screen counts as the first input, so Merge adds to the
map you are looking at rather than replacing it; with nothing loaded, pick two files
and it combines those.

Rooms are matched on their key — `16,59,0` for a placed room, `sewer-200` for one
the server only gave an id — and resolved with the same rule the mapper uses for
*Import map JSON…*:

- a **visited** record beats one that was only ever seen from a doorway;
- between two visited records, the one **seen more recently** wins;
- ties go to the file named later.

A room is taken whole from one file or the other, never blended, so you can't end up
with a record that never existed. Transit links are pooled and de-duplicated in both
directions, and a floor keeps the name the first file gave it.

Afterwards a summary shows what each file contributed — rooms new, rooms that
replaced an older copy, rooms ignored as older — and, importantly, **any cell where
the two maps describe different rooms**. That's the case where merging loses
something: two files disagree about what lives at `14,56,-1`, one of them wins, and
the other room is gone. Each one is listed with both names and which file won.

Nothing is written to disk until you press **Save merged map…**, which writes
`pbn-map_merged_YYYYMMDD.json`. That file loads in the viewer and imports into the
mapper through *Import map JSON…* like any other export. Your original files are
never modified.

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
