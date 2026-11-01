import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccountKey, CollectionManifest, SCHEMA_VERSION, SyncRun } from "@learningxxx/contracts";
import { CanvasClient } from "@learningxxx/collector";
import { createHandlers } from "../src/handlers.ts";
import { LibraryService } from "../src/library-service.ts";
import { createRouter } from "../src/router.ts";
import type { SessionService } from "../src/session-service.ts";

const BASE = "https://lms.example.test";
const STORAGE = "https://files.example.test";
const PDF = "%PDF-synthetic-week1";

/** Minimal synthetic Canvas: one course, one week, one PDF. */
function lms(options: { user?: number; status?: number; offline?: boolean } = {}) {
  const json = (body: unknown) => new Response(JSON.stringify(body));
  return (async (input: string | URL | Request) => {
    if (options.offline) throw new TypeError("network down");
    const url = new URL(String(input));
    if (url.origin === STORAGE) return new Response(PDF);
    const path = url.pathname + url.search;
    if (options.status) return new Response("", { status: options.status });
    if (path === "/api/v1/users/self") return json({ id: options.user ?? 4242, name: "합성 사용자" });
    if (path === "/api/v1/courses/95899") return json({ id: 95899, name: "합성 논리회로", enrollment_term_id: 122 });
    if (path === "/api/v1/courses/95899/modules?per_page=100") return json([{ id: 1, name: "1주차", position: 1 }]);
    if (path === "/api/v1/courses/95899/modules/1/items?per_page=100") return json([{ id: 10, type: "File", content_id: 9001 }]);
    if (path === "/api/v1/courses/95899/files/9001") {
      return json({ id: 9001, display_name: "week1.pdf", filename: "week1.pdf", "content-type": "application/pdf", size: PDF.length, url: `${BASE}/files/9001/download`, modified_at: "2026-10-01T00:00:00Z" });
    }
    if (path === "/files/9001/download") return new Response(null, { status: 302, headers: { location: `${STORAGE}/blob/9001` } });
    if (path.startsWith("/api/v1/courses/95899/discussion_topics") || path.startsWith("/api/v1/courses/95899/assignments")) return json([]);
    return new Response("", { status: 404 });
  }) as typeof globalThis.fetch;
}

function setup(fetch = lms(), root = mkdtempSync(join(tmpdir(), "wbs012-"))) {
  const progress: SyncRun[] = [];
  let logins = 0;
  let settle: () => void = () => {};
  const done = new Promise<void>((resolve) => (settle = resolve));
  const library = new LibraryService({
    root,
    client: () => new CanvasClient({ baseUrl: BASE, fetch, getAuthHeaders: async () => ({}) }),
    onProgress: (run) => {
      progress.push(run);
      if (run.status !== "running") settle();
    },
    openLogin: () => void (logins += 1),
  });
  return { root, library, progress, done, logins: () => logins };
}

async function collected() {
  const s = setup();
  await s.library.init();
  await s.library.run({ scope: "all_courses" });
  await s.done;
  return s;
}

test("an empty library answers with nothing, not an error", async () => {
  const { library } = setup();
  await library.init();
  assert.deepEqual(await library.courses(), []);
  assert.deepEqual(await library.status(), {});
});

test("a run collects the course, pushes running then the final run, and serves it locally", async () => {
  const { library, progress, root } = await collected();
  assert.deepEqual(progress.map((r) => r.status), ["running", "succeeded"]);
  assert.equal(progress[0]!.id, progress[1]!.id);
  const [course] = await library.courses();
  assert.equal(course?.title, "합성 논리회로");
  const manifest = CollectionManifest.parse(await library.manifest(course!.id));
  const asset = manifest.items[0]!.assets[0]!;
  const file = await library.asset({ courseId: course!.id, assetId: asset.id });
  assert.equal(file.mediaType, "application/pdf");
  assert.equal(Buffer.from(file.bytes).toString(), PDF);
  assert.equal((await library.status()).lastSucceeded?.id, progress[1]!.id);
  const { accountKey } = JSON.parse(readFileSync(join(root, "account.json"), "utf8")) as { accountKey: string };
  AccountKey.parse(accountKey);
  assert.ok(!accountKey.includes("4242"), "the LMS user id is hashed");
});

test("a second start while collecting is refused", async () => {
  const s = setup();
  await s.library.init();
  const first = s.library.run({ scope: "all_courses" });
  await assert.rejects(s.library.run({ scope: "all_courses" }), (e: { appError?: { code: string } }) => e.appError?.code === "RUN_ALREADY_ACTIVE");
  await first;
  await s.done;
});

