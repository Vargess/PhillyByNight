# Changelog

Functional changes to `PbN-Mapper.user.js`, newest first. Repository-level changes
(the viewer, tooling) are noted under the date they landed.

Versions are the `@version` in the script's metadata block. Where a release bundles
work done over several days, the dates are given per item.

---

## Viewer — 2026-11-09

`map-viewer.html` only. The userscript is unchanged, so `@version` stays at 3.10.1.

### Added
- **MUSH Map export in the viewer**, as a **⤴ MUSH Map** toolbar button. The
  exporter from the userscript, ported onto the viewer's room records.

  It is here because merging is the viewer's job and sharing was the mapper's, and
  the two did not meet: a map combined from two players had to be pushed back
  through Tampermonkey — loading someone else's map over your own live game state —
  before it could be shared.

  The report is shown in the viewer's own modal rather than a `confirm()`, listing
  rooms, exits, areas, lines, stops, traits, grid and layers, and what was left
  behind, with nothing written until **Save MUSH Map file…** is pressed.

  Because room ids are derived from the room key rather than the clock, the two
  exporters produce the **same file byte for byte** from the same map; this is
  checked by diffing one against the other rather than assumed.

---

## 3.10.1 — 2026-11-09

No behaviour change. Tampermonkey's built-in ESLint flags `no-multi-spaces` on this
file's column-aligned trailing comments, which looks like a defect when you first
paste the script in. The rule is now configured with `ignoreEOLComments` at the top
of the file, so alignment is allowed but genuine stray double-spaces in code are
still caught. The alignment itself is unchanged.

---

## 3.10.0 — 2026-11-09

