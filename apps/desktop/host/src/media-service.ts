import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { AccountKey, AppError, Id, MediaAsset, Recording } from "@learningxxx/contracts";
import type { Course, Transcript, TranscriptionJob } from "@learningxxx/contracts";
import { downloadVideo } from "@learningxxx/collector";
import type { VideoDownloadInput } from "@learningxxx/collector";
import { EngineError, TranscriptionQueue } from "@learningxxx/transcriber";
import type { Engine } from "@learningxxx/transcriber";
import { z } from "zod";

const Download = z.object({ id: Id, courseId: Id, resourceId: Id, sourceId: z.string().regex(/^[\w-]{1,64}$/), title: z.string().min(1).max(200), status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]), receivedBytes: z.number().nonnegative().optional(), totalBytes: z.number().positive().optional(), errorCode: z.string().optional(), assetId: Id.optional() });
export type MediaDownload = z.infer<typeof Download>;
const Catalog = z.object({ assets: z.array(MediaAsset), downloads: z.array(Download) });
type Catalog = z.infer<typeof Catalog>;
interface Partition { key: string; root: string; catalog: Catalog; queue: TranscriptionQueue; writes: Promise<void> }
export interface MediaServiceOptions {
  dataRoot: string;
  accountKey: () => string | undefined;
  courses: () => Promise<Course[]>;
  originals: () => MediaAsset[];
  recordings: (courseId: string) => Recording[];
  engine: Engine;
  contextFor?: (asset: MediaAsset) => Promise<string>;
  videos: (course: Course) => Promise<{ sourceId: string; title: string }[]>;
  openOriginal: (path: string) => Promise<void>;
  video: (course: Course, contentId: string) => Pick<VideoDownloadInput, "fetch" | "resolveSource" | "allowedOrigins">;
}
function fail(code: "NOT_FOUND" | "SCOPE_VIOLATION" | "CHECKSUM_MISMATCH" | "AUTH_REQUIRED" | "MEDIA_UNREADABLE", message: string): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable: false }) });
}

