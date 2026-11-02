import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CollectionManifest, Course, Week } from "@learningxxx/contracts";
import { stableId } from "../src/discovery.ts";
import { CanvasClient, CollectionError, LearningXClient, collectResources, createDirectoryStore, validPayload } from "../src/index.ts";
import type { ResourceCollectionResult } from "../src/index.ts";
import { BASE, lms, noWait } from "./fake-lms.ts";

const COMMONS = "https://commons.example.test";
const TOKEN = "synthetic.lx.token";
const accountKey = "acct_synthalpha01";
const courseId = stableId("course", accountKey, "77", "1001");
const course = Course.parse({ id: courseId, accountKey, termId: "77", sourceCourseId: "1001", title: "합성 논리회로" });
const weeks = ["501", "502"].map((sid, order) => Week.parse({ id: stableId("week", courseId, sid), courseId, sourceWeekId: sid, label: `${order + 1}주차`, order }));
const lxId = (cid: string) => stableId("resource", courseId, "file", `commons:${cid}`);

type Content = { body: string; ext: string; updated: string | number; opened?: boolean; type?: string };

/** Synthetic LearningX + Commons following the real shapes (khu-ecampus-archive flow). */
function learningx() {
  const state = {
    token: TOKEN as string | undefined,
    contents: new Map<string, Content>([
      ["c0ffee01", { body: "%PDF-1.7 week one", ext: "pdf", updated: "2026-09-02 10:00:00" }],
      ["c0ffee02", { body: "%PDF-1.7 week two", ext: "pdf", updated: 1_788_000_000_000 }],
    ]),
    extra: [] as Record<string, unknown>[],
    calls: [] as { url: string; auth: string | null; referer: string | null }[],
    emOpened: new Set<string>(),
    errorPage: new Set<string>(),
  };
  const item = (cid: string, title: string) => {
    const c = state.contents.get(cid)!;
    return {
      content_type: "attendance_item",
      title,
      url: `${BASE}/courses/1001/modules/items/${cid}`,
      content_data: {
        opened: c.opened ?? true,
        item_content_data: { content_id: cid, content_type: c.type ?? c.ext, file_name: `${title}.${c.ext}`, last_updated_date: c.updated },
      },
    };
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    state.calls.push({ url: url.href, auth: headers.get("authorization"), referer: headers.get("referer") });
    if (url.origin === BASE && url.pathname === "/learningx/api/v1/courses/1001/modules") {
      if (headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("{}", { status: 401 });
      return Response.json([
        { module_id: 501, title: "1주차", module_items: [item("c0ffee01", "1주차 강의자료"), { content_type: "assignment", title: "과제" }] },
        { module_id: 999, title: "2주차", module_items: [item("c0ffee02", "2주차 강의자료"), ...state.extra] },
      ]);
    }
    if (url.origin === COMMONS) {
      let m = /^\/CommonsCore2\/v2\/contents\/(\w+)$/.exec(url.pathname);
      if (m) {
        const c = state.contents.get(m[1]!);
        return c ? Response.json({ result: { download_url: `${COMMONS}/dl/${m[1]}`, extension: c.ext } }) : Response.json({ detail_code: 51 }, { status: 404 });
      }
      m = /^\/em\/(\w+)$/.exec(url.pathname);
      if (m) {
        state.emOpened.add(m[1]!);
        return new Response("<html>viewer</html>");
      }
      m = /^\/dl\/(\w+)$/.exec(url.pathname);
      if (m) {
        // Like the real Commons: no viewer session or wrong Referer → 500 HTML error page.
        if (!state.emOpened.has(m[1]!) || headers.get("referer") !== `${COMMONS}/em/${m[1]}` || state.errorPage.has(m[1]!)) {
          return new Response("<!DOCTYPE html><html>error</html>", { status: state.errorPage.has(m[1]!) ? 200 : 500 });
        }
        return new Response(state.contents.get(m[1]!)!.body);
      }
    }
    assert.fail(`unexpected request ${url.href}`);
  }) as typeof globalThis.fetch;
  return { state, fetch };
}

function setup() {
  const canvas = lms();
  const lx = learningx();
  const root = mkdtempSync(join(tmpdir(), "wbs039-"));
  const client = new CanvasClient({ baseUrl: BASE, fetch: canvas.fetch, getAuthHeaders: async () => ({}) });
  const learningxClient = new LearningXClient({ canvasBaseUrl: BASE, commonsBaseUrl: COMMONS, fetch: lx.fetch, getToken: async () => lx.state.token });
  const store = createDirectoryStore(root);
  const now = () => new Date("2026-11-01T09:00:00Z");
  const run = (previous?: CollectionManifest) => collectResources({ client, learningx: learningxClient, store, course, weeks, previous, now, retry: noWait() });
  return { lx, root, run };
}

const manifest = (r: ResourceCollectionResult): CollectionManifest =>
  CollectionManifest.parse({
    schemaVersion: 1, course, weeks, revision: 1, syncRunId: "55555555-5555-4555-8555-000000000001",
    generatedAt: "2026-11-01T09:00:00Z", items: r.items, tombstones: r.tombstones,
  });
