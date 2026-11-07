import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { AccountKey, AppError, Id, ImportedDocKind, LectureMention, MANUAL_ENGINE, MediaAsset, Recording, SCHEMA_VERSION, Sha256, Transcript } from "@learningxxx/contracts";
import type { MentionCandidate, PreferredLanguage } from "@learningxxx/contracts";
import type { Course, IpcResponse, TranscriptionJob } from "@learningxxx/contracts";
import { downloadVideo } from "@learningxxx/collector";
import { TRANSLATE_BATCH } from "./readable-note.ts";
import type { VideoDownloadInput } from "@learningxxx/collector";
import { EngineError, TranscriptionQueue } from "@learningxxx/transcriber";
import type { Engine } from "@learningxxx/transcriber";
import { z } from "zod";

const Download = z.object({ id: Id, courseId: Id, resourceId: Id, sourceId: z.string().regex(/^[\w-]{1,64}$/), title: z.string().min(1).max(200), status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]), receivedBytes: z.number().nonnegative().optional(), totalBytes: z.number().positive().optional(), errorCode: z.string().optional(), assetId: Id.optional() });
export type MediaDownload = z.infer<typeof Download>;
/** WBS-066: an original imported with its own transcript and notes; it is not transcribed again. */
const Imported = z.object({ sha256: Sha256, transcriptId: Id.optional(), model: z.string().max(200).optional(), docs: z.array(ImportedDocKind), createdAt: z.string() });
/** WBS-069: a version the user corrected by hand, stored apart from engine output. */
const Correction = z.object({ sha256: Sha256, transcriptId: Id });
/** WBS-087: originals the student deleted to free space; their transcripts and notes stay. */
const Removed = z.object({ assetId: Id, removedAt: z.string() });
const Catalog = z.object({ assets: z.array(MediaAsset), downloads: z.array(Download), imports: z.array(Imported).default([]), corrections: z.array(Correction).default([]), mentions: z.array(LectureMention).default([]), removed: z.array(Removed).default([]) });
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
  /** WBS-069: transcript text → readable note through the official CLI; absent, the button reports it is unavailable. */
  readable?: (input: { title: string; text: string; signal: AbortSignal }) => Promise<string>;
  /** WBS-070: transcript text → assignment/exam candidates (parsed against the transcript). */
  mentions?: (input: { title: string; text: string; transcript: Transcript; signal: AbortSignal }) => Promise<MentionCandidate[]>;
  /** WBS-071: sentences → translations in the same order (undefined where none came back). */
  translate?: (input: { language: PreferredLanguage; lines: string[]; signal: AbortSignal }) => Promise<(string | undefined)[]>;
  /** WBS-083: transcript sentences → the same sentences with misheard words fixed (undefined where none came back). */
  correct?: (input: { title: string; context: string; lines: string[]; signal: AbortSignal }) => Promise<(string | undefined)[]>;
  /** WBS-083: told when a transcription finishes, once per course asset with those bytes. */
  onTranscribed?: (input: { courseId: string; assetId: string; transcriptId: string; title: string }) => void;
  openOriginal: (path: string) => Promise<void>;
  video: (course: Course, contentId: string) => Pick<VideoDownloadInput, "fetch" | "resolveSource" | "allowedOrigins">;
}
function fail(code: "NOT_FOUND" | "SCOPE_VIOLATION" | "CHECKSUM_MISMATCH" | "AUTH_REQUIRED" | "MEDIA_UNREADABLE" | "INVALID_REQUEST" | "RUN_ALREADY_ACTIVE", message: string): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable: false }) });
}

/** Durable account-scoped originals → automatic local transcription. No summary. */
/** WBS-083: the engine name of corrections Claude Code made automatically. */
export const AUTO_CORRECTION_ENGINE = "claude-code-correction";


export class MediaService {
  readonly #o: MediaServiceOptions;
  #partition: Partition | undefined;
  #activation: Promise<void> = Promise.resolve();
  #closing = false;
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
    const pattern = recording ? /^media\/originals\/[a-f0-9]{64}\.(wav|m4a|mp3|aac|aif|aiff|flac|caf|mp4|3gp|amr|ogg|oga|opus)$/ : /^video-originals\/[a-f0-9]{2}\/[a-f0-9]{64}\.mp4$/;
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

  /** Every original is transcribed once, except one imported with its own transcript (WBS-066). */
  #enqueue(p: Partition, asset: MediaAsset): TranscriptionJob | undefined {
    if (p.catalog.imports.some((i) => i.sha256 === asset.sha256 && i.transcriptId)) return undefined;
    if (this.#isRemoved(p, asset.id)) return undefined;
    return p.queue.enqueue(asset);
  }

