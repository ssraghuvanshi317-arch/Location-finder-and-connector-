# Location-finder-and-connector-
Helps you mentally map out the place you are in by using your location.

## What is here

| File | Purpose |
|------|---------|
| `familiarizer.py` | Prototype narrator. Builds a road graph, detects junctions, walks each branch to find the road name and best landmark "toward X", and speaks fixed templates. Has a synthetic self-test that needs no internet. |
| `build_tiles.py` | Offline builder. Reads an OpenStreetMap extract (`.osm.pbf` or `.osm` XML), reuses the junction and salience logic from `familiarizer.py`, precomputes every junction's branches, and writes zoom-14 JSON tiles the phone can fetch one at a time. |
| `test.osm` | A tiny hand-made map (four roads, three landmarks) placed in central Delhi so the builder can be tested without downloading anything. |

## Quick start (no downloads)

```
pip install -r requirements.txt
python familiarizer.py --synthetic
python build_tiles.py --input test.osm --bbox 28.5,77.1,28.7,77.4
```

The builder writes `tiles/14/11707/6831.json`. Open it and look at junction `2`: its
north branch is Second Avenue toward Sacred Heart Cathedral. City Station lands in the
neighbouring tile `14/11706/6831.json` because it sits a few metres west of the tile
boundary, which is why the phone fetches the eight surrounding tiles as well.

## Real data

1. Download a Geofabrik extract, e.g. the India or northern-zone `.osm.pbf`.
2. `pip install osmium`
3. `python build_tiles.py --input india-latest.osm.pbf --bbox 28.58,77.18,28.66,77.28`
4. Open a tile for a junction you know and check whether the branches say what you would say.

The `--bbox` keeps memory proportional to the area, not to the whole file. To pre-clip:
`osmium extract -b 77.18,28.58,77.28,28.66 india-latest.osm.pbf -o delhi.osm.pbf`

## Serving tiles

Tiles are plain files with predictable names, so any static host works. Upload the
`tiles/` folder to Cloudflare R2 (or similar) and the phone fetches
`https://<bucket>/14/<x>/<y>.json` directly. No server process is needed.

## Known gaps

- `build_tiles.py` has not yet been run against a real `.pbf`; expect a small fix on first run.
- Landmarks mapped as multipolygon relations (some large parks) are skipped.
- The "toward X" walk is conservative: a landmark just past the end of a road is not picked
  up. The lazy LLM salience pass (the `salience` field in each tile) and a neighbourhood-name
  fallback are meant to cover this.
