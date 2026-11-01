import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { AppError, CollectionManifest, Course, Week } from "@learningxxx/contracts";
import { stableId } from "../src/discovery.ts";
import { CanvasClient, CollectionError, collectResources, createDirectoryStore, toUtc } from "../src/index.ts";
import type { ResourceCollectionResult } from "../src/index.ts";
import { BASE, C, STORAGE, lms, noWait } from "./fake-lms.ts";

const accountKey = "acct_synthalpha01";
const courseId = stableId("course", accountKey, "77", "1001");
const course = Course.parse({ id: courseId, accountKey, termId: "77", sourceCourseId: "1001", title: "합성 논리회로" });
const weeks = ["501", "502"].map((sid, order) => Week.parse({ id: stableId("week", courseId, sid), courseId, sourceWeekId: sid, label: `${order + 1}주차`, order }));
const resId = (kind: string, sid: string) => stableId("resource", courseId, kind, sid);

function setup() {
  const fake = lms();
  const root = mkdtempSync(join(tmpdir(), "wbs008-"));
  const client = new CanvasClient({ baseUrl: BASE, fetch: fake.fetch, getAuthHeaders: async () => ({ Cookie: "session=synthetic" }) });
  const store = createDirectoryStore(root);
  const now = () => new Date("2026-11-01T09:00:00Z");
  const run = (previous?: CollectionManifest) => collectResources({ client, store, course, weeks, previous, now, retry: noWait() });
  return { ...fake, root, store, run };
}

const manifest = (r: ResourceCollectionResult): CollectionManifest =>
  CollectionManifest.parse({
    schemaVersion: 1, course, weeks, revision: 1, syncRunId: "55555555-5555-4555-8555-000000000001",
    generatedAt: "2026-11-01T09:00:00Z", items: r.items, tombstones: r.tombstones,
  });
const item = (r: ResourceCollectionResult, kind: string, sid: string) => r.items.find((i) => i.resource.id === resId(kind, sid));
const downloads = (calls: { url: string }[]) => calls.filter((c) => c.url.startsWith(STORAGE)).length;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("first collection", () => {
  test("normalizes files, notices and assignments into a valid manifest", async () => {
    const { run } = setup();
    const r = await run();
    assert.deepEqual(r.errors, []);
    manifest(r);
    assert.equal(r.items.length, 6);
    assert.deepEqual(r.skippedTypes, { Page: 1, ExternalUrl: 1 });
  });

  test("weeks come from modules; a file in two modules belongs to the earliest week", async () => {
    const { run } = setup();
    const r = await run();
    assert.equal(item(r, "file", "9001")?.resource.weekId, weeks[0]!.id);
    assert.equal(item(r, "file", "9002")?.resource.weekId, weeks[1]!.id);
    assert.equal(item(r, "assignment", "7001")?.resource.weekId, weeks[0]!.id);
    assert.equal(item(r, "assignment", "7002")?.resource.weekId, weeks[1]!.id, "quiz module item links its assignment");
    assert.equal(item(r, "assignment", "7003")?.resource.weekId, undefined);
    assert.equal(item(r, "notice", "6001")?.resource.weekId, undefined, "announcements are course notices");
    assert.equal(item(r, "notice", "6002"), undefined, "unpublished announcement is skipped");
  });

  test("assets are stored content-addressed with verified hashes and normalized media types", async () => {
    const { run, root } = setup();
    const r = await run();
    const asset = item(r, "file", "9001")!.assets[0]!;
    assert.equal(asset.sha256, sha("%PDF-synthetic-1"));
    assert.equal(asset.storageKey, `originals/${asset.sha256.slice(0, 2)}/${asset.sha256}.pdf`);
    assert.equal(readFileSync(join(root, asset.storageKey), "utf8"), "%PDF-synthetic-1");
    assert.equal(item(r, "file", "9002")!.assets[0]!.mediaType, "application/vnd.ms-powerpoint");
    assert.equal(item(r, "notice", "6001")!.assets[0]!.originalName, "map.pdf");
    assert.deepEqual(readdirSync(join(root, "tmp")), [], "no partial files left");
  });

  test("the session goes only to the LMS origin, never to file storage", async () => {
    const { run, state } = setup();
    await run();
    for (const call of state.calls) assert.equal(call.cookie !== null, call.url.startsWith(BASE), call.url);
    assert.ok(downloads(state.calls) > 0);
  });

  test("deadlines are UTC; a value without a zone is read as Seoul time and flagged", async () => {
    const { run } = setup();
    const r = await run();
    assert.deepEqual(item(r, "assignment", "7001")!.assignment, { resourceId: resId("assignment", "7001"), dueAt: "2026-11-07T14:59:00Z", timezone: "Asia/Seoul", timezoneBasis: "source_explicit", submissionUrl: `${BASE}/courses/1001/assignments/7001` });
    assert.equal(item(r, "assignment", "7002")!.assignment!.dueAt, "2026-11-10T14:59:00Z");
    assert.equal(item(r, "assignment", "7002")!.assignment!.timezoneBasis, "assumed_asia_seoul");
    const unclear = item(r, "assignment", "7003")!;
    assert.equal(unclear.assignment!.dueAt, null);
    assert.equal(unclear.resource.sourceUrl, undefined, "non-https or foreign links are dropped");
    assert.deepEqual(toUtc("2026-11-10T23:59:00+09:00"), { at: "2026-11-10T14:59:00Z", assumed: false });
  });
});

