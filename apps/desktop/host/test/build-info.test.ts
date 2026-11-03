import assert from "node:assert/strict";
import { test } from "node:test";
import { readBuildInfo } from "../src/build-info.ts";

const git = (answers: Record<string, string>) => async (args: string[]) => {
  const key = args.join(" ");
  if (!(key in answers)) throw new Error(`unexpected git ${key}`);
  return answers[key]!;
};
const answers = {
  "rev-parse --abbrev-ref HEAD": "feat/WBS-061-dev-version-label",
  "rev-parse --short HEAD": "a1b2c3d",
  "rev-parse --show-toplevel": "/Users/x/LearningXXX/.claude/worktrees/wbs-061",
  "status --porcelain --untracked-files=no": " M apps/desktop/ui/src/App.tsx",
};

test("a development run reports branch, WBS task, commit, folder and uncommitted changes", async () => {
  assert.deepEqual(await readBuildInfo("/app", false, git(answers)), { dev: true, branch: "feat/WBS-061-dev-version-label", commit: "a1b2c3d", task: "WBS-061", dirty: true, folder: "wbs-061" });
});

test("a detached checkout, a missing git and a packaged app are all handled", async () => {
  assert.equal((await readBuildInfo("/app", false, git({ ...answers, "rev-parse --abbrev-ref HEAD": "HEAD" }))).branch, "(detached)");
  assert.deepEqual(await readBuildInfo("/app", false, async () => { throw new Error("no git"); }), { dev: true });
  assert.deepEqual(await readBuildInfo("/app", true, async () => { throw new Error("not called"); }), { dev: false });
});
