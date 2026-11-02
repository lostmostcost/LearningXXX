import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CollectionError, createCommonsVideoResolver, downloadVideo } from "../src/index.ts";
import type { VideoDownloadInput } from "../src/index.ts";

const BASE = "https://commons.example.test";
const courseId = "11111111-1111-4111-8111-111111111111";
const resourceId = "22222222-2222-4222-8222-222222222222";
const video = await readFile(new URL("./fixtures/video/black.mp4", import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup(extra: Partial<VideoDownloadInput> = {}) {
  const root = await mkdtemp(join(tmpdir(), "wbs024-")); roots.push(root);
  let resolves = 0;
  const input: VideoDownloadInput = {
    root, courseId, resourceId, sourceId: "lecture01", title: "합성 강의", allowedOrigins: [BASE], attempts: 1, retryDelayMs: 0,
    resolveSource: async () => ({ url: `${BASE}/original.mp4?signature=${++resolves}`, referer: `${BASE}/em/lecture01` }),
    fetch: (async () => new Response(video, { headers: { "content-type": "video/mp4", "content-length": String(video.length) } })) as typeof fetch,
    ...extra,
  };
  return { root, input, resolves: () => resolves };
}
const code = (expected: string) => (error: unknown) => error instanceof CollectionError && error.appError.code === expected;
const response = (body: BodyInit, headers: Record<string, string> = {}) => new Response(body, { headers: { "content-type": "video/mp4", ...headers } });

test("Commons refreshes metadata/viewer each time, scopes cookies and never sends LearningX token", async () => {
  let attempt = 0;
  const requests: { url: string; init: RequestInit }[] = [];
  const resolver = createCommonsVideoResolver({ contentId: "lecture01", commonsBaseUrl: BASE, fetch: (async (url, init) => {
    requests.push({ url: String(url), init: init! });
    if (String(url).includes("/contents/")) return Response.json({ result: { extension: "mp4", download_url: `/dl?sig=${++attempt}` } });
    return new Response("viewer");
  }) as typeof fetch });
  assert.match((await resolver()).url, /sig=1/);
  assert.match((await resolver()).url, /sig=2/);
  assert.equal(requests.length, 4);
  for (const r of requests) { assert.equal(r.init.redirect, "manual"); assert.equal(new Headers(r.init.headers).has("authorization"), false); }
});

test("resolver rejects external URL, non-MP4/DRM-only source, expired login and oversized metadata", async () => {
  for (const [body, expected] of [[{ result: { extension: "mp4", download_url: "https://evil.test/dl" } }, "SOURCE_CHANGED"], [{ result: { extension: "m3u8", download_url: "/stream" } }, "UNSUPPORTED_FORMAT"]] as const) {
    await assert.rejects(createCommonsVideoResolver({ contentId: "lecture01", commonsBaseUrl: BASE, fetch: (async () => Response.json(body)) as typeof fetch })(), code(expected));
  }
  await assert.rejects(createCommonsVideoResolver({ contentId: "lecture01", fetch: (async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } })) as typeof fetch })(), code("AUTH_REQUIRED"));
  await assert.rejects(createCommonsVideoResolver({ contentId: "lecture01", fetch: (async () => new Response("x".repeat(1024 * 1024 + 1))) as typeof fetch })(), code("SOURCE_CHANGED"));
  await assert.rejects(createCommonsVideoResolver({ contentId: "lecture01", fetch: (async () => { throw new Error("signed-secret-URL"); }) as typeof fetch })(), (e: unknown) => e instanceof Error && !String(e).includes("signed-secret"));
  await assert.rejects(createCommonsVideoResolver({ contentId: "lecture01", fetch: (async () => new Response(new ReadableStream({ start(c) { c.error(new Error("signed-secret-URL")); } }))) as typeof fetch })(), (e: unknown) => e instanceof CollectionError && !String(e).includes("signed-secret"));
});

test("complete synthetic MP4 becomes immutable original/MediaAsset; repeat and concurrent downloads deduplicate", async () => {
  const { input, root } = await setup();
  const results = await Promise.all([downloadVideo(input), downloadVideo(input)]);
  assert.equal(results[0]!.id, results[1]!.id);
  assert.equal(results[0]!.sha256, createHash("sha256").update(video).digest("hex"));
  assert.equal(results[0]!.role, "original");
  assert.equal(results[0]!.source.type, "lms_video");
  assert.deepEqual(await readFile(join(root, results[0]!.storageKey)), video);
  assert.deepEqual(await readdir(join(root, "video-tmp")), []);
  assert.equal(JSON.stringify(results).includes("signature"), false);
});

test("size missing stays indeterminate while streaming; actual structure still required", async () => {
  const progress: (number | undefined)[] = [];
  const { input } = await setup({ fetch: (async () => response(video)) as typeof fetch, onProgress: (_received, total) => { progress.push(total); } });
  await downloadVideo(input);
  assert.ok(progress.length > 0);
  assert.ok(progress.every((n) => n === undefined));
});

test("expired signed address, network interruption and 5xx retry with newly resolved source", async () => {
  for (const status of [403, 503, 0]) {
    let calls = 0;
    const { input, resolves, root } = await setup({ attempts: 2, fetch: (async () => {
      if (++calls === 1) {
        if (status) return new Response(null, { status });
        return response(new ReadableStream({ start(controller) { controller.enqueue(video.subarray(0, 80)); controller.error(new Error("secret-url")); } }));
      }
      return response(video);
    }) as typeof fetch });
    await downloadVideo(input);
    assert.equal(resolves(), 2);
    assert.deepEqual(await readdir(join(root, "video-tmp")), []);
  }
});

