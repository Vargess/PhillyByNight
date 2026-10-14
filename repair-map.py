"""Repair a PbN Mapper export produced by script versions before 3.0.0.

Mirrors the migration + anchoring that PbN-Mapper.user.js now performs on load, so a
file run through this is byte-for-byte what the script itself would produce.

What it fixes:
  * Rooms the server addresses only by numeric id ("sewer-160") were laid out by dead
    reckoning on synthetic floors (z = -1478, -1654, ...). Their real grid cells are
    recoverable from neighbouring grid rooms' exits, which carry targetRoomId. Each
    floating island is shifted onto the real grid by a single offset and re-keyed.
  * Duplicate records for the same room -- one dead-reckoned, one an unvisited
    placeholder sitting at the real cell -- are merged.
  * Transit edges bucketed under a catch-all "Transit" line are re-derived per edge.

Usage:  python repair-map.py <input.json> [-o <output.json>]
"""

import argparse
import collections
import json
import re
import sys

SCHEMA_VERSION = 3
VEHICLE_Z_THRESHOLD = -50
RELATIVE_Z_BASE = -1000
UNKNOWN_LINE = "Unknown line"

GRID_KEY_RE = re.compile(r"^-?\d+,-?\d+,-?\d+$")
ID_KEY_RE = re.compile(r"^([A-Za-z][A-Za-z_]*)-(\d+)$")

DIR = {
    "north": (0, 1, 0), "south": (0, -1, 0), "east": (1, 0, 0), "west": (-1, 0, 0),
    "northeast": (1, 1, 0), "northwest": (-1, 1, 0),
    "southeast": (1, -1, 0), "southwest": (-1, -1, 0),
    "up": (0, 0, 1), "down": (0, 0, -1),
}

notes = []


def note(msg):
    notes.append(msg)
    print("  " + msg)


def cap(s):
    return s[0].upper() + s[1:] if s else s


def parse_id_key(key):
    m = ID_KEY_RE.match(key or "")
    return (m.group(1), int(m.group(2))) if m else None


def pseudo_z_for_area(area):
    h = 0
    for ch in area:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
        if h >= 2 ** 31:
            h -= 2 ** 32
    return RELATIVE_Z_BASE - (abs(h) % 900)


def is_vehicle_at(placement, z):
    return placement in ("grid", "anchored") and z is not None and z <= VEHICLE_Z_THRESHOLD


# ------------------------------------------------------------------- migration

def migrate_room(key, raw):
    r = dict(raw)
    r["key"] = key
    if r.get("id") is None:
        info = parse_id_key(key)
        r["id"] = info[1] if info else None

    if "placement" not in r:
        if GRID_KEY_RE.match(key):
            x, y, z = (int(v) for v in key.split(","))
            r.update(placement="grid", x=x, y=y, z=z)
        elif raw.get("isGrid") is False and raw.get("relX") is not None:
            info = parse_id_key(key)
            prefix = info[0] if info else "area"
            nb = raw.get("neighborhood") or {}
            r.update(
                placement="reckoned",
                x=raw["relX"], y=raw["relY"], z=raw["relZ"],
                islandId=raw.get("islandId") or key,
                area=f"{prefix}::{nb['slug']}" if nb.get("slug") else prefix,
                areaLabel=f"{cap(prefix)} ({nb['name']})" if nb.get("name") else cap(prefix),
            )
        else:
            r.update(placement=None, x=None, y=None, z=None)

    for dead in ("isGrid", "relX", "relY", "relZ"):
        r.pop(dead, None)
    if r["placement"] != "reckoned":
        r["islandId"] = None
        r["positionUncertain"] = False
    r["isVehicle"] = is_vehicle_at(r["placement"], r.get("z"))
    return r


# --------------------------------------------------------------------- indexes

def build_indexes(rooms):
    id_to_key = {r["id"]: k for k, r in rooms.items() if r.get("id") is not None}
    id_to_coord = {}
    for r in rooms.values():
        if r.get("x") is None or r["placement"] == "reckoned":
            continue
        for e in r.get("exits") or []:
            off = DIR.get(e.get("direction"))
            t = e.get("targetRoomId")
            if not off or t is None:
                continue
            c = (r["x"] + off[0], r["y"] + off[1], r["z"] + off[2])
            if t not in id_to_coord:
                id_to_coord[t] = c
            elif id_to_coord[t] is not None and id_to_coord[t] != c:
                note(f"conflicting coordinates for room id {t} -- ignoring both "
                     f"({id_to_coord[t]} vs {c})")
                id_to_coord[t] = None
    return id_to_key, id_to_coord