The MUSH Map site turned out to be [open
source](https://github.com/StoiaCode/mush-map-editor), so 3.9.0's export — written
against a single 7-room sample — was rebuilt against their actual schema and tested
by running their editor locally and importing the whole map into it.

### Fixed
- **`features` are `{ id, label }` records, not strings.** Joining the array printed
  `[object Object]` in the mapper's hover card and in the viewer's details panel, and
  two of the viewer's predicates — `isTransitStation` and `hasResource` — tested a
  regex against the object and so could never match. All four now read the label.
  (12 rooms in the author's map carry features, so this was quietly wrong throughout.)

### Added
- **Neighbourhoods become their areas.** Their areas are a union of rectangles, so
  each neighbourhood is described exactly by merging its cells into horizontal runs
  rather than boxed off with a bounding rectangle — 128 rects for 5 neighbourhoods
  over 549 rooms. Theirs span every layer, which is right: the sewers under
  Kensington are still Kensington.
- **Transit lines become their transit lines.** Ours are unordered pairs of station
  names, theirs an ordered run of stops, so the pairs are walked from a terminus to
  recover the route. A station with no room of its own becomes one of their `stub`
  stops instead of vanishing.
- **Room features become their traits**, their open-ended per-room markers, with an
  emoji each.

### Changed
- The map is now placed around the centre of their 1000×1000 grid, which is where
  their editor opens a new map, instead of in the corner. Coordinates are clamped to
  the grid, because they clamp on import and a silently moved room would land on top
  of its neighbour.
- Their layers are plain integers with no floor at zero — confirmed in their source —
  so street level stays `0` and the sewers stay negative. `MUSH_Z_OFFSET` is kept as
  the escape hatch but is no longer expected to be needed.
- The claim that re-uploading "lines up with the previous one" was only ever true of
  their **Replace** path; their **Merge** reassigns every id on import. Corrected in
  the README.

### Verified against their editor
Running their code locally and importing the full file: 631 rooms over layers −2 to
3, 1,133 exits and 130 vertical links all survive their `normalize()` with the
geometry assertion passing on every one; 5 areas, 1 transit line (11 real stops plus
1 stub) and 3 traits on 12 rooms come through with no dangling references; all
coordinates land inside the grid at 433–568 × 385–616.

---

## 3.9.0 — 2026-11-09

### Added
- **Export for MUSH Map (sharing)…** in the `⋯` menu, converting the map into the
  format the public MUSH Map site uses so it can be uploaded instead of typed in
  room by room. Writes `mush-map_YYYYMMDD.json` after showing exactly what will and
  will not survive, and waits for confirmation before writing.
  - Rooms, names, positions and layers carry over with relative geometry intact;
    exits carry over wherever they have a compass bearing.
  - Their rooms have one free-text `description`, so our tags, exposure tier,
    features, haven status and neighbourhood are written into it rather than lost.
    Room colour is mapped onto their palette and their `tagLabels` legend is filled
    in to match, so a shared map reads the way ours does.
  - Room ids are derived from the room key, not the clock, so the same map exports
    byte-identically every time and a re-upload lines up with the previous one.
  - Dropped, and reported in the confirmation: transit lines (their `transitLines`
    was empty in the sample, so its shape is unknown), sewer "passage N" exits
    (no bearing to translate), vehicles and unplaced rooms (their grid needs a
    real cell). On the author's 634-room map: 631 rooms and 1,133 exits out, 173
    bearingless passages and 36 dangling exits left behind.

### Notes
- Their format was inferred from a single 7-room export, so two conventions were
  read off the sample and then checked back against it: **their y axis grows
  downward** where ours grows north (the map is flipped on export), and their
  coordinates are positive (it is shifted into positive space). The same geometry
  assertion passes on all 1,133 exported exits and on all 8 of theirs.
- Their sample never used a negative layer. Street level stays at `0` and sewers at
  `-1`/`-2`; `MUSH_Z_OFFSET` shifts everything up if their site refuses negatives.

---

## 3.8.1 — 2026-11-08

### Fixed
- **Docking on mobile still covered the close controls.** 3.8.0 assumed the message
  pane's top-right corner was free; on the real layout it isn't. Two causes, both
  fixed:
  - **The wrong element was being chosen.** On mobile the page scrolls *as well as*
    the message pane — the room image and tag displays sit below the input bar, so
    the whole page needs scrolling to reach them. That makes the outer wrapper a
    scroll candidate too, and because it is the larger of the two, "largest
    scroller wins" picked the wrapper, whose top-right corner is exactly where the
    controls are. Candidates that *contain* another candidate are now dropped, so
    the innermost scroller — the message log — wins.
  - **The chosen corner is no longer assumed to be free.** Having picked a corner,
    the dock now samples what is actually painted under the panel's title bar with
    `elementsFromPoint` and steps down past any control sitting there. This works
    whatever the obstruction is — a menu bar, a floating close button, something the
    game adds later — and whether or not the pane search got the right element. It
    stops rather than descending past a third of the screen, and only control-sized
    elements count, so the panel is never pushed below a page-sized container.
- The docked height now accounts for having stepped down, instead of running off
  the bottom of the screen by however far the panel moved.
- Every dock logs the pointer type, touch points, viewport, which element was
  chosen, and how far it stepped — so a bad dock can be diagnosed from **Log to
  file** rather than guessed at.

---

## 3.8.0 — 2026-11-08

### Added
- **The dock button knows about mobile layouts.** On a phone or tablet the game
  slides its sidebar below the input field as you scroll, so a panel docked to the
  top-right of the *window* sits on top of the menu's close button. `↗` now docks to
  the top-right of the game's own scrolling message pane there, below the menu bar.
  Desktop docking is unchanged — same corner, same size, same pixel.
  - Detection is by feature rather than user agent, because **iPadOS Safari reports
    itself as a Macintosh**: `/iPad/.test(navigator.userAgent)` is false on the exact
    device this is for. The test is a coarse pointer *or* `maxTouchPoints > 1`,
    **and** a screen whose short edge is ≤ 1024px — both halves required, which
    excludes a touchscreen desktop monitor and a narrow desktop window. Evaluated per
    dock, so rotating a tablet needs no reload.
  - The pane is found by shape — the largest element on the page that genuinely
    scrolls vertically, excluding our own panel and any dialog — rather than by a
    class name the game is free to change.
  - The docked panel is capped to fit inside the pane, and only the *on-screen* part
    of the pane counts as a target. A pane wider than the viewport, or scrolled
    half out of it, falls back to the window corner instead of docking the panel
    somewhere unreachable.
  - **`⋯` → Dock inside the game text pane** cycles `auto` / `always` / `never` for
    when the detection is wrong on a device I can't test. In `auto` the menu line
    reports what it decided, and every dock is written to the activity log with the
    mode, the detection result and the chosen geometry.

---

## 2026-11-03 — map-viewer.html (8)

### Added
- **Merge two or more map files.** A `⊕ Merge` button in the top bar takes any
  number of files, and dropping several onto the window at once does the same. The
  map already on screen is the first input, so merging adds to what you are looking
  at instead of replacing it.
  - Rooms are matched on their key and resolved with the mapper's own import rule —
    visited beats unvisited, then the more recent `lastSeen` wins, ties to the file
    named later. A room is taken whole from one side or the other, never blended.
  - Transit links are pooled and de-duplicated on the sorted pair, matching the
    mapper's `addTransitEdge`, so merging a file twice doesn't double its lines.
    Floor labels are kept from the first file that names a floor.
  - A report shows each file's contribution (new / replaced / ignored as older) and
    lists **every cell where the two maps describe different rooms** — the case
    where a merge silently loses one of them. Each is shown with both names, both
    ids and which file won.
  - **Save merged map…** writes `pbn-map_merged_YYYYMMDD.json`, which the mapper's
    *Import map JSON…* accepts. Nothing touches the disk until that button is
    pressed, and the source files are never modified.
- The viewer gained a general modal dialog, dismissed with Escape, the backdrop or
  Close, and the map's keyboard navigation is suspended while one is open.

### Changed
- `ingest()`'s format sniffing is split out as `bundleOf()`, so merging reads a
  file's contents without loading it. The merged bundle goes back through `ingest()`
  unchanged, which means a merged map is normalised, indexed and drawn by exactly
  the same code as a file loaded from disk.
- Dropping a **single** file still loads it, as before. Only a multi-file drop merges.

---

## 3.7.0 — 2026-11-02

### Added
- **Exported maps carry the date they were saved**: `pbn-map_20261102.json` rather
  than `pbn-map.json`. A folder of exports now reads as a history and sorts into
  order, instead of relying on the browser's `pbn-map (3).json` numbering. Autosave
  and activity-log file names are unchanged — they already carried a timestamp, and
  now share the same date helper.
- **A hover card naming the room under the cursor**, on both the mapper and the
  viewer. The rooms already carried an SVG `<title>`, but the browser's tooltip for
  one waits about a second and is drawn in the OS style, which sits badly over a dark
  map in a small panel. The card shows after 120ms in the panel's own styling, with
  the room name as a heading and the existing detail underneath. It follows the
  cursor, flips to the other side rather than running off the screen edge, and closes
  on leaving the room, panning, zooming, collapsing the panel or redrawing the map.

### Changed
- The mapper's hover card is attached to the page rather than the panel, so a room
  near the panel's edge still gets a readable card instead of a clipped one.

---

## 2026-11-02 — map-viewer.html (7)

### Added
- **The same hover card as the mapper**, replacing the SVG `<title>` on each room:
  name, key and id, key-feature state, and neighbourhood. Background-floor rooms stay
  non-interactive, as before.

---

## 2026-10-17 — map-viewer.html (6)

### Fixed
- **Filter groups no longer scroll inside themselves while the sidebar has height to
  spare.** Each group's value list was capped at 180px with its own scrollbar, so
  Primary tag — 25 values, 592px — scrolled in a small box no matter how tall the
  window was. The cap is gone: groups render at full height, the filters section is
  the only thing that scrolls, and it does so only once the content genuinely exceeds
  the column. On a 900px window that means no wasted space; on a tall one, nothing
  scrolls at all.

---

## 2026-10-17 — map-viewer.html (5)

### Changed
- **Statistics is back in the left sidebar**, sitting on its floor, and **the filters
  expand to take the remaining height** — 72% of the column on a 900px-tall window.
  The sidebar no longer scrolls as a single piece; the filter list scrolls inside its
  own section, which is what lets that section absorb the slack and keeps statistics
  pinned to the bottom. On a short window the filters give way first and scroll, and
  statistics stays put.
- With statistics gone from the right-hand panel, the room list there grows from 54%
  to 70%.

---

## 2026-10-17 — map-viewer.html (4)

### Changed
- **Statistics moved to the right-hand panel and sits on its floor**, below the room
  list, at any panel height. The statistics grid now packs two label/value pairs per
  row: at one pair per row it took a third of the column and pushed the room list
  under the half it is meant to have. The split is now details 30% / list 54% /
  statistics 16%.
- **The map's "Key features" box describes the targeted room** rather than listing the
  whole palette — its state, its haven ring, a count of its open, locked and broken
  exits, its stairs, any exits leading somewhere unknown, and how its position was
  derived. It follows the target, including keyboard movement, and falls back to the
  full palette when nothing is targeted. Reading an eight-row key to decode one room
  was work the box can do for you.

### Fixed
- The details panel's collapse button stopped collapsing anything once the panel held
  a room list and a stats grid. Two causes: a flex item will not shrink below its
  content's min-content width while `min-width` is `auto`, and `width` alone does not
  size a flex item — `flex-basis` does.
- The panel no longer animates its width. A width transition that stalls leaves the
  panel stuck open with the collapsed class applied and no way to tell, which is a
  worse failure than losing a 150ms slide.
- The room list no longer claims the whole column. Its flex basis came from its own
  content — hundreds of rows — which squeezed the details above it to a 40px sliver.

---

## 2026-10-17 — map-viewer.html (3)

### Added
- **Right-click a room to set where the viewer opens.** The menu also offers to reset
  to the built-in default and to centre on the room. The choice is kept in
  `localStorage` rather than in the map file — it is a browsing preference, not
  something about the map, so it survives re-exporting. The chosen room carries an
  orange outline so the setting is visible rather than invisible.

### Changed
- **"Rooms on this floor" moved to the right-hand panel**, taking half its height.
  The details body is the half that is capped, so a room with many exits scrolls
  rather than squeezing the list away.
- **Filter groups run broadest to narrowest**: Neighborhood, Exposure tier, Primary
  tag, Placement. Placement is an implementation detail of the mapper and now sits
  last instead of first.
- **The Floor and Colour-by selects are centred on the top bar.** The header is a
  three-column grid with equal outer columns, so the middle cell stays dead centre
  whatever the filename length or button count; the file name ellipsises instead of
  pushing it off. Equal flex spacers were tried first and did not work — they only
  centre when both sides happen to weigh the same, and the file-info line made the
  left side much wider.

### Fixed
- A global `keydown` handler called `e.target.matches(...)`, but `e.target` is
  `window` when nothing has focus, and `window` has no `matches`. The handler threw
  and swallowed the rest of itself, so the key did nothing. Keyboard navigation and
  Escape-to-deselect now work in that state.

---

## 2026-10-17 — map-viewer.html (2)

### Changed
- A freshly loaded map now opens **centred on `16,59,0` at street level**, at 1× zoom,
  with that room selected and set as the keyboard cursor — the same state as clicking
  it. `availableFloors` is sorted high-to-low, so the previous
  `selectFloor(availableFloors[0])` opened on the topmost floor, typically a rooftop
  or two, and then zoomed to fit just those.
- If a file has no such room it falls back to street level, or the busiest floor when
  there is no street level, and frames the whole floor rather than landing somewhere
  arbitrary.

### Fixed
- Loading a second file kept the previous one's selected and current room, which could
  point at a room the new file does not contain. Both are cleared on load.

---

## 2026-10-17 — map-viewer.html

The viewer had grown its own visual language, so the same room looked like two
different things depending on which tool you opened. It now shares the mapper's.

### Changed
- **Room colours are the mapper's**, in the mapper's precedence: current room gold,
  claimed haven dark orange, unclaimed haven light orange, both-ways vertical bright
  cyan, one-way vertical dark cyan, standard blue, unvisited an outline only. The old
  scheme led with "transit station" and painted havens and stairwells underneath it.
- **Vehicles are circles**, chosen from `isVehicle` alone, so a train car you have
  only heard of is still a circle while unvisited.
- **Exit lines are green open, red locked, yellow broken**, with the blocked two
  dashed. Previously all exits were one grey and broken ones shared locked's colour.
  The viewer's directional arrowheads keep their extra information but now take the
  colour of the exit they belong to.
- Haven rings, `▲`/`▼` stair markers and the undrawable-exit count were added to
  match the mapper's marks.
- The legend lists the states in precedence order, so it doubles as an explanation of
  which colour wins when a room is several things at once.

### Fixed
- **The viewer drew far fewer exits than the mapper.** It would only draw a line when
  an exit carried a `targetRoomId`, and only 360 of this save's 801 exits do — so most
  of the surface appeared as unconnected rooms. It now uses the mapper's resolution:
  `targetRoomId` where present, compass arithmetic otherwise, and a half-length stub
  when only the bearing is known. Street level went from 51 drawn exits to 426, which
  matches the mapper's own count exactly.
- Rooms whose exits could not be drawn were greyed out wholesale, painting over haven
  and stairwell colouring. They keep their real colour now, with the count of unknown
  exits marked in the corner as the mapper does it.

### Notes
- The alternative colouring schemes (primary tag, exposure, placement, neighbourhood,
  haven) are unchanged and still available; only the default "key features" mode
  mirrors the mapper.
- The viewer still resolves a few exits the mapper cannot, because it infers id-to-
  coordinate mappings across the whole file at once rather than as rooms arrive. On
  sublevel 1 that is 101 lines against the mapper's 96. It is extra knowledge rather
  than a disagreement, so it was left in place.

---

## 3.6.1 — 2026-10-16

### Fixed
- **The update check stopped explaining itself and started working.** 3.5.1 made the
  CSP failure report accurately, but it still reported one every single time, because
  the game's `connect-src` will never permit a request to GitHub. The menu item is now
  **Open the update page…** and goes straight there: navigation isn't governed by
  `connect-src`, and Tampermonkey's install page states the published version, shows
  the diff and waits for confirmation — everything the comparison was for.
- The page is opened synchronously inside the click. Previously `window.open` ran after
  an `await`, by which point the user gesture had expired and a popup blocker could
  swallow it silently. If one still blocks it, the URL is shown instead.

### Notes
- `GM_xmlhttpRequest` would bypass the policy, but requires an `@grant`, and any
  `@grant` moves the script into Tampermonkey's sandbox where `window` is no longer the
  page's — the WebSocket hook that records every room would stop working. Not worth it
  for a version string.

---

## 3.6.0 — 2026-10-16

### Changed
- **Exit lines on the map now use the footer's palette**: green open, red locked,
  yellow broken, with locked and broken still dashed. Previously every blocked exit
  was one maroon regardless, so a broken door was indistinguishable from a locked one
  on the map even after the footer learned to tell them apart. The three colours are
  defined once and shared, so the two views cannot drift again.

### Notes
- The old lines shaded between two greys according to an internal `known` flag. That
  sounds like "have we been there" but actually means "did `targetRoomId` resolve",
  which most older grid captures lack — 399 of 426 Street-level lines fall into it.
  Shading open exits by it would have painted nearly the whole surface as unexplored,
  so the distinction was dropped rather than carried over. Line *length* still
  reflects it: a half-length stub is an exit whose destination could not be resolved.

---

## 3.5.1 — 2026-10-16

### Fixed
- **Check for updates failed on the game page.** Its Content-Security-Policy allows
  `connect-src 'self' wss: ws:` plus the game's own CDN and Google — GitHub is not on
  that list, so the fetch was refused. Firefox reports this as a bare `NetworkError`,
  indistinguishable from being offline, and the old message said "could not reach
  GitHub", which pointed at the wrong thing entirely.

  The check now listens for the CSP violation and names the real cause, then offers
  to open Tampermonkey's install page — which is not subject to the page's policy and
  shows the published version anyway. Declining opens nothing. If the policy ever
  changes, the version comparison starts working again on its own.

### Changed
- Broken exits are **yellow** in the footer, distinct from locked red. Broken takes
  precedence over locked where an exit is somehow both.

---

## 3.5.0 — 2026-10-16

### Added
- The footer now lists the current room's **exits**, green for open and red for locked
  or broken, abbreviated (`N NE E SE S SW W NW U D`, sewer passages as `P1 P2 P3`) and
  sorted into compass order rather than whatever order the server sent them. Hovering
  one gives the full direction, whether it is locked or broken, and the destination
  room where that is known.

### Notes
- Locked status was already in the data — the game sends `isLocked` per exit and the
  map has been drawing those as red dashed lines all along. This surfaces the same
  information as text.
- Locked and broken are both shown red, matching how the map already draws them. The
  tooltip distinguishes the two.
- Footer layout: the room name shrinks far more eagerly than the exits and can yield
  completely, so all ten exits stay legible down to the 220px minimum panel width and
  the resize grip is never pushed out of the footer.

---

## 3.4.0 — 2026-10-16

### Changed
- The current room's name now sits in a **grey footer bar** instead of being floated
  over the map. It previously overlapped whatever happened to be drawn beneath it,
  which no amount of text shadow really fixes. Long names truncate with an ellipsis.
- **Resizing moved into the footer.** The browser's own resize grip renders at the
  panel's bottom-right corner regardless of what is there, so it used to sit on top of
  the map. Native resizing is off and a `◢` grip in the footer drives it by hand,
  keeping the minimum size and leaving the panel's position alone while dragging.

---

## 3.3.0 — 2026-10-16

### Added
- **Check for updates** in the `⋯` menu, showing the running version in its label. It
  fetches the published script, compares versions, and if a newer one exists offers to
  open Tampermonkey's install page — which shows the changes and waits for
  confirmation. The script only reads the published file; it cannot replace itself.
- `@downloadURL` and `@updateURL`, so Tampermonkey knows where the canonical copy
  lives and its dashboard can offer a manual update.

### Notes
- Updating stays something you ask for. The metadata URLs only say *where* to look,
  not *when* — whether Tampermonkey also checks on a schedule is its own setting, and
  removing the URLs would not disable that, since it falls back to the URL the script
  was installed from. The README documents how to turn its automatic checking off.
- The check uses a plain `fetch`, which works because raw.githubusercontent.com sends
  `Access-Control-Allow-Origin: *`. That matters: any `@grant` would move the script
  out of page context and break the WebSocket hook the whole mapper depends on.
  Network and parse failures report clearly and fall back to showing the URL.

---

## 3.2.0 — 2026-10-16

### Added
- **Explore.** A toolbar button that sends `search north` … `search southwest` and
  then `inspect`, paced 1.5 seconds apart, to turn up exits a room description
  doesn't mention. While running it shows progress and doubles as a stop control.
- **Explore each new room automatically**, a menu toggle that runs the same sweep on
  every arrival. The Explore button is held visibly depressed while it's armed.
- Walking out of a room mid-sweep now abandons the remaining searches instead of
  firing them into wherever you've just arrived.

### Fixed
- The dock button's glyph was `⇱` (north **west** arrow to corner), pointing the
  opposite way from the corner it docks to. Now `↗`.
- Game-window detection now leads with `.q-dialog`. The game is a Quasar app, so its
  windows have a real selector; previously this relied on ARIA guesses and a
  size-and-z-index heuristic.

### Notes
- Auto-explore initially fired only on a room's first visit. That was wrong: the game
  gains new sections over time, so a room searched previously can have exits it didn't
  have then. It now sweeps every arrival.

---

## 3.1.0 — 2026-10-16

### Added
- **Activity log.** Records every `42[…]` frame the game sends — not only the two
  events the mapper acts on — plus socket open/close, outbound commands, the script's
  own decisions, and any error with its stack. Buffered, written in batches, trimmed
  to the newest 5,000 entries, stored in IndexedDB.
- **Log to file**, exporting the log as JSON along with the context needed to read it:
  script and schema version, URL, user agent, room and placement counts, view state.
- Toggles for recording the log and for clearing it.
- **Dock button** returning the panel to the top-right corner at its default size,
  zoom and centring *(2026-10-15)*.
- **Auto-minimise while a game window is open** — `/char`, `/inv`, `/inf`, `/craft`,
  `/mail`, `/xp` and the rest. A collapse you performed yourself is never auto-undone
  *(2026-10-15)*.
- **Autosaves**: a snapshot every 30 minutes, newest four kept, in IndexedDB. The
  Autosaves panel lists each one and can write it to disk or roll the live map back to
  it, which makes *Clear saved map* recoverable *(2026-10-15)*.
- **Overflow menu** (`⋯`). Seven buttons already filled the 340px header and docking
  would have pushed the collapse control off the edge, so Export, Import, Autosaves,
  Discard-estimated and Clear moved into a menu *(2026-10-15)*.

### Changed
- Chat is deliberately **not** recorded in the activity log. System messages are kept
  verbatim because the mapper reads them; every other chat line has its text replaced
  with a `[n chars withheld]` marker. A toggle turns that off if needed, and each
  export states which mode produced it.
- Zoom floor lowered from 0.4× to 0.1×, since anchoring merged the old synthetic
  floors into real ones and a single floor can now span the whole city *(2026-10-15)*.
- Recentre and fit run synchronously instead of deferring a frame, which previously
  made them silently do nothing while the tab was in the background *(2026-10-15)*.

### Fixed
- IndexedDB opening now handles `onblocked` and `onversionchange`. Without it, a
  second tab holding the database open at the older version would leave the upgrade
  hanging forever, silently stopping both logging and autosaving with nothing in the
  console.

---

## 3.0.0 — 2026-08-30

A rewrite of how rooms are positioned, and the fixes that fell out of it.

### Added
- **Placement engine.** Every room now carries how far its position can be trusted:
  `grid` (the server gave coordinates), `anchored` (worked out from a neighbour's
  exits), `reckoned` (dead reckoning on a synthetic floor) or unplaced.
- **Anchoring.** Rooms the server addresses only by numeric id — sewers, steam
  tunnels — are placed on the real grid by reading neighbouring rooms' exits, which
  carry `targetRoomId`. A floating island is shifted onto the grid in one piece by a
  single offset and re-keyed to its true coordinates.
- Guards against bad anchors: an island with contradictory anchors is left estimated
  rather than snapped into place; one whose outside links would mostly stop being
  cell-adjacent is refused; and a room id that two placed rooms disagree about is
  trusted from neither.
- **Fit button** (`⛶`), zooming out until the whole current floor is visible.
- Haven colouring — dark orange claimed, light orange unclaimed — and vertical
  connections in cyan, bright for rooms going both up and down, dark for one way.
- A count badge for exits that lead somewhere unknown and can't be drawn, so a
  four-way sewer junction no longer looks like a dead end.
- Friendly floor names (`Street level`, `Sublevel 1`, `Level +1`, `In transit`).

### Changed
- Exit lines resolve through `targetRoomId` where possible and fall back to compass
  arithmetic, drawing a half-length stub where the destination has never been seen.
- Transit lines are re-derived per edge rather than bucketing anything unrecognised
  into a single catch-all, which had the same line appearing two and three times over.
- Room records are merged rather than rebuilt, so a partial update no longer erases
  known fields.
- The pending-direction queue is timestamped and sanity-checked against the previous
  room's exits. Previously a single unrecognised failure message would desynchronise
  it permanently and silently corrupt every subsequent placement.
- Pan and zoom update the group transform instead of rebuilding the scene, which was
  roughly a thousand element creations per mousemove.
- Map writes are debounced and flushed on unload instead of re-serialising the whole
  map on every step.

### Fixed
- Errors inside the mapper are no longer swallowed by the frame parser's `catch`.
- The floor list is rebuilt rather than appended to, so cleared floors disappear.
- Riding a train no longer drags the view onto the vehicle's private floor.
- Dead-reckoned rooms parked as "position unknown" could be shifted onto ordinary
  coordinates by a later merge while keeping the stale flag, and real rooms could grow
  into the holding area reserved for unknown positions.

---

## 2026-10-13 — repository

- Added `map-viewer.html`, a standalone offline viewer for an exported map bundle.
  Drag a JSON onto it to browse rooms by floor with filtering, search, colouring
  schemes and per-room detail.
- Added `.gitignore`, keeping personal map data and local tooling out of the
  repository.
- Added, then removed (2026-10-14), `repair-map.py` — a one-off utility that upgrades
  a pre-3.0.0 export by anchoring its dead-reckoned areas onto the real grid. Kept
  locally rather than shipped; the userscript performs the same migration on import.

---

## Earlier

Versions before 3.0.0 predate this repository, so the following is reconstructed from
the migration code 3.0.0 still carries rather than from commit history.

- **Schema 2** partitioned areas without server coordinates by key prefix *and*
  neighbourhood. Prefix alone had silently merged unrelated networks that happened to
  share one — every neighbourhood's sewer being `sewer-N`.
- **Schema 1** stored rooms keyed by coordinate with an `isGrid` flag, laying out
  everything else by dead reckoning on synthetic floors with relative coordinates.

Both shapes are still read on import and upgraded in place.
