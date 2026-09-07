"""
build_tiles.py — turn an OpenStreetMap extract into small "tiles" the phone can stream.

WHAT A TILE IS
--------------
The world map is cut into a grid of squares. At zoom level 14 each square is roughly
2 km on a side. Every square gets an address (z, x, y) — the same scheme every map app
uses. The phone works out which square it is standing in from its GPS, downloads that
one small file plus the ones around it, and never has to hold a whole city.

WHAT GOES IN A TILE  (tiles/14/{x}/{y}.json)
-------------------------------------------
  nodes     : { node_id: [lat, lon] }              every road vertex in or touching the tile
  edges     : [ [u, v, length_m, road_name, highway_class], ... ]
  junctions : { node_id: { "kind": "junction"|"name_change",
                            "name": "Mandi House" or null,
                            "branches": [ { "to": node_id, "bearing": 0-360,
                                            "road": "Barakhamba Road",
                                            "dest": "Connaught Place" }, ... ] } }
  landmarks : [ { "name", "lat", "lon", "score", "class", "wikidata" }, ... ]
  salience  : null    <- the lazy LLM pass fills this in later, once, per tile

Everything the phone needs to *speak* is already here. It only adds two things at
runtime: its own heading (to turn "bearing 90" into "on your left"), and the trip
counters ("...again").

PIPELINE POSITION
-----------------
  Geofabrik .osm.pbf  --this script-->  tiles/  --upload-->  Cloudflare R2  --range request-->  phone

INPUT
-----
  --input  path to .osm.pbf (needs: pip install osmium) or .osm XML (no extra install)
  --bbox   min_lat,min_lon,max_lat,max_lon   (default: central Delhi)
           Keeps memory small. For all of India, run once per region, or first clip
           the file with the osmium CLI:  osmium extract -b <bbox> india-latest.osm.pbf -o delhi.osm.pbf
  --out    output folder (default ./tiles)

Run:
  python build_tiles.py --input delhi.osm.pbf
  python build_tiles.py --input test.osm --bbox 28.5,77.1,28.7,77.4
"""

import argparse
import json
import math
import os
import sys
from collections import defaultdict

import networkx as nx

# Reuse the geometry, salience and branch-walking logic from the prototype.
from familiarizer import Frame, RoadMap, salience, bearing, PROFILES

ZOOM = 14

# Which OSM "highway" values are roads we narrate on. Footways are included because the
# walking profile needs them; motorways are excluded because there are no junctions to speak of.
ROAD_CLASSES = {
    "primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link",
    "residential", "unclassified", "living_street", "pedestrian", "footway", "path",
    "service", "trunk", "trunk_link",
}

# Which tagged things count as potential landmarks. Mirrors CLASS_WEIGHTS in familiarizer.py.
LANDMARK_KEYS = ("amenity", "tourism", "historic", "leisure", "railway",
                 "public_transport", "natural", "shop", "place")


# ---------------------------------------------------------------------------
# Tile maths (standard web-mercator tile numbering)
# ---------------------------------------------------------------------------
def latlon_to_tile(lat, lon, z=ZOOM):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2.0 * n)
    return x, y


# ---------------------------------------------------------------------------
# Readers — both produce the same three dicts:
#   nodes {id: (lat, lon, tags)}   ways {id: (refs, tags)}
# ---------------------------------------------------------------------------
def in_bbox(lat, lon, bbox):
    return bbox[0] <= lat <= bbox[2] and bbox[1] <= lon <= bbox[3]


def read_osm_xml(path, bbox):
    """Stdlib parser for small .osm files. Good for tests; too slow for a country."""
    import xml.etree.ElementTree as ET
    nodes, ways = {}, {}
    for _, el in ET.iterparse(path, events=("end",)):
        if el.tag == "node":
            lat, lon = float(el.get("lat")), float(el.get("lon"))
            if in_bbox(lat, lon, bbox):
                tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
                nodes[int(el.get("id"))] = (lat, lon, tags)
            el.clear()
        elif el.tag == "way":
            refs = [int(nd.get("ref")) for nd in el.findall("nd")]
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            if any(r in nodes for r in refs):
                ways[int(el.get("id"))] = (refs, tags)
            el.clear()
    return nodes, ways


def read_osm_pbf(path, bbox):
    """
    Streaming reader for .pbf files using pyosmium. PBF files list all nodes first,
    then all ways, so one pass is enough: we keep only nodes inside the bbox and then
    only ways that touch a kept node. Memory stays proportional to the bbox, not to India.
    """
    try:
        import osmium
    except ImportError:
        sys.exit("pip install osmium   (then re-run)")

    nodes, ways = {}, {}

    class H(osmium.SimpleHandler):
        def node(self, n):
            if n.location.valid() and in_bbox(n.location.lat, n.location.lon, bbox):
                tags = {t.k: t.v for t in n.tags}
                nodes[n.id] = (n.location.lat, n.location.lon, tags)

        def way(self, w):
            refs = [nd.ref for nd in w.nodes]
            if any(r in nodes for r in refs):
                ways[w.id] = (refs, {t.k: t.v for t in w.tags})

    H().apply_file(path)
    return nodes, ways


