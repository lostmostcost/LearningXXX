"""Toolchain pins stay consistent; inside the shared container they are actually installed."""
import json
import os
import pathlib
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
TOOLCHAIN = json.loads((ROOT / "infra/dev/toolchain.json").read_text())
DOCKERFILE = (ROOT / "infra/dev/Dockerfile").read_text()
IN_CONTAINER = os.environ.get("LEARNINGXXX_CONTAINER") == "1"


class ToolchainPinTests(unittest.TestCase):
    def test_dockerfile_uses_pinned_images_and_versions(self):
        self.assertIn(f"FROM {TOOLCHAIN['node']['image']} AS node", DOCKERFILE)
        self.assertIn(f"python:{TOOLCHAIN['python']['container']}-slim-bookworm@sha256:", DOCKERFILE)
        self.assertIn(f"pnpm@{TOOLCHAIN['pnpm']['version']}", DOCKERFILE)
        self.assertTrue(TOOLCHAIN["node"]["image"].startswith(
            f"node:{TOOLCHAIN['node']['version']}-"))

    def test_every_base_image_is_digest_pinned(self):
        for line in DOCKERFILE.splitlines():
            if line.startswith("FROM "):
                self.assertIn("@sha256:", line, line)

    @unittest.skipUnless(IN_CONTAINER, "installed versions are checked in the shared container")
    def test_container_has_pinned_node_and_pnpm(self):
        node = subprocess.check_output(["node", "--version"], text=True).strip()
        pnpm = subprocess.check_output(["pnpm", "--version"], text=True).strip()
        self.assertEqual(f"v{TOOLCHAIN['node']['version']}", node)
        self.assertEqual(TOOLCHAIN["pnpm"]["version"], pnpm)


if __name__ == "__main__":
    unittest.main()
