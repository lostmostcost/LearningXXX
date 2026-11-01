import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SCHEMA_VERSION } from "@learningxxx/contracts";
import type { RunEvent, Session } from "@learningxxx/contracts";
import type { RunRequest } from "@learningxxx/cli-adapter";
import { FileService } from "../src/file-service.ts";
import { resolveScoped } from "../src/path-scope.ts";
import { MAX_SNAPSHOT_BYTES, RunHistory } from "../src/run-history.ts";
import { SessionService } from "../src/session-service.ts";
import type { StartCli } from "../src/session-service.ts";
import { SessionStore } from "../src/session-store.ts";

const COURSE = "11111111-1111-4111-8111-000000000001";
const NOW = "2026-11-02T00:00:00Z";
const tick = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const event = (runId: string, seq: number, type: string, payload: unknown) =>
  ({ schemaVersion: SCHEMA_VERSION, eventId: randomUUID(), runId, seq, occurredAt: NOW, type, payload }) as RunEvent;

/** Stands in for the CLI: changes the disk, then ends the run. */
function cli(work: (req: RunRequest) => void, end = "run.completed"): StartCli {
  return async (req) => ({
    ok: true,
    events: (async function* () {
      yield event(req.runId, 0, "run.started", {
        appSessionId: req.appSessionId, cliSessionId: req.cliSessionId, mode: req.mode, apiKeySource: "none", tools: [], mcpServers: [],
      });
      work(req);
      if (end === "run.completed") yield event(req.runId, 1, "run.completed", { exitCode: 0 });
    })(),
  });
}

function setup(work: (req: RunRequest) => void = () => {}, end?: string) {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "wbs017-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "wbs017-outside-")));
  const calls: RunRequest[] = [];
  const startCli = cli((req) => {
    calls.push(req);
    work(req);
  }, end);
  const options = {
    dataRoot,
    store: new SessionStore(join(dataRoot, "app-state.json")),
    startCli,
    history: (now: () => string) => new RunHistory(join(dataRoot, "history"), now),
  };
  const sessions = new SessionService(options);
  const trashed: string[] = [];
  const confirmed: string[] = [];
  const state = { confirm: true, picked: outside as string | undefined };
  const files = new FileService({
    dataRoot,
    sessions,
    history: sessions.history!,
    chooseFolder: async () => state.picked,
    confirmTrash: async (path) => (confirmed.push(path), state.confirm),
    trash: async (path) => void trashed.push(path),
  });
  return { dataRoot, outside, sessions, files, trashed, confirmed, state, calls, reopen: () => new SessionService(options) };
}

const courseSession = (s: SessionService) => s.create({ mode: "course", courseId: COURSE, title: "t" });
const workspace = (dataRoot: string, session: Session) => join(dataRoot, session.workspaceKey);

async function runOnce(sessions: SessionService, appSessionId: string) {
  const draft = { text: "q", attachmentIds: [], captureIds: [], targetSessionId: appSessionId, intent: "chat" as const };
  const run = await sessions.startRun({ requestId: randomUUID(), draft });
  await tick();
  return run;
}

async function code(action: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof action === "function" ? action() : action);
  } catch (error) {
    return (error as { appError: { code: string } }).appError.code;
  }
  return assert.fail("expected a failure");
}

test("path scope refuses every way out of the root", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wbs017-scope-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "wbs017-out-")));
  symlinkSync(outside, join(root, "link"));
  writeFileSync(join(outside, "secret.txt"), "x");
  assert.equal(resolveScoped(root, "a/b.md"), join(root, "a/b.md"));
  for (const key of ["../x", "a/../../x", "/etc/hosts", "", ".", "link/secret.txt", "link/new.txt", "a\0b"]) {
    assert.equal(resolveScoped(root, key), undefined, key);
  }
});

