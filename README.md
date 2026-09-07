# Location-finder-and-connector-
Helps you mentally map out the place you are in by using your location.

## What is here

| File | Purpose |
|------|---------|
| `familiarizer.py` | Prototype narrator. Builds a road graph, detects junctions, walks each branch to find the road name and best landmark "toward X", and speaks fixed templates. Has a synthetic self-test that needs no internet. |
| `build_tiles.py` | Offline builder. Reads an OpenStreetMap extract (`.osm.pbf` or `.osm` XML), reuses the junction and salience logic from `familiarizer.py`, precomputes every junction's branches, and writes zoom-14 JSON tiles the phone can fetch one at a time. |
| `test.osm` | A tiny hand-made map (four roads, four landmarks, one neighbourhood) placed in central Delhi so everything can be tested without downloading anything. |
| `salience_pass.py` | The lazy LLM pass. Shows Claude one tile's junction branches and landmarks and asks what a local would say for "toward X"; writes the answer into the tile's `salience` field. Has `--dry-run` and `--mock` modes that need no API key. |
| `upload_r2.sh` | Pushes `tiles/` to a Cloudflare R2 bucket with the AWS CLI (R2 speaks S3). Setup steps are in the file header. |
| `app/index.html` | The phone. A single static page: GPS + compass in, spoken narration out. Fetches tiles straight from the bucket. Has a Demo button and a `window.app.simulate()` hook for testing without a phone. |

## Quick start (no downloads)

```
pip install -r requirements.txt   # networkx is all the builder needs; the rest are optional
python familiarizer.py --synthetic
python build_tiles.py --input test.osm --bbox 28.5,77.1,28.7,77.4
```

The builder writes `tiles/14/11707/6831.json`. Open it and look at junction `2`: its
north branch is Second Avenue toward Sacred Heart Cathedral. City Station lands in the
neighbouring tile `14/11706/6831.json` because it sits a few metres west of the tile
boundary, which is why the phone fetches the eight surrounding tiles as well.

## The phone app

`app/index.html` is a static page. Host it anywhere that serves HTTPS (it can sit in the
same R2 bucket as the tiles, or on GitHub Pages). Open it on the phone, paste the tile
base URL (your bucket's public host), press Start, and walk. It speaks through the
browser's speech synthesis. Add it to the home screen to get a full-screen app.

To try it on a laptop without GPS, serve the repo folder and use the demo route:

```
python build_tiles.py --input test.osm --bbox 28.5,77.1,28.7,77.4
python -m http.server 8000
# open http://localhost:8000/app/?base=/tiles  and press "Demo route"
```

It walks Station Road east and turns north up Second Avenue, saying "Civic Hospital
coming up on your right", the junction line with all three branches, and then the
cathedral.

## The LLM salience pass

```
pip install anthropic
export ANTHROPIC_API_KEY=...
python salience_pass.py tiles/14/11707/6831.json --dry-run   # see the prompt
python salience_pass.py --all tiles --limit 20                # fill in 20 tiles
sh upload_r2.sh                                               # re-sync only the changed files
```

The phone prefers a `salience` answer when one exists and falls back to the builder's
pick otherwise, so it is safe to run this on a few tiles at a time. To run it lazily on
first request instead, call `enrich_tile(path)` from whatever serves the tile.

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

## How "toward X" is chosen

For each road leaving a junction the builder walks up to 600 m along it and picks, in order:
the most salient landmark alongside the road, a named circle or chowk it reaches, a salient
landmark just past where the walk stopped, and finally the nearest neighbourhood name.
The LLM pass can override any of these.

## Known gaps

- Not yet run on a real Geofabrik extract (only on a `.pbf` converted from `test.osm` and
  on a synthetic Delhi-sized city of 22,500 junctions, which builds in about 18 s). Expect
  a small fix on first run.
- Multipolygon landmarks whose outer ring is split across several ways get an approximate
  area; the centroid, which is what narration uses, is fine.
- The phone app has been tested in headless Chromium with simulated GPS, not on a handset.
  Compass handling differs between iOS and Android and may need tuning on a real device.
- Tiles for dense areas may be larger than ideal; if one exceeds about 1 MB, drop `service`
  and `footway` edges from it.