test("partial/oversized/HTML/partial-range/DRM response cannot publish an original", async () => {
  const encrypted = Buffer.from(video);
  const avc = encrypted.lastIndexOf("avc1"); assert.ok(avc > 0); encrypted.write("encv", avc, "ascii");
  const badOffset = Buffer.from(video), stco = badOffset.indexOf("stco"); assert.ok(stco > 0);
  badOffset.writeUInt32BE(video.length + 1, stco + 12);
  const badSamples = Buffer.from(video), stsz = badSamples.indexOf("stsz"); assert.ok(stsz > 0);
  badSamples.writeUInt32BE(0xffffffff, stsz + 16);
  const cases = [
    () => response(video.subarray(0, video.length - 5), { "content-length": String(video.length) }),
    () => response(video.subarray(0, video.length - 5)),
    () => response(Buffer.from("<!DOCTYPE html>login")),
    () => new Response(video, { status: 206 }),
    () => response(video, { "content-length": "1" }),
    () => response(video, { "content-length": "9007199254740993" }),
    () => response(encrypted),
    () => response(badOffset),
    () => response(badSamples),
    () => response(video, { "content-type": "text/html" }),
  ];
  for (const make of cases) {
    const { input, root } = await setup({ fetch: (async () => make()) as typeof fetch });
    await assert.rejects(downloadVideo(input), (e: unknown) => e instanceof CollectionError);
    assert.deepEqual(await readdir(join(root, "video-tmp")), []);
    assert.equal((await readdir(root)).includes("video-originals"), false);
  }
});

test("cancellation during retry backoff prevents another request; attempt timeout aborts fetch", async () => {
  const abort = new AbortController();
  let calls = 0;
  const { input } = await setup({ attempts: 3, retryDelayMs: 1000, signal: abort.signal, fetch: (async () => {
    calls++; setTimeout(() => abort.abort(), 5); return new Response(null, { status: 503 });
  }) as typeof fetch });
  await assert.rejects(downloadVideo(input), code("RUN_INTERRUPTED")); assert.equal(calls, 1);
  // Real fetch respects AbortSignal. This mock models the same contract.
  const timed = await setup({ timeoutMs: 5, fetch: (async (_url, init) => new Promise<Response>((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error("test must have aborted sooner")), 1000);
    const finish = () => { clearTimeout(keepAlive); reject(new Error("aborted")); };
    if (init?.signal?.aborted) finish(); else init?.signal?.addEventListener("abort", finish, { once: true });
  })) as typeof fetch });
  await assert.rejects(downloadVideo(timed.input), code("DOWNLOAD_FAILED"));
});

test("stream cap applies without Content-Length; metadata length mismatch is not completion", async () => {
  const { input } = await setup({ maxBytes: video.length - 1, fetch: (async () => response(video)) as typeof fetch });
  await assert.rejects(downloadVideo(input), code("DOWNLOAD_INCOMPLETE"));
  const another = await setup({ resolveSource: async () => ({ url: `${BASE}/a`, referer: `${BASE}/em`, expectedBytes: video.length + 1 }) });
  await assert.rejects(downloadVideo(another.input), code("DOWNLOAD_INCOMPLETE"));
});

test("external/redirect/auth failures stop; no follow and no arbitrary error detail escapes", async () => {
  let calls = 0;
  const { input } = await setup({ attempts: 3, resolveSource: async () => ({ url: "https://evil.test/file", referer: BASE }), fetch: (async () => { calls++; return response(video); }) as typeof fetch });
  await assert.rejects(downloadVideo(input), code("SOURCE_CHANGED")); assert.equal(calls, 0);
  const other = await setup({ attempts: 3, fetch: (async (_url, init) => { calls++; assert.equal(init?.redirect, "manual"); return new Response(null, { status: 302 }); }) as typeof fetch });
  await assert.rejects(downloadVideo(other.input), code("AUTH_REQUIRED")); assert.equal(calls, 1);
});

test("cancellation during stream cleans partial; existing original survives later failures", async () => {
  const controller = new AbortController();
  const { input, root } = await setup();
  const good = await downloadVideo(input);
  input.signal = controller.signal;
  input.onProgress = () => controller.abort("private cancellation reason");
  await assert.rejects(downloadVideo(input), code("RUN_INTERRUPTED"));
  assert.deepEqual(await readFile(join(root, good.storageKey)), video);
  assert.deepEqual(await readdir(join(root, "video-tmp")), []);
});

test("tampered existing original is never overwritten; symlink temp folder cannot escape root", async () => {
  const { input, root } = await setup();
  const good = await downloadVideo(input);
  await writeFile(join(root, good.storageKey), "tampered");
  await assert.rejects(downloadVideo(input), code("CHECKSUM_MISMATCH"));
  assert.equal(await readFile(join(root, good.storageKey), "utf8"), "tampered");
  const other = await setup();
  await symlink(root, join(other.root, "video-tmp"));
  await assert.rejects(downloadVideo(other.input), code("SCOPE_VIOLATION"));
});