const find = (r: ResourceCollectionResult, cid: string) => r.items.find((i) => i.resource.id === lxId(cid));
const downloads = (calls: { url: string }[]) => calls.filter((c) => c.url.includes("/dl/")).length;

describe("LearningX lecture materials (WBS-039)", () => {
  test("opened PDFs are stored as file resources in their week, with the viewer session and Referer", async () => {
    const { lx, root, run } = setup();
    const r = await run();
    assert.deepEqual(r.errors, []);
    manifest(r);
    const one = find(r, "c0ffee01")!;
    assert.equal(one.resource.kind, "file");
    assert.equal(one.resource.weekId, weeks[0]!.id, "module_id matches the Canvas module");
    assert.equal(find(r, "c0ffee02")!.resource.weekId, weeks[1]!.id, "unknown module_id falls back to the week label");
    assert.equal(one.resource.updatedAt, "2026-09-02T01:00:00Z", "a zoneless date is Seoul time");
    assert.equal(find(r, "c0ffee02")!.resource.updatedAt, "2026-08-29T10:40:00Z", "epoch milliseconds");
    const asset = one.assets[0]!;
    assert.equal(asset.mediaType, "application/pdf");
    assert.equal(asset.originalName, "1주차 강의자료.pdf");
    assert.equal(readFileSync(join(root, asset.storageKey), "utf8"), "%PDF-1.7 week one");
    assert.equal(downloads(lx.state.calls), 2);
  });

  test("the token goes only to the LearningX API, never to Commons", async () => {
    const { lx, run } = setup();
    await run();
    for (const call of lx.state.calls) {
      assert.equal(call.auth !== null, call.url.includes("/learningx/api/"), call.url);
    }
  });

  test("an unchanged material is reused without contacting Commons", async () => {
    const { lx, run } = setup();
    const first = await run();
    lx.state.calls.length = 0;
    const second = await run(manifest(first));
    assert.deepEqual(second.errors, []);
    assert.equal(lx.state.calls.filter((c) => c.url.startsWith(COMMONS)).length, 0);
    assert.equal(find(second, "c0ffee01")!.resource.revision, 1);
  });

  test("an updated material is downloaded again and its revision rises", async () => {
    const { lx, run } = setup();
    const first = await run();
    lx.state.contents.set("c0ffee01", { body: "%PDF-1.7 week one v2", ext: "pdf", updated: "2026-10-02 10:00:00" });
    const second = await run(manifest(first));
    assert.equal(find(second, "c0ffee01")!.resource.revision, 2);
    assert.equal(downloads(lx.state.calls), 3);
  });

  test("an HTML error page is never saved as a PDF; the previous good copy stays", async () => {
    const { lx, run } = setup();
    const first = await run();
    lx.state.contents.set("c0ffee01", { body: "%PDF-1.7 new", ext: "pdf", updated: "2026-10-03 10:00:00" });
    lx.state.errorPage.add("c0ffee01");
    const second = await run(manifest(first));
    assert.equal(second.errors[0]?.code, "DOWNLOAD_FAILED");
    assert.equal(second.errors[0]?.resourceSourceId, "commons:c0ffee01");
    assert.deepEqual(find(second, "c0ffee01"), find(first, "c0ffee01"));
  });

  test("movies and not-yet-open items are listed as skipped, not fetched", async () => {
    const { lx, run } = setup();
    lx.state.contents.set("feed0001", { body: "", ext: "mp4", type: "movie", updated: "2026-09-02 10:00:00" });
    lx.state.extra.push(
      { content_type: "attendance_item", title: "강의 영상", content_data: { item_content_data: { content_id: "feed0001", content_type: "movie" } } },
      { content_type: "attendance_item", title: "다음 주", content_data: { opened: false, item_content_data: { content_id: "not_open", content_type: "pdf" } } },
    );
    const r = await run();
    assert.deepEqual(r.skippedTypes, { Page: 1, ExternalUrl: 1, "learningx:movie": 1, "learningx:not_open": 1 });
    assert.equal(lx.state.calls.some((c) => c.url.includes("feed0001")), false);
  });

  test("without a LearningX sign-in the run stops as AUTH_REQUIRED", async () => {
    const { lx, run } = setup();
    lx.state.token = undefined;
    await assert.rejects(run(), (e) => e instanceof CollectionError && e.appError.code === "AUTH_REQUIRED");
    lx.state.token = "expired.token";
    await assert.rejects(run(), (e) => e instanceof CollectionError && e.appError.code === "AUTH_REQUIRED" && e.appError.detail?.httpStatus === 401);
  });

  test("payload check rejects HTML and wrong magic bytes", () => {
    const b = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));
    assert.equal(validPayload(b("%PDF-1.4"), "pdf"), true);
    assert.equal(validPayload(b("  <!DOCTYPE html>"), "pdf"), false);
    assert.equal(validPayload(b("PK\x03\x04rest"), "pdf"), false);
    assert.equal(validPayload(b("PK\x03\x04rest"), "pptx"), true);
    assert.equal(validPayload(b(""), "pdf"), false);
  });
});
