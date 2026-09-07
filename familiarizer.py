"""
Location Familiarizer — junction + corridor narration prototype.

Two narrators over one OSM road graph:
  * Junction narrator  — fires approaching an intersection or a road-name change:
        "Approaching X. Left onto A Road, toward P. Right onto B Road, toward Q."
  * Corridor narrator  — fires between junctions for landmarks near the *road you are on*:
        "Sacred Heart Cathedral coming up on your left."

Usage
-----
Synthetic self-test (no internet, no osmnx):
    python familiarizer.py --synthetic

Real Delhi data (needs: pip install osmnx networkx):
    python familiarizer.py --center 28.6262,77.2350 --start 28.6262,77.2350 --end 28.6304,77.2210

--center      point around which to download ~1.5 km of OSM data
--start/--end fake GPS trace runs along the shortest road path between these
--mode        walking | driving   (changes look-ahead and corridor width)

Everything that speaks is a fixed template. No LLM is in the loop here —
that's deliberate; the LLM's job is batch salience ranking and "tell me more".
"""

import argparse
import math
import sys
from collections import defaultdict
import networkx as nx

# ---------------------------------------------------------------------------
# Tunables (all guesses — tune them on a real street)
# ---------------------------------------------------------------------------
PROFILES = {
    "walking": dict(lookahead=40, corridor=60, branch_walk=600, sample_step=8),
    "driving": dict(lookahead=200, corridor=150, branch_walk=2500, sample_step=40),
}

# Salience: how strongly a feature class reads as a "reference point" a local would use.
CLASS_WEIGHTS = {
    ("railway", "station"): 10, ("public_transport", "station"): 10,
    ("amenity", "hospital"): 8, ("amenity", "university"): 8, ("amenity", "college"): 6,
    ("amenity", "marketplace"): 8, ("amenity", "place_of_worship"): 6,
    ("leisure", "park"): 6, ("natural", "water"): 6, ("tourism", "attraction"): 7,
    ("historic", "*"): 6, ("amenity", "school"): 3, ("amenity", "cinema"): 4,
    ("shop", "mall"): 6, ("amenity", "restaurant"): 1, ("amenity", "cafe"): 1,
    ("shop", "*"): 0.5, ("amenity", "atm"): 0, ("amenity", "bank"): 1,
    # Neighbourhood names are how locals actually give directions ("toward Lajpat Nagar").
    # They are destinations, never corridor call-outs (see corridor_ahead).
    ("place", "neighbourhood"): 5, ("place", "suburb"): 5, ("place", "quarter"): 5,
    ("place", "locality"): 4, ("place", "village"): 4, ("place", "town"): 5,
}

# Multiples of the profile's corridor width used by the "toward X" fallbacks.
END_RADIUS_X = 4      # landmark sitting just past the end of the walked road
PLACE_RADIUS_M = 1000  # nearest neighbourhood name to the end of the walked road


def is_place(lm):
    return (lm.get("class") or "").startswith("place=")


def salience(tags, area_m2=0.0):
    score = 0.0
    for (k, v), w in CLASS_WEIGHTS.items():
        if k in tags and (v == "*" or tags[k] == v):
            score = max(score, w)
    if tags.get("wikidata") or tags.get("wikipedia"):
        score += 5  # strongest single signal of recognisability
    if area_m2 > 5000:
        score += 2
    if area_m2 > 50000:
        score += 2
    return score


# ---------------------------------------------------------------------------
# Geometry helpers (local flat-earth frame; fine at city scale)
# ---------------------------------------------------------------------------
class Frame:
    def __init__(self, lat0, lon0):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = 111320 * math.cos(math.radians(lat0))
        self.ky = 110540

    def xy(self, lat, lon):
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)


def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def bearing(a, b):
    """Compass bearing in degrees from a to b, 0 = north, 90 = east."""
    return math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) % 360


def turn(heading, target_bearing):
    """Signed turn angle (-180,180]; positive = right, negative = left."""
    d = (target_bearing - heading + 180) % 360 - 180
    return d


def turn_word(d):
    a = abs(d)
    if a < 30:
        return "straight"
    if a > 150:
        return "back"
    if d < 0:
        return "sharp left" if a > 110 else "left"
    return "sharp right" if a > 110 else "right"