test("a run's changes are listed by comparing the disk, not by trusting events", async () => {
  const { sessions, dataRoot } = setup((req) => {
    writeFileSync(join(req.workspacePath, "new.md"), "new");
    writeFileSync(join(req.workspacePath, "keep.md"), "changed");
    writeFileSync(join(req.workspacePath, "same.md"), "same");
  });
  const session = courseSession(sessions);
  writeFileSync(join(workspace(dataRoot, session), "keep.md"), "original");
  writeFileSync(join(workspace(dataRoot, session), "same.md"), "same");
  const run = await runOnce(sessions, session.appSessionId);
  const record = sessions.history!.changes(run.runId);
  assert.deepEqual(record?.changes.map((c) => [c.key, c.change]), [["keep.md", "modified"], ["new.md", "created"]]);
});

test("a deletion by the run is reported and can be restored", async () => {
  const { rmSync } = await import("node:fs");
  const { sessions, files, dataRoot } = setup((req) => rmSync(join(req.workspacePath, "a.md")));
  const session = courseSession(sessions);
  const path = join(workspace(dataRoot, session), "a.md");
  writeFileSync(path, "original");
  const run = await runOnce(sessions, session.appSessionId);
  assert.deepEqual(sessions.history!.changes(run.runId)?.changes, [{ key: "a.md", change: "deleted", restorable: true }]);
  assert.deepEqual(await files.restore({ runId: run.runId }), { restored: ["a.md"], skipped: [] });
  assert.equal(readFileSync(path, "utf8"), "original");
});

test("restore returns edits, recreates folders, and sends new files to the Trash", async () => {
  const { sessions, files, dataRoot, trashed } = setup((req) => {
    writeFileSync(join(req.workspacePath, "notes.md"), "changed");
    writeFileSync(join(req.workspacePath, "created.md"), "new");
  });
  const session = courseSession(sessions);
  const dir = workspace(dataRoot, session);
  writeFileSync(join(dir, "notes.md"), "original");
  const run = await runOnce(sessions, session.appSessionId);
  const result = await files.restore({ runId: run.runId });
  assert.deepEqual(result.restored.sort(), ["created.md", "notes.md"]);
  assert.equal(readFileSync(join(dir, "notes.md"), "utf8"), "original");
  assert.deepEqual(trashed, [join(dir, "created.md")]);
  assert.equal(existsSync(join(dir, "created.md")), true, "the app itself deletes nothing");
});

test("a run cut off by a quit still gets a change summary on restart", async () => {
  const { sessions, reopen, dataRoot } = setup((req) => writeFileSync(join(req.workspacePath, "partial.md"), "half"), "none");
  const session = courseSession(sessions);
  const hanging = await runOnce(sessions, session.appSessionId);
  assert.equal(existsSync(join(workspace(dataRoot, session), "partial.md")), true);
  const restarted = reopen();
  assert.deepEqual(restarted.history!.changes(hanging.runId)?.changes.map((c) => c.key), ["partial.md"]);
});

test("the history lives outside the workspace the CLI can read", async () => {
  const { sessions, dataRoot, calls } = setup();
  const session = courseSession(sessions);
  const run = await runOnce(sessions, session.appSessionId);
  const copy = sessions.history!.beforeCopy(run.runId, "x");
  assert.equal(copy.startsWith(`${calls[0]?.workspacePath}/`), false);
  assert.equal(copy.startsWith(dataRoot), true);
});

test("a workspace too large to copy is compared but marked not restorable", async () => {
  const history = new RunHistory(mkdtempSync(join(tmpdir(), "wbs017-h-")), () => NOW);
  const dir = mkdtempSync(join(tmpdir(), "wbs017-big-"));
  const { truncateSync } = await import("node:fs");
  writeFileSync(join(dir, "big.bin"), "");
  truncateSync(join(dir, "big.bin"), MAX_SNAPSHOT_BYTES + 1);
  const runId = randomUUID();
  history.begin(runId, randomUUID(), dir, []);
  writeFileSync(join(dir, "new.md"), "x");
  const record = history.finish(runId);
  assert.equal(record?.snapshotKept, false);
  assert.deepEqual(record?.changes, [{ key: "new.md", change: "created", restorable: false }]);
});

test("a symlink in the workspace is not followed when snapshotting", async () => {
  const { sessions, dataRoot, outside } = setup();
  writeFileSync(join(outside, "secret.txt"), "SYNTHETIC");
  const session = courseSession(sessions);
  symlinkSync(join(outside, "secret.txt"), join(workspace(dataRoot, session), "link.txt"));
  const run = await runOnce(sessions, session.appSessionId);
  assert.equal(existsSync(sessions.history!.beforeCopy(run.runId, "link.txt")), false);
});

