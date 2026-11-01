"""Exercise real competing clones and a bare Git remote, without network."""
import concurrent.futures
import importlib.util
import json
import pathlib
import tempfile
import unittest

module_path = pathlib.Path(__file__).resolve().parents[2] / "scripts/claim.py"
spec = importlib.util.spec_from_file_location("claim", module_path)
claim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(claim)


class ClaimTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.remote = self.root / "remote.git"
        claim.git("init", "--bare", str(self.remote))
        self.a = self.root / "a"
        self.b = self.root / "b"
        claim.git("clone", str(self.remote), str(self.a))
        self.configure(self.a, "A")
        claim.git("commit", "--allow-empty", "-m", "seed", cwd=self.a)
        claim.git("push", "origin", "HEAD", cwd=self.a)
        claim.git("clone", str(self.remote), str(self.b))
        self.configure(self.b, "B")

    def configure(self, path, who):
        claim.git("config", "user.name", who, cwd=path)
        claim.git("config", "user.email", f"{who}@example.test", cwd=path)

    def refs(self):
        return claim.git("ls-remote", "origin", "refs/heads/claims/*", cwd=self.a)

    def test_overlapping_area_is_rejected_without_partial_task(self):
        claim.acquire(self.a, "WBS-001", ["cli"])
        with self.assertRaises(RuntimeError):
            claim.acquire(self.b, "WBS-002", ["cli", "ui"])
        self.assertNotIn("task-WBS-002", self.refs())
        self.assertNotIn("area-ui", self.refs())
        claim.release(self.a, "WBS-001")
        self.assertEqual("", self.refs())

    def test_disjoint_tasks_can_run_together(self):
        claim.acquire(self.a, "WBS-001", ["cli"])
        claim.acquire(self.b, "WBS-003", ["shared"])
        claim.release(self.a, "WBS-001")
        self.assertIn("task-WBS-003", self.refs())
        claim.release(self.b, "WBS-003")

    def test_simultaneous_same_task_only_one_wins(self):
        def attempt(path):
            try:
                claim.acquire(path, "WBS-001", ["cli"])
                return path
            except RuntimeError:
                return None
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            winners = list(filter(None, pool.map(attempt, [self.a, self.b])))
        self.assertEqual(1, len(winners))
        claim.release(winners[0], "WBS-001")

    def test_stale_receipt_cannot_delete_new_claim(self):
        old = claim.acquire(self.a, "WBS-001", ["cli"])
        receipt = self.a / ".git/learningxxx-claims/WBS-001.json"
        claim.release(self.a, "WBS-001")
        current = claim.acquire(self.b, "WBS-001", ["cli"])
        receipt.write_text(json.dumps(old))
        with self.assertRaises(RuntimeError):
            claim.release(self.a, "WBS-001")
        self.assertIn(current["sha"], self.refs())
        claim.release(self.b, "WBS-001")


if __name__ == "__main__":
    unittest.main()