def side_of(heading, from_xy, to_xy):
    """Left/right of a point relative to travel heading."""
    hx, hy = math.sin(math.radians(heading)), math.cos(math.radians(heading))
    dx, dy = to_xy[0] - from_xy[0], to_xy[1] - from_xy[1]
    cross = hx * dy - hy * dx
    return "left" if cross > 0 else "right"


def project_on_segment(p, a, b):
    """Return (t_clamped, perpendicular_distance, t_raw) of p projected onto segment a-b."""
    ax, ay = a
    bx, by = b
    px, py = p
    vx, vy = bx - ax, by - ay
    L2 = vx * vx + vy * vy
    if L2 == 0:
        return 0.0, dist(p, a), 0.0
    t_raw = ((px - ax) * vx + (py - ay) * vy) / L2
    t = max(0.0, min(1.0, t_raw))
    q = (ax + t * vx, ay + t * vy)
    return t, dist(p, q), t_raw


# ---------------------------------------------------------------------------
# Spatial index so landmark lookups don't scan every landmark for every segment.
# A city bbox has thousands of landmarks and tens of thousands of segments walked;
# a plain scan is billions of projections. A coarse grid makes it near-constant.
# ---------------------------------------------------------------------------
class LandmarkIndex:
    def __init__(self, landmarks, cell=250.0):
        self.cell = cell
        self.cells = defaultdict(list)
        for lm in landmarks:
            self.cells[self._key(lm["xy"])].append(lm)

    def _key(self, p):
        return (math.floor(p[0] / self.cell), math.floor(p[1] / self.cell))

    def near_segment(self, a, b, radius):
        """Every landmark whose cell overlaps the segment's bbox grown by `radius`."""
        kx0, ky0 = self._key((min(a[0], b[0]) - radius, min(a[1], b[1]) - radius))
        kx1, ky1 = self._key((max(a[0], b[0]) + radius, max(a[1], b[1]) + radius))
        for i in range(kx0, kx1 + 1):
            for j in range(ky0, ky1 + 1):
                yield from self.cells.get((i, j), ())