# ---------------------------------------------------------------------------
# Build the road graph + landmark list, exactly the shape familiarizer.RoadMap expects
# ---------------------------------------------------------------------------
def build(nodes, ways, bbox):
    frame = Frame((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)
    G = nx.Graph()
    landmarks = []
    road_class = {}

    for wid, (refs, tags) in ways.items():
        hw = tags.get("highway")
        if hw in ROAD_CLASSES:
            name = tags.get("name")
            refs = [r for r in refs if r in nodes]
            for r in refs:
                if r not in G:
                    lat, lon, _ = nodes[r]
                    G.add_node(r, lat=lat, lon=lon, xy=frame.xy(lat, lon))
            for u, v in zip(refs, refs[1:]):
                if u == v or G.has_edge(u, v):
                    continue
                L = math.dist(G.nodes[u]["xy"], G.nodes[v]["xy"])
                G.add_edge(u, v, name=name, length=L, highway=hw)
                road_class[(u, v)] = hw
            # Named roundabouts / circles carry their name on the way with junction=roundabout
            if tags.get("junction") == "roundabout" and name:
                for r in refs:
                    G.nodes[r]["name"] = name

        elif tags.get("name") and any(k in tags for k in LANDMARK_KEYS):
            # An *area* landmark (park, hospital campus, mall). Centroid + shoelace area.
            pts = [frame.xy(nodes[r][0], nodes[r][1]) for r in refs if r in nodes]
            if len(pts) < 3:
                continue
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            area = 0.5 * abs(sum(pts[i][0] * pts[(i + 1) % len(pts)][1]
                                 - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts))))
            landmarks.append(_landmark(tags, (cx, cy), frame, area))

    # Point landmarks (a node with a name + a landmark tag)
    for nid, (lat, lon, tags) in nodes.items():
        if tags.get("name") and any(k in tags for k in LANDMARK_KEYS):
            landmarks.append(_landmark(tags, frame.xy(lat, lon), frame, 0.0))

    return RoadMap(G, landmarks, frame), road_class


def _landmark(tags, xy, frame, area):
    cls = next((f"{k}={tags[k]}" for k in LANDMARK_KEYS if k in tags), "")
    lat = xy[1] / frame.ky + frame.lat0
    lon = xy[0] / frame.kx + frame.lon0
    return {"name": tags["name"], "xy": xy, "lat": round(lat, 6), "lon": round(lon, 6),
            "score": salience(tags, area), "class": cls,
            "wikidata": tags.get("wikidata")}


# ---------------------------------------------------------------------------
# Precompute junction branches, then slice everything into tiles
# ---------------------------------------------------------------------------
def write_tiles(rm: RoadMap, road_class, out_dir):
    G = rm.G
    prof = PROFILES["walking"]   # branch-walk distance used for "toward X"
    tiles = defaultdict(lambda: {"nodes": {}, "edges": [], "junctions": {}, "landmarks": [], "salience": None})

    def tile_of(n):
        return latlon_to_tile(G.nodes[n]["lat"], G.nodes[n]["lon"])

    # edges: an edge that crosses a tile boundary goes into both tiles
    for u, v, d in G.edges(data=True):
        for t in {tile_of(u), tile_of(v)}:
            T = tiles[t]
            for n in (u, v):
                T["nodes"][n] = [round(G.nodes[n]["lat"], 6), round(G.nodes[n]["lon"], 6)]
            T["edges"].append([u, v, round(d["length"], 1), d.get("name"), d.get("highway")])

    # junctions + their branches (the expensive bit; done once here, never on the phone)
    n_j = 0
    for n in G.nodes:
        kind = rm.is_junction(n)
        if not kind:
            continue
        n_j += 1
        if n_j % 5000 == 0:
            print(f"  ... {n_j} junctions done", flush=True)
        branches = []
        for nbr in G.neighbors(n):
            road, dest = rm.destination_for(n, nbr, prof)
            branches.append({"to": nbr,
                             "bearing": round(bearing(G.nodes[n]["xy"], G.nodes[nbr]["xy"])),
                             "road": road, "dest": dest})
        tiles[tile_of(n)]["junctions"][n] = {"kind": kind, "name": G.nodes[n].get("name"),
                                             "branches": branches}

    # landmarks by their own position
    for lm in rm.landmarks:
        t = latlon_to_tile(lm["lat"], lm["lon"])
        tiles[t]["landmarks"].append({k: lm[k] for k in ("name", "lat", "lon", "score", "class", "wikidata")})

    for (x, y), T in tiles.items():
        d = os.path.join(out_dir, str(ZOOM), str(x))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{y}.json"), "w") as f:
            json.dump(T, f, separators=(",", ":"))

    print(f"graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges, "
          f"{n_j} junctions, {len(rm.landmarks)} landmarks -> {len(tiles)} tiles in {out_dir}/")
    return tiles


def parse_bbox(s):
    return tuple(float(x) for x in s.split(","))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--bbox", type=parse_bbox, default=(28.58, 77.18, 28.66, 77.28),
                    help="min_lat,min_lon,max_lat,max_lon (default: central Delhi)")
    ap.add_argument("--out", default="tiles")
    a = ap.parse_args()

    reader = read_osm_pbf if a.input.endswith(".pbf") else read_osm_xml
    nodes, ways = reader(a.input, a.bbox)
    print(f"read {len(nodes)} nodes, {len(ways)} ways inside bbox")
    rm, road_class = build(nodes, ways, a.bbox)
    write_tiles(rm, road_class, a.out)
