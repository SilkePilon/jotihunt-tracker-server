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
lock = threading.Lock()  # guards starting a rebuild
state_lock = threading.Lock()  # guards reads/writes of state
RETRY_DELAYS = [300, 900, 1800, 3600]  # first-build retries, then hourly
server_proc = None


def path(name):
    return os.path.join(DATA, name)


def log(msg):
    print(f"[supervisor] {msg}", flush=True)


def load_meta():
    try:
        with open(path("meta.json")) as f:
            meta = json.load(f)
        set_state(builtAt=meta.get("builtAt"), report=meta.get("report"))
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


def set_state(**values):
    with state_lock:
        state.update(values)


def run_captured(cmd):
    """Run a command, capture stderr; on failure raise with the last ~1000 chars of it."""
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        tail = (result.stderr or "")[-1000:]
        log(f"{cmd[0]} failed (exit {result.returncode}): {tail}")
        raise RuntimeError(f"{cmd[0]} exited {result.returncode}: {tail}")
    return result


def build():
    tmp_pbf, cut_pbf, night_pbf = path("source.osm.pbf.tmp"), path("gelderland.osm.pbf"), path("gelderland-night.osm.pbf")
    new_graph, graph_cache, graph_old = path("graph-new"), path("graph-cache"), path("graph-old")
    log(f"downloading {SOURCE_URL}")
    with urllib.request.urlopen(SOURCE_URL, timeout=60) as res, open(tmp_pbf, "wb") as out_file:
        shutil.copyfileobj(res, out_file)
    os.replace(tmp_pbf, path("source.osm.pbf"))
    run_captured(["osmium", "extract", "-b", BBOX, "-s", "smart", "--overwrite", "-o", cut_pbf, path("source.osm.pbf")])
    out = run_captured(["python3", "/app/prepare_night.py", cut_pbf, night_pbf, path("report.json")])
    report = json.loads(out.stdout.strip().splitlines()[-1])
    shutil.rmtree(new_graph, ignore_errors=True)
    subprocess.run(["java", f"-Xmx{IMPORT_HEAP}", f"-Ddw.graphhopper.graph.location={new_graph}", f"-Ddw.graphhopper.datareader.file={night_pbf}", "-jar", JAR, "import", CONFIG], check=True)
    stop_server()
    shutil.rmtree(graph_old, ignore_errors=True)
    had_old = os.path.isdir(graph_cache)
    built_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        if had_old:
            os.rename(graph_cache, graph_old)
        os.rename(new_graph, graph_cache)
        with open(path("meta.json.tmp"), "w") as f:
            json.dump({"builtAt": built_at, "report": report}, f)
        os.replace(path("meta.json.tmp"), path("meta.json"))
    except Exception:
        if had_old and os.path.isdir(graph_old):
            shutil.rmtree(graph_cache, ignore_errors=True)
            os.rename(graph_old, graph_cache)
        raise
    shutil.rmtree(graph_old, ignore_errors=True)
    set_state(builtAt=built_at, report=report)
    start_server()


def rebuild_async():
    with lock:
        if state["building"]:
            return False
        set_state(building=True, lastError=None)

    def work():
        attempt = 0
        try:
            while True:
                try:
                    build()
                    set_state(lastError=None)
                    log("rebuild done")
                    return
                except Exception as error:  # noqa: BLE001 - report any failure via /status
                    set_state(lastError=str(error)[-1500:])
                    log(f"rebuild failed: {error}")
                    if server_proc is None and os.path.isdir(path("graph-cache")):
                        start_server()
                    if os.path.isdir(path("graph-cache")):
                        return  # old graph keeps serving; the next weekly run retries
                    delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
                    attempt += 1
                    log(f"no graph yet, retrying in {delay // 60} min")
                    time.sleep(delay)
        finally:
            set_state(building=False)

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
            with state_lock:
                snapshot = dict(state)
            return self._json(200, {**snapshot, "online": graphhopper_online()})
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
        with state_lock:
            building = state["building"]
        if not building and (server_proc is None or server_proc.poll() is not None) and os.path.isdir(path("graph-cache")):
            log("GraphHopper is not running, restarting")
            start_server()
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