# ------------------------------------------------------------------- anchoring

def verify_island_links(rooms, moves, moving, id_to_key, id_to_coord):
    """Check the island's links to the *outside* against the proposed offset.

    Those links are independent evidence: they come from exits (often labelled
    "passage 1" rather than a compass point) that played no part in choosing the offset.
    Links within the island prove nothing -- dead reckoning made them adjacent by
    construction -- so they are excluded.
    """
    inside = {m["room"]["id"] for m in moves if m["room"].get("id") is not None}
    ok, bad = 0, []
    for m in moves:
        for e in m["room"].get("exits") or []:
            t = e.get("targetRoomId")
            if t is None or t in inside:
                continue
            c = id_to_coord.get(t)
            if not c:
                tr = rooms.get(id_to_key.get(t))
                if not tr or tr.get("x") is None or tr["key"] in moving:
                    continue
                c = (tr["x"], tr["y"], tr["z"])
            dz = c[2] - m["z"]
            cheb = max(abs(c[0] - m["x"]), abs(c[1] - m["y"]))
            if (dz == 0 and cheb == 1) or (abs(dz) == 1 and cheb == 0):
                ok += 1
            else:
                bad.append(f"{m['room'].get('name')} ({m['new']}) -> room id {t} at {c}")
    return ok, bad


def anchor_islands(rooms):
    """Shift each dead-reckoned island onto the real grid. Returns True if anything moved."""
    id_to_key, id_to_coord = build_indexes(rooms)
    islands = collections.defaultdict(list)
    for r in rooms.values():
        if r["placement"] == "reckoned":
            islands[r["islandId"]].append(r)

    changed = False
    for island_id, members in islands.items():
        offset, anchors, disagreement = None, 0, None
        for r in members:
            c = id_to_coord.get(r["id"]) if r.get("id") is not None else None
            if not c:
                continue
            o = (c[0] - r["x"], c[1] - r["y"], c[2] - r["z"])
            anchors += 1
            if offset is None:
                offset = o
            elif offset != o:
                disagreement = (r["key"], offset, o)
        if offset is None:
            note(f"island {island_id} ({len(members)} rooms) has no anchor -- left estimated")
            continue
        if disagreement:
            note(f"island {island_id} has contradictory anchors {disagreement} -- left estimated")
            continue

        moves = []
        for r in members:
            x, y, z = r["x"] + offset[0], r["y"] + offset[1], r["z"] + offset[2]
            moves.append({"room": r, "old": r["key"], "new": f"{x},{y},{z}", "x": x, "y": y, "z": z})
        moving = {m["old"] for m in moves}

        link_ok, link_bad = verify_island_links(rooms, moves, moving, id_to_key, id_to_coord)
        if link_bad:
            # A single odd link can be genuine (the elevated line spans two cells between
            # Somerset and Huntingdon), so only a majority of broken links condemns it.
            verdict = "rejecting" if len(link_bad) > link_ok else "accepting anyway"
            note(f"island {island_id}: {len(link_bad)} of {len(link_bad) + link_ok} outside links "
                 f"would not be cell-adjacent -- {verdict}")
            for b in link_bad[:5]:
                note("    " + b)
            if len(link_bad) > link_ok:
                continue

        blocked = False
        for m in moves:
            occ = rooms.get(m["new"])
            if not occ or occ["key"] in moving:
                continue
            if occ.get("visited") and occ.get("name") and m["room"].get("name") \
                    and occ["name"] != m["room"]["name"] and occ.get("id") != m["room"].get("id"):
                note(f"refusing to anchor island {island_id}: "
                     f"{m['room']['name']} ({m['old']}) would land on {occ['name']} ({occ['key']})")
                blocked = True
                break
        if blocked:
            continue

        absorbed = 0
        for m in moves:
            rooms.pop(m["old"], None)
        for m in moves:
            displaced = rooms.get(m["new"])
            r = m["room"]
            if displaced is not None:
                absorbed += 1
                if not r.get("name"):
                    r["name"] = displaced.get("name")
            r.update(key=m["new"], x=m["x"], y=m["y"], z=m["z"],
                     placement="anchored", islandId=None, positionUncertain=False)
            r.pop("area", None)
            r.pop("areaLabel", None)
            r["isVehicle"] = is_vehicle_at("anchored", m["z"])
            rooms[m["new"]] = r
        note(f"anchored island {island_id}: {len(moves)} room(s) by offset {offset} "
             f"({anchors} anchor(s), {link_ok} confirming link(s), {absorbed} placeholder(s) absorbed)")
        changed = True
    return changed


