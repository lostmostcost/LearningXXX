import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDetail, buildLabel } from "../src/build-label.ts";

test("a development run is labelled by its WBS task and commit; a packaged app is not", () => {
  assert.equal(buildLabel({ dev: true, branch: "feat/WBS-061-dev-version-label", task: "WBS-061", commit: "a1b2c3d", dirty: true, folder: "wbs-061" }), "개발 · WBS-061 · a1b2c3d · 수정됨");
  assert.equal(buildLabel({ dev: true, branch: "main", commit: "a1b2c3d", dirty: false }), "개발 · main · a1b2c3d");
  assert.equal(buildLabel({ dev: true }), "개발 · 개발 실행");
  assert.equal(buildLabel({ dev: false }), undefined);
  assert.equal(buildLabel(undefined), undefined);
  assert.equal(buildDetail({ dev: true, branch: "main", folder: "LearningXXX", commit: "a1b2c3d" }), "브랜치 main · 폴더 LearningXXX · 커밋 a1b2c3d");
});
