import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { RunChanges, Session } from "@learningxxx/contracts";
import { canGrantFolders, canTrash, displayKey, hasRestorable, recordsFor, recoveryNote, restoreSummary } from "../src/files.ts";

const record = (over: Partial<RunChanges> = {}): RunChanges =>
  RunChanges.parse({
    runId: randomUUID(), appSessionId: randomUUID(), recordedAt: "2026-11-02T00:00:00Z", snapshotKept: true, externalFolders: [],
    changes: [{ key: "a.md", change: "modified", restorable: true }], ...over,
  });

test("external keys show the folder name, not an index", () => {
  assert.equal(displayKey("external-1/r.md", ["/a/first", "/b/second"]), "second/r.md");
  assert.equal(displayKey("external-5/r.md", []), "외부 폴더/r.md");
  assert.equal(displayKey("notes/a.md"), "notes/a.md");
});

test("a list that arrived for another session is dropped", () => {
  const mine = record();
  assert.deepEqual(recordsFor([record(), mine], mine.appSessionId), [mine]);
});

test("the panel is rebuilt per session, so nothing carries across a switch", async () => {
  const { readFileSync } = await import("node:fs");
  const panel = readFileSync(new URL("../src/ChatPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /<FilesSection key=\{active\.appSessionId\}/);
});

test("only an existing file can go to the Trash", () => {
  assert.equal(canTrash({ key: "a", change: "created", restorable: true }), true);
  assert.equal(canTrash({ key: "a", change: "deleted", restorable: true }), false);
});

test("independent sessions are not offered external folders", () => {
  const base = { appSessionId: randomUUID(), createdAt: "2026-11-02T00:00:00Z", lastUsedAt: "2026-11-02T00:00:00Z", title: "t", status: "idle" };
  const independent = Session.parse({ ...base, mode: "independent", workspaceKey: `sessions/${randomUUID()}` });
  const course = Session.parse({ ...base, mode: "course", courseId: randomUUID(), workspaceKey: "courses/x/sessions/y" });
  assert.equal(canGrantFolders(independent), false);
  assert.equal(canGrantFolders(course), true);
});

test("restore is not offered when nothing can be restored", () => {
  assert.equal(hasRestorable(record()), true);
  assert.equal(hasRestorable(record({ snapshotKept: false, changes: [{ key: "a.md", change: "created", restorable: false }] })), false);
});

test("the recovery note states the real limit", () => {
  assert.match(recoveryNote(record()), /휴지통/);
  assert.match(recoveryNote(record({ snapshotKept: false })), /되돌릴 수 없습니다/);
  assert.match(recoveryNote(record({ changes: [{ key: "external-0/a", change: "created", restorable: false }] })), /외부 폴더/);
});

test("the restore result names what was skipped", () => {
  assert.equal(restoreSummary({ restored: ["a"], skipped: [] }), "1개를 되돌렸습니다.");
  assert.match(restoreSummary({ restored: [], skipped: ["notes.md"] }), /notes\.md/);
});