describe("collecting again", () => {
  test("is idempotent: same ids and revisions, no new downloads, no tombstones", async () => {
    const { run, state } = setup();
    const first = await run();
    const before = downloads(state.calls);
    const second = await run(manifest(first));
    assert.deepEqual(second.items, first.items);
    assert.deepEqual(second.tombstones, []);
    assert.equal(downloads(state.calls), before, "unchanged originals are reused");
  });

  test("a title edit keeps id and revision", async () => {
    const { run, state } = setup();
    const first = await run();
    state.files.get("9001")!.name = "week1-boolean-renamed.pdf";
    state.assignments[0]!.name = "과제 1 (수정)";
    const second = await run(manifest(first));
    assert.equal(item(second, "file", "9001")!.resource.title, "week1-boolean-renamed.pdf");
    assert.equal(item(second, "file", "9001")!.resource.revision, 1);
    assert.equal(item(second, "assignment", "7001")!.resource.revision, 1);
  });

  test("changed content raises the revision and keeps the old original on disk", async () => {
    const { run, state, root } = setup();
    const first = await run();
    const oldKey = item(first, "file", "9001")!.assets[0]!.storageKey;
    Object.assign(state.files.get("9001")!, { body: "%PDF-synthetic-1-v2", modified: "2026-10-20T00:00:00Z" });
    state.assignments[0]!.due_at = "2026-11-14T14:59:00Z";
    state.announcements[0]!.posted_at = "2026-10-06T01:00:00Z";
    const second = await run(manifest(first));
    assert.equal(item(second, "file", "9001")!.resource.revision, 2);
    assert.equal(item(second, "file", "9001")!.assets[0]!.sha256, sha("%PDF-synthetic-1-v2"));
    assert.equal(item(second, "assignment", "7001")!.resource.revision, 2);
    assert.equal(item(second, "notice", "6001")!.resource.revision, 2);
    assert.equal(item(second, "file", "9002")!.resource.revision, 1);
    assert.equal(readFileSync(join(root, oldKey), "utf8"), "%PDF-synthetic-1");
  });

  test("a damaged stored original is downloaded again", async () => {
    const { run, root } = setup();
    const first = await run();
    const asset = item(first, "file", "9001")!.assets[0]!;
    writeFileSync(join(root, asset.storageKey), "corrupted");
    const second = await run(manifest(first));
    assert.deepEqual(item(second, "file", "9001")!.assets[0], asset);
    assert.equal(readFileSync(join(root, asset.storageKey), "utf8"), "%PDF-synthetic-1");
  });
});