# --------------------------------------------------------------------- transit

def normalize_line(raw):
    t = re.sub(r"^SEPTA\s+", "", str(raw), flags=re.I).strip()
    t = re.sub(r"\s*\bEl\b\.?$", " Line", t, flags=re.I).strip()
    if not re.search(r"\bLine$", t, flags=re.I):
        t += " Line"
    return re.sub(r"\s+", " ", t)


def extract_line(station):
    s = str(station or "")
    m = (re.search(r"\[\s*(.+?)\s*\]\s*$", s)
         or re.search(r"\s[—–]\s*(.+?)\s*$", s)
         or re.match(r"^(.+?\bLine)\s*,", s, flags=re.I))
    return normalize_line(m.group(1)) if m else None


def migrate_transit(raw):
    out = {}

    def add(line, a, b):
        out.setdefault(line, [])
        k = tuple(sorted((a, b)))
        if not any(tuple(sorted(e)) == k for e in out[line]):
            out[line].append([a, b])

    unlabelled = []
    for line, edges in (raw or {}).items():
        for edge in edges or []:
            if not isinstance(edge, list) or len(edge) < 2:
                continue
            a, b = edge[0], edge[1]
            resolved = extract_line(a) or extract_line(b)
            if resolved:
                add(resolved, a, b)
            else:
                unlabelled.append((a, b, line))

    for _ in range(8):
        if not unlabelled:
            break
        line_of = {}
        for line, edges in out.items():
            for edge in edges:
                for s in edge:
                    if s not in line_of:
                        line_of[s] = line
                    elif line_of[s] != line:
                        line_of[s] = None      # interchange: lends no line
        progressed = False
        for i in range(len(unlabelled) - 1, -1, -1):
            a, b, _orig = unlabelled[i]
            line = line_of.get(a) or line_of.get(b)
            if not line:
                continue
            add(line, a, b)
            unlabelled.pop(i)
            progressed = True
        if not progressed:
            break

    for a, b, line in unlabelled:
        add(line if line and line != "Transit" else UNKNOWN_LINE, a, b)
    return out


def compute_floor_labels(rooms):
    out = {}
    for r in rooms.values():
        if r["placement"] != "reckoned" or r.get("z") is None or not r.get("areaLabel"):
            continue
        depth = r["z"] - pseudo_z_for_area(r.get("area") or "area")
        out[str(r["z"])] = (f"{r['areaLabel']} (estimated)" if depth == 0
                            else f"{r['areaLabel']} {'+' if depth > 0 else ''}{depth} (estimated)")
    return out


# ------------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("-o", "--output")
    args = ap.parse_args()

    with open(args.input, encoding="utf-8") as fh:
        data = json.load(fh)
    raw_rooms = data.get("rooms", data)
    raw_transit = data.get("transitEdges", {})

    print(f"Loaded {len(raw_rooms)} rooms, "
          f"{sum(len(v) for v in raw_transit.values())} transit edges from {args.input}")

    rooms = {k: migrate_room(k, r) for k, r in raw_rooms.items()
             if isinstance(r, dict)}

    print("\nAnchoring dead-reckoned areas onto the real grid:")
    for _ in range(8):
        if not anchor_islands(rooms):
            break

    print("\nRebuilding transit lines:")
    transit = migrate_transit(raw_transit)
    for line, edges in sorted(transit.items()):
        print(f"  {line}: {len(edges)} edge(s)")

    counts = collections.Counter(r["placement"] or "unplaced" for r in rooms.values())
    zs = collections.Counter(r["z"] for r in rooms.values() if r.get("x") is not None)
    print("\nResult:")
    print(f"  rooms: {len(raw_rooms)} -> {len(rooms)}  ({len(raw_rooms) - len(rooms)} duplicate(s) merged)")
    print(f"  placement: {dict(counts)}")
    print(f"  floors: {dict(sorted(zs.items(), reverse=True))}")
    for r in rooms.values():
        if r["placement"] is None:
            print(f"  unplaced: {r['key']} {r.get('name')!r} "
                  f"(no coordinates recorded; will be placed next time you visit it)")

    out_path = args.output or args.input
    bundle = {
        "schemaVersion": SCHEMA_VERSION,
        "rooms": rooms,
        "transitEdges": transit,
        "floorLabels": compute_floor_labels(rooms),
        "exportedAt": data.get("exportedAt"),
        "repairedBy": "repair-map.py",
    }
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(bundle, fh, indent=2, ensure_ascii=False)
    print(f"\nWrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
