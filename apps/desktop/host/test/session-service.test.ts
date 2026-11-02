import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Run, SCHEMA_VERSION, Session } from "@learningxxx/contracts";
import type { RunEvent } from "@learningxxx/contracts";
import type { RunRequest, StartOutcome } from "@learningxxx/cli-adapter";
import { buildPrompt, SessionService } from "../src/session-service.ts";
import type { StartCli } from "../src/session-service.ts";
import { SessionStore } from "../src/session-store.ts";
import { TranscriptStore } from "../src/transcript-store.ts";

const COURSE = "11111111-1111-4111-8111-000000000001";
const OTHER_COURSE = "11111111-1111-4111-8111-000000000002";
const tick = () => new Promise((resolve) => setImmediate(resolve));

const event = (runId: string, seq: number, type: string, payload: unknown) =>
  ({ schemaVersion: SCHEMA_VERSION, eventId: randomUUID(), runId, seq, occurredAt: "2026-11-02T00:00:00Z", type, payload }) as RunEvent;

function started(req: RunRequest, seq = 0) {
  return event(req.runId, seq, "run.started", {
    appSessionId: req.appSessionId, cliSessionId: req.cliSessionId, mode: req.mode, apiKeySource: "none", tools: [], mcpServers: [],
  });
}

const completing: StartCli = async (req) => ({
  ok: true,
  events: (async function* () {
    yield started(req);
    yield event(req.runId, 1, "run.completed", { exitCode: 0 });
  })(),
});

/** A run that stays open until the test releases it. */
function holding() {
  let release: (event?: RunEvent) => void = () => {};
  const gate = new Promise<RunEvent | undefined>((resolve) => (release = resolve));
  const start: StartCli = async (req) => ({
    ok: true,
    events: (async function* () {
      yield started(req);
      const last = await gate;
      if (last) yield last;
    })(),
  });
  return { start, release: (e?: RunEvent) => release(e) };
}

function setup(startCli: StartCli = completing) {
  const dataRoot = mkdtempSync(join(tmpdir(), "wbs015-"));
  const store = new SessionStore(join(dataRoot, "app-state.json"));
  const calls: RunRequest[] = [];
  const recording: StartCli = (req, signal) => {
    calls.push(req);
    return startCli(req, signal);
  };
  const make = (cli = recording) => new SessionService({ dataRoot, store, startCli: cli });
  return { dataRoot, store, calls, make, service: make() };
}

const draft = (targetSessionId: string, text = "질문") => ({
  text, attachmentIds: [], captureIds: [], targetSessionId, intent: "chat" as const,
});
const run = (service: SessionService, appSessionId: string, requestId: string = randomUUID()) =>
  service.startRun({ requestId, draft: draft(appSessionId) });

async function code(action: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof action === "function" ? action() : action);
  } catch (error) {
    return (error as { appError: { code: string } }).appError.code;
  }
  return assert.fail("expected a failure");
}

test("a course can hold several sessions", () => {
  const { service } = setup();
  const a = service.create({ mode: "course", courseId: COURSE, title: "a" });
  const b = service.create({ mode: "course", courseId: COURSE, title: "b" });
  service.create({ mode: "course", courseId: OTHER_COURSE, title: "c" });
  assert.notEqual(a.appSessionId, b.appSessionId);
  assert.notEqual(a.workspaceKey, b.workspaceKey);
  assert.equal(service.list({ courseId: COURSE, includeArchived: false }).length, 2);
});

test("an independent workspace is a bare UUID with no course in the path", () => {
  const { service, dataRoot } = setup();
  const session = service.create({ mode: "independent", title: "t" });
  Session.parse(session);
  assert.equal(session.workspaceKey, `sessions/${session.appSessionId}`);
  assert.equal(session.courseId, undefined);
  assert.deepEqual(readdirSync(join(dataRoot, session.workspaceKey)), []);
});

test("independent sessions never appear under a course", () => {
  const { service } = setup();
  service.create({ mode: "independent", title: "t" });
  assert.equal(service.list({ courseId: COURSE, includeArchived: false }).length, 0);
});

