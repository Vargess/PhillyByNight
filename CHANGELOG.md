# Changelog

Functional changes to `PbN-Mapper.user.js`, newest first. Repository-level changes
(the viewer, tooling) are noted under the date they landed.

Versions are the `@version` in the script's metadata block. Where a release bundles
work done over several days, the dates are given per item.

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
