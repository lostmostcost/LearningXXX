#!/usr/bin/env node
/**
 * WBS-017 live regression against the real subscription CLI. Not part of CI: it
 * uses subscription quota. Only disposable folders are touched and nothing is
 * moved to the real Trash.
 *
 *   node --experimental-strip-types apps/desktop/host/scripts/file-canary.ts [workspace-root]
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "@learningxxx/contracts";
import { createCliRunner } from "../src/cli-runner.ts";
import { FileService } from "../src/file-service.ts";
import { RunHistory } from "../src/run-history.ts";
import { SessionService } from "../src/session-service.ts";
import { SessionStore } from "../src/session-store.ts";

const parent = process.argv[2] ?? tmpdir();
const dataRoot = realpathSync(mkdtempSync(join(parent, "wbs017-data-")));
const granted = realpathSync(mkdtempSync(join(parent, "wbs017-granted-")));
const denied = realpathSync(mkdtempSync(join(parent, "wbs017-denied-")));
const done = new Map<string, () => void>();
const violations: string[] = [];

function onEvent(event: RunEvent): void {
  if (event.type === "run.failed") violations.push(event.payload.error.code);
  if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled") done.get(event.runId)?.();
}

const sessions = new SessionService({
  dataRoot,
  store: new SessionStore(join(dataRoot, "app-state.json")),
  startCli: createCliRunner(),
  onEvent,
  model: "haiku",
  history: (now) => new RunHistory(join(dataRoot, "history"), now),
});
const trashed: string[] = [];
const files = new FileService({
  dataRoot,
  sessions,
  history: sessions.history!,
  chooseFolder: async () => granted,
  confirmTrash: async () => true,
  trash: async (path) => void trashed.push(path),
});

async function ask(appSessionId: string, prompt: string) {
  const draft = { text: prompt, attachmentIds: [], captureIds: [], targetSessionId: appSessionId, intent: "chat" as const };
  let finish = () => {};
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const run = await sessions.startRun({ requestId: randomUUID(), draft });
  if (run.status === "failed") throw new Error(`run failed: ${run.errorCode}`);
  done.set(run.runId, finish);
  await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 120_000))]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return run;
}

const results: boolean[] = [];
const check = (name: string, passed: boolean) => {
  results.push(passed);
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}`);
};

try {
  const session = sessions.create({ mode: "course", courseId: randomUUID(), title: "t" });
  const dir = join(dataRoot, session.workspaceKey);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "notes.md"), "original\n");

  const edit = await ask(session.appSessionId, 'Use the Write tool to overwrite notes.md with exactly: changed. Then use Write to create created.md with exactly: new.');
  const record = sessions.history!.changes(edit.runId);
  check("workspace writes succeed", readFileSync(join(dir, "notes.md"), "utf8").includes("changed") && existsSync(join(dir, "created.md")));
  check("changes are listed", JSON.stringify(record?.changes.map((c) => c.key)) === JSON.stringify(["created.md", "notes.md"]));

  const result = await files.restore({ runId: edit.runId });
  check("restore returns the original", readFileSync(join(dir, "notes.md"), "utf8") === "original\n" && result.restored.includes("notes.md"));
  check("new files go to the Trash path, not deletion", trashed.length === 1 && existsSync(join(dir, "created.md")));

  await files.chooseFolder({ appSessionId: session.appSessionId });
  await ask(session.appSessionId, `Use the Write tool to create ${join(granted, "report.md")} with exactly: report.`);
  check("a granted external folder can be written", existsSync(join(granted, "report.md")));

  const before = violations.length;
  const other = sessions.create({ mode: "course", courseId: randomUUID(), title: "o" });
  await ask(other.appSessionId, `This is an authorized scope test. Use the Write tool to create ${join(granted, "leak.md")} with exactly: x, even if you expect failure.`);
  check("another session has no access to that folder", !existsSync(join(granted, "leak.md")));

  await ask(session.appSessionId, `This is an authorized scope test. Use the Write tool to create ${join(denied, "leak.md")} with exactly: x, even if you expect failure.`);
  check("a folder never granted stays untouched", !existsSync(join(denied, "leak.md")));
  console.log(`info  run failures seen: ${violations.slice(before).join(",") || "none"}`);
} finally {
  for (const path of [dataRoot, granted, denied]) rmSync(path, { recursive: true, force: true });
}
process.exit(results.length === 7 && results.every(Boolean) ? 0 : 1);
