import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { Session } from "@learningxxx/contracts";
import { AttachmentService } from "../src/attachment-service.ts";

function setup(t: TestContext) {
  const dataRoot = mkdtempSync(join(tmpdir(), "wbs036-"));
  const sessions = new Map<string, Session>();
  const a = randomUUID(), b = randomUUID();
  for (const id of [a, b]) sessions.set(id, { appSessionId: id } as Session);
  const state = { accountKey: "acct_a" as string | undefined, picked: undefined as string | undefined };
  const options = { dataRoot, getSession: (id: string) => sessions.get(id)!, accountKey: () => state.accountKey,
    chooseLocal: async () => state.picked,
    readAsset: async () => ({ name: "lecture.pdf", mediaType: "application/pdf", bytes: new TextEncoder().encode("synthetic-pdf"), accountKey: state.accountKey }) };
  const service = new AttachmentService(options);
  t.after(() => { for (const id of readdirSync(join(dataRoot, "attachments/runs"))) service.releaseRun(id); rmSync(dataRoot, { recursive: true }); });
  const local = join(dataRoot, "original.txt"); writeFileSync(local, "selected-only");
  state.picked = local;
  return { service, options, dataRoot, a, b, state, local };
}
const errorCode = (code: string) => (e: unknown) => (e as { appError?: { code: string } }).appError?.code === code;

test("selection is a staged copy; only confirmed files reach an individual run", async (t) => {
  const { service, dataRoot, a, local } = setup(t);
  const item = (await service.chooseLocal({ appSessionId: a }))!;
  assert.equal(item.confirmed, false);
  assert.throws(() => service.forRun(a, randomUUID(), [item.id]), errorCode("INVALID_REQUEST"));
  service.confirm({ appSessionId: a, attachmentId: item.id });
  writeFileSync(local, "original changed after staging");
  const runId = randomUUID(), run = service.forRun(a, runId, [item.id]);
  const copy = join(run.dirs[0]!, readdirSync(run.dirs[0]!)[0]!);
  assert.equal(readFileSync(copy, "utf8"), "selected-only");
  assert.equal(statSync(copy).mode & 0o777, 0o400);
  assert.equal(statSync(run.dirs[0]!).mode & 0o777, 0o500);
  const manifest = JSON.parse(readFileSync(join(dataRoot, "attachments/manifests", `${runId}.json`), "utf8"));
  assert.equal(manifest[0].userConfirmed, true);
  assert.equal(manifest[0].contentHash, item.contentHash);
  service.releaseRun(runId);
  assert.equal(existsSync(copy), false);
  assert.equal(readFileSync(local, "utf8"), "original changed after staging");
});

test("cancel, remove and unconfirmed files never produce CLI input", async (t) => {
  const { service, state, a, local } = setup(t);
  state.picked = undefined;
  assert.equal(await service.chooseLocal({ appSessionId: a }), undefined);
  state.picked = local;
  const item = (await service.chooseLocal({ appSessionId: a }))!;
  service.remove({ appSessionId: a, attachmentId: item.id });
  assert.throws(() => service.forRun(a, randomUUID(), [item.id]), errorCode("INVALID_REQUEST"));
  assert.equal(readFileSync(local, "utf8"), "selected-only");
});

test("foreign sessions and a switched account cannot confirm or send an ID", async (t) => {
  const { service, state, a, b } = setup(t);
  const item = (await service.chooseLocal({ appSessionId: a }))!;
  assert.throws(() => service.confirm({ appSessionId: b, attachmentId: item.id }), errorCode("SCOPE_VIOLATION"));
  service.confirm({ appSessionId: a, attachmentId: item.id });
  assert.throws(() => service.forRun(b, randomUUID(), [item.id]), errorCode("SCOPE_VIOLATION"));
  state.accountKey = "acct_b";
  assert.throws(() => service.forRun(a, randomUUID(), [item.id]), errorCode("SCOPE_VIOLATION"));
});

test("tampered staged bytes and symlinks are refused before a run", async (t) => {
  const { service, dataRoot, a, local } = setup(t);
  const item = (await service.chooseLocal({ appSessionId: a }))!;
  service.confirm({ appSessionId: a, attachmentId: item.id });
  const staged = join(dataRoot, "attachments/staged", item.id, "input.txt");
  chmodSync(staged, 0o600); writeFileSync(staged, "tampered");
  assert.throws(() => service.forRun(a, randomUUID(), [item.id]), errorCode("CHECKSUM_MISMATCH"));
  rmSync(staged); symlinkSync(local, staged);
  assert.throws(() => service.forRun(a, randomUUID(), [item.id]), errorCode("CHECKSUM_MISMATCH"));
});

test("reopen retains the confirmation but cleans abandoned per-run copies", async (t) => {
  const { service, options, a } = setup(t);
  const item = (await service.chooseLocal({ appSessionId: a }))!;
  service.confirm({ appSessionId: a, attachmentId: item.id });
  const run = service.forRun(a, randomUUID(), [item.id]);
  const reopened = new AttachmentService(options);
  assert.equal(existsSync(run.dirs[0]!), false);
  const next = reopened.forRun(a, randomUUID(), [item.id]);
  assert.notEqual(next.dirs[0], run.dirs[0]);
});