  #isRemoved(p: Partition, assetId: string): boolean { return p.catalog.removed.some((r) => r.assetId === assetId); }

  /** Has a finished transcript (made here or imported with the recording). */
  #transcribed(p: Partition, asset: MediaAsset): boolean {
    if (p.catalog.imports.some((i) => i.sha256 === asset.sha256 && i.transcriptId)) return true;
    return p.queue.jobs().some((j) => j.status === "succeeded" && j.outputTranscriptId && p.catalog.assets.find((a) => a.id === j.sourceAssetId)?.sha256 === asset.sha256);
  }

  #gone(p: Partition, asset: MediaAsset): void {
    if (this.#isRemoved(p, asset.id)) fail("NOT_FOUND", "이 원본은 저장공간 정리로 지웠습니다. 전사와 정리본은 그대로 있습니다.");
  }

  /**
   * WBS-087: the recordings and downloaded videos kept on this Mac, per course,
   * with which of them may be deleted (only those with a finished transcript).
   */
  async storage(): Promise<IpcResponse<"media.storage">> {
    const p = await this.#activate(), courses = await this.#o.courses();
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    return { courses: courses.filter((c) => c.accountKey === p.key).map((course) => ({
      courseId: course.id, title: course.title,
      items: p.catalog.assets.filter((a) => a.courseId === course.id && a.role === "original").map((a) => {
        const removed = p.catalog.removed.find((r) => r.assetId === a.id);
        return { assetId: a.id, title: a.title, kind: a.source.type === "recording" ? "recording" as const : "video" as const, bytes: a.bytes, createdAt: a.createdAt, transcribed: this.#transcribed(p, a), ...(removed ? { removedAt: removed.removedAt } : {}) };
      }),
    })).filter((c) => c.items.length) };
  }

  /**
   * Deletes the chosen originals of a course. Only ones with a finished
   * transcript, never during a download; transcripts, corrections, notes and
   * translations are kept. The file goes only when no other kept asset uses
   * the same stored bytes.
   */
  async removeOriginals(courseId: string, assetIds: readonly string[]): Promise<IpcResponse<"media.removeOriginals">> {
    const { p } = await this.#course(courseId);
    const skipped: { assetId: string; reason: string }[] = [];
    const chosen: MediaAsset[] = [];
    for (const id of new Set(assetIds)) {
      const asset = p.catalog.assets.find((a) => a.id === id && a.courseId === courseId && a.role === "original");
      const reason = !asset ? "이 과목의 원본이 아닙니다" : this.#isRemoved(p, id) ? "이미 지웠습니다"
        : !this.#transcribed(p, asset) ? "전사가 끝나지 않았습니다"
        : p.catalog.downloads.some((d) => d.assetId === id && (d.status === "queued" || d.status === "running")) ? "받는 중입니다" : undefined;
      if (reason) skipped.push({ assetId: id, reason }); else chosen.push(asset!);
    }
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    const removedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    p.catalog.removed.push(...chosen.map((a) => ({ assetId: a.id, removedAt })));
    // Recorded first: a crash between the two steps leaves a marked original, never an unmarked missing one.
    await this.#save(p);
    let freedBytes = 0;
    for (const storageKey of new Set(chosen.map((a) => a.storageKey))) {
      const owner = chosen.find((a) => a.storageKey === storageKey)!;
      if (p.catalog.assets.some((a) => a.storageKey === storageKey && !this.#isRemoved(p, a.id))) continue;
      try { await unlink(this.#path(p, owner)); freedBytes += owner.bytes; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") skipped.push({ assetId: owner.id, reason: "파일을 지우지 못했습니다" }); }
    }
    return { removed: chosen.length, freedBytes, skipped };
  }

  #importDir(p: Partition, sha256: string): string {
    return join(p.root, "imports", Sha256.parse(sha256));
  }

  /**
   * WBS-066, before the original itself is stored: keeps the transcript and
   * notes that came with it, keyed by the original's content, so that a crash
   * between the two steps never sends it to transcription.
   */
  async adoptImport(courseId: string, input: { sha256: string; transcript?: Transcript; model?: string; docs: { kind: ImportedDocKind; text: string }[] }): Promise<void> {
    const { p } = await this.#course(courseId);
    if (p.catalog.imports.some((i) => i.sha256 === input.sha256)) return;
    const dir = this.#importDir(p, input.sha256);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const doc of input.docs) await writeFile(join(dir, `${ImportedDocKind.parse(doc.kind)}.txt`), doc.text, { mode: 0o600 });
    const transcript = input.transcript ? Transcript.parse(input.transcript) : undefined;
    if (transcript) await writeFile(join(dir, "transcript.json"), JSON.stringify(transcript), { mode: 0o600 });
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    p.catalog.imports.push(Imported.parse({ sha256: input.sha256, ...(transcript ? { transcriptId: transcript.id } : {}), ...(input.model ? { model: input.model.slice(0, 200) } : {}), docs: input.docs.map((d) => d.kind), createdAt: new Date().toISOString() }));
    await this.#save(p);
  }

  /** Imported transcripts never change, so each is read once per account (the list is polled). */
  readonly #importedCache = new Map<string, Transcript | undefined>();
  async #importedTranscript(p: Partition, sha256: string): Promise<Transcript | undefined> {
    const record = p.catalog.imports.find((i) => i.sha256 === sha256);
    if (!record?.transcriptId) return undefined;
    const key = `${p.key}/${sha256}`;
    if (this.#importedCache.has(key)) return this.#importedCache.get(key);
    let transcript: Transcript | undefined;
    try { transcript = Transcript.parse(JSON.parse(await readFile(join(this.#importDir(p, sha256), "transcript.json"), "utf8"))); }
    catch { transcript = undefined; }
    this.#importedCache.set(key, transcript);
    return transcript;
  }

  /** A copied note of an imported original, as text. */
  async importedDoc(courseId: string, assetId: string, doc: ImportedDocKind): Promise<{ text: string }> {
    const { p } = await this.#course(courseId), asset = p.catalog.assets.find((a) => a.id === assetId && a.courseId === courseId);
    const record = asset && p.catalog.imports.find((i) => i.sha256 === asset.sha256);
    if (!asset || !record?.docs.includes(doc)) fail("NOT_FOUND", "가져온 문서를 찾지 못했습니다.");
    const text = await readFile(join(this.#importDir(p, asset.sha256), `${ImportedDocKind.parse(doc)}.txt`), "utf8").catch(() => fail("NOT_FOUND", "가져온 문서를 찾지 못했습니다."));
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    return { text };
  }

  async #activate(): Promise<Partition> {
    if (this.#closing) fail("SCOPE_VIOLATION", "앱이 종료 중입니다.");
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
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("CHECKSUM_MISMATCH", "미디어 목록을 읽지 못했습니다. 기존 파일을 보존했습니다."); catalog = { assets: [], downloads: [], imports: [], corrections: [], mentions: [], removed: [] }; }
      const p = { key, root, catalog, writes: Promise.resolve() } as Partition;
      const engine: Engine = { info: this.#o.engine.info, parameters: this.#o.engine.parameters, transcribe: async (input) => {
        const asset = p.catalog.assets.find((a) => this.#path(p, a) === input.audioPath);
        if (!asset) throw new EngineError("NOT_FOUND", "원본 정보를 찾지 못했습니다.", false);
        try { await this.#verify(p, asset); } catch { throw new EngineError("CHECKSUM_MISMATCH", "원본 무결성을 확인하지 못했습니다.", false); }
        input.signal.throwIfAborted();
        return this.#o.engine.transcribe(input);
      } };
      // A short lease: after a crash the interrupted job runs again within about a minute.
      p.queue = new TranscriptionQueue({ root: join(root, "transcription"), engine, pathOf: (a) => this.#path(p, a), leaseMs: 60_000,
        onChange: (job) => {
          if (job.status !== "succeeded" || !job.outputTranscriptId || !this.#o.onTranscribed) return;
          const sha = p.catalog.assets.find((a) => a.id === job.sourceAssetId)?.sha256;
          for (const a of p.catalog.assets.filter((x) => x.sha256 === sha && !this.#isRemoved(p, x.id))) this.#o.onTranscribed({ courseId: a.courseId, assetId: a.id, transcriptId: job.outputTranscriptId, title: a.title });
        }, ...(this.#o.contextFor ? { contextFor: this.#o.contextFor } : {}) });
      for (const d of catalog.downloads) if (d.status === "running" || d.status === "queued") { d.status = "failed"; d.errorCode = "RUN_INTERRUPTED"; }
      await this.#save(p);
      if (this.#closing) fail("SCOPE_VIOLATION", "앱이 종료 중입니다.");
      if (key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다. 다시 여세요.");
      this.#partition = p;
      for (const asset of catalog.assets) this.#enqueue(p, asset);
      p.queue.start();
    });
    this.#activation = operation; await operation;
    if (this.#closing) fail("SCOPE_VIOLATION", "앱이 종료 중입니다.");
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
    this.#enqueue(p, valid); return valid;
  }
  async authorize(courseId: string): Promise<void> { await this.#course(courseId); }

  /** Reconcile durable confirmed recordings and the catalog, including a crash before enqueue. */
  async recover(): Promise<void> {
    const p = await this.#activate(), courses = await this.#o.courses();
    for (const asset of this.#o.originals()) if (!p.catalog.assets.some((a) => a.id === asset.id) && courses.some((c) => c.id === asset.courseId && c.accountKey === p.key)) await this.register(asset);
    for (const asset of p.catalog.assets) this.#enqueue(p, asset);
  }

  readonly #correctionCache = new Map<string, Transcript | undefined>();
  async #correction(p: Partition, transcriptId: string): Promise<Transcript | undefined> {
    const key = `${p.key}/${transcriptId}`;
    if (this.#correctionCache.has(key)) return this.#correctionCache.get(key);
    let transcript: Transcript | undefined;
    try { transcript = Transcript.parse(JSON.parse(await readFile(join(p.root, "corrections", `${Id.parse(transcriptId)}.json`), "utf8"))); }
    catch { transcript = undefined; }
    this.#correctionCache.set(key, transcript);
    return transcript;
  }

  /**
   * WBS-069: the user's own corrections of one transcript version, kept as a
   * new "corrected" version with the same times. Nothing existing is changed.
   */
  async saveCorrection(courseId: string, assetId: string, basedOnTranscriptId: string, texts: string[], engine: { name: string; version: string } = { name: MANUAL_ENGINE, version: "user" }): Promise<{ transcriptId: string }> {
    const { p } = await this.#course(courseId);
    const asset = p.catalog.assets.find((a) => a.id === assetId && a.courseId === courseId) ?? fail("NOT_FOUND", "현재 과목의 원본이 아닙니다.");
    const base = (await this.list(courseId)).transcripts.find((t) => t.id === basedOnTranscriptId && t.sourceAssetId === assetId) ?? fail("NOT_FOUND", "고칠 전사 판을 찾지 못했습니다.");
    if (texts.length !== base.segments.length) fail("INVALID_REQUEST", "전사 문장 수가 바뀌었습니다. 다시 열어 고쳐 주세요.");
    const transcript = Transcript.parse({
      schemaVersion: SCHEMA_VERSION, id: randomUUID(), sourceAssetId: assetId, kind: "corrected",
      engine, parametersHash: createHash("sha256").update(engine.name).digest("hex"),
      basedOnTranscriptId, language: base.language, createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      segments: base.segments.map((segment, i) => ({ startMs: segment.startMs, endMs: segment.endMs, text: texts[i]!.trim() })),
    });
    const dir = join(p.root, "corrections");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, `${transcript.id}.json`), JSON.stringify(transcript), { mode: 0o600 });
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    p.catalog.corrections.push({ sha256: asset.sha256, transcriptId: transcript.id });
    await this.#save(p);
    return { transcriptId: transcript.id };
  }

  /**
   * WBS-083: Claude Code fixes misheard words of one transcript version,
   * sentence by sentence with the course's material titles as context, kept
   * as a new corrected version (times unchanged). Sentences without an answer
   * stay as they were.
   */
  async autoCorrect(courseId: string, assetId: string, transcriptId: string, signal: AbortSignal): Promise<{ transcriptId: string; changed: number }> {
    const run = this.#o.correct ?? fail("INVALID_REQUEST", "자동 교정을 쓸 수 없습니다.");
    const asset = (await this.#course(courseId)).p.catalog.assets.find((a) => a.id === assetId && a.courseId === courseId) ?? fail("NOT_FOUND", "현재 과목의 원본이 아닙니다.");
    const base = (await this.list(courseId)).transcripts.find((t) => t.id === transcriptId && t.sourceAssetId === assetId) ?? fail("NOT_FOUND", "전사 판을 찾지 못했습니다.");
    const context = await (this.#o.contextFor?.(asset) ?? Promise.resolve(""));
    const lines = base.segments.map((s) => s.text);
    const out: string[] = [];
    let changed = 0;
    for (let at = 0; at < lines.length; at += TRANSLATE_BATCH) {
      const batch = lines.slice(at, at + TRANSLATE_BATCH);
      const fixed = await run({ title: asset.title, context, lines: batch, signal });
      batch.forEach((line, i) => { const t = line.trim() ? fixed[i] ?? line : line; if (t !== line) changed++; out.push(t); });
    }
    const saved = await this.saveCorrection(courseId, assetId, transcriptId, out, { name: AUTO_CORRECTION_ENGINE, version: "claude-code" });
    return { ...saved, changed };
  }

  /** One Claude Code request (readable note or announcement search) at a time. */
  #claudeRun: AbortController | undefined;
  /** WBS-073: what the running Claude Code request is, for the queue screen. */
  #claudeLabel: { what: string; courseId: string; title: string; startedAt: string } | undefined;
  /**
   * WBS-069: on request, a readable note of one transcript version made by the
   * official Claude Code with the user's subscription. Kept as the original's
   * "readable_app" document (replacing an earlier one); the transcript stays.
   */
  async makeReadable(courseId: string, assetId: string, transcriptId: string): Promise<{ doc: "readable_app" }> {
    if (!this.#o.readable) fail("NOT_FOUND", "정리본 만들기를 쓸 수 없습니다.");
    if (this.#claudeRun) fail("RUN_ALREADY_ACTIVE", "Claude Code 요청이 이미 진행 중입니다. 끝난 뒤 다시 시도하세요.");
    const { p } = await this.#course(courseId);
    const asset = p.catalog.assets.find((a) => a.id === assetId && a.courseId === courseId) ?? fail("NOT_FOUND", "현재 과목의 원본이 아닙니다.");
    const version = (await this.list(courseId)).transcripts.find((t) => t.id === transcriptId && t.sourceAssetId === assetId) ?? fail("NOT_FOUND", "전사 판을 찾지 못했습니다.");
    const stamp = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
    const text = version.segments.filter((s) => s.text.trim()).map((s) => `[${stamp(s.startMs)}] ${s.text.trim()}`).join("\n");
    if (!text) fail("INVALID_REQUEST", "정리할 전사 내용이 없습니다.");
    const abort = new AbortController();
    this.#claudeRun = abort;
    this.#claudeLabel = { what: "정리본 만들기", courseId, title: asset.title, startedAt: new Date().toISOString() };
    try {
      const note = (await this.#o.readable({ title: asset.title, text, signal: abort.signal })).trim();
      if (!note) fail("INVALID_REQUEST", "정리본이 비어 있습니다. 다시 시도하세요.");
      if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
      const dir = this.#importDir(p, asset.sha256);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, "readable_app.txt"), note, { mode: 0o600 });
      const record = p.catalog.imports.find((i) => i.sha256 === asset.sha256);
      if (record) { if (!record.docs.includes("readable_app")) record.docs.push("readable_app"); }
      else p.catalog.imports.push(Imported.parse({ sha256: asset.sha256, docs: ["readable_app"], createdAt: new Date().toISOString() }));
      await this.#save(p);
      return { doc: "readable_app" };
    } finally { this.#claudeRun = undefined; this.#claudeLabel = undefined; }
  }

  /** WBS-070: candidates only; nothing is saved until the user confirms some. */
  async findMentions(courseId: string, assetId: string, transcriptId: string): Promise<{ candidates: MentionCandidate[] }> {
    if (!this.#o.mentions) fail("NOT_FOUND", "과제·시험 안내 찾기를 쓸 수 없습니다.");
    if (this.#claudeRun) fail("RUN_ALREADY_ACTIVE", "Claude Code 요청이 이미 진행 중입니다. 끝난 뒤 다시 시도하세요.");
    const { p } = await this.#course(courseId);
    const asset = p.catalog.assets.find((a) => a.id === assetId && a.courseId === courseId) ?? fail("NOT_FOUND", "현재 과목의 원본이 아닙니다.");
    const version = (await this.list(courseId)).transcripts.find((t) => t.id === transcriptId && t.sourceAssetId === assetId) ?? fail("NOT_FOUND", "전사 판을 찾지 못했습니다.");
    const stamp = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
    const text = version.segments.filter((x) => x.text.trim()).map((x) => `[${stamp(x.startMs)}] ${x.text.trim()}`).join("\n");
    if (!text) fail("INVALID_REQUEST", "찾을 전사 내용이 없습니다.");
    const abort = new AbortController();
    this.#claudeRun = abort;
    this.#claudeLabel = { what: "과제·시험 안내 찾기", courseId, title: asset.title, startedAt: new Date().toISOString() };
    try {
      const candidates = await this.#o.mentions({ title: asset.title, text, transcript: version, signal: abort.signal });
      if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
      return { candidates };
    } finally { this.#claudeRun = undefined; this.#claudeLabel = undefined; }
  }

  /** WBS-070: the confirmed ones, with their evidence checked against the transcript again. */
  async addMentions(courseId: string, assetId: string, candidates: MentionCandidate[]): Promise<{ mentions: LectureMention[] }> {
    const { p } = await this.#course(courseId);
    if (!p.catalog.assets.some((a) => a.id === assetId && a.courseId === courseId)) fail("NOT_FOUND", "현재 과목의 원본이 아닙니다.");
    const transcripts = (await this.list(courseId)).transcripts.filter((t) => t.sourceAssetId === assetId);
    const confirmedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const added: LectureMention[] = [];
    for (const c of candidates) {
      const segment = transcripts.find((t) => t.id === c.transcriptId)?.segments.find((x) => x.startMs === c.startMs);
      if (!segment) fail("INVALID_REQUEST", "근거 시각이 전사와 맞지 않습니다. 다시 찾아 주세요.");
      // The same announcement at the same time is kept once.
      if ([...p.catalog.mentions, ...added].some((m) => m.assetId === assetId && m.startMs === c.startMs && m.title === c.title)) continue;
      added.push(LectureMention.parse({ ...c, quote: segment.text.slice(0, 1000), id: randomUUID(), courseId, assetId, confirmedAt }));
    }
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    p.catalog.mentions.push(...added);
    await this.#save(p);
    return { mentions: added };
  }

  async mentions(courseId: string): Promise<{ mentions: LectureMention[] }> {
    const { p } = await this.#course(courseId);
    return { mentions: p.catalog.mentions.filter((m) => m.courseId === courseId).toSorted((a, b) => b.confirmedAt.localeCompare(a.confirmedAt)) };
  }

  async removeMention(courseId: string, mentionId: string): Promise<Record<string, never>> {
    const { p } = await this.#course(courseId);
    const before = p.catalog.mentions.length;
    p.catalog.mentions = p.catalog.mentions.filter((m) => !(m.id === mentionId && m.courseId === courseId));
    if (p.catalog.mentions.length === before) fail("NOT_FOUND", "항목을 찾지 못했습니다.");
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    await this.#save(p);
    return {};
  }

  #translationFile(p: Partition, transcriptId: string, language: PreferredLanguage): string {
    return join(p.root, "translations", `${Id.parse(transcriptId)}.${language}.json`);
  }

  /** WBS-071: a translation made before, or nothing. */
  async translation(courseId: string, assetId: string, transcriptId: string, language: PreferredLanguage): Promise<{ texts?: string[] }> {
    const { p } = await this.#course(courseId);
    const version = (await this.list(courseId)).transcripts.find((t) => t.id === transcriptId && t.sourceAssetId === assetId);
    if (!version) fail("NOT_FOUND", "전사 판을 찾지 못했습니다.");
    try {
      const texts = z.array(z.string()).parse(JSON.parse(await readFile(this.#translationFile(p, transcriptId, language), "utf8")));
      return texts.length === version.segments.length ? { texts } : {};
    } catch { return {}; }
  }

  /**
   * WBS-071: on request, the version translated sentence by sentence through
   * Claude Code, in batches. A sentence that did not come back keeps its
   * original text (and is counted), so times and order always match. Saved
   * for next time; the transcript itself is unchanged.
   */
  async translate(courseId: string, assetId: string, transcriptId: string, language: PreferredLanguage): Promise<{ texts: string[]; untranslated: number }> {
    const run = this.#o.translate;
    if (!run) fail("NOT_FOUND", "번역을 쓸 수 없습니다.");
    if (this.#claudeRun) fail("RUN_ALREADY_ACTIVE", "Claude Code 요청이 이미 진행 중입니다. 끝난 뒤 다시 시도하세요.");
    const { p } = await this.#course(courseId);
    const version = (await this.list(courseId)).transcripts.find((t) => t.id === transcriptId && t.sourceAssetId === assetId) ?? fail("NOT_FOUND", "전사 판을 찾지 못했습니다.");
    const abort = new AbortController();
    this.#claudeRun = abort;
    this.#claudeLabel = { what: "전사 번역", courseId, title: p.catalog.assets.find((a) => a.id === assetId)?.title ?? "전사", startedAt: new Date().toISOString() };
    try {
      const texts: string[] = [];
      let untranslated = 0;
      for (let at = 0; at < version.segments.length; at += TRANSLATE_BATCH) {
        const batch = version.segments.slice(at, at + TRANSLATE_BATCH).map((s) => s.text);
        const blanks = batch.map((t) => !t.trim());
        const out = batch.some((t) => t.trim()) ? await run({ language, lines: batch, signal: abort.signal }) : [];
        batch.forEach((original, i) => { const t = blanks[i] ? original : out[i]; if (t === undefined) untranslated++; texts.push(t ?? original); });
      }
      if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
      const file = this.#translationFile(p, transcriptId, language);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, JSON.stringify(texts), { mode: 0o600 });
      return { texts, untranslated };
    } finally { this.#claudeRun = undefined; this.#claudeLabel = undefined; }
  }

  /**
   * WBS-073: everything running or waiting on this Mac for the current
   * account, in the order it will run: transcriptions (one at a time, oldest
   * first), video downloads and the Claude Code request.
   */
  async queue(): Promise<IpcResponse<"media.queue">> {
    const p = await this.#activate(), courses = await this.#o.courses();
    const titleOf = (courseId: string) => courses.find((c) => c.id === courseId)?.title;
    const items: IpcResponse<"media.queue">["items"] = [];
    const active = p.queue.jobs().filter((j) => j.status === "running" || j.status === "queued").toSorted((a, b) => (a.status === "running" ? -1 : 0) - (b.status === "running" ? -1 : 0));
    let position = 0;
    for (const job of active) {
      const asset = p.catalog.assets.find((a) => a.id === job.sourceAssetId);
      if (!asset || !courses.some((c) => c.id === asset.courseId && c.accountKey === p.key)) continue;
      const courseTitle = titleOf(asset.courseId);
      items.push({ kind: "transcription", id: job.id, courseId: asset.courseId, ...(courseTitle ? { courseTitle } : {}), title: asset.title, status: job.status === "running" ? "running" : "queued",
        ...(job.status === "running" && job.progress !== undefined ? { progress: job.progress } : {}), ...(job.status === "queued" ? { ahead: position } : {}) });
      position++;
    }
    for (const d of p.catalog.downloads.filter((x) => x.status === "running" || x.status === "queued")) {
      const courseTitle = titleOf(d.courseId);
      items.push({ kind: "download", id: d.id, courseId: d.courseId, ...(courseTitle ? { courseTitle } : {}), title: d.title, status: d.status === "running" ? "running" : "queued",
        ...(d.receivedBytes !== undefined && d.totalBytes ? { progress: Math.min(1, d.receivedBytes / d.totalBytes) } : {}) });
    }
    const claude = this.#claudeLabel;
    if (claude) { const courseTitle = titleOf(claude.courseId); items.push({ kind: "claude", id: claude.startedAt, courseId: claude.courseId, ...(courseTitle ? { courseTitle } : {}), title: `${claude.what} · ${claude.title}`, status: "running" }); }
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    return { transcriptionPaused: p.queue.paused, items };
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
    for (const asset of assets) {
      for (const c of p.catalog.corrections.filter((x) => x.sha256 === asset.sha256)) {
        const t = await this.#correction(p, c.transcriptId);
        if (t) transcripts.push({ ...t, sourceAssetId: asset.id });
      }
    }
    const importedDocs: Record<string, ImportedDocKind[]> = {};
    for (const asset of assets) {
      const record = p.catalog.imports.find((i) => i.sha256 === asset.sha256);
      if (!record) continue;
      if (record.docs.length) importedDocs[asset.id] = record.docs;
      const transcript = await this.#importedTranscript(p, asset.sha256);
      if (!transcript) continue;
      transcripts.push({ ...transcript, sourceAssetId: asset.id });
      // Shown like a finished transcription, so the screen needs no special case.
      jobs.push({ schemaVersion: SCHEMA_VERSION, id: transcript.id, sourceAssetId: asset.id, engine: transcript.engine, parametersHash: transcript.parametersHash, idempotencyKey: asset.sha256, status: "succeeded", attempt: 1, outputTranscriptId: transcript.id, createdAt: transcript.createdAt, updatedAt: transcript.createdAt });
    }
    // WBS-073: why a queued transcription waits — how many run before it, and what is running now (any course).
    const order = p.queue.jobs().filter((j) => j.status === "running" || j.status === "queued").toSorted((a, b) => (a.status === "running" ? -1 : 0) - (b.status === "running" ? -1 : 0));
    const runningJob = order.find((j) => j.status === "running");
    const runningAsset = runningJob ? p.catalog.assets.find((a) => a.id === runningJob.sourceAssetId) : undefined;
    const runningTitle = runningAsset ? `${(await this.#o.courses()).find((c) => c.id === runningAsset.courseId)?.title ?? ""} ${runningAsset.title}`.trim().slice(0, 300) : undefined;
    const waiting: Record<string, { ahead: number; runningTitle?: string; runningProgress?: number }> = {};
    for (const job of jobs.filter((j) => j.status === "queued")) {
      const original = order.findIndex((j) => j.id === job.id);
      if (original < 0) continue;
      waiting[job.id] = { ahead: original, ...(runningTitle && runningJob?.id !== job.id ? { runningTitle } : {}), ...(runningJob?.progress !== undefined ? { runningProgress: runningJob.progress } : {}) };
    }
    return { assets, recordings: this.#o.recordings(courseId), jobs, transcripts, transcriptionPaused: p.queue.paused, importedDocs, waiting, downloads: p.catalog.downloads.filter((d) => d.courseId === courseId), removed: assets.filter((a) => this.#isRemoved(p, a.id)).map((a) => a.id) };
  }

  async asset(courseId: string, assetId: string) {
    const { p } = await this.#course(courseId), asset = p.catalog.assets.find((a) => a.id === assetId && a.courseId === courseId);
    if (!asset) fail("NOT_FOUND", "현재 과목의 원본이 아닙니다.");
    this.#gone(p, asset);
    if (asset.bytes > 256 * 1024 ** 2) fail("MEDIA_UNREADABLE", "큰 원본은 시스템 플레이어로 열기를 사용하세요. 앱 내 재생은 256MB까지 지원합니다.");
    const path = await this.#verify(p, asset), bytes = new Uint8Array(await readFile(path));
    if (bytes.length !== asset.bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) fail("CHECKSUM_MISMATCH", "읽는 동안 원본이 바뀌었습니다.");
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    return { bytes, mediaType: asset.mediaType };
  }

  async retry(courseId: string, jobId: string) {
    const { p } = await this.#course(courseId), listed = await this.list(courseId);
    const previous = listed.jobs.find(j => j.id === jobId);
    const asset = p.catalog.assets.find(a => a.id === previous?.sourceAssetId && a.courseId === courseId);
    if (!asset) fail("NOT_FOUND", "현재 과목의 전사 작업이 아닙니다.");
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    const current = this.#enqueue(p, asset);
    if (current && (current.status === "failed" || current.status === "cancelled")) p.queue.retry(current.id);
    return {};
  }

  /** WBS-101: whether the student (or the automation setting) paused transcription; false before the media list was first opened. */
  transcriptionPaused(): boolean { return this.#partition?.queue.paused ?? false; }

  async pauseTranscription() {
    const p = await this.#activate();
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    await p.queue.pause();
    return { paused: p.queue.paused };
  }

  async resumeTranscription() {
    const p = await this.#activate();
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    p.queue.resume();
    return { paused: p.queue.paused };
  }

  /** Stops one job of this course; queued or running, it ends as cancelled and keeps its original. */
  async cancelTranscription(courseId: string, jobId: string) {
    const { p } = await this.#course(courseId), listed = await this.list(courseId);
    if (!listed.jobs.some((j) => j.id === jobId)) fail("NOT_FOUND", "현재 과목의 전사 작업이 아닙니다.");
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    await p.queue.cancel(jobId);
    return {};
  }

  async retryUnavailable(): Promise<void> {
    const p = await this.#activate(), courses = await this.#o.courses();
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    for (const asset of p.catalog.assets) {
      if (!courses.some(c => c.id === asset.courseId && c.accountKey === p.key)) continue;
      const current = this.#enqueue(p, asset);
      if (current?.status === "failed" && current.errorCode === "ENGINE_UNAVAILABLE") p.queue.retry(current.id);
    }
  }

  async open(courseId: string, assetId: string) {
    const { p } = await this.#course(courseId), asset = p.catalog.assets.find((a) => a.id === assetId && a.courseId === courseId);
    if (!asset) fail("NOT_FOUND", "현재 과목의 원본이 아닙니다.");
    this.#gone(p, asset);
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
    // A video whose original was deleted to free space (WBS-087) can be downloaded again.
    const existing = p.catalog.downloads.find((d) => d.courseId === courseId && d.sourceId === sourceId && ["queued", "running", "succeeded"].includes(d.status) && !(d.status === "succeeded" && d.assetId && this.#isRemoved(p, d.assetId)));
    if (existing) return { downloadId: existing.id };
    p.catalog.downloads.push(item); await this.#save(p);
    const abort = new AbortController();
    const done = Promise.resolve().then(async () => {
      try {
        item.status = "running"; await this.#save(p);
        if (this.#closing || p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정 변경 또는 앱 종료로 중단했습니다.");
        const asset = await downloadVideo({ root: p.root, courseId, resourceId: item.resourceId, sourceId, title, ...this.#o.video(course, sourceId), signal: abort.signal, onProgress: (received, total) => { item.receivedBytes = received; if (total !== undefined) item.totalBytes = total; } });
        if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다. 새 계정으로 전달하지 않았습니다.");
        p.catalog.assets.push(asset); item.assetId = asset.id; item.status = "succeeded";
        // Persist before enqueue; restart reconciles a missing job.
        await this.#save(p); this.#enqueue(p, asset);
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
  async stop() {
    this.#closing = true;
    this.#claudeRun?.abort();
    await this.#activation.catch(() => {});
    for (const d of this.#downloads.values()) d.abort.abort();
    await Promise.allSettled([...this.#downloads.values()].map((d) => d.done));
    await this.#partition?.queue.stop();
  }
}