test("first run opens a CLI session and the next one resumes it", async () => {
  const { service, calls } = setup();
  const { appSessionId } = service.create({ mode: "course", courseId: COURSE, title: "t" });
  await run(service, appSessionId);
  await tick();
  await run(service, appSessionId);
  assert.equal(calls[0]?.resume, false);
  assert.equal(calls[1]?.resume, true);
  assert.equal(calls[1]?.cliSessionId, calls[0]?.cliSessionId);
});

test("two sessions never share a CLI session", async () => {
  const { service, calls } = setup();
  await run(service, service.create({ mode: "independent", title: "a" }).appSessionId);
  await run(service, service.create({ mode: "independent", title: "b" }).appSessionId);
  assert.notEqual(calls[0]?.cliSessionId, calls[1]?.cliSessionId);
});

test("the adapter receives the session's mode and own workspace", async () => {
  const { service, calls, dataRoot } = setup();
  const session = service.create({ mode: "independent", title: "t" });
  await run(service, session.appSessionId);
  assert.equal(calls[0]?.mode, "independent");
  assert.equal(calls[0]?.workspacePath, join(dataRoot, session.workspaceKey));
});

test("a CLI session that never opened is not mapped, so the next run starts fresh", async () => {
  const failing: StartOutcome = { ok: false, error: { code: "CLI_AUTH_REQUIRED", message: "로그인", retryable: false } };
  const { service, make, calls } = setup(async () => failing);
  const { appSessionId } = service.create({ mode: "course", courseId: COURSE, title: "t" });
  const first = await run(service, appSessionId);
  assert.equal(first.status, "failed");
  assert.equal(first.errorCode, "CLI_AUTH_REQUIRED");
  const session = service.list({ includeArchived: false })[0];
  assert.equal(session?.cliSessionId, undefined);
  assert.equal(session?.status, "idle");
  await run(make(completing), appSessionId).catch(() => {});
  assert.equal(calls.length, 1);
});

test("one session runs one request at a time", async () => {
  const hold = holding();
  const { service } = setup(hold.start);
  const { appSessionId } = service.create({ mode: "independent", title: "t" });
  const first = await run(service, appSessionId);
  assert.equal(await code(run(service, appSessionId)), "RUN_ALREADY_ACTIVE");
  hold.release(event(first.runId, 1, "run.completed", { exitCode: 0 }));
  await tick();
  await tick();
  await run(service, appSessionId);
});

test("different sessions can run at the same time", async () => {
  const hold = holding();
  const { service } = setup(hold.start);
  await run(service, service.create({ mode: "independent", title: "a" }).appSessionId);
  await run(service, service.create({ mode: "independent", title: "b" }).appSessionId);
});

test("a repeated requestId returns the same run and starts nothing", async () => {
  const { service, calls } = setup();
  const { appSessionId } = service.create({ mode: "course", courseId: COURSE, title: "t" });
  const requestId = randomUUID();
  const first = await run(service, appSessionId, requestId);
  await tick();
  const again = await run(service, appSessionId, requestId);
  assert.equal(again.runId, first.runId);
  assert.equal(calls.length, 1);
});

test("a simultaneous double click starts one run", async () => {
  const { service, calls } = setup();
  const { appSessionId } = service.create({ mode: "course", courseId: COURSE, title: "t" });
  const requestId = randomUUID();
  await Promise.all([run(service, appSessionId, requestId), run(service, appSessionId, requestId)]);
  assert.equal(calls.length, 1);
});

test("cancel aborts the active run", async () => {
  let signal: AbortSignal | undefined;
  const hold = holding();
  const { service } = setup((req, s) => ((signal = s), hold.start(req, s)));
  const { appSessionId } = service.create({ mode: "independent", title: "t" });
  const active = await run(service, appSessionId);
  service.cancel({ runId: active.runId });
  assert.equal(signal?.aborted, true);
  hold.release(event(active.runId, 1, "run.cancelled", { processExited: true, writtenFiles: [] }));
});

