"""
salience_pass.py — the lazy LLM pass that fills in each tile's "salience" field.

WHY
---
build_tiles.py picks "toward X" for every junction branch with a fixed formula
(station beats hospital beats cafe). A local would sometimes choose differently:
the small temple everyone navigates by, the market rather than the school next to
it, the neighbourhood name when nothing on the road is famous. This script shows
Claude one tile at a time — its junction branches and its landmarks — and asks it
to choose, per branch, what a local would say. The answer is written back into
the tile's "salience" field, so every later fetch of that tile gets the smarter
version for free and the phone never talks to an LLM.

WHAT GETS WRITTEN  (tile["salience"])
-------------------------------------
  {
    "model":   "claude-opus-5",
    "created": "2026-09-07T12:00:00Z",
    "junctions": { "<node_id>": { "name": "Mandi House Chowk" | null,
                                  "branches": { "<to_node_id>": "toward text" | null } } },
    "top_landmarks": [ "Sacred Heart Cathedral", ... ]     # what this area is known for
  }
The phone prefers salience.junctions[n].branches[to] when present, otherwise the
precomputed branch "dest". Missing fields fall through, so a partial answer is fine.

RUN
---
  export ANTHROPIC_API_KEY=...
  python salience_pass.py tiles/14/11707/6831.json              # one tile, in place
  python salience_pass.py --all tiles --limit 20                # first 20 tiles lacking salience
  python salience_pass.py tiles/14/11707/6831.json --dry-run    # print the prompt, call nothing
  python salience_pass.py tiles/14/11707/6831.json --mock       # write a fake answer (tests the plumbing)

After running, re-upload the changed tiles (upload_r2.sh does a sync, so only changed
files move). To run this "lazily on first request" instead of up front, call
`enrich_tile(path)` from whatever serves the tile; the function is the whole API.
"""

import argparse
import datetime as dt
import glob
import json
import os
import sys
from typing import Dict, List, Optional

from pydantic import BaseModel

MODEL = "claude-opus-5"

SYSTEM = """You help a walking/driving narrator sound like a local.

You are given one map tile from central Delhi (or wherever the coordinates say): its
junctions, the roads leaving each junction, the destination the current formula picked
for each road, and every named landmark and neighbourhood in the tile with its class
and a rough salience score.

For each junction branch, choose the single best "toward X" a local would say when
giving directions down that road. Prefer, in order: a place nearly everyone in the
city knows; a place people in that neighbourhood navigate by (a market, a temple, a
metro station, a chowk); the neighbourhood name itself; otherwise null. Keep the
current pick when it is already what a local would say. Never invent a place that is
not in the list. Use the exact name as listed. Prefer short names people actually use
(the "short" hint when given).

Also name the junction itself if it is a well-known chowk/circle and its name is
missing but obvious from the landmarks (e.g. a metro station at the junction), else
null. Finally list up to five landmarks this tile is best known for, most famous first."""


class Branch(BaseModel):
    to: int
    dest: Optional[str]


class Junction(BaseModel):
    id: int
    name: Optional[str]
    branches: List[Branch]


class Salience(BaseModel):
    junctions: List[Junction]
    top_landmarks: List[str]


def compass(b):
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][int(((b % 360) + 22.5) // 45) % 8]


def neighbour_landmarks(path):
    """Landmarks from the eight surrounding tiles, when those files exist next to this one.
    A branch's destination is often just over the tile edge."""
    try:
        d, name = os.path.split(path)
        xdir, xs = os.path.split(d)
        x, y = int(xs), int(os.path.splitext(name)[0])
    except ValueError:
        return []
    out = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            if dx == dy == 0:
                continue
            p = os.path.join(xdir, str(x + dx), f"{y + dy}.json")
            if os.path.exists(p):
                with open(p) as f:
                    out += json.load(f)["landmarks"]
    return out


def describe_tile(tile, path):
    """Compact plain-text description of the tile for the prompt."""
    lines = [f"Tile {path}", ""]
    lms = sorted(tile["landmarks"], key=lambda l: -l["score"])
    lines.append(f"LANDMARKS IN THIS TILE ({len(lms)}):")
    for l in lms:
        wd = "  wikidata" if l.get("wikidata") else ""
        lines.append(f"  - {l['name']}  [{l['class']}, score {l['score']}{wd}]")
    near = sorted(neighbour_landmarks(path), key=lambda l: -l["score"])[:40]
    if near:
        lines.append("")
        lines.append(f"LANDMARKS IN NEIGHBOURING TILES (top {len(near)}):")
        for l in near:
            lines.append(f"  - {l['name']}  [{l['class']}, score {l['score']}]")
    lines.append("")
    js = {k: v for k, v in tile["junctions"].items() if v["kind"] == "junction"}
    lines.append(f"JUNCTIONS ({len(js)}):")
    for nid, j in js.items():
        lines.append(f"  junction {nid}  name={j['name']!r}")
        for b in j["branches"]:
            lines.append(f"    -> to {b['to']}  {compass(b['bearing'])}  road={b['road']!r}  current_dest={b['dest']!r}")
    return "\n".join(lines)


def ask_claude(text):
    import anthropic
    client = anthropic.Anthropic()
    resp = client.messages.parse(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM,
        messages=[{"role": "user", "content": text}],
        output_format=Salience,
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError(f"model refused: {resp.stop_details}")
    return resp.parsed_output


def mock_answer(tile):
    """Echo the formula's picks — exercises the write path without an API call."""
    js = [Junction(id=int(n), name=j["name"],
                   branches=[Branch(to=b["to"], dest=b["dest"]) for b in j["branches"]])
          for n, j in tile["junctions"].items() if j["kind"] == "junction"]
    top = [l["name"] for l in sorted(tile["landmarks"], key=lambda l: -l["score"])[:5]]
    return Salience(junctions=js, top_landmarks=top)


def to_field(ans: Salience, model):
    return {
        "model": model,
        "created": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "junctions": {str(j.id): {"name": j.name, "branches": {str(b.to): b.dest for b in j.branches}}
                      for j in ans.junctions},
        "top_landmarks": ans.top_landmarks,
    }


def enrich_tile(path, dry_run=False, mock=False, force=False):
    """Fill in tile[\"salience\"] at `path`. Returns True if the file was written."""
    with open(path) as f:
        tile = json.load(f)
    if tile.get("salience") and not force:
        return False
    if not any(j["kind"] == "junction" for j in tile["junctions"].values()):
        return False  # nothing to decide
    text = describe_tile(tile, path)
    if dry_run:
        print(text)
        return False
    ans = mock_answer(tile) if mock else ask_claude(text)
    tile["salience"] = to_field(ans, "mock" if mock else MODEL)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(tile, f, separators=(",", ":"))
    os.replace(tmp, path)
    return True


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("tiles", nargs="*", help="tile .json files")
    ap.add_argument("--all", metavar="DIR", help="every tile under DIR that lacks salience")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--force", action="store_true", help="redo tiles that already have salience")
    a = ap.parse_args()

    paths = list(a.tiles)
    if a.all:
        paths += sorted(glob.glob(os.path.join(a.all, "*", "*", "*.json")))
    if not paths:
        sys.exit("give tile paths or --all DIR")
    done = 0
    for p in paths:
        if a.limit and done >= a.limit:
            break
        if enrich_tile(p, a.dry_run, a.mock, a.force):
            done += 1
            print(f"wrote salience -> {p}")
    print(f"{done} tiles updated")
