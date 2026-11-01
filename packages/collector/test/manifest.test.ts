import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CollectionManifest, SyncRun } from "@learningxxx/contracts";
import { stableId } from "../src/discovery.ts";
import { CanvasClient, CollectionError, collectCourse, commitManifest, createDirectoryStore, readCurrentManifest, readSyncStatus } from "../src/index.ts";
import { BASE, C, lms, noWait } from "./fake-lms.ts";

const accountKey = "acct_synthalpha01";
const courseId = stableId("course", accountKey, "77", "1001");

function setup() {
  const fake = lms();
  const root = mkdtempSync(join(tmpdir(), "wbs010-"));
  const store = createDirectoryStore(root);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 1, 9, 0, tick++));
  const client = new CanvasClient({ baseUrl: BASE, fetch: fake.fetch, getAuthHeaders: async () => ({ Cookie: "session=synthetic" }) });
  const run = () => collectCourse({ client, store, root, accountKey, sourceCourseId: "1001", now, retry: noWait() });
  const dir = join(root, "courses", courseId);
  const current = () => readFileSync(join(dir, "current.json"), "utf8");
  return { ...fake, root, store, run, dir, current };
}

const revisions = (dir: string) => readdirSync(join(dir, "revisions")).sort();

describe("recording a collection", () => {
  test("first run writes revision 1, the active manifest and a succeeded sync run", async () => {
    const { run, root, dir, current } = setup();
    const r = await run();
    assert.equal(r.syncRun.status, "succeeded");
    assert.equal(r.written, true);
    assert.equal(r.manifest?.revision, 1);
    assert.deepEqual(revisions(dir), ["1.json"]);
    assert.deepEqual(CollectionManifest.parse(JSON.parse(current())), r.manifest);
    assert.deepEqual(await readCurrentManifest(root, { courseId, accountKey }), r.manifest);
    SyncRun.parse(JSON.parse(readFileSync(join(root, "sync-runs", `${r.syncRun.id}.json`), "utf8")));
    assert.deepEqual((await readSyncStatus(root, accountKey)).lastSucceeded, r.syncRun);
    assert.ok(!readdirSync(dir).some((n) => n.endsWith(".tmp")));
  });

  test("re-running without changes is idempotent: no new revision, active file untouched", async () => {
    const { run, dir, current, root } = setup();
    await run();
    const before = current();
    const second = await run();
    assert.equal(second.written, false);
    assert.equal(second.manifest?.revision, 1);
    assert.equal(current(), before);
    assert.deepEqual(revisions(dir), ["1.json"]);
    assert.equal(readdirSync(join(root, "sync-runs")).length, 2, "every run is still recorded");
  });

  test("a source change produces the next revision and keeps history", async () => {
    const { run, dir, state } = setup();
    await run();
    state.assignments[0]!.due_at = "2026-11-21T14:59:00Z";
    const second = await run();
    assert.equal(second.manifest?.revision, 2);
    assert.deepEqual(revisions(dir), ["1.json", "2.json"]);
  });

  test("a partial run is recorded as partial and never as the last success", async () => {
    const { run, state, root } = setup();
    state.failing.add(`${C}/files/9002`);
    const r = await run();
    assert.equal(r.syncRun.status, "partial");
    assert.deepEqual(r.syncRun.errors.map((e) => [e.code, e.resourceSourceId]), [["DOWNLOAD_FAILED", "9002"]]);
    assert.equal(r.written, true);
    const status = await readSyncStatus(root, accountKey);
    assert.equal(status.lastSucceeded, undefined);
    assert.equal(status.current?.id, r.syncRun.id);
  });
});

describe("the previous good manifest survives failures", () => {
  test("an expired login fails the run and leaves the active manifest as it was", async () => {
    const { run, root, store, current } = setup();
    await run();
    const before = current();
    const expired = new CanvasClient({ baseUrl: BASE, fetch: async () => new Response("", { status: 401 }), getAuthHeaders: async () => ({}) });
    const r = await collectCourse({ client: expired, store, root, accountKey, sourceCourseId: "1001", retry: noWait() });
    assert.equal(r.syncRun.status, "failed");
    assert.equal(r.syncRun.errors[0]?.code, "AUTH_REQUIRED");
    assert.equal(r.written, false);
    assert.equal(current(), before);
  });

  test("a manifest is not committed when an original fails its hash", async () => {
    const { run, root, store, current } = setup();
    const first = await run();
    const before = current();
    const asset = first.manifest!.items.find((i) => i.assets.length)!.assets[0]!;
    writeFileSync(join(root, asset.storageKey), "tampered");
    const draft = { ...first.manifest!, items: first.manifest!.items.map((i) => ({ ...i, resource: { ...i.resource, title: `${i.resource.title}!` } })) };
    const error = await commitManifest(root, store, draft).then(() => assert.fail("expected CHECKSUM_MISMATCH"), (e: unknown) => e);
    assert.ok(error instanceof CollectionError);
    assert.equal(error.appError.code, "CHECKSUM_MISMATCH");
    assert.equal(current(), before);
  });

  test("another contract major asks for an update and the file is left alone", async () => {
    const { run, root, dir, current } = setup();
    await run();
    const future = { ...JSON.parse(current()), schemaVersion: 2 };
    writeFileSync(join(dir, "current.json"), JSON.stringify(future));
    const before = current();
    await assert.rejects(readCurrentManifest(root, { courseId, accountKey }), (e: unknown) => e instanceof CollectionError && e.appError.code === "SCHEMA_VERSION_UNSUPPORTED");
    const r = await run();
    assert.equal(r.syncRun.status, "failed");
    assert.equal(r.syncRun.errors[0]?.code, "SCHEMA_VERSION_UNSUPPORTED");
    assert.equal(current(), before);
  });

  test("a damaged active manifest is reported, not silently replaced", async () => {
    const { run, dir } = setup();
    await run();
    writeFileSync(join(dir, "current.json"), "{ not json");
    const r = await run();
    assert.equal(r.syncRun.status, "failed");
    assert.equal(r.syncRun.errors[0]?.code, "CHECKSUM_MISMATCH");
    assert.equal(readFileSync(join(dir, "current.json"), "utf8"), "{ not json");
  });

  test("another account's manifest is refused, and runs are filtered by account", async () => {
    const { run, root } = setup();
    await run();
    await assert.rejects(readCurrentManifest(root, { courseId, accountKey: "acct_synthbeta002" }), (e: unknown) => e instanceof CollectionError && e.appError.code === "SCOPE_VIOLATION");
    assert.deepEqual(await readSyncStatus(root, "acct_synthbeta002"), {});
  });

  test("with no data yet there is no manifest and no status", async () => {
    const root = mkdtempSync(join(tmpdir(), "wbs010-empty-"));
    assert.equal(await readCurrentManifest(root, { courseId, accountKey }), undefined);
    assert.deepEqual(await readSyncStatus(root, accountKey), {});
    assert.equal(existsSync(join(root, "courses")), false);
  });
});
