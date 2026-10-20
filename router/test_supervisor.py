import os
import tempfile
import unittest
from unittest import mock

import supervisor


class ServedConfig(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = self.tmp.name
        self.app = os.path.join(self.data, "app")
        os.makedirs(os.path.join(self.app, "custom_models"))
        self.config = os.path.join(self.app, "config.yml")
        self.legacy = os.path.join(self.app, "config-legacy.yml")
        with open(self.config, "w") as f:
            f.write("new")
        self.patches = [
            mock.patch.object(supervisor, "DATA", self.data),
            mock.patch.object(supervisor, "CONFIG", self.config),
            mock.patch.object(supervisor, "LEGACY_CONFIG", self.legacy),
            mock.patch.object(supervisor, "CUSTOM_MODELS", os.path.join(self.app, "custom_models")),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_built_copy_wins(self):
        with open(os.path.join(self.data, "config-built.yml"), "w") as f:
            f.write("built")
        with open(self.legacy, "w") as f:
            f.write("legacy")
        self.assertEqual(supervisor.served_config(), os.path.join(self.data, "config-built.yml"))

    def test_legacy_when_never_built_with_a_copy(self):
        with open(self.legacy, "w") as f:
            f.write("legacy")
        self.assertEqual(supervisor.served_config(), self.legacy)

    def test_shipped_config_as_last_resort(self):
        self.assertEqual(supervisor.served_config(), self.config)

    def test_hash_changes_with_config_and_custom_models(self):
        first = supervisor.config_hash()
        with open(os.path.join(self.app, "custom_models", "foot_night.json"), "w") as f:
            f.write("{}")
        second = supervisor.config_hash()
        with open(self.config, "w") as f:
            f.write("newer")
        self.assertNotEqual(first, second)
        self.assertNotEqual(second, supervisor.config_hash())

    def test_needs_rebuild_when_meta_hash_differs(self):
        self.assertTrue(supervisor.config_outdated({}))
        self.assertTrue(supervisor.config_outdated({"configHash": "old"}))
        self.assertFalse(supervisor.config_outdated({"configHash": supervisor.config_hash()}))

    def test_remember_built_config_copies_and_returns_hash(self):
        digest = supervisor.remember_built_config()
        with open(os.path.join(self.data, "config-built.yml")) as f:
            self.assertEqual(f.read(), "new")
        self.assertEqual(digest, supervisor.config_hash())


if __name__ == "__main__":
    unittest.main()
