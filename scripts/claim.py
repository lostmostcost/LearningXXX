#!/usr/bin/env python3
"""Atomic, cooperative task/area claims using Git refs. No Notion auto-sync."""
import argparse
import datetime
import json
import pathlib
import re
import subprocess
import sys
import uuid


def git(*args, cwd=None, input=None):
    result = subprocess.run(["git", *args], cwd=cwd, input=input, text=True,
                            capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result.stdout.strip()


def acquire(cwd, task, areas, remote="origin"):
    if not re.fullmatch(r"WBS-\d{3}", task):
        raise ValueError("Invalid task ID")
    if not areas or any(not re.fullmatch(r"[a-z][a-z0-9-]*", a) for a in areas):
        raise ValueError("Invalid claim areas")
    receipt_dir = pathlib.Path(git("rev-parse", "--git-common-dir", cwd=cwd))
    if not receipt_dir.is_absolute():
        receipt_dir = pathlib.Path(cwd) / receipt_dir
    receipt_dir = receipt_dir / "learningxxx-claims"
    receipt_dir.mkdir(parents=True, exist_ok=True)
    receipt = receipt_dir / f"{task}.json"
    metadata = {"task": task, "areas": sorted(set(areas)), "remote": remote,
                "owner": git("var", "GIT_AUTHOR_IDENT", cwd=cwd),
                "time": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "nonce": str(uuid.uuid4())}
    head = git("rev-parse", "HEAD", cwd=cwd)
    tree = git("rev-parse", "HEAD^{tree}", cwd=cwd)
    sha = git("commit-tree", tree, "-p", head, cwd=cwd,
              input=json.dumps(metadata, ensure_ascii=False) + "\n")
    refs = [f"refs/heads/claims/task-{task}"] + [
        f"refs/heads/claims/area-{a}" for a in metadata["areas"]]
    record = {**metadata, "sha": sha, "refs": refs}
    # Reserve locally before network I/O. A network ambiguity keeps the receipt.
    with receipt.open("x") as handle:
        json.dump(record, handle, indent=2)
    try:
        git("push", "--atomic", *[f"--force-with-lease={r}:" for r in refs],
            remote, *[f"{sha}:{r}" for r in refs], cwd=cwd)
    except RuntimeError:
        # Delete receipt only if we can prove none of our refs reached remote.
        try:
            remote_state = git("ls-remote", remote, *refs, cwd=cwd)
            if not any(line.split()[0] == sha for line in remote_state.splitlines()):
                receipt.unlink()
        except RuntimeError:
            pass
        raise
    return record


def release(cwd, task):
    if not re.fullmatch(r"WBS-\d{3}", task):
        raise ValueError("Invalid task ID")
    common = pathlib.Path(git("rev-parse", "--git-common-dir", cwd=cwd))
    if not common.is_absolute():
        common = pathlib.Path(cwd) / common
    receipt = common / "learningxxx-claims" / f"{task}.json"
    record = json.loads(receipt.read_text())
    # Compare-and-delete is atomic remotely; no stale clone can release new claims.
    git("push", "--atomic",
        *[f"--force-with-lease={r}:{record['sha']}" for r in record["refs"]],
        record["remote"], *[f":{r}" for r in record["refs"]], cwd=cwd)
    receipt.unlink()
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["acquire", "release"])
    parser.add_argument("task")
    parser.add_argument("--ready-confirmed", action="store_true",
                        help="Acknowledge checking live Notion Ready/dependencies")
    args = parser.parse_args()
    root = pathlib.Path(git("rev-parse", "--show-toplevel"))
    if args.action == "acquire":
        if not args.ready_confirmed:
            parser.error("Read current Notion Ready/dependencies, then pass --ready-confirmed")
        tasks = json.loads((root / "docs/pm/wbs.json").read_text())["tasks"]
        task = next((t for t in tasks if t["id"] == args.task), None)
        if not task:
            parser.error("Unknown WBS ID")
        record = acquire(root, args.task, task["areas"])
    else:
        record = release(root, args.task)
    print(json.dumps({"action": args.action, "task": args.task,
                      "areas": record["areas"], "sha": record["sha"]}))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, OSError) as error:
        print(f"Claim failed: {error}", file=sys.stderr)
        sys.exit(1)
