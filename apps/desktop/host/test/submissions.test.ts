import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollectionManifest } from "@learningxxx/contracts";
import { cannotSubmit, readAssignment, submitFile, type CanvasHttp } from "../src/assignment-submit.ts";
import { Submissions } from "../src/submissions.ts";

const COURSE = "11111111-1111-4111-8111-111111111111", RES = "22222222-2222-4222-8222-222222222222";

/** A synthetic Canvas: one assignment, an upload host, and every request recorded. */
function canvas(over: Record<string, unknown> = {}) {
  const state = { attempt: 0, files: [] as string[], uploads: 0, submits: 0, failSubmitOnce: false, calls: [] as { url: string; method: string; body?: URLSearchParams | FormData }[] };
  const assignment = () => ({ id: 77, name: "10주차 ERD", due_at: "2026-11-09T14:59:00Z", lock_at: null, unlock_at: "2026-11-01T00:00:00Z", submission_types: ["online_upload"], allowed_extensions: ["pdf"], locked_for_user: false, allowed_attempts: -1, ...over,
    submission: { workflow_state: state.attempt ? "submitted" : "unsubmitted", attempt: state.attempt || null, submitted_at: state.attempt ? "2026-11-04T05:00:00Z" : null, attachments: state.files.map((f) => ({ display_name: f })) } });
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const http: CanvasHttp = { request: async (url, { method, body }) => {
    state.calls.push({ url, method, ...(body ? { body } : {}) });
    if (url === "/api/v1/courses/1001/assignments/77?include[]=submission") return ok(assignment());
    if (url === "/api/v1/courses/1001/assignments/77/submissions/self/files") return ok({ upload_url: "https://upload.example.test/u", upload_params: { key: "k1" } });
    if (url === "https://upload.example.test/u") { state.uploads++; return new Response(null, { status: 302, headers: { location: "https://khcanvas.example/api/v1/files/555/create_success" } }); }
    if (url === "https://khcanvas.example/api/v1/files/555/create_success") return ok({ id: 555, display_name: "erd.pdf" });
    if (url === "/api/v1/courses/1001/assignments/77/submissions") {
      if (state.failSubmitOnce) { state.failSubmitOnce = false; state.attempt++; state.files = ["erd.pdf"]; return new Response("gateway", { status: 502 }); }
      state.submits++; state.attempt++; state.files = ["erd.pdf"]; return ok({ id: 1 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  } };
  return { http, state };
}
const file = { name: "erd.pdf", bytes: new TextEncoder().encode("%PDF demo"), contentType: "application/pdf" };
const now = new Date("2026-11-04T05:00:00Z");

describe("assignment submission", () => {
  it("says why a file cannot go in", async () => {
    const { http } = canvas();
    const a = await readAssignment(http, "1001", "77");
    assert.equal(cannotSubmit(a, "erd.pdf", now), undefined);
    assert.match(cannotSubmit(a, "erd.hwp", now)!, /허용된 형식/);
    assert.match(cannotSubmit({ ...a, types: ["on_paper"] }, "erd.pdf", now)!, /파일 제출을 받지 않습니다/);
    assert.match(cannotSubmit({ ...a, lockAt: "2026-11-01T00:00:00Z" }, "erd.pdf", now)!, /기간이 끝났습니다/);
    assert.match(cannotSubmit({ ...a, allowedAttempts: 1, submission: { ...a.submission, attempt: 1 } }, "erd.pdf", now)!, /횟수/);
    await assert.rejects(readAssignment(http, "1001", "77/../x"), /잘못된 과제 번호/);
  });

  it("uploads and submits once, sends field values first, and confirms the new attempt", async () => {
    const { http, state } = canvas();
    const before = await readAssignment(http, "1001", "77");
    const result = await submitFile(http, { courseId: "1001", assignmentId: "77", file, before, now });
    assert.deepEqual(result, { attempt: 1, submittedAt: "2026-11-04T05:00:00Z", files: ["erd.pdf"] });
    const form = state.calls.find((c) => c.url === "https://upload.example.test/u")!.body as FormData;
    assert.deepEqual([...form.keys()], ["key", "file"]);
    const submit = state.calls.find((c) => c.url.endsWith("/submissions"))!.body as URLSearchParams;
    assert.equal(submit.get("submission[submission_type]"), "online_upload");
    assert.equal(submit.get("submission[file_ids][]"), "555");
    // Asking again with the same confirmation sends nothing new.
    assert.deepEqual(await submitFile(http, { courseId: "1001", assignmentId: "77", file, before, now }), result);
    assert.equal(state.submits, 1);
    assert.equal(state.uploads, 1);
  });

  it("an answer lost after the LMS took the submission is not submitted twice", async () => {
    const { http, state } = canvas();
    state.failSubmitOnce = true;
    const before = await readAssignment(http, "1001", "77");
    await assert.rejects(submitFile(http, { courseId: "1001", assignmentId: "77", file, before, now }), /502/);
    const again = await submitFile(http, { courseId: "1001", assignmentId: "77", file, before, now });
    assert.equal(again.attempt, 1);
    assert.equal(state.submits, 0, "the retry saw the submission and sent nothing");
  });

  it("refuses a wrong file before anything is uploaded", async () => {
    const { http, state } = canvas();
    const before = await readAssignment(http, "1001", "77");
    await assert.rejects(submitFile(http, { courseId: "1001", assignmentId: "77", file: { ...file, name: "erd.hwp" }, before, now }), /허용된 형식/);
    assert.equal(state.calls.filter((c) => c.method === "POST").length, 0);
  });
});

describe("Submissions service", () => {
  async function setup(over: Record<string, unknown> = {}) {
    const root = await mkdtemp(join(tmpdir(), "submit-"));
    const user = join(root, "erd.pdf"); await writeFile(user, "%PDF demo");
    const c = canvas(over);
    let clock = now;
    const manifest = { course: { sourceCourseId: "1001" }, items: [{ resource: { id: RES, kind: "assignment", source: "lms", sourceId: "77", title: "10주차 ERD" }, assets: [] }] } as unknown as CollectionManifest;
    const autos: unknown[] = [];
    const s = new Submissions({ root, accountKey: () => "acct_abcdefgh", manifest: async () => manifest, http: () => c.http, chooseFile: async () => user, now: () => clock, onAuto: (r) => autos.push(r) });
    return { s, c, autos, setNow: (d: Date) => { clock = d; }, done: () => rm(root, { recursive: true, force: true }) };
  }

  it("shows what will be sent, then submits only after confirmation", async () => {
    const t = await setup();
    try {
      const plan = await t.s.choose(COURSE, RES);
      assert.equal(plan.fileName, "erd.pdf");
      assert.equal(plan.assignment?.name, "10주차 ERD");
      assert.equal(plan.problem, undefined);
      assert.equal(t.c.state.calls.filter((c) => c.method === "POST").length, 0, "choosing sends nothing");
      const result = await t.s.confirm(plan.planId!);
      assert.equal(result.attempt, 1);
      await assert.rejects(t.s.confirm(plan.planId!), /다시 골라/);
    } finally { await t.done(); }
  });

  it("runs a confirmed rule at its time, and skips it when the student submitted meanwhile", async () => {
    const t = await setup();
    try {
      const plan = await t.s.choose(COURSE, RES);
      const rule = await t.s.schedule(plan.planId!, 60);
      assert.equal(rule.at, "2026-11-09T13:59:00Z");
      await t.s.tick();
      assert.equal(t.c.state.submits, 0, "not before its time");
      t.setNow(new Date("2026-11-09T14:00:00Z"));
      await t.s.tick();
      assert.equal(t.c.state.submits, 1);
      assert.deepEqual((await t.s.rules()).rules.map((r) => r.state), ["done"]);
      const plan2 = await t.s.choose(COURSE, RES);
      t.setNow(now);
      await t.s.schedule(plan2.planId!, 60);
      t.c.state.attempt = 2;
      t.setNow(new Date("2026-11-09T14:00:00Z"));
      await t.s.tick();
      assert.equal(t.c.state.submits, 1, "already submitted by hand: nothing sent");
      assert.equal((await t.s.rules()).rules.at(-1)!.state, "already");
      assert.equal(t.autos.length, 2);
    } finally { await t.done(); }
  });

  it("cancels a waiting rule and refuses rules that cannot run", async () => {
    const t = await setup();
    try {
      const plan = await t.s.choose(COURSE, RES);
      const rule = await t.s.schedule(plan.planId!, 60);
      await t.s.cancel(rule.ruleId);
      assert.equal((await t.s.rules()).rules[0]!.state, "cancelled");
      t.setNow(new Date("2026-11-09T14:00:00Z"));
      await t.s.tick();
      assert.equal(t.c.state.submits, 0);
      const late = await t.s.choose(COURSE, RES);
      await assert.rejects(t.s.schedule(late.planId!, 90), /이미 지났습니다/);
    } finally { await t.done(); }
  });
});