/** Durable account-scoped originals → automatic local transcription. No summary. */
export class MediaService {
  readonly #o: MediaServiceOptions;
  #partition: Partition | undefined;
  #activation: Promise<void> = Promise.resolve();
  #downloads = new Map<string, { abort: AbortController; done: Promise<void> }>();
  constructor(options: MediaServiceOptions) { this.#o = options; }

  async #save(p: Partition): Promise<void> {
    const text = JSON.stringify(p.catalog);
    const write = p.writes.catch(() => {}).then(async () => {
      await mkdir(p.root, { recursive: true, mode: 0o700 });
      const temp = join(p.root, `${randomUUID()}.tmp`);
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, join(p.root, "catalog.json"));
    });
    p.writes = write; await write;
  }

  #path(p: Partition, asset: MediaAsset): string {
    if (asset.role !== "original") fail("SCOPE_VIOLATION", "원본만 전사할 수 있습니다.");
    const recording = asset.source.type === "recording";
    const pattern = recording ? /^media\/originals\/[a-f0-9]{64}\.(wav|m4a)$/ : /^video-originals\/[a-f0-9]{2}\/[a-f0-9]{64}\.mp4$/;
    if (!pattern.test(asset.storageKey)) fail("SCOPE_VIOLATION", "허용된 원본 저장 경로가 아닙니다.");
    return resolve(recording ? this.#o.dataRoot : p.root, asset.storageKey);
  }

  async #verify(p: Partition, asset: MediaAsset): Promise<string> {
    const path = this.#path(p, asset), base = await realpath(asset.source.type === "recording" ? this.#o.dataRoot : p.root);
    const actual = await realpath(path).catch(() => fail("CHECKSUM_MISMATCH", "원본이 없거나 손상되었습니다."));
    const rel = relative(base, actual);
    if (rel.startsWith("..") || resolve(base, rel) !== actual) fail("SCOPE_VIOLATION", "원본 경로가 데이터 폴더를 벗어났습니다.");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat(); if (!stat.isFile() || stat.size !== asset.bytes) fail("CHECKSUM_MISMATCH", "원본 크기가 바뀌었습니다.");
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest("hex") !== asset.sha256) fail("CHECKSUM_MISMATCH", "원본 내용이 바뀌었습니다. 전사하지 않았습니다.");
    } finally { await file.close(); }
    return path;
  }

  async #activate(): Promise<Partition> {
    const key = this.#o.accountKey(); if (!key) fail("AUTH_REQUIRED", "학교 자료를 먼저 수집해 계정을 확인하세요.");
    AccountKey.parse(key);
    const operation = this.#activation.catch(() => {}).then(async () => {
      if (this.#partition?.key === key) return;
      for (const download of this.#downloads.values()) download.abort.abort();
      await Promise.allSettled([...this.#downloads.values()].map((d) => d.done));
      await this.#partition?.queue.stop();
      this.#partition = undefined;
      const root = join(this.#o.dataRoot, "media", "accounts", key);
      let catalog: Catalog;
      try { catalog = Catalog.parse(JSON.parse(await readFile(join(root, "catalog.json"), "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("CHECKSUM_MISMATCH", "미디어 목록을 읽지 못했습니다. 기존 파일을 보존했습니다."); catalog = { assets: [], downloads: [] }; }
      const p = { key, root, catalog, writes: Promise.resolve() } as Partition;
      const engine: Engine = { info: this.#o.engine.info, parameters: this.#o.engine.parameters, transcribe: async (input) => {
        const asset = p.catalog.assets.find((a) => this.#path(p, a) === input.audioPath);
        if (!asset) throw new EngineError("NOT_FOUND", "원본 정보를 찾지 못했습니다.", false);
        try { await this.#verify(p, asset); } catch { throw new EngineError("CHECKSUM_MISMATCH", "원본 무결성을 확인하지 못했습니다.", false); }
        input.signal.throwIfAborted();
        return this.#o.engine.transcribe(input);
      } };
      p.queue = new TranscriptionQueue({ root: join(root, "transcription"), engine, pathOf: (a) => this.#path(p, a), ...(this.#o.contextFor ? { contextFor: this.#o.contextFor } : {}) });
      for (const d of catalog.downloads) if (d.status === "running" || d.status === "queued") { d.status = "failed"; d.errorCode = "RUN_INTERRUPTED"; }
      await this.#save(p);
      if (key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다. 다시 여세요.");
      this.#partition = p;
      for (const asset of catalog.assets) p.queue.enqueue(asset);
      p.queue.start();
    });
    this.#activation = operation; await operation;
    if (key !== this.#o.accountKey() || this.#partition?.key !== key) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다. 다시 여세요.");
    return this.#partition;
  }

  async #course(courseId: string): Promise<{ p: Partition; course: Course }> {
    const p = await this.#activate(), courses = await this.#o.courses();
    const course = courses.find((c) => c.id === courseId && c.accountKey === p.key);
    if (!course || p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "현재 계정의 과목이 아닙니다.");
    return { p, course };
  }

  async register(asset: MediaAsset): Promise<MediaAsset> {
    const valid = MediaAsset.parse(asset), { p } = await this.#course(valid.courseId);
    await this.#verify(p, valid);
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    if (!p.catalog.assets.some((a) => a.id === valid.id)) { p.catalog.assets.push(valid); await this.#save(p); }
    p.queue.enqueue(valid); return valid;
  }
  async authorize(courseId: string): Promise<void> { await this.#course(courseId); }

  /** Reconcile durable confirmed recordings and the catalog, including a crash before enqueue. */
  async recover(): Promise<void> {
    const p = await this.#activate(), courses = await this.#o.courses();
    for (const asset of this.#o.originals()) if (!p.catalog.assets.some((a) => a.id === asset.id) && courses.some((c) => c.id === asset.courseId && c.accountKey === p.key)) await this.register(asset);
    for (const asset of p.catalog.assets) p.queue.enqueue(asset);
  }

  async list(courseId: string) {
    const { p } = await this.#course(courseId);
    const assets = p.catalog.assets.filter((a) => a.courseId === courseId);
    const jobs: TranscriptionJob[] = [], transcripts: Transcript[] = [];
    for (const asset of assets) {
      // The shared queue deduplicates equal bytes across asset IDs/courses.
      for (const job of p.queue.jobs()) {
        const original = p.catalog.assets.find((a) => a.id === job.sourceAssetId);
        if (original?.sha256 !== asset.sha256) continue;
        jobs.push({ ...job, sourceAssetId: asset.id });
        if (job.outputTranscriptId) { const t = p.queue.transcript(job.outputTranscriptId); if (t) transcripts.push({ ...t, sourceAssetId: asset.id }); }
      }
    }
    return { assets, recordings: this.#o.recordings(courseId), jobs, transcripts, downloads: p.catalog.downloads.filter((d) => d.courseId === courseId) };
  }

  async asset(courseId: string, assetId: string) {
    const { p } = await this.#course(courseId), asset = p.catalog.assets.find((a) => a.id === assetId && a.courseId === courseId);
    if (!asset) fail("NOT_FOUND", "현재 과목의 원본이 아닙니다.");
    if (asset.bytes > 256 * 1024 ** 2) fail("MEDIA_UNREADABLE", "큰 원본은 시스템 플레이어로 열기를 사용하세요. 앱 내 재생은 256MB까지 지원합니다.");
    const path = await this.#verify(p, asset), bytes = new Uint8Array(await readFile(path));
    if (bytes.length !== asset.bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) fail("CHECKSUM_MISMATCH", "읽는 동안 원본이 바뀌었습니다.");
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    return { bytes, mediaType: asset.mediaType };
  }

  async retry(courseId: string, jobId: string) {
    const { p } = await this.#course(courseId), listed = await this.list(courseId);
    if (!listed.jobs.some((j) => j.id === jobId)) fail("NOT_FOUND", "현재 과목의 전사 작업이 아닙니다.");
    p.queue.retry(jobId); return {};
  }

  async open(courseId: string, assetId: string) {
    const { p } = await this.#course(courseId), asset = p.catalog.assets.find((a) => a.id === assetId && a.courseId === courseId);
    if (!asset) fail("NOT_FOUND", "현재 과목의 원본이 아닙니다.");
    const path = await this.#verify(p, asset);
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    await this.#o.openOriginal(path); return {};
  }

  async videos(courseId: string) {
    const { p, course } = await this.#course(courseId), videos = await this.#o.videos(course);
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    return { videos };
  }

  async download(courseId: string, sourceId: string) {
    const { p, course } = await this.#course(courseId);
    const source = (await this.videos(courseId)).videos.find((v) => v.sourceId === sourceId);
    if (!source) fail("SCOPE_VIOLATION", "현재 과목에서 접근 가능한 영상이 아닙니다.");
    const title = source.title;
    const item = Download.parse({ id: randomUUID(), resourceId: randomUUID(), courseId, sourceId, title, status: "queued" });
    const existing = p.catalog.downloads.find((d) => d.courseId === courseId && d.sourceId === sourceId && ["queued", "running", "succeeded"].includes(d.status));
    if (existing) return { downloadId: existing.id };
    p.catalog.downloads.push(item); await this.#save(p);
    const abort = new AbortController();
    const done = Promise.resolve().then(async () => {
      try {
        item.status = "running"; await this.#save(p);
        if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
        const asset = await downloadVideo({ root: p.root, courseId, resourceId: item.resourceId, sourceId, title, ...this.#o.video(course, sourceId), signal: abort.signal, onProgress: (received, total) => { item.receivedBytes = received; if (total !== undefined) item.totalBytes = total; } });
        if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다. 새 계정으로 전달하지 않았습니다.");
        p.catalog.assets.push(asset); item.assetId = asset.id; item.status = "succeeded";
        // Persist before enqueue; restart reconciles a missing job.
        await this.#save(p); p.queue.enqueue(asset);
      } catch (error) {
        item.status = item.assetId ? "succeeded" : abort.signal.aborted ? "cancelled" : "failed";
        item.errorCode = (error as { appError?: { code?: string } }).appError?.code ?? "DOWNLOAD_FAILED";
        await this.#save(p);
      }
    }).finally(() => this.#downloads.delete(item.id));
    this.#downloads.set(item.id, { abort, done });
    // Keep background failures from becoming an unhandled rejection; catalog is retained.
    void done.catch(() => {});
    return { downloadId: item.id };
  }

  async cancelDownload(courseId: string, downloadId: string) {
    const { p } = await this.#course(courseId);
    if (!p.catalog.downloads.some((d) => d.id === downloadId && d.courseId === courseId)) fail("NOT_FOUND", "다운로드를 찾지 못했습니다.");
    const active = this.#downloads.get(downloadId); active?.abort.abort(); await active?.done; return {};
  }
  async stop() { for (const d of this.#downloads.values()) d.abort.abort(); await Promise.allSettled([...this.#downloads.values()].map((d) => d.done)); await this.#partition?.queue.stop(); }
}
