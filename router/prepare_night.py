"""Rewrite night-closed walking ways so GraphHopper's foot_temporal_access can block them at night.

Pass 1 collects nature reserve polygons of the big Dutch managers. Pass 2 rewrites highway ways:
- ways whose own tags close them at night get one normalised tag (and open by day);
- untagged unpaved paths inside a reserve get the same tag (signs there usually say sunrise-sunset).
GraphHopper only understands date ranges, so "closed at night" is written as an all-year range; the
server adds the `foot_temporal_access == NO` rule only to night requests.
"""
import json
import os
import re
import sys

import osmium
from shapely import wkb as shapely_wkb
from shapely.strtree import STRtree
from shapely.geometry import LineString

NIGHT_TAG = "foot:conditional"
NIGHT_VALUE = "no @ (Jan01-Dec31)"
RESERVE_OPERATORS = {"Staatsbosbeheer", "Natuurmonumenten", "Geldersch Landschap & Kasteelen"}
FALLBACK_HIGHWAYS = {"path", "footway", "track", "bridleway"}
CONDITIONAL_KEYS = ("access:conditional", "foot:conditional")
CLOSED_BASE = {"no", "private"}


def _norm(value: str) -> str:
    return re.sub(r"\s+", "", value.lower())


def is_night_closed(tags: dict) -> bool:
    if "highway" not in tags:
        return False
    for key in CONDITIONAL_KEYS:
        value = _norm(tags.get(key, ""))
        if value.startswith("no@") and "sunset-sunrise" in value:
            return True
        if (value.startswith("permissive@") or value.startswith("yes@")) and "sunrise-sunset" in value:
            return True
    hours = tags.get("opening_hours", "").strip()
    return bool(hours) and hours != "24/7"


def rewrite_night(tags: dict) -> dict:
    out = {k: v for k, v in tags.items() if k not in CONDITIONAL_KEYS and k != "opening_hours"}
    for key in ("foot", "access"):
        if out.get(key) in CLOSED_BASE:
            out.pop(key)
            out["foot"] = "permissive"
    out[NIGHT_TAG] = NIGHT_VALUE
    return out


def is_fallback_candidate(tags: dict) -> bool:
    return tags.get("highway") in FALLBACK_HIGHWAYS and tags.get("foot") != "designated"


def with_night_rule(tags: dict) -> dict:
    return {**tags, NIGHT_TAG: NIGHT_VALUE}


class ReserveCollector(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.factory = osmium.geom.WKBFactory()
        self.polygons = []

    def area(self, a):
        tags = a.tags
        is_reserve = tags.get("leisure") == "nature_reserve" or tags.get("boundary") == "protected_area"
        if not is_reserve or tags.get("operator") not in RESERVE_OPERATORS:
            return
        try:
            self.polygons.append(shapely_wkb.loads(self.factory.create_multipolygon(a), hex=True))
        except RuntimeError:
            pass  # broken multipolygon


class Rewriter(osmium.SimpleHandler):
    def __init__(self, writer, reserves):
        super().__init__()
        self.writer = writer
        self.tree = STRtree(reserves)
        self.reserves = reserves
        self.night_tagged = 0
        self.fallback_tagged = 0

    def node(self, n):
        self.writer.add_node(n)

    def relation(self, r):
        self.writer.add_relation(r)

    def _inside_reserve(self, w) -> bool:
        try:
            line = LineString([(n.lon, n.lat) for n in w.nodes])
        except osmium.InvalidLocationError:
            return False
        for index in self.tree.query(line):
            if self.reserves[index].intersects(line):
                return True
        return False

    def way(self, w):
        tags = dict(w.tags)
        if is_night_closed(tags):
            self.night_tagged += 1
            self.writer.add_way(w.replace(tags=rewrite_night(tags)))
        elif is_fallback_candidate(tags) and self.reserves and self._inside_reserve(w):
            self.fallback_tagged += 1
            self.writer.add_way(w.replace(tags=with_night_rule(tags)))
        else:
            self.writer.add_way(w)


def run(source: str, target: str, report_path: str) -> dict:
    collector = ReserveCollector()
    collector.apply_file(source, locations=True)
    if os.path.exists(target):
        os.remove(target)  # pyosmium 3.7 SimpleWriter has no overwrite flag
    writer = osmium.SimpleWriter(target)
    try:
        rewriter = Rewriter(writer, collector.polygons)
        rewriter.apply_file(source, locations=True)
    finally:
        writer.close()
    report = {"nightTagged": rewriter.night_tagged, "fallbackTagged": rewriter.fallback_tagged, "reserves": len(collector.polygons)}
    with open(report_path, "w") as f:
        json.dump(report, f)
    return report


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("usage: prepare_night.py IN.osm.pbf OUT.osm.pbf REPORT.json")
    print(json.dumps(run(sys.argv[1], sys.argv[2], sys.argv[3])))
