import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { ComposerDraft, Run, SCHEMA_VERSION, Session } from "@learningxxx/contracts";
import type { RunEvent } from "@learningxxx/contracts";
import { addTurn, applyEvent, emptyTranscript, errorHelp, openRun, withHistory } from "../src/chat.ts";
import { emptyDraft, freeze, sendBlock, viewingFor, viewingOf, visibleSessions, type Draft } from "../src/composer.ts";

const COURSE = "aaaaaaaa-0000-4000-8000-000000000001";
const session = (over: Partial<Session> = {}): Session =>
  Session.parse({
    appSessionId: randomUUID(), mode: "course", courseId: COURSE, workspaceKey: "courses/x/sessions/y", title: "s",
    createdAt: "2026-11-01T00:00:00Z", lastUsedAt: "2026-11-01T00:00:00Z", status: "idle", ...over,
  });
const independent = () => {
  const id = randomUUID();
  return session({ appSessionId: id, mode: "independent", courseId: undefined, workspaceKey: `sessions/${id}` });
};
const text = (t: string): Draft => ({ ...emptyDraft(), text: t });

describe("send lock", () => {
  const s = session();
  const cases: [string, Draft, Session | undefined, boolean, string | undefined][] = [
    ["no session", text("hi"), undefined, false, "no_session"],
    ["archived", text("hi"), session({ archivedAt: "2026-11-01T01:00:00Z" }), false, "archived"],
    ["a run is open", text("hi"), s, true, "running"],
    ["blank text", text("   "), s, false, "empty"],
    ["attachment still preparing", { ...text("hi"), attachments: [{ id: randomUUID(), name: "a.pdf", status: "preparing" }] }, s, false, "preparing"],
    ["failed attachment", { ...text("hi"), attachments: [{ id: randomUUID(), name: "a.pdf", status: "failed" }] }, s, false, "failed_attachment"],
    ["selection only", { ...emptyDraft(), intent: "explain_simply", selection: { assetId: randomUUID(), text: "De Morgan" } }, s, false, undefined],
    ["ready", text("hi"), s, false, undefined],
  ];
  for (const [label, draft, target, running, expected] of cases) test(label, () => assert.equal(sendBlock(draft, target, running), expected));
});

describe("frozen at send time", () => {
  test("the target session is fixed when frozen, and later edits do not reach it", () => {
    const a = session();
    const draft = text("질문 A");
    const sent = freeze(draft, a.appSessionId);
    draft.text = "바뀐 내용";
    assert.equal(sent.targetSessionId, a.appSessionId);
    assert.equal(sent.text, "질문 A");
    ComposerDraft.parse(sent);
  });

  test("attachments are frozen by id; an invalid draft is never produced", () => {
    const id = randomUUID();
    const sent = freeze({ ...text("x"), attachments: [{ id, name: "a.pdf", status: "ready" }] }, randomUUID());
    assert.deepEqual(sent.attachmentIds, [id]);
    assert.throws(() => freeze({ ...emptyDraft(), intent: "translate_en_ko" }, randomUUID()), "translate needs a selection");
  });

  test("sessions are listed per course and independent sessions stay separate", () => {
    const mine = session();
    const other = session({ courseId: "aaaaaaaa-0000-4000-8000-000000000002" });
    const free = independent();
    const shown = visibleSessions([mine, other, free], COURSE);
    assert.deepEqual(shown.course.map((s) => s.appSessionId), [mine.appSessionId]);
    assert.deepEqual(shown.independent.map((s) => s.appSessionId), [free.appSessionId]);
  });
});

