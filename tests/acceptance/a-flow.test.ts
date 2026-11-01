import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { buildLibrary } from "../../apps/desktop/ui/src/library.ts";
import { viewTarget } from "../../apps/desktop/ui/src/document.ts";
import { openPdf, type PdfLib } from "../../apps/desktop/ui/src/pdf.ts";
import { emptyDraft, freeze, withSelection } from "../../apps/desktop/ui/src/composer.ts";
import { addTurn, applyEvent, emptyTranscript, errorHelp } from "../../apps/desktop/ui/src/chat.ts";
import { CAPTURE_PNG, harness, until, STORAGE } from "./harness.ts";

const requireUi = createRequire(new URL("../../apps/desktop/ui/package.json", import.meta.url));
const pdfjs: PdfLib = await import(pathToFileURL(requireUi.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
const draft = (target: string, text = "explicit question") => freeze({ ...emptyDraft(), text }, target);

test("manual collection → local PDF → explicit excerpt → IPC → adapter → fake CLI → restart/resume", async (t) => {
  const h = await harness(t);
  await h.collect();
  const [course] = (await h.ok("library.courses", {})).courses;
  assert.ok(course);
  const { manifest } = await h.ok("library.manifest", { courseId: course.id });
  assert.ok(manifest);
  const library = buildLibrary(manifest);
  const entry = library.weeks.flatMap((w) => w.entries)[0]!;
  const target = viewTarget(entry);
  assert.equal(target.kind, "pdf");
  if (target.kind !== "pdf") return;
  const bytes = await h.ok("library.asset", { courseId: course.id, assetId: target.asset.id });
  const pdf = await openPdf(pdfjs, bytes.bytes, { verbosity: 0 });
  t.after(() => pdf.close());
  assert.deepEqual(pdf.state, { kind: "ready", pageCount: 2, hasText: true });
  const content = await (await pdf.doc!.getPage(1)).getTextContent();
  assert.ok(content.items.some((i) => "str" in i && i.str.includes("selected excerpt")));
  const { session } = await h.ok("session.create", { mode: "independent", title: "fresh" });
  const selected = freeze(withSelection(emptyDraft(), { assetId: target.asset.id, page: 1, text: "selected excerpt" }, "translate_en_ko"), session.appSessionId);
  const { run } = await h.ok("run.start", { requestId: randomUUID(), draft: selected });
  await until(() => !h.sessions().isActive(session.appSessionId));
  let transcript = emptyTranscript();
  for (const e of h.events) transcript = applyEvent(transcript, e);
  transcript = addTurn(transcript, run, selected);
  assert.equal(transcript.turns[0]!.state, "completed");
  assert.match(transcript.turns[0]!.answer, /selected excerpt/);
  const first = h.calls()[0]!;
  assert.match(first.stdin, /영어 텍스트를 한국어/);
  assert.ok(!first.stdin.includes("UNSELECTED_PAGE_CANARY") && !first.stdin.includes(course.title));
  assert.ok(!first.argv.includes("--add-dir"));
  h.restart();
  const restored = (await h.ok("session.list", { includeArchived: false })).sessions.find((s) => s.appSessionId === session.appSessionId)!;
  assert.ok(restored.cliSessionId);
  await h.ok("run.start", { requestId: randomUUID(), draft: draft(session.appSessionId, "second explicit question") });
  await until(() => !h.sessions().isActive(session.appSessionId));
  const resumed = h.calls()[1]!;
  assert.equal(resumed.argv[resumed.argv.indexOf("--resume") + 1], restored.cliSessionId);
  assert.equal(resumed.cwd, first.cwd);
  const other = (await h.ok("session.create", { mode: "independent", title: "other" })).session;
  await h.ok("run.start", { requestId: randomUUID(), draft: draft(other.appSessionId) });
  await until(() => !h.sessions().isActive(other.appSessionId));
  assert.notEqual(h.calls()[2]!.cwd, first.cwd);
  assert.ok(!h.calls()[2]!.argv.includes("--resume"));
  for (const req of h.network.filter((r) => r.url.startsWith(STORAGE))) assert.equal(req.headers.get("cookie"), null);
});

test("offline/expired collection keeps cached PDF; account switch refuses old account asset", async (t) => {
  const h = await harness(t);
  await h.collect();
  const course = (await h.ok("library.courses", {})).courses[0]!;
  const asset = (await h.ok("library.manifest", { courseId: course.id })).manifest!.items[0]!.assets[0]!;
  const get = () => h.ok("library.asset", { courseId: course.id, assetId: asset.id });
  const original = await get();
  for (const mode of ["offline", "expired"] as const) {
    h.state[mode] = true;
    const result = await h.call("collection.run", { scope: "all_courses" });
    assert.ok(!result.ok);
    assert.equal(result.error.code, mode === "offline" ? "DOWNLOAD_FAILED" : "AUTH_REQUIRED");
    assert.deepEqual((await get()).bytes, original.bytes);
    h.state[mode] = false;
  }
  assert.equal(h.state.loginCount, 1);
  await h.collect();
  h.state.user = 77;
  await h.collect();
  assert.notEqual((await h.ok("library.courses", {})).courses[0]!.accountKey, course.accountKey);
  const refused = await h.call("library.asset", { courseId: course.id, assetId: asset.id });
  assert.ok(!refused.ok);
  assert.equal(refused.error.code, "SCOPE_VIOLATION");
});

test("concurrent starts and duplicate requestId never duplicate a collection or CLI process", async (t) => {
  const h = await harness(t);
  const first = h.collect();
  const duplicateCollection = await h.call("collection.run", { scope: "all_courses" });
  assert.ok(!duplicateCollection.ok);
  assert.equal(duplicateCollection.error.code, "RUN_ALREADY_ACTIVE");
  await first;
  const { session } = await h.ok("session.create", { mode: "independent", title: "one" });
  const request = { requestId: randomUUID(), draft: draft(session.appSessionId) };
  const [a, b] = await Promise.all([h.ok("run.start", request), h.ok("run.start", request)]);
  assert.equal(a.run.runId, b.run.runId);
  await until(() => !h.sessions().isActive(session.appSessionId));
  assert.equal(h.calls().length, 1);
});

for (const [scenario, expected] of [["auth_expired", "CLI_AUTH_REQUIRED"], ["usage_limit", "USAGE_LIMIT"], ["wrong_session", "ISOLATION_VIOLATION"], ["outside_executed", "ISOLATION_VIOLATION"]]) {
  test(`${scenario}: adapter failure reaches host state and chat without automatic resend`, async (t) => {
    const h = await harness(t);
    const { session } = await h.ok("session.create", { mode: "independent", title: "boundary" });
    h.state.scenario = scenario!;
    const sent = draft(session.appSessionId);
    const { run } = await h.ok("run.start", { requestId: randomUUID(), draft: sent });
    await until(() => !h.sessions().isActive(session.appSessionId));
    const saved = h.store.load().runs.find((r) => r.runId === run.runId)!;
    assert.equal(saved.status, "failed");
    assert.equal(saved.errorCode, expected);
    let transcript = addTurn(emptyTranscript(), saved, sent);
    for (const e of h.events) transcript = applyEvent(transcript, e);
    assert.equal(transcript.turns[0]!.state, "failed");
    assert.equal(h.calls().length, 1);
    if (transcript.turns[0]!.error) assert.ok(errorHelp(transcript.turns[0]!.error).text);
    assert.ok(!transcript.turns[0]!.answer.includes("SYNTHETIC-CANARY"));
  });
}

test("forbidden API environment never starts even a synthetic CLI", async (t) => {
  const h = await harness(t);
  const { session } = await h.ok("session.create", { mode: "independent", title: "credentials" });
  h.state.extraEnv = { ANTHROPIC_API_KEY: "synthetic-placeholder" };
  const { run } = await h.ok("run.start", { requestId: randomUUID(), draft: draft(session.appSessionId) });
  assert.equal(run.status, "failed");
  assert.equal(run.errorCode, "FORBIDDEN_CREDENTIAL_ENV");
  assert.equal(h.calls().length, 0);
});

test("course file output → persisted summary → restore to test Trash; explicit deletion refusal", async (t) => {
  const h = await harness(t);
  await h.collect();
  const courseId = (await h.ok("library.courses", {})).courses[0]!.id;
  const { session } = await h.ok("session.create", { mode: "course", courseId, title: "files" });
  h.state.scenario = "write_file";
  const { run } = await h.ok("run.start", { requestId: randomUUID(), draft: draft(session.appSessionId) });
  await until(() => !h.sessions().isActive(session.appSessionId));
  const { changes } = await h.ok("files.changes", { runId: run.runId });
  assert.deepEqual(changes!.changes, [{ key: "notes/summary.md", change: "created", restorable: true }]);
  const path = join(h.dataRoot, session.workspaceKey, "notes/summary.md");
  assert.equal(readFileSync(path, "utf8"), "synthetic\n");
  assert.deepEqual(await h.ok("files.trash", { appSessionId: session.appSessionId, runId: run.runId, key: "notes/summary.md" }), { trashed: false });
  assert.equal(h.trash.length, 0);
  assert.deepEqual(await h.ok("files.restore", { runId: run.runId }), { restored: ["notes/summary.md"], skipped: [] });
  assert.deepEqual(h.trash, [path]);
});

test("cancelled partial file survives and can be inspected without automatic rerun", async (t) => {
  const h = await harness(t);
  const { session } = await h.ok("session.create", { mode: "course", courseId: randomUUID(), title: "cancel" });
  h.state.scenario = "slow";
  const { run } = await h.ok("run.start", { requestId: randomUUID(), draft: draft(session.appSessionId) });
  await until(() => h.events.some((e) => e.type === "text.delta"));
  await h.ok("run.cancel", { runId: run.runId });
  await until(() => !h.sessions().isActive(session.appSessionId));
  assert.equal(h.store.load().runs.find((r) => r.runId === run.runId)!.status, "cancelled");
  assert.equal(readFileSync(join(h.dataRoot, session.workspaceKey, "draft.md"), "utf8"), "partial\n");
  assert.ok((await h.ok("files.changes", { runId: run.runId })).changes!.changes.some((c) => c.key === "draft.md"));
  h.restart();
  assert.equal(h.calls().length, 1);
});

test("unknown attachment/capture IDs are rejected, never silently dropped or sent", async (t) => {
  const h = await harness(t);
  await h.collect();
  const courseId = (await h.ok("library.courses", {})).courses[0]!.id;
  const { session } = await h.ok("session.create", { mode: "course", courseId, title: "attachment" });
  for (const field of ["attachmentIds", "captureIds"] as const) {
    const result = await h.call("run.start", { requestId: randomUUID(), draft: { ...draft(session.appSessionId), [field]: [randomUUID()] } });
    assert.ok(!result.ok);
    assert.equal(result.error.code, "INVALID_REQUEST");
  }
  assert.equal(h.calls().length, 0);
});

// These are missing workflows, not expected successes with fabricated attachment IDs.
// Replace each TODO with preparation → explicit confirmation → verified copy → CLI assertions after implementation.
test("A-001: selected course/local files are confirmed and copied to this run only", async (t) => {
  const h = await harness(t);
  await h.collect();
  const courseId = (await h.ok("library.courses", {})).courses[0]!.id;
  const manifest = (await h.ok("library.manifest", { courseId })).manifest!;
  const asset = manifest.items.flatMap((item) => item.assets)[0]!;
  const { session } = await h.ok("session.create", { mode: "independent", title: "explicit attachments" });
  const { session: other } = await h.ok("session.create", { mode: "independent", title: "other" });
  const { attachment } = await h.ok("attachments.prepareAsset", { appSessionId: session.appSessionId, courseId, assetId: asset.id });
  assert.equal(attachment.confirmed, false);
  const attempted = await h.call("run.start", { requestId: randomUUID(), draft: { ...draft(session.appSessionId), attachmentIds: [attachment.id] } });
  assert.ok(!attempted.ok); assert.equal(h.calls().length, 0);
  await h.ok("attachments.confirm", { appSessionId: session.appSessionId, attachmentId: attachment.id });
  const foreign = await h.call("run.start", { requestId: randomUUID(), draft: { ...draft(other.appSessionId), attachmentIds: [attachment.id] } });
  assert.ok(!foreign.ok); assert.equal(h.calls().length, 0);
  h.state.scenario = "attachment_read";
  const { run } = await h.ok("run.start", { requestId: randomUUID(), draft: { ...draft(session.appSessionId), text: "read confirmed file", attachmentIds: [attachment.id] } });
  await until(() => !h.sessions().isActive(session.appSessionId));
  assert.equal(h.store.load().runs.find((r) => r.runId === run.runId)!.status, "completed");
  const first = h.calls()[0]!;
  assert.ok(first.argv.includes("--add-dir"));
  assert.ok(first.stdin.includes(run.runId));
  assert.ok(!first.stdin.includes("SYNTHETIC_COURSE_CANARY"));
  assert.ok(!first.stdin.includes(h.dataRoot + "/library"));
  assert.ok(h.events.some((e) => e.runId === run.runId && e.type === "text.delta" && e.payload.text.includes("%PDF")));
  assert.equal(existsSync(first.argv[first.argv.indexOf("--add-dir") + 1]!), false, "completed run's temporary copy removed");
  const local = join(h.root, "local.txt"); writeFileSync(local, "EXPLICIT_LOCAL_CANARY");
  h.state.pickedFile = local;
  const prepared = (await h.ok("attachments.chooseLocal", { appSessionId: session.appSessionId })).attachment!;
  await h.ok("attachments.confirm", { appSessionId: session.appSessionId, attachmentId: prepared.id });
  const next = await h.ok("run.start", { requestId: randomUUID(), draft: { ...draft(session.appSessionId), attachmentIds: [prepared.id] } });
  await until(() => !h.sessions().isActive(session.appSessionId));
  assert.ok(h.events.some((e) => e.runId === next.run.runId && e.type === "text.delta" && e.payload.text.includes("EXPLICIT_LOCAL_CANARY")));
  assert.ok(!h.calls()[1]!.stdin.includes(attachment.id));
  await h.ok("attachments.remove", { appSessionId: session.appSessionId, attachmentId: prepared.id });
  const removed = await h.call("run.start", { requestId: randomUUID(), draft: { ...draft(session.appSessionId), attachmentIds: [prepared.id] } });
  assert.ok(!removed.ok); assert.equal(h.calls().length, 2);
  assert.equal(readFileSync(local, "utf8"), "EXPLICIT_LOCAL_CANARY");
});
test("A-002: a selected region is previewed, explicitly confirmed and copied to this run only", async (t) => {
  // Synthetic: the Mac selection tool and permission prompt are replaced by the harness. Real Mac behaviour is a WBS-020 self-test item.
  const h = await harness(t);
  const { session } = await h.ok("session.create", { mode: "independent", title: "capture" });
  const { session: other } = await h.ok("session.create", { mode: "independent", title: "other" });
  h.state.capture = "cancel";
  assert.deepEqual(await h.ok("captures.start", { appSessionId: session.appSessionId }), {}, "Escape leaves nothing to send");
  h.state.capture = "denied";
  const denied = await h.call("captures.start", { appSessionId: session.appSessionId });
  assert.ok(!denied.ok);
  assert.equal(denied.error.code, "CAPTURE_PERMISSION_DENIED");
  assert.equal(denied.error.retryable, false);
  h.state.capture = "fail";
  const failed = await h.call("captures.start", { appSessionId: session.appSessionId });
  assert.ok(!failed.ok && failed.error.code === "CAPTURE_FAILED" && failed.error.retryable);
  h.state.capture = "png";
  const { capture } = await h.ok("captures.start", { appSessionId: session.appSessionId });
  assert.ok(capture);
  assert.deepEqual(capture.preview, CAPTURE_PNG, "the preview is exactly what will be sent");
  assert.equal(capture.attachment.confirmed, false);
  const early = await h.call("run.start", { requestId: randomUUID(), draft: { ...draft(session.appSessionId), captureIds: [capture.attachment.id] } });
  assert.ok(!early.ok); assert.equal(h.calls().length, 0);
  await h.ok("attachments.confirm", { appSessionId: session.appSessionId, attachmentId: capture.attachment.id });
  for (const wrong of [
    { ...draft(other.appSessionId), captureIds: [capture.attachment.id] },
    { ...draft(session.appSessionId), attachmentIds: [capture.attachment.id] },
  ]) {
    const refused = await h.call("run.start", { requestId: randomUUID(), draft: wrong });
    assert.ok(!refused.ok);
  }
  assert.equal(h.calls().length, 0, "no refused capture ever reached the CLI");
  h.state.scenario = "attachment_read";
  const { run } = await h.ok("run.start", { requestId: randomUUID(), draft: { ...draft(session.appSessionId), text: "what is in this region", captureIds: [capture.attachment.id] } });
  await until(() => !h.sessions().isActive(session.appSessionId));
  assert.equal(h.store.load().runs.find((r) => r.runId === run.runId)!.status, "completed");
  const call = h.calls()[0]!;
  const dir = call.argv[call.argv.indexOf("--add-dir") + 1]!;
  assert.ok(dir.includes(run.runId), "copy is per run");
  assert.ok(h.events.some((e) => e.runId === run.runId && e.type === "text.delta" && e.payload.text.includes("CAPTURE_SELECTED_REGION_CANARY")));
  assert.equal(existsSync(dir), false, "temporary run copy removed after the run");
  await until(() => readdirSync(h.root).every((n) => !n.startsWith("learningxxx-capture-")));
});
test.todo("A-ready: file scope/change summary/restore/trash controls connected to UI (A-003)");


test("A-001: cancelled attachment runs remove only the temporary run copy", async (t) => {
  const h = await harness(t);
  const { session } = await h.ok("session.create", { mode: "course", courseId: randomUUID(), title: "cancel explicit copy" });
  const local = join(h.root, "cancel.txt"); writeFileSync(local, "KEEP_ORIGINAL");
  h.state.pickedFile = local;
  const item = (await h.ok("attachments.chooseLocal", { appSessionId: session.appSessionId })).attachment!;
  await h.ok("attachments.confirm", { appSessionId: session.appSessionId, attachmentId: item.id });
  h.state.scenario = "slow";
  const { run } = await h.ok("run.start", { requestId: randomUUID(), draft: { ...draft(session.appSessionId), attachmentIds: [item.id] } });
  await until(() => h.events.some((e) => e.runId === run.runId && e.type === "text.delta"));
  const call = h.calls()[0]!, dir = call.argv[call.argv.indexOf("--add-dir") + 1]!;
  assert.equal(existsSync(dir), true);
  await h.ok("run.cancel", { runId: run.runId });
  await until(() => !h.sessions().isActive(session.appSessionId));
  assert.equal(existsSync(dir), false);
  assert.equal(readFileSync(local, "utf8"), "KEEP_ORIGINAL");
});

test("A-001: switching the real library account invalidates prepared attachment IDs", async (t) => {
  const h = await harness(t);
  await h.collect();
  const courseId = (await h.ok("library.courses", {})).courses[0]!.id;
  const asset = (await h.ok("library.manifest", { courseId })).manifest!.items.flatMap((item) => item.assets)[0]!;
  const { session } = await h.ok("session.create", { mode: "course", courseId, title: "account-bound" });
  const { attachment } = await h.ok("attachments.prepareAsset", { appSessionId: session.appSessionId, courseId, assetId: asset.id });
  await h.ok("attachments.confirm", { appSessionId: session.appSessionId, attachmentId: attachment.id });
  h.state.user = 84;
  await h.collect();
  const result = await h.call("run.start", { requestId: randomUUID(), draft: { ...draft(session.appSessionId), attachmentIds: [attachment.id] } });
  assert.ok(!result.ok); assert.equal(result.error.code, "SCOPE_VIOLATION");
  assert.equal(h.calls().length, 0);
});