# ---------------------------------------------------------------------------
# Graph model
# ---------------------------------------------------------------------------
class RoadMap:
    """
    Undirected graph. Node attrs: xy (metric), name (optional, e.g. a named circle).
    Edge attrs: name (road name or None), length (m).
    Landmarks: list of dicts {name, xy, score}.
    """

    def __init__(self, G, landmarks, frame):
        self.G = G
        self.landmarks = landmarks
        self.frame = frame
        self.index = LandmarkIndex(landmarks)

    # ---- junction detection -------------------------------------------------
    def edge_name(self, u, v):
        return self.G.edges[u, v].get("name")

    def is_junction(self, n):
        nbrs = list(self.G.neighbors(n))
        if len(nbrs) >= 3:
            return "junction"
        if len(nbrs) == 2:
            a, b = (self.edge_name(n, x) for x in nbrs)
            if a and b and a != b:
                return "name_change"
        return None

    # ---- follow a way outward from a junction ---------------------------------
    def walk_branch(self, junction, first, max_dist):
        """
        Follow the road starting junction->first, preferring to stay on the same
        named way, for up to max_dist metres. Returns (path_nodes, road_name, next_named_junction).
        """
        name = self.edge_name(junction, first)
        path = [junction, first]
        travelled = self.G.edges[junction, first]["length"]
        prev, cur = junction, first
        next_named = None
        while travelled < max_dist:
            if self.is_junction(cur) == "junction" and self.G.nodes[cur].get("name") and cur != junction:
                next_named = self.G.nodes[cur]["name"]
            options = [x for x in self.G.neighbors(cur) if x != prev]
            if not options:
                break
            same = [x for x in options if name and self.edge_name(cur, x) == name]
            if same:
                nxt = same[0]
            elif len(options) == 1:
                nxt = options[0]
            else:
                break  # ambiguous — the road ends here as far as narration is concerned
            travelled += self.G.edges[cur, nxt]["length"]
            path.append(nxt)
            prev, cur = cur, nxt
        return path, name, next_named

    def landmarks_along(self, path, corridor):
        """Landmarks within `corridor` metres of any segment on the path, sorted by salience."""
        found = {}
        for a, b in zip(path, path[1:]):
            axy, bxy = self.G.nodes[a]["xy"], self.G.nodes[b]["xy"]
            for lm in self.index.near_segment(axy, bxy, corridor):
                t, d, t_raw = project_on_segment(lm["xy"], axy, bxy)
                if d <= corridor and -0.05 <= t_raw <= 1.05 and lm["name"] not in found:
                    found[lm["name"]] = lm
        return sorted(found.values(), key=lambda l: -l["score"])

    def landmarks_beyond(self, path, radius):
        """
        Landmarks within `radius` of the far end of the walked path that lie *ahead*
        (in the direction of the last segment). Catches "the park is just past where
        Ridge Lane ends", which the corridor test misses.
        """
        if len(path) < 2:
            return []
        a, b = self.G.nodes[path[-2]]["xy"], self.G.nodes[path[-1]]["xy"]
        hx, hy = b[0] - a[0], b[1] - a[1]
        out = []
        for lm in self.index.near_segment(b, b, radius):
            dx, dy = lm["xy"][0] - b[0], lm["xy"][1] - b[1]
            if dist(lm["xy"], b) <= radius and hx * dx + hy * dy >= 0:
                out.append(lm)
        return sorted(out, key=lambda l: -l["score"])

    def nearest_place(self, node, radius):
        """Closest neighbourhood/suburb name to a node, or None."""
        p = self.G.nodes[node]["xy"]
        best, best_d = None, radius
        for lm in self.index.near_segment(p, p, radius):
            if is_place(lm):
                d = dist(lm["xy"], p)
                if d < best_d:
                    best, best_d = lm, d
        return best["name"] if best else None

    def destination_for(self, junction, first, prof):
        """
        Road name and the best "toward X" for the branch junction->first, tried in order:
          1. most salient landmark alongside the walked road
          2. a named junction (circle / chowk) reached along it
          3. a salient landmark just past where the walk stopped
          4. the nearest neighbourhood name to where the walk stopped
        """
        path, road, next_named = self.walk_branch(junction, first, prof["branch_walk"])
        lms = [l for l in self.landmarks_along(path, prof["corridor"] * 2) if not is_place(l)]
        if lms and lms[0]["score"] >= 4:
            return road, lms[0]["name"]
        if next_named:
            return road, next_named
        beyond = [l for l in self.landmarks_beyond(path, prof["corridor"] * END_RADIUS_X) if not is_place(l)]
        if beyond and beyond[0]["score"] >= 4:
            return road, beyond[0]["name"]
        return road, self.nearest_place(path[-1], PLACE_RADIUS_M)

    # ---- corridor landmarks on the current edge, ahead of the user --------------
    def corridor_ahead(self, u, v, pos_xy, heading, prof):
        axy, bxy = self.G.nodes[u]["xy"], self.G.nodes[v]["xy"]
        t_me, _, _ = project_on_segment(pos_xy, axy, bxy)
        out = []
        for lm in self.index.near_segment(axy, bxy, prof["corridor"]):
            if is_place(lm):
                continue  # "Lajpat Nagar coming up on your left" is not a thing
            t, d, t_raw = project_on_segment(lm["xy"], axy, bxy)
            if d <= prof["corridor"] and t > t_me and t_raw <= 1.05:
                along = (t - t_me) * dist(axy, bxy)
                if along <= prof["lookahead"] * 1.5:
                    out.append((along, lm, side_of(heading, pos_xy, lm["xy"])))
        return sorted(out, key=lambda x: x[0])


