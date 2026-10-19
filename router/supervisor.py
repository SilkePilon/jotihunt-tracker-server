"""Keeps a GraphHopper graph for Gelderland up to date and serves it.

Pipeline (first start, weekly Monday 03:00 Europe/Amsterdam, or POST /rebuild):
download NL extract -> cut to Gelderland+10 km -> prepare_night.py -> GraphHopper import into a new dir ->
stop server -> swap dirs -> start server. The old graph keeps serving while a rebuild runs.
"""
import datetime
import json
import os
import shutil
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo

DATA = os.environ.get("DATA_DIR", "/data")
SOURCE_URL = os.environ.get("OSM_SOURCE_URL", "https://download.geofabrik.de/europe/netherlands-latest.osm.pbf")
BBOX = os.environ.get("OSM_BBOX", "4.85,51.61,7.00,52.64")
JAR = "/app/graphhopper-web.jar"
CONFIG = "/app/config.yml"
SERVE_HEAP = os.environ.get("SERVE_HEAP", "1g")
IMPORT_HEAP = os.environ.get("IMPORT_HEAP", "2g")
TZ = ZoneInfo("Europe/Amsterdam")

state = {"building": False, "builtAt": None, "report": None, "lastError": None}
lock = threading.Lock()
server_proc = None


def path(name):
    return os.path.join(DATA, name)


def log(msg):
    print(f"[supervisor] {msg}", flush=True)


def load_meta():
    try:
        with open(path("meta.json")) as f:
            meta = json.load(f)
        state["builtAt"], state["report"] = meta.get("builtAt"), meta.get("report")
    except FileNotFoundError:
        pass


def start_server():
    global server_proc
    log("starting GraphHopper")
    server_proc = subprocess.Popen(["java", f"-Xmx{SERVE_HEAP}", f"-Ddw.graphhopper.graph.location={path('graph-cache')}", "-jar", JAR, "server", CONFIG])


def stop_server():
    global server_proc
    if server_proc and server_proc.poll() is None:
        log("stopping GraphHopper")
        server_proc.terminate()
        try:
            server_proc.wait(60)
        except subprocess.TimeoutExpired:
            server_proc.kill()
    server_proc = None


def build():
    tmp_pbf, cut_pbf, night_pbf = path("source.osm.pbf.tmp"), path("gelderland.osm.pbf"), path("gelderland-night.osm.pbf")
    new_graph = path("graph-new")
    log(f"downloading {SOURCE_URL}")
    urllib.request.urlretrieve(SOURCE_URL, tmp_pbf)
    os.replace(tmp_pbf, path("source.osm.pbf"))
    subprocess.run(["osmium", "extract", "-b", BBOX, "-s", "smart", "--overwrite", "-o", cut_pbf, path("source.osm.pbf")], check=True)
    out = subprocess.run(["python3", "/app/prepare_night.py", cut_pbf, night_pbf, path("report.json")], check=True, capture_output=True, text=True)
    report = json.loads(out.stdout.strip().splitlines()[-1])
    shutil.rmtree(new_graph, ignore_errors=True)
    subprocess.run(["java", f"-Xmx{IMPORT_HEAP}", f"-Ddw.graphhopper.graph.location={new_graph}", f"-Ddw.graphhopper.datareader.file={night_pbf}", "-jar", JAR, "import", CONFIG], check=True)
    stop_server()
    shutil.rmtree(path("graph-cache"), ignore_errors=True)
    os.replace(new_graph, path("graph-cache"))
    built_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with open(path("meta.json"), "w") as f:
        json.dump({"builtAt": built_at, "report": report}, f)
    state["builtAt"], state["report"] = built_at, report
    start_server()


def rebuild_async():
    with lock:
        if state["building"]:
            return False
        state["building"] = True
        state["lastError"] = None

    def work():
        try:
            build()
            log("rebuild done")
        except Exception as error:  # noqa: BLE001 - report any failure via /status
            state["lastError"] = str(error)
            log(f"rebuild failed: {error}")
            if server_proc is None and os.path.isdir(path("graph-cache")):
                start_server()
        finally:
            state["building"] = False

    threading.Thread(target=work, daemon=True).start()
    return True


def graphhopper_online():
    try:
        with urllib.request.urlopen("http://127.0.0.1:8989/health", timeout=2) as res:
            return res.status == 200
    except Exception:  # noqa: BLE001
        return False


class Admin(BaseHTTPRequestHandler):
    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/status":
            return self._json(200, {**state, "online": graphhopper_online()})
        self._json(404, {"message": "not found"})

    def do_POST(self):
        if self.path == "/rebuild":
            started = rebuild_async()
            return self._json(202 if started else 409, {"started": started})
        self._json(404, {"message": "not found"})

    def log_message(self, *_args):
        pass


def weekly():
    last = None
    while True:
        now = datetime.datetime.now(TZ)
        if now.weekday() == 0 and now.hour == 3 and last != now.date():
            last = now.date()
            rebuild_async()
        time.sleep(60)


def main():
    os.makedirs(DATA, exist_ok=True)
    load_meta()
    if os.path.isdir(path("graph-cache")):
        start_server()
    else:
        rebuild_async()
    threading.Thread(target=weekly, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8990), Admin).serve_forever()


if __name__ == "__main__":
    main()
