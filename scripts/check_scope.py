#!/usr/bin/env python3
"""Check committed branch paths against its WBS allowlist (not authorization)."""
import json
import pathlib
import subprocess
import sys

if len(sys.argv) != 3:
    sys.exit("Usage: python3 scripts/check_scope.py WBS-NNN origin/main")
root = pathlib.Path(__file__).resolve().parents[1]
tasks = json.loads((root / "docs/pm/wbs.json").read_text())["tasks"]
task = next((t for t in tasks if t["id"] == sys.argv[1]), None)
if task is None:
    sys.exit("Unknown WBS ID")
# --no-renames includes both removed and added paths; a rename cannot hide scope.
output = subprocess.check_output(["git", "diff", "--no-renames", "--name-only", "-z",
                                  f"{sys.argv[2]}...HEAD"], cwd=root)
paths = [p.decode() for p in output.split(b"\0") if p]
outside = [p for p in paths if not any(
    p.startswith(a) if a.endswith("/") else p == a for a in task["paths"])]
if outside:
    sys.exit("Outside task scope:\n" + "\n".join(outside))
print(f"PASS: {len(paths)} committed paths in {task['id']} scope; review uncommitted files separately")