test("trash asks first, showing the full path, and honours a refusal", async () => {
  const { sessions, files, dataRoot, trashed, confirmed, state } = setup();
  const session = courseSession(sessions);
  const path = join(workspace(dataRoot, session), "a.md");
  writeFileSync(path, "x");
  state.confirm = false;
  assert.deepEqual(await files.trash({ appSessionId: session.appSessionId, key: "a.md" }), { trashed: false });
  assert.deepEqual(trashed, []);
  assert.deepEqual(confirmed, [path]);
  state.confirm = true;
  assert.deepEqual(await files.trash({ appSessionId: session.appSessionId, key: "a.md" }), { trashed: true });
  assert.deepEqual(trashed, [path]);
});

test("trash cannot reach outside the session, including through a symlink", async () => {
  const { sessions, files, dataRoot, outside, confirmed } = setup();
  const session = courseSession(sessions);
  const dir = workspace(dataRoot, session);
  writeFileSync(join(outside, "secret.txt"), "x");
  symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
  mkdirSync(join(dataRoot, "library"));
  writeFileSync(join(dataRoot, "library/original.pdf"), "x");
  for (const key of ["link.txt", "../../../../library/original.pdf", "/etc/hosts", "external-0/x"]) {
    assert.equal(await code(files.trash({ appSessionId: session.appSessionId, key })), "SCOPE_VIOLATION", key);
  }
  assert.deepEqual(confirmed, []);
});

test("a chosen folder reaches that session's runs only", async () => {
  const { sessions, files, outside, calls } = setup();
  const a = courseSession(sessions);
  const b = courseSession(sessions);
  assert.deepEqual((await files.chooseFolder({ appSessionId: a.appSessionId })).externalFolders, [outside]);
  await runOnce(sessions, a.appSessionId);
  await runOnce(sessions, b.appSessionId);
  assert.deepEqual(calls[0]?.writableDirs, [outside]);
  assert.equal(calls[1]?.writableDirs, undefined);
});

test("an independent session cannot be given a folder", async () => {
  const { sessions, files } = setup();
  const session = sessions.create({ mode: "independent", title: "t" });
  assert.equal(await code(files.chooseFolder({ appSessionId: session.appSessionId })), "SCOPE_VIOLATION");
});

test("too-broad folders and the app's own data are refused", async () => {
  const { sessions, files, state, dataRoot } = setup();
  const session = courseSession(sessions);
  mkdirSync(join(dataRoot, "library"));
  for (const folder of ["/", homedir(), dirname(homedir()), dataRoot, join(dataRoot, "library")]) {
    state.picked = folder;
    assert.equal(await code(files.chooseFolder({ appSessionId: session.appSessionId })), "SCOPE_VIOLATION", folder);
  }
});

test("cancelling the picker changes nothing", async () => {
  const { sessions, files, state } = setup();
  const session = courseSession(sessions);
  state.picked = undefined;
  assert.equal((await files.chooseFolder({ appSessionId: session.appSessionId })).externalFolders, undefined);
});

test("removing a folder ends access on the next run", async () => {
  const { sessions, files, outside, calls } = setup();
  const session = courseSession(sessions);
  await files.chooseFolder({ appSessionId: session.appSessionId });
  files.removeFolder({ appSessionId: session.appSessionId, folder: outside });
  await runOnce(sessions, session.appSessionId);
  assert.equal(calls[0]?.writableDirs, undefined);
});

test("external changes are listed but not claimed as restorable", async () => {
  const { sessions, files, outside } = setup((req) => writeFileSync(join(req.writableDirs![0]!, "report.md"), "x"));
  const session = courseSession(sessions);
  await files.chooseFolder({ appSessionId: session.appSessionId });
  const run = await runOnce(sessions, session.appSessionId);
  assert.deepEqual(sessions.history!.changes(run.runId)?.changes, [{ key: "external-0/report.md", change: "created", restorable: false }]);
  assert.deepEqual(await files.restore({ runId: run.runId }), { restored: [], skipped: ["external-0/report.md"] });
});