# ---------------------------------------------------------------------------
# Narration
# ---------------------------------------------------------------------------
class Narrator:
    def __init__(self, rm: RoadMap, mode="walking"):
        self.rm = rm
        self.prof = PROFILES[mode]
        self.said_junction = {}   # node -> count this trip
        self.said_landmark = set()
        self.lines = []

    def say(self, text):
        self.lines.append(text)
        print("  🔊 " + text)

    def junction_line(self, node, came_from, heading):
        rm = self.rm
        kind = rm.is_junction(node)
        jname = rm.G.nodes[node].get("name")
        count = self.said_junction.get(node, 0)
        again = " again" if count else ""
        parts = []
        if kind == "name_change":
            (other,) = [x for x in rm.G.neighbors(node) if x != came_from]
            parts.append(f"{rm.edge_name(came_from, node)} becomes {rm.edge_name(node, other)}")
        else:
            head = f"Approaching {jname}{again}." if jname else f"Approaching a junction{again}."
            parts.append(head)
            branches = []
            for nbr in rm.G.neighbors(node):
                if nbr == came_from:
                    continue
                b = bearing(rm.G.nodes[node]["xy"], rm.G.nodes[nbr]["xy"])
                branches.append((turn(heading, b), nbr))
            for d, nbr in sorted(branches):
                tw = turn_word(d)
                if tw == "back":
                    continue
                road, dest = rm.destination_for(node, nbr, self.prof)
                road_s = f"onto {road}" if road else "onto an unnamed road"
                dest_s = f", toward {dest}" if dest else ""
                parts.append(f"{tw.capitalize()} {road_s}{dest_s}.")
        self.said_junction[node] = count + 1
        self.say(" ".join(parts))

    def step(self, u, v, pos_xy, heading):
        """One GPS tick: user is on edge u->v at pos_xy travelling with heading."""
        rm, prof = self.rm, self.prof
        # corridor narrator
        for along, lm, side in rm.corridor_ahead(u, v, pos_xy, heading, prof):
            key = lm["name"]
            if key in self.said_landmark or along > prof["lookahead"]:
                continue
            if lm["score"] < 2:
                continue
            self.said_landmark.add(key)
            self.say(f"{lm['name']} coming up on your {side}.")
        # junction narrator
        d_to_v = dist(pos_xy, rm.G.nodes[v]["xy"])
        if rm.is_junction(v) and d_to_v <= prof["lookahead"]:
            if self.said_junction.get(("live", v)) != u:  # once per approach
                self.said_junction[("live", v)] = u
                self.junction_line(v, u, heading)