describe("transcript from host events", () => {
  const s = session();
  const run = Run.parse({ runId: randomUUID(), appSessionId: s.appSessionId, requestId: randomUUID(), startedAt: "2026-11-01T00:00:00Z", status: "streaming" });
  const sent = freeze(text("질문"), s.appSessionId);
  const ev = (seq: number, type: string, payload: unknown, runId = run.runId) =>
    ({ schemaVersion: SCHEMA_VERSION, eventId: randomUUID(), runId, seq, occurredAt: "2026-11-01T00:00:01Z", type, payload }) as RunEvent;
  const startedEv = ev(0, "run.started", { appSessionId: s.appSessionId, cliSessionId: randomUUID(), mode: "course", apiKeySource: "none", tools: [], mcpServers: [] });

  test("events that arrive before the run.start answer are replayed, so no words are lost", () => {
    let t = emptyTranscript();
    t = applyEvent(t, startedEv);
    t = applyEvent(t, ev(1, "text.delta", { text: "안녕" }));
    assert.equal(t.turns.length, 0);
    t = addTurn(t, run, sent);
    t = applyEvent(t, ev(2, "text.delta", { text: "하세요" }));
    t = applyEvent(t, ev(3, "run.completed", { exitCode: 0 }));
    assert.equal(t.turns[0]!.answer, "안녕하세요");
    assert.equal(t.turns[0]!.state, "completed");
    assert.deepEqual(t.early, []);
  });

  test("events of runs this window did not start never become turns", () => {
    let t = addTurn(emptyTranscript(), run, sent);
    t = applyEvent(t, ev(0, "text.delta", { text: "남의 응답" }, randomUUID()));
    assert.equal(t.turns.length, 1);
    assert.equal(t.turns[0]!.answer, "");
  });

  test("one open run per session; it closes on failure with the error kept for the user", () => {
    let t = addTurn(emptyTranscript(), run, sent);
    assert.ok(openRun(t, s.appSessionId));
    assert.equal(openRun(t, randomUUID()), undefined);
    t = applyEvent(t, ev(1, "tool.requested", { toolUseId: "t1", tool: "Read", targetKeys: ["<outside>"], decision: "denied" }));
    t = applyEvent(t, ev(2, "run.failed", { exitCode: 1, error: { code: "USAGE_LIMIT", message: "한도", retryable: true, retryAfter: "2026-11-01T05:00:00Z" } }));
    assert.equal(openRun(t, s.appSessionId), undefined);
    assert.deepEqual(t.turns[0]!.tools, [{ tool: "Read", decision: "denied", targets: ["<outside>"] }]);
    const help = errorHelp(t.turns[0]!.error!);
    assert.ok(help.retry);
    assert.ok(help.text.includes("이후에 다시 보내세요"));
  });

  test("retry is not offered where resending cannot help", () => {
    assert.equal(errorHelp({ code: "SESSION_NOT_FOUND", message: "없음", retryable: false }).retry, false);
    assert.equal(errorHelp({ code: "ISOLATION_VIOLATION", message: "경계", retryable: false }).retry, false);
    assert.equal(errorHelp({ code: "CLI_AUTH_REQUIRED", message: "로그인", retryable: false }).retry, true);
  });
});

test("saved turns from before a restart come first and never replace what this window saw", () => {
  const appSessionId = randomUUID();
  const sent = { text: "q", attachmentIds: [], captureIds: [], targetSessionId: appSessionId, intent: "chat" as const };
  const saved = (runId: string, answer: string) => ({ runId, appSessionId, sent, answer, tools: [], artifacts: [], state: "completed" as const });
  const old = randomUUID(), live = randomUUID();
  const now = addTurn(emptyTranscript(), Run.parse({ runId: live, appSessionId, requestId: randomUUID(), startedAt: "2026-11-02T00:00:00Z", status: "streaming" }), sent);
  const merged = withHistory(now, [saved(old, "예전 답"), saved(live, "저장된 사본")]);
  assert.deepEqual(merged.turns.map((t) => [t.runId, t.answer]), [[old, "예전 답"], [live, ""]]);
  assert.equal(withHistory(merged, [saved(old, "예전 답")]), merged);
});

test("what is on screen goes only to a session of the course on screen", () => {
  const a = randomUUID(), b = randomUUID(), course = randomUUID();
  assert.deepEqual(viewingOf([a, b], { assetId: b, page: 4 }), { assetId: b, page: 4 });
  assert.deepEqual(viewingOf([a], { assetId: b, page: 4 }), { assetId: a }, "a page from another material is not reused");
  assert.equal(viewingOf([], undefined), undefined);
  const viewing = { assetId: a, page: 2 };
  const base = { workspaceKey: "w", title: "t", createdAt: "2026-11-02T00:00:00Z", lastUsedAt: "2026-11-02T00:00:00Z", status: "idle" as const };
  const own = Session.parse({ ...base, appSessionId: randomUUID(), mode: "course", courseId: course });
  const other = Session.parse({ ...base, appSessionId: randomUUID(), mode: "course", courseId: randomUUID() });
  const independent = Session.parse({ ...base, appSessionId: randomUUID(), mode: "independent", workspaceKey: `sessions/${randomUUID()}` });
  assert.deepEqual(viewingFor(own, course, viewing), viewing);
  assert.equal(viewingFor(other, course, viewing), undefined);
  assert.equal(viewingFor(independent, course, viewing), undefined);
  assert.deepEqual(freeze(emptyDraftWithText(), own.appSessionId, viewing).viewing, viewing);
});

function emptyDraftWithText(): Draft {
  return { ...emptyDraft(), text: "정리해줘" };
}
