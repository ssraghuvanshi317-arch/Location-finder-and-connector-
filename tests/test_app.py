"""
End-to-end test of the phone app against tiles built from test.osm, in headless Chromium.

    pip install playwright && playwright install chromium
    python tests/test_app.py

Builds the tiles into a temp folder, serves them with http.server, replays the demo
route through window.app.simulate(), checks the spoken lines, then drives the real
geolocation path with fake GPS fixes. Set PW_CHROMIUM to use a specific Chromium binary.
"""
import json, os, shutil, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = tempfile.mkdtemp(prefix="familiarizer-test-")
subprocess.check_call([sys.executable, os.path.join(REPO, "build_tiles.py"), "--input", os.path.join(REPO, "test.osm"),
                       "--bbox", "28.5,77.1,28.7,77.4", "--out", os.path.join(ROOT, "tiles")], stdout=subprocess.DEVNULL)
shutil.copy(os.path.join(REPO, "app", "index.html"), ROOT)
shutil.copytree(os.path.join(ROOT, "tiles"), os.path.join(ROOT, "tiles_sal"))
subprocess.check_call([sys.executable, os.path.join(REPO, "salience_pass.py"), "--all", os.path.join(ROOT, "tiles_sal"), "--mock"],
                      stdout=subprocess.DEVNULL)
p = os.path.join(ROOT, "tiles_sal", "14", "11707", "6831.json"); t = json.load(open(p))
t["salience"]["junctions"]["2"]["branches"]["5"] = "the Cathedral"; t["salience"]["junctions"]["2"]["name"] = "Test Chowk"
json.dump(t, open(p, "w"))
LAUNCH = {"executable_path": os.environ["PW_CHROMIUM"]} if os.environ.get("PW_CHROMIUM") else {}
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "--bind", "127.0.0.1"], cwd=ROOT,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
DEMO = [[28.6260, 77.2340], [28.6260, 77.2371], [28.6287, 77.2371]]
ok = True
def check(name, cond):
    global ok
    print(("PASS " if cond else "FAIL ") + name); ok &= bool(cond)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(**LAUNCH)
        errors = []
        # 1. plain tiles, simulated walk
        pg = b.new_page(); pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto("http://127.0.0.1:8765/index.html?base=tiles")
        lines = pg.evaluate("route => window.app.simulate(route, 8, 0)", DEMO)
        print("\n".join("  🔊 " + l for l in lines))
        check("hospital called on the right while walking east", any(l == "Civic Hospital coming up on your right." for l in lines))
        check("junction line names all three branches", any(l.startswith("Approaching a junction. Left onto Second Avenue, toward Sacred Heart Cathedral. Straight onto Station Road, toward Riverside Park. Right onto Second Avenue, toward Lodhi Colony.") for l in lines))
        check("cathedral called on the right while walking north", any(l == "Sacred Heart Cathedral coming up on your right." for l in lines))
        check("each line spoken once", len(lines) == len(set(lines)))
        check("starts on Station Road, not First Avenue", not any("First Avenue becomes" in l for l in lines))
        # 2. salience override preferred
        pg2 = b.new_page(); pg2.on("pageerror", lambda e: errors.append(str(e)))
        pg2.goto("http://127.0.0.1:8765/index.html?base=tiles_sal")
        lines2 = pg2.evaluate("route => window.app.simulate(route, 8, 0)", DEMO)
        jl = [l for l in lines2 if l.startswith("Approaching")]
        print("  🔊 " + (jl[0] if jl else "<none>"))
        check("salience junction name + branch text used", jl and jl[0].startswith("Approaching Test Chowk. Left onto Second Avenue, toward the Cathedral."))
        # 3. real geolocation path: Start button, two fixes -> heading from motion
        ctx = b.new_context(geolocation={"latitude": 28.6260, "longitude": 77.2350}, permissions=["geolocation"])
        pg3 = ctx.new_page(); pg3.on("pageerror", lambda e: errors.append(str(e)))
        pg3.goto("http://127.0.0.1:8765/index.html?base=tiles")
        pg3.click("#start")
        pg3.wait_for_function("document.getElementById('pos').textContent.includes('77.23500')")
        pg3.wait_for_function("G && G.edges.length > 0")   # tiles fetched on the first fix have arrived
        ctx.set_geolocation({"latitude": 28.6260, "longitude": 77.2352})
        pg3.wait_for_function("document.getElementById('pos').textContent.includes('77.23520')")
        ctx.set_geolocation({"latitude": 28.6260, "longitude": 77.2354})
        try:
            pg3.wait_for_function("document.getElementById('status').textContent.includes('Station Road')", timeout=5000)
        except Exception as ex:
            print("  DEBUG status:", pg3.inner_text("#status"), "| pos:", pg3.inner_text("#pos"), "| lines:", pg3.evaluate("app.lines"), "| tiles:", pg3.evaluate("[...tiles.entries()].map(([k,v])=>k+':'+(v==null?'null':v==='loading'?'loading':'ok'))"))
        print("  status:", pg3.inner_text("#status"), "| pos:", pg3.inner_text("#pos"))
        check("GPS fixes snap onto Station Road with a derived heading", "Station Road" in pg3.inner_text("#status") and "°" in pg3.inner_text("#pos"))
        check("no JS errors", not errors); print(errors)
        b.close()
finally:
    srv.terminate()
    shutil.rmtree(ROOT, ignore_errors=True)
sys.exit(0 if ok else 1)