test("a restart marks open runs interrupted and resends nothing", async () => {
  const hold = holding();
  const { service, make, calls } = setup(hold.start);
  const { appSessionId } = service.create({ mode: "course", courseId: COURSE, title: "t" });
  await run(service, appSessionId);
  await tick();
  const restarted = make();
  const session = restarted.list({ includeArchived: false })[0];
  assert.equal(session?.status, "interrupted");
  assert.ok(session?.cliSessionId);
  assert.equal(calls.length, 1);
  await run(restarted, appSessionId).catch(() => {});
  assert.equal(calls.at(-1)?.resume, true);
});

test("sessions and the CLI mapping survive a restart", async () => {
  const { service, make, calls } = setup();
  const { appSessionId } = service.create({ mode: "independent", title: "t" });
  await run(service, appSessionId);
  await tick();
  await run(make(), appSessionId);
  assert.equal(calls[1]?.resume, true);
  assert.equal(calls[1]?.cliSessionId, calls[0]?.cliSessionId);
});

test("a stream that ends without a final event is interrupted, not completed", async () => {
  const { service } = setup(async (req) => ({ ok: true, events: (async function* () { yield started(req); })() }));
  const { appSessionId } = service.create({ mode: "independent", title: "t" });
  await run(service, appSessionId);
  await tick();
  await tick();
  assert.equal(service.list({ includeArchived: false })[0]?.status, "interrupted");
});

test("archive hides without deleting, and can be undone", () => {
  const { service } = setup();
  const { appSessionId } = service.create({ mode: "course", courseId: COURSE, title: "t" });
  assert.ok(service.archive({ appSessionId, archived: true }).archivedAt);
  assert.equal(service.list({ includeArchived: false }).length, 0);
  assert.equal(service.list({ includeArchived: true }).length, 1);
  assert.equal(service.archive({ appSessionId, archived: false }).archivedAt, undefined);
});

test("an archived session cannot run, and a running one cannot be archived", async () => {
  const hold = holding();
  const { service } = setup(hold.start);
  const archived = service.create({ mode: "independent", title: "a" });
  service.archive({ appSessionId: archived.appSessionId, archived: true });
  assert.equal(await code(run(service, archived.appSessionId)), "INVALID_REQUEST");
  const busy = service.create({ mode: "independent", title: "b" });
  await run(service, busy.appSessionId);
  assert.equal(await code(() => service.archive({ appSessionId: busy.appSessionId, archived: true })), "RUN_ALREADY_ACTIVE");
});

test("an unknown session fails plainly", async () => {
  const { service } = setup();
  assert.equal(await code(run(service, randomUUID())), "NOT_FOUND");
});

test("attachments are refused until they can be delivered, never silently dropped", async () => {
  const { service, calls } = setup();
  const { appSessionId } = service.create({ mode: "independent", title: "t" });
  const request = { requestId: randomUUID(), draft: { ...draft(appSessionId), attachmentIds: [randomUUID()] } };
  assert.equal(await code(service.startRun(request)), "INVALID_REQUEST");
  assert.equal(calls.length, 0);
});

test("the prompt holds only what the user sent", () => {
  const selection = { assetId: randomUUID(), text: "gate" };
  assert.equal(buildPrompt(draft("x", "안녕")), "안녕");
  const translated = buildPrompt({ ...draft("x", ""), intent: "translate_en_ko", selection });
  assert.match(translated, /한국어로 번역/);
  assert.match(translated, /gate/);
});

test("stored records stay valid contract objects", async () => {
  const { service, store } = setup();
  const { appSessionId } = service.create({ mode: "independent", title: "t" });
  await run(service, appSessionId);
  await tick();
  const state = store.load();
  state.sessions.forEach((s) => Session.parse(s));
  state.runs.forEach((r) => Run.parse(r));
  assert.equal(state.runs[0]?.status, "completed");
});

test("a corrupt state file is kept aside, not overwritten", () => {
  const { dataRoot, store } = setup();
  const path = join(dataRoot, "app-state.json");
  writeFileSync(path, "{broken");
  assert.deepEqual(store.load(), { sessions: [], runs: [] });
  assert.equal(existsSync(path), false);
  assert.ok(readdirSync(dataRoot).some((name) => name.startsWith("app-state.json.corrupt-")));
});