# ---------------------------------------------------------------------------
# Fake GPS trace along a node path
# ---------------------------------------------------------------------------
def simulate(rm: RoadMap, node_path, mode):
    nar = Narrator(rm, mode)
    step = PROFILES[mode]["sample_step"]
    print(f"\n=== {mode.upper()} trace over {len(node_path)} nodes ===")
    for u, v in zip(node_path, node_path[1:]):
        a, b = rm.G.nodes[u]["xy"], rm.G.nodes[v]["xy"]
        L = dist(a, b)
        heading = bearing(a, b)
        n = max(1, int(L // step))
        for i in range(n + 1):
            t = min(1.0, i * step / L) if L else 1.0
            pos = (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
            nar.step(u, v, pos, heading)
    return nar.lines


# ---------------------------------------------------------------------------
# Synthetic city for self-test (a 3x3 grid, named streets, a few landmarks)
# ---------------------------------------------------------------------------
def synthetic():
    frame = Frame(28.6, 77.2)
    G = nx.Graph()
    ns = ["First Avenue", "Second Avenue", "Third Avenue"]      # run north-south (x = const)
    ew = ["Park Road", "Station Road", "Temple Road"]           # run east-west   (y = const)
    for i in range(3):
        for j in range(3):
            G.add_node((i, j), xy=(i * 300.0, j * 300.0))
    G.nodes[(1, 1)]["name"] = "Central Circle"
    for i in range(3):
        for j in range(2):
            G.add_edge((i, j), (i, j + 1), name=ns[i], length=300.0)
    for j in range(3):
        for i in range(2):
            G.add_edge((i, j), (i + 1, j), name=ew[j], length=300.0)
    # a dangling spur where the road name changes mid-way
    G.add_node("spur1", xy=(600.0, 750.0)); G.add_node("spur2", xy=(600.0, 900.0))
    G.add_edge((2, 2), "spur1", name="Third Avenue", length=150.0)
    G.add_edge("spur1", "spur2", name="Ridge Lane", length=150.0)

    def lm(name, x, y, tags, area=0):
        return {"name": name, "xy": (x, y), "score": salience(tags, area)}

    landmarks = [
        lm("City Station", 20, 620, {"railway": "station", "wikidata": "Q1"}),
        lm("St. Mary's Church", 320, 150, {"amenity": "place_of_worship", "religion": "christian"}),
        lm("Riverside Park", 720, 300, {"leisure": "park", "wikidata": "Q2"}, area=80000),
        lm("Corner Cafe", 30, 330, {"amenity": "cafe"}),
        lm("Sacred Heart Cathedral", 275, 450, {"amenity": "place_of_worship", "wikidata": "Q4"}),
        lm("Civic Hospital", 430, 640, {"amenity": "hospital"}),
        lm("Old Fort", 900, 600, {"historic": "fort", "wikidata": "Q3"}, area=60000),
        lm("Far Temple", 300, 1200, {"amenity": "place_of_worship"}),  # off any corridor
        lm("Two-streets-over Mall", 450, 150, {"shop": "mall"}),        # 150 m off Second Ave: excluded
    ]
    rm = RoadMap(G, landmarks, frame)
    # walk: west end of Station Rd -> Central Circle -> north on Second Ave -> east on Temple Rd -> spur
    path = [(0, 1), (1, 1), (1, 2), (2, 2), "spur1", "spur2"]
    return rm, path


# ---------------------------------------------------------------------------
# Real OSM loader (osmnx) — run this on your own machine
# ---------------------------------------------------------------------------
def load_osm(center, start, end, mode):
    try:
        import osmnx as ox
    except ImportError:
        sys.exit("pip install osmnx networkx   (then re-run)")
    net = "walk" if mode == "walking" else "drive"
    Gd = ox.graph_from_point(center, dist=1500, network_type=net, simplify=True)
    Gu = ox.convert.to_undirected(Gd) if hasattr(ox, "convert") else ox.utils_graph.get_undirected(Gd)
    frame = Frame(*center)
    G = nx.Graph()
    for n, d in Gu.nodes(data=True):
        G.add_node(n, xy=frame.xy(d["y"], d["x"]))
        # junction names for roundabouts / named circles come from the junction=* tag on the way;
        # osmnx keeps them sparsely, so this stays mostly None on real data. Batch enrichment fixes it.
    for u, v, d in Gu.edges(data=True):
        name = d.get("name")
        if isinstance(name, list):
            name = name[0]
        if G.has_edge(u, v):
            continue
        G.add_edge(u, v, name=name, length=float(d.get("length", 0.0)))

    tags = {"amenity": True, "tourism": True, "historic": True, "leisure": "park",
            "railway": "station", "public_transport": "station", "natural": "water",
            "shop": ["mall", "supermarket"]}
    landmarks = []
    try:
        gdf = ox.features_from_point(center, tags=tags, dist=1500)
        gdf = gdf[gdf["name"].notna()]
        for _, row in gdf.iterrows():
            geom = row.geometry
            c = geom.centroid
            area = 0.0
            if geom.geom_type in ("Polygon", "MultiPolygon"):
                area = geom.area * frame.kx * frame.ky  # deg² -> m² (rough)
            rtags = {k: v for k, v in row.items() if isinstance(v, str)}
            landmarks.append({"name": row["name"], "xy": frame.xy(c.y, c.x),
                              "score": salience(rtags, area)})
    except Exception as e:
        print("landmark fetch failed:", e)
    rm = RoadMap(G, landmarks, frame)
    s = ox.distance.nearest_nodes(Gu, start[1], start[0])
    t = ox.distance.nearest_nodes(Gu, end[1], end[0])
    path = nx.shortest_path(G, s, t, weight="length")
    print(f"graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges, {len(landmarks)} named landmarks")
    return rm, path


def parse_ll(s):
    lat, lon = s.split(",")
    return float(lat), float(lon)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--synthetic", action="store_true")
    ap.add_argument("--center", type=parse_ll)
    ap.add_argument("--start", type=parse_ll)
    ap.add_argument("--end", type=parse_ll)
    ap.add_argument("--mode", default="walking", choices=list(PROFILES))
    a = ap.parse_args()
    if a.synthetic or not a.center:
        rm, path = synthetic()
        simulate(rm, path, "walking")
        simulate(rm, path, "driving")
    else:
        rm, path = load_osm(a.center, a.start or a.center, a.end, a.mode)
        simulate(rm, path, a.mode)