describe("partial failure keeps good data", () => {
  test("one failing file is reported and its previous item stays", async () => {
    const { run, state } = setup();
    const first = await run();
    state.failing.add(`${C}/files/9002`);
    const second = await run(manifest(first));
    assert.deepEqual(second.errors.map((e) => [e.code, e.resourceSourceId, e.retryable]), [["DOWNLOAD_FAILED", "9002", true]]);
    assert.deepEqual(item(second, "file", "9002"), item(first, "file", "9002"));
    assert.equal(second.items.length, first.items.length);
    second.errors.forEach((e) => AppError.parse(e));
  });

  test("without a previous item the failed resource is simply absent", async () => {
    const { run, state } = setup();
    state.failing.add(`${C}/files/9002`);
    const r = await run();
    assert.equal(item(r, "file", "9002"), undefined);
    assert.equal(r.items.length, 5);
  });

  test("a truncated download is not stored", async () => {
    const { run, state, root } = setup();
    state.files.get("9002")!.served = "synth";
    const r = await run();
    assert.equal(r.errors[0]?.code, "DOWNLOAD_FAILED");
    assert.equal(item(r, "file", "9002"), undefined);
    assert.deepEqual(readdirSync(join(root, "tmp")), []);
  });

  test("a failed listing never turns resources into tombstones", async () => {
    const { run, state } = setup();
    const first = await run();
    state.failing.add(`${C}/assignments?per_page=100`);
    const second = await run(manifest(first));
    assert.deepEqual(second.tombstones, []);
    assert.equal(item(second, "assignment", "7001")?.resource.revision, 1);
    assert.equal(second.errors[0]?.code, "DOWNLOAD_FAILED");
  });

  test("a download link to another origin is refused without a request", async () => {
    const { run, state } = setup();
    state.files.get("9002")!.url = `${STORAGE}/blob/9002`;
    const r = await run();
    assert.deepEqual(r.errors.map((e) => [e.code, e.resourceSourceId]), [["SOURCE_CHANGED", "9002"]]);
    assert.ok(!state.calls.some((c) => c.url === `${STORAGE}/blob/9002`));
  });
});

describe("removal and login expiry", () => {
  test("removed and locked resources become tombstones; reappearing ones come back", async () => {
    const { run, state } = setup();
    const first = await run();
    state.modules.set("502", [{ id: 6, type: "Quiz", content_id: 8001 }]);
    state.files.get("9001")!.locked = true;
    state.assignments.pop();
    const second = await run(manifest(first));
    const reasons = Object.fromEntries(second.tombstones.map((t) => [t.resourceId, t.reason]));
    assert.deepEqual(reasons, {
      [resId("file", "9001")]: "hidden_at_source",
      [resId("file", "9002")]: "deleted_at_source",
      [resId("assignment", "7003")]: "deleted_at_source",
    });
    manifest(second);
    state.files.get("9001")!.locked = false;
    const third = await run(manifest(second));
    assert.ok(item(third, "file", "9001"));
    assert.ok(!third.tombstones.some((t) => t.resourceId === resId("file", "9001")));
  });

  test("an expired login stops the whole run instead of producing a partial manifest", async () => {
    const { root } = setup();
    const loginRedirect = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/files/")) return new Response(null, { status: 302, headers: { location: `${BASE}/login/canvas` } });
      return lms().fetch(input, init);
    }) as typeof globalThis.fetch;
    const client = new CanvasClient({ baseUrl: BASE, fetch: loginRedirect, getAuthHeaders: async () => ({ Cookie: "session=synthetic" }) });
    const error = await collectResources({ client, store: createDirectoryStore(root), course, weeks, retry: noWait() }).then(() => assert.fail("expected AUTH_REQUIRED"), (e: unknown) => e);
    assert.ok(error instanceof CollectionError);
    assert.equal(error.appError.code, "AUTH_REQUIRED");
  });

  test("another account gets different resource ids for the same LMS item", () => {
    const other = stableId("course", "acct_synthbeta002", "77", "1001");
    assert.notEqual(stableId("resource", other, "file", "9001"), resId("file", "9001"));
  });
});