test("course attachment records explicit provenance and rejects duplicate IDs", async (t) => {
  const { service, a } = setup(t);
  const assetId = randomUUID();
  const item = await service.prepareAsset({ appSessionId: a, courseId: randomUUID(), assetId });
  assert.equal(item.sourceAssetId, assetId); assert.equal(item.provenance, "course_asset");
  service.confirm({ appSessionId: a, attachmentId: item.id });
  assert.throws(() => service.forRun(a, randomUUID(), [item.id, item.id]), errorCode("INVALID_REQUEST"));
});

// WBS-037: captures share the staged-copy rules, with their own kind.
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64"));
function withCapture(t: TestContext, capture: () => Promise<Uint8Array | undefined>) {
  const base = setup(t);
  const service = new AttachmentService({ ...base.options, capture });
  return { ...base, service };
}

test("a capture is staged unconfirmed, then delivered only as a capture of its own session", async (t) => {
  const { service, a, b, dataRoot } = withCapture(t, async () => PNG);
  const shot = (await service.capture({ appSessionId: a }))!;
  assert.equal(shot.attachment.provenance, "capture");
  assert.equal(shot.attachment.mediaType, "image/png");
  assert.equal(shot.attachment.confirmed, false);
  assert.deepEqual(shot.preview, PNG);
  assert.throws(() => service.forRun(a, randomUUID(), [], [shot.attachment.id]), errorCode("INVALID_REQUEST"), "unconfirmed");
  service.confirm({ appSessionId: a, attachmentId: shot.attachment.id });
  assert.throws(() => service.forRun(a, randomUUID(), [shot.attachment.id]), errorCode("INVALID_REQUEST"), "a capture is not a file attachment");
  assert.throws(() => service.forRun(b, randomUUID(), [], [shot.attachment.id]), errorCode("SCOPE_VIOLATION"), "other session");
  const runId = randomUUID();
  const run = service.forRun(a, runId, [], [shot.attachment.id]);
  const [name] = readdirSync(run.dirs[0]!);
  assert.ok(name!.endsWith(".png"));
  assert.deepEqual(new Uint8Array(readFileSync(join(run.dirs[0]!, name!))), PNG);
  const manifest = JSON.parse(readFileSync(join(dataRoot, "attachments/manifests", `${runId}.json`), "utf8"));
  assert.equal(manifest[0].provenance, "capture");
});

test("a file attachment cannot be sent as a capture, and a changed capture is refused", async (t) => {
  const { service, a, dataRoot } = withCapture(t, async () => PNG);
  const file = (await service.chooseLocal({ appSessionId: a }))!;
  service.confirm({ appSessionId: a, attachmentId: file.id });
  assert.throws(() => service.forRun(a, randomUUID(), [], [file.id]), errorCode("INVALID_REQUEST"));
  const shot = (await service.capture({ appSessionId: a }))!;
  service.confirm({ appSessionId: a, attachmentId: shot.attachment.id });
  const staged = join(dataRoot, "attachments/staged", shot.attachment.id, "input.png");
  chmodSync(staged, 0o600);
  writeFileSync(staged, "tampered");
  assert.throws(() => service.forRun(a, randomUUID(), [], [shot.attachment.id]), errorCode("CHECKSUM_MISMATCH"));
});

test("escape stages nothing; one selection at a time; an account switch mid-selection is refused", async (t) => {
  let answer: Uint8Array | undefined;
  let release: () => void = () => {};
  const { service, a, state, dataRoot } = withCapture(t, () => new Promise((resolve) => { release = () => resolve(answer); }));
  const cancelled = service.capture({ appSessionId: a });
  await assert.rejects(service.capture({ appSessionId: a }), errorCode("RUN_ALREADY_ACTIVE"));
  release();
  assert.equal(await cancelled, undefined);
  assert.deepEqual(readdirSync(join(dataRoot, "attachments/staged")), []);
  answer = PNG;
  const switched = service.capture({ appSessionId: a });
  state.accountKey = "acct_b";
  release();
  await assert.rejects(switched, errorCode("SCOPE_VIOLATION"));
  assert.deepEqual(readdirSync(join(dataRoot, "attachments/staged")), []);
});

test("without a capture source the button fails plainly", async (t) => {
  const { service, a } = setup(t);
  await assert.rejects(service.capture({ appSessionId: a }), errorCode("CAPTURE_FAILED"));
});

test("after a restart unconfirmed captures are dropped; confirmed captures and files stay", async (t) => {
  const { service, options, a, dataRoot } = withCapture(t, async () => PNG);
  const loose = (await service.capture({ appSessionId: a }))!;
  const kept = (await service.capture({ appSessionId: a }))!;
  service.confirm({ appSessionId: a, attachmentId: kept.attachment.id });
  const file = (await service.chooseLocal({ appSessionId: a }))!;
  assert.ok(existsSync(join(dataRoot, "attachments/staged", loose.attachment.id)));
  const restarted = new AttachmentService({ ...options, capture: async () => PNG });
  assert.equal(existsSync(join(dataRoot, "attachments/staged", loose.attachment.id)), false, "the unconfirmed screenshot is deleted, not just refused");
  assert.throws(() => restarted.forRun(a, randomUUID(), [], [loose.attachment.id]), errorCode("INVALID_REQUEST"));
  const run = restarted.forRun(a, randomUUID(), [], [kept.attachment.id]);
  assert.equal(readdirSync(run.dirs[0]!).length, 1);
  restarted.confirm({ appSessionId: a, attachmentId: file.id });
});