test("a missing sign-in opens the login window and runs nothing", async () => {
  const s = setup(lms({ status: 401 }));
  await s.library.init();
  await assert.rejects(s.library.run({ scope: "all_courses" }), (e: { appError?: { code: string } }) => e.appError?.code === "AUTH_REQUIRED");
  assert.equal(s.logins(), 1);
  assert.deepEqual(s.progress, []);
  assert.equal((await s.library.run({ scope: "all_courses" }).catch(() => "refused-again")), "refused-again", "the lock was released");
});

test("offline after a collection: everything already collected stays readable", async () => {
  const first = await collected();
  const [course] = await first.library.courses();
  const before = readFileSync(join(first.root, "courses", course!.id, "current.json"), "utf8");
  const offline = setup(lms({ offline: true }), first.root);
  await offline.library.init();
  assert.equal((await offline.library.courses()).length, 1);
  const manifest = (await offline.library.manifest(course!.id))!;
  const file = await offline.library.asset({ courseId: course!.id, assetId: manifest.items[0]!.assets[0]!.id });
  assert.equal(Buffer.from(file.bytes).toString(), PDF);
  await assert.rejects(offline.library.run({ scope: "all_courses" }), (e: { appError?: { code: string } }) => e.appError?.code === "DOWNLOAD_FAILED");
  assert.equal(readFileSync(join(first.root, "courses", course!.id, "current.json"), "utf8"), before);
});

test("originals are re-hashed before they are handed to the renderer", async () => {
  const { library, root } = await collected();
  const [course] = await library.courses();
  const asset = (await library.manifest(course!.id))!.items[0]!.assets[0]!;
  await assert.rejects(library.asset({ courseId: course!.id, assetId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }), (e: { appError?: { code: string } }) => e.appError?.code === "NOT_FOUND");
  writeFileSync(join(root, asset.storageKey), "tampered");
  await assert.rejects(library.asset({ courseId: course!.id, assetId: asset.id }), (e: { appError?: { code: string } }) => e.appError?.code === "CHECKSUM_MISMATCH");
});

test("a run cut off by a crash shows as interrupted after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "wbs012-crash-"));
  mkdirSync(join(root, "sync-runs"), { recursive: true });
  const stuck = SyncRun.parse({ schemaVersion: 1, id: "99999999-9999-4999-8999-000000000001", accountKey: "acct_synthalpha01", trigger: "manual", scope: "course", startedAt: "2026-11-01T08:00:00Z", status: "running", errors: [] });
  writeFileSync(join(root, "sync-runs", `${stuck.id}.json`), JSON.stringify(stuck));
  const { library } = setup(lms(), root);
  await library.init();
  const saved = SyncRun.parse(JSON.parse(readFileSync(join(root, "sync-runs", `${stuck.id}.json`), "utf8")));
  assert.equal(saved.status, "interrupted");
});

test("another account on the same Mac does not see the first account's courses", async () => {
  const first = await collected();
  const other = setup(lms({ user: 777 }), first.root);
  await other.library.init();
  await other.library.run({ scope: "all_courses" });
  await other.done;
  const courses = await other.library.courses();
  assert.equal(courses.length, 1);
  assert.notEqual(courses[0]!.accountKey, (await first.library.courses())[0]!.accountKey);
});

test("the library channels pass the contract through the router, bytes included", async () => {
  const { library } = await collected();
  const router = createRouter(createHandlers({} as SessionService, library));
  const call = (channel: string, payload: unknown) => router({ schemaVersion: SCHEMA_VERSION, channel, payload });
  const courses = await call("library.courses", {});
  assert.ok(courses.ok);
  const course = (courses.data as { courses: { id: string }[] }).courses[0]!;
  const manifest = await call("library.manifest", { courseId: course.id });
  assert.ok(manifest.ok);
  const assetId = (manifest.data as { manifest: CollectionManifest }).manifest.items[0]!.assets[0]!.id;
  const asset = await call("library.asset", { courseId: course.id, assetId });
  assert.ok(asset.ok && (asset.data as { bytes: Uint8Array }).bytes instanceof Uint8Array);
  const status = await call("collection.status", {});
  assert.ok(status.ok);
  const missing = await call("library.manifest", { courseId: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
  assert.deepEqual(missing, { ok: true, data: {} });
});
