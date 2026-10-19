import json
import os
import tempfile
import unittest

import osmium

from prepare_night import NIGHT_TAG, NIGHT_VALUE, is_fallback_candidate, is_night_closed, rewrite_night, run, with_night_rule

HERE = os.path.dirname(os.path.abspath(__file__))


class TagRules(unittest.TestCase):
    def test_conditional_no_at_night(self):
        self.assertTrue(is_night_closed({"highway": "track", "access:conditional": "no @ (sunset-sunrise)"}))
        self.assertTrue(is_night_closed({"highway": "track", "foot:conditional": "no@ (sunset-sunrise)"}))

    def test_permissive_by_day(self):
        self.assertTrue(is_night_closed({"highway": "path", "foot": "no", "foot:conditional": "permissive @ (sunrise-sunset)"}))
        self.assertTrue(is_night_closed({"highway": "path", "access": "no", "access:conditional": "permissive @ (sunrise - sunset)"}))

    def test_opening_hours(self):
        self.assertTrue(is_night_closed({"highway": "footway", "opening_hours": "sunrise-sunset"}))
        self.assertTrue(is_night_closed({"highway": "footway", "opening_hours": "Jan-Mar: 09:00-18:00; Oct: 09:00-19:00"}))
        self.assertFalse(is_night_closed({"highway": "footway", "opening_hours": "24/7"}))

    def test_non_highway_and_plain(self):
        self.assertFalse(is_night_closed({"leisure": "park", "opening_hours": "sunrise-sunset"}))
        self.assertFalse(is_night_closed({"highway": "path"}))

    def test_rewrite_opens_by_day_and_blocks_at_night(self):
        out = rewrite_night({"highway": "path", "foot": "no", "foot:conditional": "permissive @ (sunrise-sunset)", "name": "x"})
        self.assertEqual(out, {"highway": "path", "foot": "permissive", "name": "x", NIGHT_TAG: NIGHT_VALUE})
        out = rewrite_night({"highway": "track", "access:conditional": "no @ (sunset-sunrise)"})
        self.assertEqual(out, {"highway": "track", NIGHT_TAG: NIGHT_VALUE})

    def test_rewrite_keeps_access_closed_for_vehicles(self):
        out = rewrite_night({"highway": "track", "access": "no", "access:conditional": "permissive @ (sunrise-sunset)"})
        self.assertEqual(out, {"highway": "track", "access": "no", "foot": "permissive", NIGHT_TAG: NIGHT_VALUE})
        out = rewrite_night({"highway": "path", "access": "private", "foot": "no", "foot:conditional": "yes @ (sunrise-sunset)"})
        self.assertEqual(out, {"highway": "path", "access": "private", "foot": "permissive", NIGHT_TAG: NIGHT_VALUE})

    def test_fallback_candidate(self):
        self.assertTrue(is_fallback_candidate({"highway": "path"}))
        self.assertTrue(is_fallback_candidate({"highway": "track", "tracktype": "grade3"}))
        self.assertFalse(is_fallback_candidate({"highway": "footway", "foot": "designated"}))
        self.assertFalse(is_fallback_candidate({"highway": "unclassified"}))
        self.assertFalse(is_fallback_candidate({"highway": "cycleway"}))
        self.assertEqual(with_night_rule({"highway": "path"}), {"highway": "path", NIGHT_TAG: NIGHT_VALUE})


class FixtureRun(unittest.TestCase):
    def test_fixture(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out.osm")
            report_path = os.path.join(tmp, "report.json")
            run(os.path.join(HERE, "fixtures", "night.osm"), out, report_path)
            tags = {}

            class Collect(osmium.SimpleHandler):
                def way(self, w):
                    tags[w.id] = dict(w.tags)

            Collect().apply_file(out)
            report = json.load(open(report_path))
        night = {wid for wid, t in tags.items() if t.get(NIGHT_TAG) == NIGHT_VALUE}
        self.assertEqual(night, {200, 300, 301, 302})
        self.assertEqual(tags[301].get("foot"), "permissive")
        self.assertNotIn("opening_hours", tags[302])
        self.assertEqual(report, {"nightTagged": 3, "fallbackTagged": 1, "reserves": 1})


if __name__ == "__main__":
    unittest.main()
