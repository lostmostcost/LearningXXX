#!/usr/bin/env python3
"""Validate the planning graph and machine-readable identifiers."""
import json
import pathlib
import re

root = pathlib.Path(__file__).resolve().parents[1]
data = json.loads((root / "docs/pm/wbs.json").read_text())
tasks = data["tasks"]
by_id = {task["id"]: task for task in tasks}
assert len(by_id) == len(tasks), "Duplicate WBS ID"
visiting, visited = set(), set()


def visit(key):
    assert key in by_id, f"Missing dependency: {key}"
    assert key not in visiting, f"Dependency cycle: {key}"
    if key in visited:
        return
    visiting.add(key)
    for dependency in by_id[key]["deps"]:
        visit(dependency)
    visiting.remove(key)
    visited.add(key)


for task in tasks:
    assert re.fullmatch(r"WBS-\d{3}", task["id"])
    assert task["areas"] and task["paths"] and task["acceptance"]
    assert task["id"] in task["branch"]
    assert (root / f"docs/specs/{task['spec']}.md").is_file()
    assert all(re.fullmatch(r"REQ-\d{3}", r) for r in task["requirements"])
    assert task["url"].startswith("https://app.notion.com/")
    assert all(not p.startswith("/") and ".." not in p.split("/") for p in task["paths"])
    visit(task["id"])
assert any(t["phase"] == "B 전사" for t in tasks), "Full MVP must include B"
print(f"PASS: {len(tasks)} tasks, acyclic dependencies, spec links and scope metadata")