test("a failing push to the window does not cut the run short", async () => {
  const { dataRoot, store } = setup();
  const service = new SessionService({ dataRoot, store, startCli: completing, onEvent: () => { throw new Error("window closed"); } });
  const session = service.create({ mode: "course", courseId: COURSE, title: "a" });
  const started = await run(service, session.appSessionId);
  await tick();
  await tick();
  const saved = store.load().runs.find((r) => r.runId === started.runId);
  assert.equal(saved?.status, "completed");
  assert.equal(service.list({ includeArchived: false })[0]?.status, "idle");
});

test("cancelling before the CLI opens is recorded as cancelled, not failed", async () => {
  const waiting: StartCli = (_req, signal) =>
    new Promise<StartOutcome>((resolve) =>
      signal.addEventListener("abort", () =>
        resolve({ ok: false, error: { code: "RUN_INTERRUPTED", message: "시작하기 전에 실행을 취소했습니다.", retryable: false } }),
      ),
    );
  const { service, calls } = setup(waiting);
  const session = service.create({ mode: "course", courseId: COURSE, title: "a" });
  const pending = run(service, session.appSessionId);
  await tick();
  service.cancel({ runId: calls[0]!.runId });
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.errorCode, undefined);
  Run.parse(result);
  assert.equal(service.list({ includeArchived: false })[0]?.status, "idle");
});

test("the chat a session showed is still there after a restart, and a cut-off answer says so", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "wbs020-"));
  const store = new SessionStore(join(dataRoot, "app-state.json"));
  const transcripts = new TranscriptStore(join(dataRoot, "transcripts"));
  const answering: StartCli = async (req) => ({
    ok: true,
    events: (async function* () {
      yield started(req);
      yield event(req.runId, 1, "text.delta", { text: "첫 " });
      yield event(req.runId, 2, "text.delta", { text: "답" });
      yield event(req.runId, 3, "run.completed", { exitCode: 0 });
    })(),
  });
  const first = new SessionService({ dataRoot, store, transcripts, startCli: answering });
  const session = first.create({ mode: "course", courseId: COURSE, title: "t" });
  await first.startRun({ requestId: randomUUID(), draft: draft(session.appSessionId, "요점") });
  for (let i = 0; i < 5; i += 1) await tick();

  const cutOff = holding();
  const second = new SessionService({ dataRoot, store, transcripts, startCli: cutOff.start });
  await second.startRun({ requestId: randomUUID(), draft: draft(session.appSessionId, "이어서") });
  await tick();
  // The app quits here: the second answer never finishes.

  const reopened = new SessionService({ dataRoot, store, transcripts, startCli: completing });
  const turns = reopened.transcript(session.appSessionId);
  assert.deepEqual(turns.map((t) => [t.sent.text, t.answer, t.state]), [["요점", "첫 답", "completed"], ["이어서", "", "failed"]]);
  assert.equal(turns[1]!.error?.code, "RUN_INTERRUPTED");
  assert.deepEqual(reopened.transcript(reopened.create({ mode: "independent", title: "i" }).appSessionId), []);
});

test("a course session's CLI gets the course brief; an independent one gets nothing", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "wbs020-"));
  const calls: RunRequest[] = [];
  const service = new SessionService({
    dataRoot,
    store: new SessionStore(join(dataRoot, "app-state.json")),
    startCli: (req, signal) => (calls.push(req), completing(req, signal)),
    courseBrief: async (courseId) => (courseId === COURSE ? "# 이 대화의 과목\n과목: 합성개론\n" : undefined),
  });
  const course = service.create({ mode: "course", courseId: COURSE, title: "c" });
  const other = service.create({ mode: "course", courseId: OTHER_COURSE, title: "o" });
  const independent = service.create({ mode: "independent", title: "i" });
  for (const s of [course, other, independent]) {
    await run(service, s.appSessionId);
    for (let i = 0; i < 3; i += 1) await tick();
  }
  const [c, o, i] = calls;
  assert.equal(c!.contextFile, join(dataRoot, "courses", COURSE, "course-context.md"));
  assert.match(readFileSync(c!.contextFile!, "utf8"), /합성개론/);
  assert.ok(!c!.contextFile!.startsWith(join(dataRoot, course.workspaceKey)), "outside the session folder");
  assert.equal(o!.contextFile, undefined);
  assert.equal(i!.contextFile, undefined);
});
