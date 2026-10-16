// ==UserScript==
// @name         PbN Mapper
// @namespace    https://philadelphiabynight.net/
// @description  Auto-maps rooms, exits, havens and transit lines while you play Philadelphia by Night.
// @version      3.0.0
// @match        https://philadelphiabynight.net/play*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function () {
  'use strict';

  // ------------------------------------------------------------------ config

  const STORAGE_KEY = 'pbn_mapper_rooms_v1';
  const TRANSIT_KEY = 'pbn_mapper_transit_v1';
  const VIEW_KEY = 'pbn_mapper_view_v1';
  const SCHEMA_KEY = 'pbn_mapper_schema';
  const SCHEMA_VERSION = 3;

  const CELL = 30;
  // Anchoring merged the old pseudo-floors into the real ones, so a single floor can now
  // span the whole city (sublevel 1 runs from University City to Kensington). Allow
  // zooming out far enough to actually see that.
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 3;
  const VEHICLE_Z_THRESHOLD = -50;
  const RELATIVE_Z_BASE = -1000;  // pseudo-floor band for areas we cannot tie to the real grid
  const PENDING_TTL_MS = 4000;
  const SAVE_DEBOUNCE_MS = 400;
  const UNKNOWN_LINE = 'Unknown line';

  const AUTOSAVE_DB = 'pbn_mapper';
  const AUTOSAVE_STORE = 'autosaves';
  const AUTOSAVE_KEEP = 4;
  const AUTOSAVE_INTERVAL_MS = 30 * 60 * 1000;

  const GRID_KEY_RE = /^-?\d+,-?\d+,-?\d+$/;
  const ID_KEY_RE = /^([A-Za-z][A-Za-z_]*)-(\d+)$/;

  // [dx, dy, dz] per compass/vertical direction.
  const DIR = {
    north: [0, 1, 0], south: [0, -1, 0], east: [1, 0, 0], west: [-1, 0, 0],
    northeast: [1, 1, 0], northwest: [-1, 1, 0], southeast: [1, -1, 0], southwest: [-1, -1, 0],
    up: [0, 0, 1], down: [0, 0, -1]
  };

  const log = (msg, color, data) =>
    (data === undefined
      ? console.log(`%c[pbn-mapper] ${msg}`, `color:${color}`)
      : console.log(`%c[pbn-mapper] ${msg}`, `color:${color}`, data));

  // ------------------------------------------------------------- data model
  //
  // Every room record carries a resolved position and a `placement` describing how
  // much that position can be trusted:
  //
  //   'grid'     - the server addressed the room as "x,y,z". Authoritative.
  //   'anchored' - the server addressed it only by numeric id, but we worked out its
  //                real cell (see resolvePlacement). Just as authoritative in practice.
  //   'reckoned' - no way to tie it to the real grid, so it lives on a synthetic
  //                pseudo-floor laid out purely by dead reckoning.
  //   null       - known to exist (named by a neighbour list) but not placeable yet.
  //
  // Anchored rooms are re-keyed to their real "x,y,z" so they merge with whatever the
  // grid already knew about that cell instead of shadowing it.

  let rooms = {};
  let transitEdges = {};          // { [lineName]: [[stationNameA, stationNameB], ...] }
  let currentKey = null;

  let idToKey = {};               // numeric room id -> canonical room key
  let idToCoord = {};             // numeric room id -> [x,y,z], or null when sources disagree

  const listeners = [];
  const notify = () => listeners.forEach((fn) => fn());
  const render = () => notify();

  // ------------------------------------------------------------- persistence

  let roomsTimer = null;
  function flushRooms() {
    clearTimeout(roomsTimer);
    roomsTimer = null;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms));
  }
  // Serialising the whole map costs a few hundred KB; movement fires this constantly,
  // so coalesce bursts and flush on the way out.
  function saveRooms() {
    if (roomsTimer === null) roomsTimer = setTimeout(flushRooms, SAVE_DEBOUNCE_MS);
  }
  const saveTransit = () => localStorage.setItem(TRANSIT_KEY, JSON.stringify(transitEdges));
  const saveView = () => localStorage.setItem(VIEW_KEY,
    JSON.stringify({ floor: state.floor, autoMinimize: state.autoMinimize }));

  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; }
    catch (e) { return fallback; }
  }

  // ------------------------------------------------------------- autosaves
  //
  // A rolling history of the whole map, taken every half hour and kept four deep.
  // It lives in IndexedDB rather than on disk because a userscript has no way to
  // delete a file it has written, so a disk-based history could only ever grow;
  // here the oldest really is discarded. Snapshots can be written out individually
  // from the Autosaves panel, and localStorage is too small to hold four of them.

  let dbPromise = null;
  function openAutosaveDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(AUTOSAVE_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(AUTOSAVE_STORE)) {
          db.createObjectStore(AUTOSAVE_STORE, { keyPath: 'savedAt' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // A failed open must not be cached forever — private windows can recover.
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  function autosaveTx(mode, run) {
    return openAutosaveDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(AUTOSAVE_STORE, mode);
      let result;
      try { result = run(tx.objectStore(AUTOSAVE_STORE)); }
      catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }
  const wrap = (req) => ({ __req: req });

  // Keys are timestamps, so IndexedDB hands them back oldest-first already.
  const autosaveKeys = () => autosaveTx('readonly', (s) => wrap(s.getAllKeys()));
  const autosaveAll = () => autosaveTx('readonly', (s) => wrap(s.getAll()))
    .then((list) => list.slice().sort((a, b) => b.savedAt - a.savedAt));
  const autosaveGet = (savedAt) => autosaveTx('readonly', (s) => wrap(s.get(savedAt)));

  async function autosavePrune(keep) {
    const keys = await autosaveKeys();
    const doomed = keys.slice(0, Math.max(0, keys.length - keep));
    if (!doomed.length) return 0;
    await autosaveTx('readwrite', (s) => { doomed.forEach((k) => s.delete(k)); });
    return doomed.length;
  }

  // The bundle an export writes, shared so an autosave and a manual export cannot drift.
  function mapBundle() {
    return {
      schemaVersion: SCHEMA_VERSION,
      rooms,
      transitEdges,
      floorLabels: computeFloorLabels(),
      exportedAt: new Date().toISOString()
    };
  }

  async function autosaveNow(reason) {
    const roomCount = Object.keys(rooms).length;
    if (!roomCount) return null;        // never let an empty map evict real history
    flushRooms();
    const entry = { savedAt: Date.now(), roomCount, reason, bundle: mapBundle() };
    try {
      await autosaveTx('readwrite', (s) => { s.put(entry); });
      const removed = await autosavePrune(AUTOSAVE_KEEP);
      log(`autosaved ${roomCount} rooms (${reason})`, '#2ecc71',
        { keeping: AUTOSAVE_KEEP, discarded: removed });
      return entry;
    } catch (e) {
      log('autosave failed: ' + (e && e.message), '#e74c3c', e);
      return null;
    }
  }

  function autosaveStamp(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------------------------------------------------------------- helpers

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const gridKey = (x, y, z) => `${x},${y},${z}`;
  const parseIdKey = (key) => {
    const m = ID_KEY_RE.exec(key || '');
    return m ? { prefix: m[1], id: Number(m[2]) } : null;
  };
  const isPlaced = (r) => !!r && r.x != null;
  const isVehicleAt = (placement, z) =>
    (placement === 'grid' || placement === 'anchored') && z != null && z <= VEHICLE_Z_THRESHOLD;
  const areaId = (prefix, slug) => (slug ? `${prefix}::${slug}` : prefix);
  const areaLabelFor = (prefix, name) => (name ? `${cap(prefix)} (${name})` : cap(prefix));

  function pseudoZForArea(area) {
    let hash = 0;
    for (let i = 0; i < area.length; i++) hash = (hash * 31 + area.charCodeAt(i)) | 0;
    return RELATIVE_Z_BASE - (Math.abs(hash) % 900);
  }

  function floorLabel(z, labels) {
    if (labels && labels[z]) return labels[z];
    if (z <= VEHICLE_Z_THRESHOLD) return 'In transit';
    if (z === 0) return 'Street level';
    if (z > 0) return `Level +${z}`;
    return `Sublevel ${-z}`;
  }

  function computeFloorLabels() {
    const out = {};
    Object.values(rooms).forEach((r) => {
      if (r.placement !== 'reckoned' || r.z == null || !r.areaLabel) return;
      const depth = r.z - pseudoZForArea(r.area || 'area');
      out[r.z] = depth === 0
        ? `${r.areaLabel} (estimated)`
        : `${r.areaLabel} ${depth > 0 ? '+' : ''}${depth} (estimated)`;
    });
    return out;
  }

  // --------------------------------------------------------------- indexes

  function rebuildIndexes() {
    idToKey = {};
    Object.values(rooms).forEach((r) => { if (r.id != null) idToKey[r.id] = r.key; });
    idToCoord = {};
    Object.values(rooms).forEach(learnCoordsFromExits);
  }

  // A room sitting on the real grid tells us, for free, the exact cell of everything
  // it has a compass/vertical exit to — including rooms the server only ever addresses
  // by numeric id. This is what lets id-keyed areas (sewers, steam tunnels) be placed
  // exactly instead of guessed at.
  function learnCoordsFromExits(r) {
    if (!isPlaced(r) || r.placement === 'reckoned' || !r.exits) return;
    r.exits.forEach((e) => {
      const off = DIR[e.direction];
      if (!off || e.targetRoomId == null) return;
      const c = [r.x + off[0], r.y + off[1], r.z + off[2]];
      const seen = idToCoord[e.targetRoomId];
      if (seen === undefined) idToCoord[e.targetRoomId] = c;
      else if (seen && (seen[0] !== c[0] || seen[1] !== c[1] || seen[2] !== c[2])) {
        // Two grid rooms disagree about where id N is; trust neither.
        log('conflicting coordinates for room id ' + e.targetRoomId + ' — ignoring both', '#e67e22',
          { from: r.key, says: c, otherSays: seen });
        idToCoord[e.targetRoomId] = null;
      }
    });
  }

  // True when `coord` is somewhere we may legitimately put this room: empty, or holding
  // a placeholder, or holding this very room under another key.
  function cellAvailable(coord, id, self) {
    const occ = rooms[gridKey(coord[0], coord[1], coord[2])];
    if (!occ) return true;
    if (self && occ === self) return true;
    if (id != null && occ.id === id) return true;
    if (!occ.visited) return true;
    return !!(self && self.name && occ.name === self.name);
  }

  // ------------------------------------------------------------- migration

  function migrateRoom(key, raw) {
    const r = Object.assign({}, raw);
    r.key = key;
    if (r.id == null) {
      const info = parseIdKey(key);
      if (info) r.id = info.id;
    }
    if (r.placement === undefined) {
      if (GRID_KEY_RE.test(key)) {
        const [x, y, z] = key.split(',').map(Number);
        r.placement = 'grid'; r.x = x; r.y = y; r.z = z;
      } else if (raw.isGrid === false && raw.relX != null) {
        const info = parseIdKey(key);
        r.placement = 'reckoned';
        r.x = raw.relX; r.y = raw.relY; r.z = raw.relZ;
        r.islandId = raw.islandId || key;
        r.area = areaId(info ? info.prefix : 'area', raw.neighborhood ? raw.neighborhood.slug : null);
        r.areaLabel = areaLabelFor(info ? info.prefix : 'area', raw.neighborhood ? raw.neighborhood.name : null);
      } else {
        // Pre-v2 leftovers: an id-keyed room saved before positions were tracked at all.
        // Keep the record (the name is still worth something) but do not pretend to place it.
        r.placement = null; r.x = null; r.y = null; r.z = null;
      }
    }
    delete r.isGrid; delete r.relX; delete r.relY; delete r.relZ;
    if (r.placement !== 'reckoned') { r.islandId = null; r.positionUncertain = false; }
    r.isVehicle = isVehicleAt(r.placement, r.z);
    return r;
  }

  function migrateAll(raw) {
    const out = {};
    Object.entries(raw || {}).forEach(([key, r]) => {
      if (!r || typeof r !== 'object') return;
      out[key] = migrateRoom(key, r);
    });
    return out;
  }

  // ------------------------------------------------------------- anchoring

  // A dead-reckoned island is internally consistent but floating: its shape is right,
  // its absolute position is unknown. As soon as any one member's real cell becomes
  // known, the whole island can be shifted onto the real grid by a single offset.
  function anchorFloatingIslands() {
    const islands = new Map();
    Object.values(rooms).forEach((r) => {
      if (r.placement !== 'reckoned') return;
      if (!islands.has(r.islandId)) islands.set(r.islandId, []);
      islands.get(r.islandId).push(r);
    });

    let changed = false;
    islands.forEach((members, islandId) => {
      let offset = null;
      let anchors = 0;
      let disagreement = null;
      members.forEach((r) => {
        const c = r.id != null ? idToCoord[r.id] : null;
        if (!c) return;
        const o = [c[0] - r.x, c[1] - r.y, c[2] - r.z];
        anchors++;
        if (!offset) offset = o;
        else if (offset[0] !== o[0] || offset[1] !== o[1] || offset[2] !== o[2]) {
          disagreement = { room: r.key, expected: offset, got: o };
        }
      });
      if (!offset) return;
      if (disagreement) {
        // Independent anchors imply different offsets, so the reckoned shape has drifted.
        // Leaving it floating is honest; snapping it would invent a position.
        log('island ' + islandId + ' has contradictory anchors — leaving it estimated', '#e74c3c', disagreement);
        return;
      }
      if (applyIslandAnchor(islandId, members, offset, anchors)) changed = true;
    });
    return changed;
  }

  // An offset that is off by even one cell will throw the island's links to the outside
  // world out of alignment. Those links are independent evidence: they come from exits
  // (often labelled "passage 1" rather than a compass point) that played no part in
  // choosing the offset. Links *within* the island prove nothing — dead reckoning made
  // them adjacent by construction — so they are excluded.
  function verifyIslandLinks(moves, moving) {
    const inside = new Map();
    moves.forEach((m) => { if (m.room.id != null) inside.set(m.room.id, true); });
    let ok = 0;
    const bad = [];
    moves.forEach((m) => {
      (m.room.exits || []).forEach((e) => {
        if (e.targetRoomId == null || inside.has(e.targetRoomId)) return;
        let c = idToCoord[e.targetRoomId];
        if (!c) {
          const t = rooms[idToKey[e.targetRoomId]];
          if (!isPlaced(t) || moving.has(t.key)) return;
          c = [t.x, t.y, t.z];
        }
        const dz = c[2] - m.z;
        const cheb = Math.max(Math.abs(c[0] - m.x), Math.abs(c[1] - m.y));
        if ((dz === 0 && cheb === 1) || (Math.abs(dz) === 1 && cheb === 0)) ok++;
        else bad.push(`${m.room.name} (${m.key}) -> room id ${e.targetRoomId} at ${c.join(',')}`);
      });
    });
    return { ok, bad };
  }

  function applyIslandAnchor(islandId, members, offset, anchors) {
    const moves = members.map((r) => {
      const x = r.x + offset[0], y = r.y + offset[1], z = r.z + offset[2];
      return { room: r, oldKey: r.key, key: gridKey(x, y, z), x, y, z };
    });
    const moving = new Set(moves.map((m) => m.oldKey));

    const links = verifyIslandLinks(moves, moving);
    if (links.bad.length) {
      // A single odd link can be genuine (the elevated line spans two cells between
      // Somerset and Huntingdon), so only a majority of broken links condemns the offset.
      const verdict = links.bad.length > links.ok ? 'rejecting' : 'accepting anyway';
      log(`island ${islandId}: ${links.bad.length} of ${links.bad.length + links.ok} outside links ` +
        `would not be cell-adjacent — ${verdict}`, '#e74c3c', { offset, examples: links.bad.slice(0, 5) });
      if (links.bad.length > links.ok) return false;
    }

    for (const m of moves) {
      const occ = rooms[m.key];
      if (!occ || moving.has(occ.key)) continue;
      if (occ.visited && occ.name && m.room.name && occ.name !== m.room.name && occ.id !== m.room.id) {
        log('refusing to anchor island ' + islandId + ' — it would land on a different known room', '#e74c3c',
          { moving: `${m.room.name} (${m.oldKey})`, onto: `${occ.name} (${occ.key})` });
        return false;
      }
    }

    moves.forEach((m) => { delete rooms[m.oldKey]; });
    moves.forEach((m) => {
      const displaced = rooms[m.key];
      const r = m.room;
      r.key = m.key; r.x = m.x; r.y = m.y; r.z = m.z;
      r.placement = 'anchored';
      r.islandId = null;
      r.positionUncertain = false;
      delete r.area; delete r.areaLabel;
      if (displaced && !r.name) r.name = displaced.name;
      rooms[m.key] = r;
      if (currentKey === m.oldKey) currentKey = m.key;
    });

    log(`anchored island ${islandId}: ${moves.length} room(s) onto the real grid`, '#2ecc71',
      { offset, anchors, confirmingLinks: links.ok, brokenLinks: links.bad.length,
        sample: moves.slice(0, 3).map((m) => `${m.room.name}: ${m.oldKey} -> ${m.key}`) });
    rebuildIndexes();
    return true;
  }

  // ------------------------------------------------------------ pending moves

  // Outgoing "move" commands that have not yet been matched to a roomUpdate. A single
  // slot is not enough (a rejected move produces no roomUpdate), and a plain queue is
  // not enough either (only one rejection message is recognised), so entries also
  // expire and are sanity-checked against the exits of the room we are leaving.
  const pending = [];

  function pushPending(dir) { pending.push({ dir, at: Date.now() }); }

  function takePendingDirection(from) {
    const now = Date.now();
    const compass = from && from.exits ? from.exits.filter((e) => DIR[e.direction]) : [];
    while (pending.length) {
      const p = pending.shift();
      if (now - p.at > PENDING_TTL_MS) continue;
      // Rooms that expose compass exits can vouch for the move; rooms whose exits are
      // labelled some other way (sewer "passage 1") cannot, so skip the check there.
      if (compass.length && !compass.some((e) => e.direction === p.dir)) continue;
      return p.dir;
    }
    return null;
  }

  // -------------------------------------------------------------- placement

  function resolvePlacement(data, id, prev, direction) {
    // 1. The server gave us a real coordinate outright.
    if (GRID_KEY_RE.test(data.key)) {
      const [x, y, z] = data.key.split(',').map(Number);
      return { key: data.key, placement: 'grid', x, y, z, islandId: null, positionUncertain: false };
    }

    const known = id != null && idToKey[id] ? rooms[idToKey[id]] : rooms[data.key];

    // 2. A neighbouring grid room has already revealed this room's cell.
    let coord = id != null && idToCoord[id] ? idToCoord[id].slice() : null;

    // 3. Otherwise: if we just stepped here from a room that *is* on the real grid,
    //    the destination cell is simply that room plus the direction we moved.
    if (!coord && prev && prev.placement !== 'reckoned' && isPlaced(prev) && direction && DIR[direction]) {
      const off = DIR[direction];
      coord = [prev.x + off[0], prev.y + off[1], prev.z + off[2]];
    }

    if (coord && cellAvailable(coord, id, known)) {
      // Promote a previously-floating island in one piece rather than tearing this
      // single room out of it and leaving the rest behind.
      if (known && known.placement === 'reckoned') {
        const members = Object.values(rooms).filter((r) => r.placement === 'reckoned' && r.islandId === known.islandId);
        applyIslandAnchor(known.islandId, members,
          [coord[0] - known.x, coord[1] - known.y, coord[2] - known.z], 1);
      }
      return {
        key: gridKey(coord[0], coord[1], coord[2]), placement: 'anchored',
        x: coord[0], y: coord[1], z: coord[2], islandId: null, positionUncertain: false
      };
    }
    if (coord) {
      log('derived cell for ' + data.key + ' is already taken by a different room — falling back', '#e67e22',
        { room: data.name, cell: coord, occupant: (rooms[gridKey(coord[0], coord[1], coord[2])] || {}).name });
    }

    // 4. Nothing new learned; keep whatever position it already had.
    if (known && isPlaced(known)) {
      return {
        key: known.key, placement: known.placement, x: known.x, y: known.y, z: known.z,
        islandId: known.islandId, positionUncertain: !!known.positionUncertain
      };
    }

    // 5. Last resort: dead reckoning on a synthetic floor.
    return reckon(data, prev, direction, known);
  }

  function reckon(data, prev, direction, known) {
    const info = parseIdKey(data.key);
    const prefix = info ? info.prefix : 'area';
    const slug = data.neighborhood ? data.neighborhood.slug : null;
    const area = areaId(prefix, slug);
    const label = areaLabelFor(prefix, data.neighborhood ? data.neighborhood.name : null);
    const baseZ = pseudoZForArea(area);

    let expected = null;
    if (prev && prev.placement === 'reckoned' && prev.area === area && direction && DIR[direction]) {
      const off = DIR[direction];
      expected = [prev.x + off[0], prev.y + off[1], prev.z + off[2]];
    }

    const base = { key: data.key, placement: 'reckoned', area, areaLabel: label };

    if (known && known.placement === 'reckoned') {
      if (expected && known.islandId !== prev.islandId) {
        mergeIslands(known.islandId, prev.islandId,
          expected[0] - known.x, expected[1] - known.y, expected[2] - known.z);
        return Object.assign(base, {
          x: expected[0], y: expected[1], z: expected[2],
          islandId: prev.islandId, positionUncertain: false
        });
      }
      // Same island: if this room was parked as an orphan and we now have a confirmed
      // approach, take the confirmed position instead of keeping the guess forever.
      if (expected && known.positionUncertain && cellFreeInReckoned(expected, known)) {
        return Object.assign(base, {
          x: expected[0], y: expected[1], z: expected[2],
          islandId: known.islandId, positionUncertain: false
        });
      }
      return Object.assign(base, {
        x: known.x, y: known.y, z: known.z,
        islandId: known.islandId, positionUncertain: !!known.positionUncertain
      });
    }

    const candidate = expected || [0, 0, baseZ];
    const islandId = expected ? prev.islandId : data.key;
    if (cellFreeInReckoned(candidate, known)) {
      return Object.assign(base, { x: candidate[0], y: candidate[1], z: candidate[2], islandId, positionUncertain: false });
    }
    // Two unrelated fragments computed the same cell. Nudging to the "nearest" free cell
    // would invent a spatial relationship, so park it in a clearly separate holding area:
    // an honest "position unknown" rather than a guessed one.
    const spot = placeOrphan(candidate[2]);
    log('coordinate collision — parked separately, true position unknown', '#e74c3c',
      { room: `${data.name} (${data.key})`, wouldHaveBeen: candidate, parkedAt: spot });
    return Object.assign(base, { x: spot[0], y: spot[1], z: candidate[2], islandId, positionUncertain: true });
  }

  function cellFreeInReckoned(c, self) {
    return !Object.values(rooms).some((r) =>
      r !== self && r.placement === 'reckoned' && r.x === c[0] && r.y === c[1] && r.z === c[2]);
  }

  const ORPHAN_X = 1000;
  const ORPHAN_ROW = 12;
  // Scan for a genuinely free slot rather than counting orphans: reckoned rooms grow
  // outward from wherever their island root landed and can reach into the holding band.
  function placeOrphan(z) {
    for (let i = 0; i < 4096; i++) {
      const c = [ORPHAN_X + (i % ORPHAN_ROW) * 2, -Math.floor(i / ORPHAN_ROW) * 2, z];
      if (cellFreeInReckoned(c, null)) return [c[0], c[1]];
    }
    return [ORPHAN_X, 0];
  }

  function mergeIslands(fromId, toId, dx, dy, dz) {
    if (fromId === toId || fromId == null || toId == null) return;
    const affected = Object.values(rooms).filter((r) => r.placement === 'reckoned' && r.islandId === fromId);
    const moving = new Set(affected);
    const blocked = affected.some((r) => !cellFreeInReckoned([r.x + dx, r.y + dy, r.z + dz], null) &&
      !Object.values(rooms).some((o) => moving.has(o) && o.x === r.x + dx && o.y === r.y + dy && o.z === r.z + dz));
    if (blocked) {
      log('refusing to merge islands — the shift would overlap existing rooms', '#e74c3c', { fromId, toId, dx, dy, dz });
      return;
    }
    log('merging islands', '#ff8c42', { fromId, toId, dx, dy, dz, rooms: affected.map((r) => r.name) });
    affected.forEach((r) => {
      r.x += dx; r.y += dy; r.z += dz;
      r.islandId = toId;
      // The shift places these rooms exactly, so a stale "unknown position" flag would
      // now be a lie in the other direction.
      r.positionUncertain = false;
    });
  }

  // ------------------------------------------------------------ room records

  function buildRecord(data, id, placed, prev) {
    const p = prev || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(data, k);
    const keep = (k, value) => (has(k) ? value : (p[k] !== undefined ? p[k] : value));

    const rec = {
      key: placed.key,
      id: id != null ? id : (p.id != null ? p.id : null),
      name: data.name || p.name || null,
      primaryTag: keep('primaryTag', data.primaryTag || null),
      exposureTier: keep('exposureTier', data.exposureTier || null),
      indoor: keep('indoor', !!data.indoor),
      features: keep('features', Array.isArray(data.features) ? data.features : []),
      isHaven: keep('isHaven', !!data.isHaven),
      havenOwnerId: keep('havenOwnerId', data.havenOwnerId != null ? data.havenOwnerId : null),
      havenIsLocked: keep('havenIsLocked', !!data.havenIsLocked),
      // Only recomputable when the payload actually carries a description; otherwise a
      // partial update would silently erase a known-claimable haven.
      havenClaimable: data.isHaven ? false
        : (typeof data.description === 'string'
          ? /may be claimed as a haven/i.test(data.description)
          : !!p.havenClaimable),
      isVehicle: isVehicleAt(placed.placement, placed.z),
      placement: placed.placement,
      x: placed.x, y: placed.y, z: placed.z,
      islandId: placed.islandId,
      positionUncertain: placed.positionUncertain,
      exits: keep('exits', (data.exits || []).map((e) => ({
        direction: e.direction,
        targetRoomId: e.targetRoomId != null ? e.targetRoomId : null,
        locked: !!e.isLocked,
        broken: !!e.broken
      }))),
      neighborhood: keep('neighborhood', data.neighborhood
        ? { slug: data.neighborhood.slug, name: data.neighborhood.name, sect: data.neighborhood.sect }
        : null),
      visited: true,
      lastSeen: Date.now()
    };
    if (placed.placement === 'reckoned') { rec.area = placed.area; rec.areaLabel = placed.areaLabel; }
    return rec;
  }

  function upsertVisited(data) {
    const prev = currentKey ? rooms[currentKey] : null;
    const direction = takePendingDirection(prev);

    const info = parseIdKey(data.key);
    const id = data.id != null ? data.id
      : (data.roomId != null ? data.roomId : (info ? info.id : null));

    const placed = resolvePlacement(data, id, prev, direction);
    const existing = rooms[placed.key] || (id != null && idToKey[id] ? rooms[idToKey[id]] : null);

    // Re-keying (an id-addressed room that turned out to have a real cell) must not
    // leave the old entry behind as a duplicate.
    if (existing && existing.key !== placed.key) delete rooms[existing.key];
    if (rooms[data.key] && data.key !== placed.key) delete rooms[data.key];

    const rec = buildRecord(data, id, placed, existing);
    rooms[placed.key] = rec;
    if (rec.id != null) idToKey[rec.id] = rec.key;
    learnCoordsFromExits(rec);

    (data.neighbors || []).forEach((n) => {
      if (!n || !n.key) return;
      const ninfo = parseIdKey(n.key);
      const nid = ninfo ? ninfo.id : null;
      const nkey = (nid != null && idToKey[nid]) ? idToKey[nid] : n.key;
      const cur = rooms[nkey];
      if (cur) { if (!cur.name) cur.name = n.name; return; }
      rooms[nkey] = migrateRoom(nkey, { name: n.name, visited: false, id: nid });
      if (nid != null) idToKey[nid] = nkey;
    });

    if (anchorFloatingIslands()) rebuildIndexes();

    currentKey = rec.key;
    if (!rec.isVehicle) ride = null;   // stepped off the train
    saveRooms();
    render();
  }

  // ------------------------------------------------------------------ transit

  function normalizeLine(raw) {
    let t = String(raw).replace(/^SEPTA\s+/i, '').trim();
    t = t.replace(/\s*\bEl\b\.?$/i, ' Line').trim();      // "Market-Frankford El" -> "... Line"
    if (!/\bLine$/i.test(t)) t += ' Line';
    return t.replace(/\s+/g, ' ');
  }

  // Station names advertise their line in several shapes; returns null when none of
  // them match, so callers can fall back rather than invent a line name.
  function extractLine(stationName) {
    const s = String(stationName || '');
    let m = s.match(/\[\s*(.+?)\s*\]\s*$/)              // "Somerset Station [ SEPTA ... Line ]"
      || s.match(/\s[—–]\s*(.+?)\s*$/)                  // "Berks Platform — Market-Frankford El"
      || s.match(/^(.+?\bLine)\s*,/i);                  // "Market-Frankford Line, Westbound Platform"
    return m ? normalizeLine(m[1]) : null;
  }

  // Older data bucketed every station whose name did not carry a bracketed line under a
  // single "Transit" pseudo-line, so one real line could appear two or three times over.
  // Re-derive each edge's line from its station names, then let stations that serve
  // exactly one known line label the hops we still could not name.
  function migrateTransit(raw) {
    const out = {};
    const add = (line, a, b) => {
      if (!out[line]) out[line] = [];
      const k = [a, b].sort().join('||');
      if (!out[line].some(([x, y]) => [x, y].sort().join('||') === k)) out[line].push([a, b]);
    };

    const unlabelled = [];
    Object.entries(raw || {}).forEach(([line, edges]) => {
      (edges || []).forEach((edge) => {
        if (!Array.isArray(edge) || edge.length < 2) return;
        const [a, b] = edge;
        const resolved = extractLine(a) || extractLine(b);
        if (resolved) add(resolved, a, b); else unlabelled.push([a, b, line]);
      });
    });

    for (let pass = 0; pass < 8 && unlabelled.length; pass++) {
      const lineOf = {};
      Object.entries(out).forEach(([line, edges]) => {
        edges.forEach((edge) => edge.forEach((s) => {
          if (lineOf[s] === undefined) lineOf[s] = line;
          else if (lineOf[s] !== line) lineOf[s] = null;   // interchange: lends no line
        }));
      });
      let progressed = false;
      for (let i = unlabelled.length - 1; i >= 0; i--) {
        const line = lineOf[unlabelled[i][0]] || lineOf[unlabelled[i][1]];
        if (!line) continue;
        add(line, unlabelled[i][0], unlabelled[i][1]);
        unlabelled.splice(i, 1);
        progressed = true;
      }
      if (!progressed) break;
    }
    unlabelled.forEach(([a, b, line]) => add(line && line !== 'Transit' ? line : UNKNOWN_LINE, a, b));
    return out;
  }

  function addTransitEdge(line, a, b) {
    if (!a || !b || a === b) return false;
    if (!transitEdges[line]) transitEdges[line] = [];
    const key = [a, b].sort().join('||');
    if (transitEdges[line].some(([x, y]) => [x, y].sort().join('||') === key)) return false;
    transitEdges[line].push([a, b]);
    saveTransit();
    notify();
    return true;
  }

  // A ride is one continuous trip. Tracking it as a single slot (rather than one slot
  // per line) matches reality — you can only be on one train — and lets a hop whose
  // stations are both unlabelled inherit the line from earlier in the same journey.
  let ride = null;   // { from: stationName, line: string|null }

  function handleSystemMessage(text) {
    let m;
    if (text === "You can't go that way.") {
      if (pending.length) pending.shift();
      return;
    }
    if ((m = text.match(/^The doors close on (.+) and the train moves off\.$/))) {
      const station = m[1];
      ride = { from: station, line: extractLine(station) || (ride && ride.line) || null };
      return;
    }
    if ((m = text.match(/^The brakes bite and the train slows\. Now arriving: (.+)\. The doors open\.$/))) {
      const station = m[1];
      const line = (ride && extractLine(ride.from)) || extractLine(station)
        || (ride && ride.line) || UNKNOWN_LINE;
      if (ride && ride.from) addTransitEdge(line, ride.from, station);
      ride = { from: station, line: line === UNKNOWN_LINE ? (ride && ride.line) || null : line };
    }
  }

  // ---------------------------------------------------------------- socket

  const OrigWS = window.WebSocket;
  window.WebSocket = new Proxy(OrigWS, {
    construct(target, args) {
      const ws = new target(...args);
      ws.addEventListener('message', (e) => {
        const raw = e.data;
        if (typeof raw !== 'string' || !raw.startsWith('42[')) return;
        let event, payload;
        // Only the parse is allowed to fail quietly — a bug in the mapper itself should
        // surface in the console, not vanish.
        try { [event, payload] = JSON.parse(raw.slice(2)); } catch (err) { return; }
        if (event === 'roomUpdate' && payload && payload.key) {
          log('roomUpdate', '#4ecdc4', payload);
          upsertVisited(payload);
        } else if (event === 'chat-message' && payload && payload.type === 'system' && typeof payload.text === 'string') {
          handleSystemMessage(payload.text);
        }
      });
      const origSend = ws.send.bind(ws);
      ws.send = (data) => {
        if (typeof data === 'string' && data.startsWith('42[')) {
          try {
            const [event, arg] = JSON.parse(data.slice(2));
            if (event === 'move' && typeof arg === 'string') pushPending(arg);
          } catch (err) { /* not a payload we care about */ }
        }
        return origSend(data);
      };
      return ws;
    }
  });

  // ------------------------------------------------------------------- boot

  rooms = migrateAll(readJSON(STORAGE_KEY, {}));
  transitEdges = migrateTransit(readJSON(TRANSIT_KEY, {}));
  rebuildIndexes();
  if (anchorFloatingIslands()) rebuildIndexes();
  if (localStorage.getItem(SCHEMA_KEY) !== String(SCHEMA_VERSION)) {
    localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION));
    flushRooms();
    saveTransit();
  }
  {
    const counts = { grid: 0, anchored: 0, reckoned: 0, unplaced: 0 };
    Object.values(rooms).forEach((r) => { counts[r.placement || 'unplaced']++; });
    log('loaded ' + Object.keys(rooms).length + ' rooms', '#4ecdc4', counts);
  }

  // --------------------------------------------------------------------- UI

  const state = Object.assign(
    {
      floor: null, scale: 1, panX: 0, panY: 0, collapsed: false,
      autoCenter: true, autoFloor: true, autoMinimize: true
    },
    readJSON(VIEW_KEY, {})
  );

  const ui = { g: null, svg: null, select: null, label: null, setCollapsed: null };

  // ------------------------------------------------- game-window auto-minimise
  //
  // The game opens /char, /inv, /inf, /craft, /mail, /xp and friends as in-page
  // overlays, and the map panel sits on top of them. We cannot know their markup in
  // advance, so match a tunable selector list first and otherwise fall back to a shape
  // test: a large, high-z-index, fixed or absolutely positioned element that is not
  // ours. Add a selector here if a particular window is missed.
  const POPUP_SELECTORS = ['[role="dialog"]', '[aria-modal="true"]'];
  const POPUP_MIN_Z = 100;
  const POPUP_MIN_AREA = 0.18;   // fraction of the viewport it must cover

  // Only panels WE minimised are restored, so a deliberate collapse is never undone.
  let autoCollapsed = false;
  let popupTimer = null;

  function overlayVisible(el) {
    if (!(el instanceof Element) || el.closest('#pbn-mapper')) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function looksLikeGameWindow(el) {
    if (!overlayVisible(el)) return false;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    const z = parseInt(cs.zIndex, 10);
    if (!Number.isFinite(z) || z < POPUP_MIN_Z) return false;
    const r = el.getBoundingClientRect();
    return (r.width * r.height) / (window.innerWidth * window.innerHeight) >= POPUP_MIN_AREA;
  }

  function gameWindowOpen() {
    for (const sel of POPUP_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) if (overlayVisible(el)) return true;
    }
    // Modals are almost always appended to <body>, so this stays cheap.
    const kids = document.body ? document.body.children : [];
    for (let i = 0; i < kids.length; i++) if (looksLikeGameWindow(kids[i])) return true;
    return false;
  }

  function evaluateGameWindows() {
    if (!ui.setCollapsed || !state.autoMinimize) return;
    const open = gameWindowOpen();
    if (open && !state.collapsed) { ui.setCollapsed(true); autoCollapsed = true; }
    else if (!open && autoCollapsed) { ui.setCollapsed(false); autoCollapsed = false; }
  }

  function scheduleWindowCheck() {
    if (popupTimer !== null) return;
    popupTimer = setTimeout(() => { popupTimer = null; evaluateGameWindows(); }, 120);
  }

  function installGameWindowWatcher() {
    const mo = new MutationObserver((records) => {
      for (const rec of records) {
        // Our own re-renders churn the SVG constantly; ignore them.
        const t = rec.target;
        if (t instanceof Element && t.closest('#pbn-mapper')) continue;
        scheduleWindowCheck();
        return;
      }
    });
    mo.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'open']
    });
    scheduleWindowCheck();
  }

  function injectUI() {
    const root = document.createElement('div');
    root.id = 'pbn-mapper';
    const initW = 340, initH = 340, margin = 12;
    // Anchor via left/top (computed to match a bottom-right default), not bottom/right —
    // an element pinned by bottom/right grows its TOP-LEFT corner when resized, which can
    // push the header off the top of the screen.
    Object.assign(root.style, {
      position: 'fixed',
      left: `${Math.max(margin, window.innerWidth - initW - margin)}px`,
      top: `${Math.max(margin, window.innerHeight - initH - margin)}px`,
      width: `${initW}px`, height: `${initH}px`,
      minWidth: '220px', minHeight: '160px', resize: 'both',
      background: 'rgba(20,20,24,0.92)', border: '1px solid #555', borderRadius: '8px',
      zIndex: 999999, color: '#eee', font: '12px sans-serif', display: 'flex', flexDirection: 'column',
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)', overflow: 'hidden'
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px',
      background: '#2a2a30', cursor: 'move', userSelect: 'none'
    });

    const title = document.createElement('span');
    title.textContent = 'Map';
    title.style.flex = '1';
    title.style.fontWeight = 'bold';

    const floorSelect = document.createElement('select');
    floorSelect.style.font = '11px sans-serif';
    floorSelect.style.maxWidth = '120px';
    floorSelect.addEventListener('change', () => {
      state.floor = Number(floorSelect.value);
      state.autoCenter = false;
      state.autoFloor = false;
      saveView();
      render();
    });

    const btn = (label, tip) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = tip || '';
      Object.assign(b.style, {
        background: '#3a3a42', color: '#eee', border: '1px solid #555', borderRadius: '4px',
        cursor: 'pointer', font: '11px sans-serif', padding: '2px 6px'
      });
      return b;
    };

    // Both of these measure the SVG's live size. Reading clientWidth forces layout, so
    // they are safe to run synchronously — deferring a frame would only make them
    // silently do nothing while the tab is in the background.
    const recenterBtn = btn('⌖', 'Recenter on current room');
    recenterBtn.addEventListener('click', () => {
      state.autoCenter = true;
      state.autoFloor = true;
      state.scale = 1;
      centerOnCurrent();
      render();
    });

    const fitBtn = btn('⛶', 'Fit the whole of this floor in view');
    fitBtn.addEventListener('click', () => { fitFloor(); render(); });

    // Put the panel back where it starts: top-right corner, default size, default zoom.
    const dockBtn = btn('⇱', 'Dock to the top-right corner at the default size');
    dockBtn.addEventListener('click', () => dockTopRight());

    function dockTopRight() {
      menu.style.display = 'none';
      autoCollapsed = false;
      setCollapsed(false);
      root.style.width = `${initW}px`;
      root.style.height = `${initH}px`;
      root.style.left = `${Math.max(margin, window.innerWidth - initW - margin)}px`;
      root.style.top = `${margin}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      root.style.resize = 'both';
      state.scale = 1;
      state.autoCenter = true;
      state.autoFloor = true;
      centerOnCurrent();
      render();
    }

    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = 'application/json';
    importInput.style.display = 'none';
    importInput.addEventListener('change', () => {
      const file = importInput.files[0];
      if (file) importMap(file);
      importInput.value = '';
    });

    function clearEstimated() {
      const n = Object.values(rooms).filter((r) => r.placement === 'reckoned').length;
      if (!n) { alert('No estimated-position rooms to clear — everything is anchored to the real grid.'); return; }
      if (confirm(`Discard ${n} room(s) whose position is only estimated? Confirmed rooms are kept. This cannot be undone.`)) {
        Object.keys(rooms).forEach((k) => { if (rooms[k].placement === 'reckoned') delete rooms[k]; });
        rebuildIndexes();
        flushRooms();
        render();
      }
    }

    function clearAll() {
      if (confirm('Clear all saved map data? This cannot be undone.')) {
        rooms = {}; transitEdges = {}; currentKey = null; state.floor = null;
        rebuildIndexes();
        flushRooms(); saveTransit(); saveView();
        render();
      }
    }

    // Seven buttons already filled a 340px header; docking would have pushed the
    // collapse control off the edge, so the occasional actions moved into a menu.
    const menuBtn = btn('⋯', 'More actions');
    const menu = document.createElement('div');
    Object.assign(menu.style, {
      position: 'absolute', top: '30px', right: '6px', zIndex: '2',
      background: '#23232a', border: '1px solid #555', borderRadius: '6px',
      boxShadow: '0 6px 18px rgba(0,0,0,0.6)', padding: '4px', display: 'none'
    });
    const menuItem = (label, fn) => {
      const it = document.createElement('div');
      it.textContent = label;
      Object.assign(it.style, {
        padding: '5px 8px', borderRadius: '4px', cursor: 'pointer',
        font: '11px sans-serif', color: '#eee', whiteSpace: 'nowrap'
      });
      it.addEventListener('mouseenter', () => { it.style.background = '#3a3a42'; });
      it.addEventListener('mouseleave', () => { it.style.background = 'transparent'; });
      it.addEventListener('click', () => { menu.style.display = 'none'; fn(); });
      menu.appendChild(it);
      return it;
    };
    menuItem('Export map JSON', exportMap);
    menuItem('Import map JSON…', () => importInput.click());
    menuItem('Autosaves…', () => openAutosavePanel());
    menuItem('Discard estimated-position rooms', clearEstimated);
    menuItem('Clear saved map', clearAll);
    const autoMinItem = menuItem('', () => {
      state.autoMinimize = !state.autoMinimize;
      saveView();
      syncAutoMinLabel();
      if (!state.autoMinimize && autoCollapsed) { setCollapsed(false); autoCollapsed = false; }
      else if (state.autoMinimize) scheduleWindowCheck();
    });
    function syncAutoMinLabel() {
      autoMinItem.textContent =
        (state.autoMinimize ? '✓ ' : ' ') + 'Minimise while a game window is open';
    }
    syncAutoMinLabel();

    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });
    window.addEventListener('mousedown', (e) => {
      if (menu.style.display !== 'none' && !menu.contains(e.target) && e.target !== menuBtn) {
        menu.style.display = 'none';
      }
    });

    // Autosaves panel: the rolling history, with a way to write any snapshot to disk
    // or roll the live map back to it.
    const autoPanel = document.createElement('div');
    Object.assign(autoPanel.style, {
      position: 'absolute', top: '30px', right: '6px', left: '6px', zIndex: '3',
      background: '#23232a', border: '1px solid #555', borderRadius: '6px',
      boxShadow: '0 6px 18px rgba(0,0,0,0.6)', padding: '8px', display: 'none',
      font: '11px sans-serif', color: '#eee', maxHeight: '75%', overflowY: 'auto'
    });

    const panelRow = () => {
      const d = document.createElement('div');
      Object.assign(d.style, { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0' });
      return d;
    };

    async function openAutosavePanel() {
      menu.style.display = 'none';
      autoPanel.style.display = 'block';
      autoPanel.textContent = 'Loading…';
      try {
        renderAutosaves(await autosaveAll());
      } catch (e) {
        autoPanel.textContent = '';
        const msg = document.createElement('div');
        msg.textContent = 'Autosaves unavailable: ' + (e && e.message);
        msg.style.color = '#e8a530';
        const close = btn('Close', '');
        close.addEventListener('click', () => { autoPanel.style.display = 'none'; });
        autoPanel.append(msg, close);
      }
    }

    function renderAutosaves(list) {
      autoPanel.textContent = '';
      const head = document.createElement('div');
      head.textContent = `Autosaves — newest ${AUTOSAVE_KEEP} kept, one every ${AUTOSAVE_INTERVAL_MS / 60000} min`;
      Object.assign(head.style, { fontWeight: 'bold', marginBottom: '4px' });
      autoPanel.appendChild(head);

      if (!list.length) {
        const none = document.createElement('div');
        none.textContent = 'No snapshots yet — the first is taken half an hour after the map loads.';
        none.style.color = '#aaa';
        autoPanel.appendChild(none);
      }

      list.forEach((e) => {
        const row = panelRow();
        const when = document.createElement('span');
        when.textContent = `${new Date(e.savedAt).toLocaleString()} · ${e.roomCount} rooms`;
        when.style.flex = '1';
        when.style.whiteSpace = 'nowrap';

        const dl = btn('⤓', 'Save this snapshot to your downloads');
        dl.addEventListener('click', async () => {
          const full = await autosaveGet(e.savedAt);
          if (full) downloadJSON(full.bundle, `PbnMapper-autosave-${autosaveStamp(e.savedAt)}.json`);
        });

        const restore = btn('⟲', 'Replace the current map with this snapshot');
        restore.addEventListener('click', async () => {
          if (!confirm(`Replace the current map (${Object.keys(rooms).length} rooms) with this `
            + `snapshot (${e.roomCount} rooms)? This cannot be undone.`)) return;
          const full = await autosaveGet(e.savedAt);
          if (!full) return;
          rooms = migrateAll(full.bundle.rooms || {});
          transitEdges = migrateTransit(full.bundle.transitEdges || {});
          currentKey = null;
          rebuildIndexes();
          anchorFloatingIslands();
          rebuildIndexes();
          flushRooms();
          saveTransit();
          autoPanel.style.display = 'none';
          render();
        });

        row.append(when, dl, restore);
        autoPanel.appendChild(row);
      });

      const actions = panelRow();
      const snapNow = btn('Snapshot now', 'Take an autosave immediately');
      snapNow.addEventListener('click', async () => { await autosaveNow('manual'); openAutosavePanel(); });
      const close = btn('Close', '');
      close.addEventListener('click', () => { autoPanel.style.display = 'none'; });
      actions.append(snapNow, close);
      autoPanel.appendChild(actions);
    }

    const collapseBtn = btn('_', 'Collapse/expand');
    let expandedHeight = root.style.height;
    let expandedWidth = root.style.width;
    function setCollapsed(next) {
      if (next === state.collapsed) return;
      state.collapsed = next;
      if (next) {
        expandedHeight = root.style.height;
        expandedWidth = root.style.width;
        body.style.display = 'none';
        root.style.height = 'auto';
        root.style.resize = 'none';
      } else {
        body.style.display = 'block';
        root.style.height = expandedHeight;
        root.style.width = expandedWidth;
        root.style.resize = 'both';
      }
    }
    collapseBtn.addEventListener('click', () => {
      autoCollapsed = false;   // a deliberate toggle takes the panel off auto-control
      setCollapsed(!state.collapsed);
    });
    ui.setCollapsed = setCollapsed;

    header.append(title, floorSelect, recenterBtn, fitBtn, dockBtn, menuBtn, importInput, collapseBtn);

    const body = document.createElement('div');
    body.style.flex = '1';
    body.style.position = 'relative';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.display = 'block';
    svg.style.cursor = 'grab';
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    svg.appendChild(g);
    body.appendChild(svg);

    const roomLabel = document.createElement('div');
    Object.assign(roomLabel.style, {
      position: 'absolute', bottom: '4px', left: '6px', right: '6px',
      fontSize: '11px', color: '#ccc', pointerEvents: 'none', textShadow: '0 0 4px #000'
    });
    body.appendChild(roomLabel);

    root.append(header, body, menu, autoPanel);
    document.body.appendChild(root);

    ui.g = g; ui.svg = svg; ui.select = floorSelect; ui.label = roomLabel;

    makeDraggable(root, header);
    makePannable(svg, body);
    new ResizeObserver(() => { clampPanelToViewport(root); render(); }).observe(root);
    window.addEventListener('resize', () => { clampPanelToViewport(root); render(); });
    window.addEventListener('beforeunload', flushRooms);
    installGameWindowWatcher();
    setInterval(() => { autosaveNow('every 30 min'); }, AUTOSAVE_INTERVAL_MS);

    listeners.push(() => {
      const labels = computeFloorLabels();
      renderFloorOptions(floorSelect, labels);
      renderSvg(g, labels);
      const cur = currentKey ? rooms[currentKey] : null;
      roomLabel.textContent = cur ? (cur.name || cur.key) : '';
    });

    render();
  }

  function floorsInUse() {
    const zs = new Set();
    Object.values(rooms).forEach((r) => { if (isPlaced(r)) zs.add(r.z); });
    return [...zs].sort((a, b) => b - a);   // highest first, matching how floors stack
  }

  function renderFloorOptions(select, labels) {
    const cur = currentKey ? rooms[currentKey] : null;
    // Riding a train would otherwise yank the view onto the vehicle's private floor.
    if (cur && state.autoFloor && isPlaced(cur) && !cur.isVehicle) state.floor = cur.z;

    const floors = floorsInUse();
    if (state.floor === null || !floors.includes(state.floor)) {
      state.floor = floors.includes(0) ? 0 : (floors.length ? floors[0] : null);
    }

    const want = floors.map((z) => `${z} ${floorLabel(z, labels)}`).join('');
    if (select.dataset.built !== want) {
      select.textContent = '';
      floors.forEach((z) => {
        const opt = document.createElement('option');
        opt.value = String(z);
        opt.textContent = floorLabel(z, labels);
        select.appendChild(opt);
      });
      select.dataset.built = want;
    }
    if (state.floor !== null) select.value = String(state.floor);
  }

  // Zoom and pan so the whole of the displayed floor fits in the panel.
  function fitFloor() {
    const vis = Object.values(rooms).filter((r) => isPlaced(r) && r.z === state.floor);
    if (!vis.length || !ui.svg) return;
    const xs = vis.map((r) => r.x), ys = vis.map((r) => r.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = (maxX - minX) * CELL + 40, h = (maxY - minY) * CELL + 40;
    state.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE,
      Math.min(ui.svg.clientWidth / w, ui.svg.clientHeight / h)));
    state.autoCenter = false;
    state.panX = -((minX + maxX) / 2) * CELL * state.scale;
    state.panY = ((minY + maxY) / 2) * CELL * state.scale;
  }

  function centerOnCurrent() {
    const cur = currentKey ? rooms[currentKey] : null;
    if (!isPlaced(cur) || cur.z !== state.floor) return;
    state.panX = -cur.x * CELL;
    state.panY = cur.y * CELL;
  }

  // Pan and zoom only move the viewport, so they update the group transform in place.
  // Rebuilding the scene on every mousemove is what made dragging feel sticky.
  function applyTransform() {
    if (!ui.g || !ui.svg) return;
    const cx = ui.svg.clientWidth / 2, cy = ui.svg.clientHeight / 2;
    ui.g.setAttribute('transform', `translate(${cx + state.panX} ${cy + state.panY}) scale(${state.scale})`);
  }

  const svgEl = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  };
  const titled = (el, text) => {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    t.textContent = text;
    el.appendChild(t);
    return el;
  };

  // Where an exit leads, preferring the server's own target id over compass arithmetic.
  // Returns null when the exit is vertical or leads somewhere we cannot draw.
  function exitTarget(r, e) {
    if (e.targetRoomId != null) {
      const t = rooms[idToKey[e.targetRoomId]];
      if (isPlaced(t)) return { x: t.x, y: t.y, z: t.z, known: true };
    }
    const off = DIR[e.direction];
    if (!off) return null;
    return { x: r.x + off[0], y: r.y + off[1], z: r.z + off[2], known: false };
  }

  function renderSvg(g, labels) {
    while (g.firstChild) g.removeChild(g.firstChild);
    if (state.autoCenter) centerOnCurrent();
    applyTransform();

    const floor = state.floor;
    if (floor === null) return;
    const visible = Object.values(rooms).filter((r) => isPlaced(r) && r.z === floor);

    visible.filter((r) => r.visited && !r.isVehicle).forEach((r) => {
      (r.exits || []).forEach((e) => {
        const t = exitTarget(r, e);
        if (!t || t.z !== floor) return;                      // vertical links show as markers
        const danger = e.locked || e.broken;
        // An exit whose destination we have never seen gets a short stub, so it reads as
        // "unexplored this way" instead of asserting a room sits there.
        const f = t.known ? 1 : 0.45;
        const line = svgEl('line', {
          x1: r.x * CELL, y1: -r.y * CELL,
          x2: (r.x + (t.x - r.x) * f) * CELL, y2: -(r.y + (t.y - r.y) * f) * CELL,
          stroke: danger ? '#c0392b' : (t.known ? '#888' : '#5a5a5a'),
          'stroke-width': 2
        });
        if (danger) line.setAttribute('stroke-dasharray', '3,3');
        g.appendChild(line);
      });
    });

    // Transit connectors: straight lines between stations on the same line, learned from
    // ride announcements. Stations on one line can sit on different floors (elevated in
    // Kensington, underground in University City), so resolve across all floors and show
    // a badge when the far end is elsewhere.
    const byName = {};
    Object.values(rooms).forEach((r) => {
      if (!r.visited || !isPlaced(r) || !r.name) return;
      if (!byName[r.name] || (byName[r.name].z !== floor && r.z === floor)) byName[r.name] = r;
    });
    Object.entries(transitEdges).forEach(([line, edges]) => {
      const color = lineColor(line);
      edges.forEach(([a, b]) => {
        const ra = byName[a], rb = byName[b];
        if (!ra || !rb) return;
        const onA = ra.z === floor, onB = rb.z === floor;
        if (onA && onB) {
          g.appendChild(titled(svgEl('line', {
            x1: ra.x * CELL, y1: -ra.y * CELL, x2: rb.x * CELL, y2: -rb.y * CELL,
            stroke: color, 'stroke-width': 2.5, 'stroke-dasharray': '1,4', 'stroke-linecap': 'round'
          }), line));
        } else if (onA || onB) {
          const here = onA ? ra : rb, other = onA ? rb : ra;
          g.appendChild(titled(svgEl('circle', {
            cx: here.x * CELL + 10, cy: -here.y * CELL - 10, r: 4,
            fill: color, stroke: '#fff', 'stroke-width': 1
          }), `${line} continues on ${floorLabel(other.z, labels)} (at "${other.name}")`));
        }
      });
    });

    const size = 16;
    visible.forEach((r) => {
      const isCurrent = r.key === currentKey;
      const hasUp = (r.exits || []).some((e) => e.direction === 'up');
      const hasDown = (r.exits || []).some((e) => e.direction === 'down');
      // Stairs, lifts and manholes are the only way between floors, so they are worth
      // spotting at a glance — the ▲/▼ glyphs alone are easy to miss at low zoom.
      // A room you can pass straight through vertically is a different thing from a
      // dead-end landing, so the two get their own shades of the same cyan family.
      const vert = r.visited && !r.isVehicle && (hasUp || hasDown);
      const vertBoth = vert && hasUp && hasDown;
      const vertOne = vert && !vertBoth;
      // Havens outrank stairs for the fill, being both rarer and the thing you actually
      // go looking for. A haven that is also a stairwell keeps its cyan outline, so
      // neither fact is lost.
      const havenClaimed = r.visited && !!r.isHaven;
      const havenOpen = r.visited && !r.isHaven && !!r.havenClaimable;
      const shape = r.isVehicle
        ? svgEl('circle', { cx: r.x * CELL, cy: -r.y * CELL, r: size / 2 })
        : svgEl('rect', {
          x: r.x * CELL - size / 2, y: -r.y * CELL - size / 2,
          width: size, height: size, rx: 3
        });
      if (isCurrent) {
        shape.setAttribute('fill', r.isVehicle ? '#2fbfae' : '#e8c547');
        shape.setAttribute('stroke', '#fff');
        shape.setAttribute('stroke-width', '2');
      } else if (r.visited) {
        // Fill says what the room IS: dark orange = a claimed haven, light orange = a
        // haven site still going spare, bright cyan = through-route up and down, dark
        // cyan = one way only. The cyans are bluer than the vehicle teal, and vehicles
        // are circles too, which settles any doubt.
        shape.setAttribute('fill',
          r.isVehicle ? '#1d7c72'
            : havenClaimed ? '#a85416'
              : havenOpen ? '#f0a34a'
                : vertBoth ? '#2fb3d9'
                  : vertOne ? '#1b6178'
                    : '#3d6fa5');
        shape.setAttribute('stroke',
          r.isVehicle ? '#4ecdc4'
            : vertBoth ? '#b8f0ff'
              : vertOne ? '#5fc8e6'
                : havenClaimed ? '#e08a45'
                  : havenOpen ? '#ffd7a3'
                    : '#7fa8d9');
        shape.setAttribute('stroke-width', (vert || havenClaimed || havenOpen) ? '1.5' : '1');
      } else {
        shape.setAttribute('fill', 'none');
        shape.setAttribute('stroke', '#666');
        shape.setAttribute('stroke-width', '1');
        shape.setAttribute('stroke-dasharray', '2,2');
      }
      if (r.positionUncertain) shape.setAttribute('stroke-dasharray', '2,2');
      titled(shape, buildTooltip(r, labels));
      shape.style.cursor = 'context-menu';
      shape.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (confirm(`Delete "${r.name || r.key}" from the map? This cannot be undone.`)) {
          delete rooms[r.key];
          if (currentKey === r.key) currentKey = null;
          rebuildIndexes();
          flushRooms();
          render();
        }
      });
      g.appendChild(shape);

      if (!r.isVehicle && (havenClaimed || havenOpen)) {
        // Drawn outside the square so it survives the current-room highlight painting
        // the fill yellow — otherwise standing in a haven hides the fact that it is one.
        const pad = 3;
        const haven = svgEl('rect', {
          x: r.x * CELL - size / 2 - pad, y: -r.y * CELL - size / 2 - pad,
          width: size + pad * 2, height: size + pad * 2, rx: 4, fill: 'none',
          stroke: '#ff9b30', 'stroke-width': 1.5
        });
        // Dashed means "not yours to walk into": unclaimed, or claimed but locked.
        if (havenOpen || r.havenIsLocked) haven.setAttribute('stroke-dasharray', '3,2');
        g.appendChild(haven);
      }

      if (r.visited && !r.isVehicle) {
        if (hasUp) g.appendChild(makeVertMarker(r.x * CELL, -r.y * CELL - size / 2 - 3, '▲'));
        if (hasDown) g.appendChild(makeVertMarker(r.x * CELL, -r.y * CELL + size / 2 + 3, '▼'));

        // Exits we can neither draw a line for nor mark as vertical: the destination has
        // never been visited and the direction ("passage 1") carries no compass bearing,
        // so there is no honest way to point at it. Without this the sewer's four-way
        // junctions look like dead ends. Show the count instead of inventing a heading.
        const undrawable = (r.exits || []).filter((e) =>
          e.direction !== 'up' && e.direction !== 'down' && !exitTarget(r, e)).length;
        if (undrawable) {
          const badge = svgEl('text', {
            x: r.x * CELL + size / 2 + 2, y: -r.y * CELL + size / 2 + 2,
            'text-anchor': 'middle', 'dominant-baseline': 'middle',
            'font-size': 9, fill: '#e8a530', 'font-weight': 'bold'
          });
          badge.textContent = String(undrawable);
          titled(badge, `${undrawable} unexplored exit${undrawable > 1 ? 's' : ''}`);
          g.appendChild(badge);
        }
      }
    });
  }

  function lineColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
    return `hsl(${Math.abs(hash) % 360}, 70%, 55%)`;
  }

  function buildTooltip(r, labels) {
    if (!r.visited) return (r.name || '(unknown)') + '\n(not yet visited)';
    if (r.isVehicle) return `${r.name}\n(in transit — not a fixed location)`;
    const lines = [r.name];
    const bits = [];
    if (r.primaryTag) bits.push(cap(r.primaryTag));
    const inOut = r.indoor ? 'Indoor' : 'Outdoor';
    if (cap(r.primaryTag || '') !== inOut) bits.push(inOut);   // "Indoor · Indoor" reads badly
    if (r.exposureTier) bits.push(cap(r.exposureTier));
    lines.push(bits.join(' · '));
    if (r.features && r.features.length) lines.push('Features: ' + r.features.join(', '));
    if (r.isHaven) {
      lines.push('Haven — claimed' + (r.havenIsLocked ? ', locked' : ', unlocked') +
        (r.havenOwnerId != null ? ` (owner #${r.havenOwnerId})` : ''));
    } else if (r.havenClaimable) lines.push('Haven — unclaimed, can be claimed');
    if (r.neighborhood) {
      lines.push(r.neighborhood.name + (r.neighborhood.sect ? ` — ${cap(r.neighborhood.sect)}` : ''));
    }
    const verticals = (r.exits || [])
      .filter((e) => e.direction === 'up' || e.direction === 'down')
      .sort((a, b) => (a.direction === 'up' ? -1 : 1));   // read "Up · Down", never "Down · Up"
    if (verticals.length) {
      lines.push(verticals.map((e) => {
        const t = rooms[idToKey[e.targetRoomId]];
        return cap(e.direction) + (isPlaced(t) ? ` to ${floorLabel(t.z, labels)}` : '');
      }).join(' · '));
    }
    const unexplored = (r.exits || []).filter((e) =>
      e.targetRoomId != null && !isPlaced(rooms[idToKey[e.targetRoomId]]));
    if (unexplored.length) lines.push('Unexplored: ' + unexplored.map((e) => e.direction).join(', '));
    lines.push(`${r.x}, ${r.y} · ${floorLabel(r.z, labels)}`);
    if (r.positionUncertain) lines.push('(position unknown — parked clear of the map)');
    else if (r.placement === 'reckoned') lines.push('(position estimated from travel path)');
    else if (r.placement === 'anchored') lines.push('(position derived from an adjacent room)');
    return lines.join('\n');
  }

  function makeVertMarker(cx, cy, glyph) {
    const t = svgEl('text', {
      x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
      'font-size': 9, fill: '#e8a530'
    });
    t.textContent = glyph;
    return t;
  }

  // Keeps the panel's header reachable and its box within the viewport, whether it got
  // there by dragging, native resize, or the window itself changing size.
  function clampPanelToViewport(root) {
    const rect = root.getBoundingClientRect();
    const minVisible = 60;
    const headerH = 30;

    let left = rect.left;
    let top = Math.min(Math.max(rect.top, 0), Math.max(0, window.innerHeight - headerH));
    left = Math.min(Math.max(left, minVisible - rect.width), window.innerWidth - minVisible);
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';

    const maxWidth = window.innerWidth - left - 4;
    const maxHeight = window.innerHeight - top - 4;
    if (rect.width > maxWidth) root.style.width = `${Math.max(220, maxWidth)}px`;
    if (rect.height > maxHeight) root.style.height = `${Math.max(160, maxHeight)}px`;
  }

  function makeDraggable(root, handle) {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target !== handle && e.target.tagName !== 'SPAN') return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const rect = root.getBoundingClientRect();
      ox = rect.left; oy = rect.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      root.style.left = `${ox + (e.clientX - sx)}px`;
      root.style.top = `${oy + (e.clientY - sy)}px`;
      root.style.right = 'auto'; root.style.bottom = 'auto';
      clampPanelToViewport(root);
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  function makePannable(svg, body) {
    let dragging = false, moved = false, sx = 0, sy = 0, startPanX = 0, startPanY = 0;
    svg.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;   // left button only, so right-click-to-delete does not pan
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      startPanX = state.panX; startPanY = state.panY;
      svg.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      // Don't drop auto-centring for a stray click that never actually dragged.
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      moved = true;
      state.autoCenter = false;
      state.panX = startPanX + dx;
      state.panY = startPanY + dy;
      applyTransform();
    });
    window.addEventListener('mouseup', () => { dragging = false; svg.style.cursor = 'grab'; });
    body.addEventListener('wheel', (e) => {
      e.preventDefault();
      state.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale * (e.deltaY < 0 ? 1.1 : 0.9)));
      applyTransform();
    }, { passive: false });
  }

  // ------------------------------------------------------------ import/export

  function exportMap() {
    flushRooms();
    downloadJSON(mapBundle(), 'pbn-map.json');
  }

  function mergeRoom(existing, incoming) {
    if (!existing) return incoming;
    if (incoming.visited && !existing.visited) return incoming;
    if (existing.visited && !incoming.visited) return existing;
    return (incoming.lastSeen || 0) >= (existing.lastSeen || 0) ? incoming : existing;
  }

  function importMap(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(reader.result); }
      catch (e) { alert('Import failed: not valid JSON.'); return; }

      const incomingRooms = migrateAll(data.rooms || data);   // older raw exports too
      const incomingTransit = migrateTransit(data.transitEdges || {});

      let addedRooms = 0;
      Object.entries(incomingRooms).forEach(([key, incoming]) => {
        const merged = mergeRoom(rooms[key], incoming);
        if (merged !== rooms[key]) addedRooms++;
        rooms[key] = merged;
      });

      let addedEdges = 0;
      Object.entries(incomingTransit).forEach(([line, edges]) => {
        edges.forEach(([a, b]) => { if (addTransitEdge(line, a, b)) addedEdges++; });
      });

      rebuildIndexes();
      anchorFloatingIslands();
      rebuildIndexes();
      flushRooms();
      render();
      alert(`Import complete: ${addedRooms} room(s) added/updated, ${addedEdges} transit link(s) added.`);
    };
    reader.readAsText(file);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectUI);
  } else {
    injectUI();
  }
})();
