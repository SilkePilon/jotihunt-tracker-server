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

    def test_graph_snapshot_wins(self):
        served = os.path.join(self.data, "graph-cache", "served")
        os.makedirs(served)
        with open(os.path.join(served, "config.yml"), "w") as f:
            f.write("built")
        with open(self.legacy, "w") as f:
            f.write("legacy")
        self.assertEqual(supervisor.served_config(), os.path.join(served, "config.yml"))

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

    def test_hash_skips_subdirectories_in_custom_models(self):
        os.makedirs(os.path.join(self.app, "custom_models", "nested"))
        with open(os.path.join(self.app, "custom_models", "foot_night.json"), "w") as f:
            f.write("{}")
        self.assertEqual(len(supervisor.config_hash()), 40)

    def test_needs_rebuild_when_meta_hash_differs(self):
        self.assertTrue(supervisor.config_outdated({}))
        self.assertTrue(supervisor.config_outdated({"configHash": "old"}))
        self.assertFalse(supervisor.config_outdated({"configHash": supervisor.config_hash()}))

    def test_snapshot_config_rewrites_custom_models_dir_and_copies_models(self):
        with open(self.config, "w") as f:
            f.write("graphhopper:\n  datareader.file: x\n  custom_models.directory: /app/custom_models\n  profiles: []\n")
        with open(os.path.join(self.app, "custom_models", "foot_night.json"), "w") as f:
            f.write('{"priority": []}')
        graph_new = os.path.join(self.data, "graph-new")
        os.makedirs(graph_new)
        digest = supervisor.snapshot_config(graph_new)
        target = os.path.join(self.data, "graph-cache", "served", "custom_models")
        with open(os.path.join(graph_new, "served", "config.yml")) as f:
            self.assertEqual(f.read(), f"graphhopper:\n  datareader.file: x\n  custom_models.directory: {target}\n  profiles: []\n")
        with open(os.path.join(graph_new, "served", "custom_models", "foot_night.json")) as f:
            self.assertEqual(f.read(), '{"priority": []}')
        self.assertEqual(digest, supervisor.config_hash())

    def test_snapshot_config_copies_as_is_without_custom_models_line(self):
        graph_new = os.path.join(self.data, "graph-new")
        os.makedirs(graph_new)
        supervisor.snapshot_config(graph_new)
        with open(os.path.join(graph_new, "served", "config.yml")) as f:
            self.assertEqual(f.read(), "new")


class RetryDecision(unittest.TestCase):
    def test_retries_without_a_graph(self):
        self.assertTrue(supervisor.should_retry(retry=False, has_graph=False))

    def test_weekly_failure_keeps_old_graph_without_retry(self):
        self.assertFalse(supervisor.should_retry(retry=False, has_graph=True))

    def test_config_rebuild_failure_retries_while_old_graph_serves(self):
        self.assertTrue(supervisor.should_retry(retry=True, has_graph=True))


class FakeProc:
    def __init__(self, code):
        self.code = code

    def poll(self):
        return self.code


class RestartDecision(unittest.TestCase):
    def test_restarts_when_never_started(self):
        self.assertTrue(supervisor.needs_restart(None, swapping=False, has_graph=True))

    def test_restarts_when_process_exited(self):
        self.assertTrue(supervisor.needs_restart(FakeProc(1), swapping=False, has_graph=True))

    def test_leaves_running_process_alone(self):
        self.assertFalse(supervisor.needs_restart(FakeProc(None), swapping=False, has_graph=True))

    def test_waits_while_swapping_graph_dirs(self):
        self.assertFalse(supervisor.needs_restart(None, swapping=True, has_graph=True))
        self.assertFalse(supervisor.needs_restart(FakeProc(1), swapping=True, has_graph=True))

    def test_nothing_to_serve_without_a_graph(self):
        self.assertFalse(supervisor.needs_restart(None, swapping=False, has_graph=False))


class StartServer(unittest.TestCase):
    def setUp(self):
        self.patches = [
            mock.patch.object(supervisor, "server_proc", None),
            mock.patch.object(supervisor, "served_config", return_value="config.yml"),
            mock.patch.object(supervisor, "log"),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_start_is_idempotent_while_running_and_restarts_after_exit(self):
        first = FakeProc(None)
        with mock.patch.object(supervisor.subprocess, "Popen", side_effect=[first, FakeProc(None)]) as popen:
            supervisor.start_server()
            supervisor.start_server()
            self.assertEqual(popen.call_count, 1)
            self.assertIs(supervisor.server_proc, first)
            first.code = 1
            supervisor.start_server()
            self.assertEqual(popen.call_count, 2)
            self.assertIsNot(supervisor.server_proc, first)


if __name__ == "__main__":
    unittest.main()
