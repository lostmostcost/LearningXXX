import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { AccountKey, AppError, Id, ImportedDocKind, LectureMention, MANUAL_ENGINE, MediaAsset, Recording, SCHEMA_VERSION, Sha256, Transcript } from "@learningxxx/contracts";
import type { MentionCandidate } from "@learningxxx/contracts";
import type { Course, TranscriptionJob } from "@learningxxx/contracts";
import { downloadVideo } from "@learningxxx/collector";
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
const Catalog = z.object({ assets: z.array(MediaAsset), downloads: z.array(Download), imports: z.array(Imported).default([]), corrections: z.array(Correction).default([]), mentions: z.array(LectureMention).default([]) });
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
  openOriginal: (path: string) => Promise<void>;
  video: (course: Course, contentId: string) => Pick<VideoDownloadInput, "fetch" | "resolveSource" | "allowedOrigins">;
}
function fail(code: "NOT_FOUND" | "SCOPE_VIOLATION" | "CHECKSUM_MISMATCH" | "AUTH_REQUIRED" | "MEDIA_UNREADABLE" | "INVALID_REQUEST" | "RUN_ALREADY_ACTIVE", message: string): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable: false }) });
}

/** Durable account-scoped originals → automatic local transcription. No summary. */
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
    const pattern = recording ? /^media\/originals\/[a-f0-9]{64}\.(wav|m4a|opus)$/ : /^video-originals\/[a-f0-9]{2}\/[a-f0-9]{64}\.mp4$/;
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
    return p.queue.enqueue(asset);
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
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("CHECKSUM_MISMATCH", "미디어 목록을 읽지 못했습니다. 기존 파일을 보존했습니다."); catalog = { assets: [], downloads: [], imports: [], corrections: [], mentions: [] }; }
      const p = { key, root, catalog, writes: Promise.resolve() } as Partition;
      const engine: Engine = { info: this.#o.engine.info, parameters: this.#o.engine.parameters, transcribe: async (input) => {
        const asset = p.catalog.assets.find((a) => this.#path(p, a) === input.audioPath);
        if (!asset) throw new EngineError("NOT_FOUND", "원본 정보를 찾지 못했습니다.", false);
        try { await this.#verify(p, asset); } catch { throw new EngineError("CHECKSUM_MISMATCH", "원본 무결성을 확인하지 못했습니다.", false); }
        input.signal.throwIfAborted();
        return this.#o.engine.transcribe(input);
      } };
      // A short lease: after a crash the interrupted job runs again within about a minute.
      p.queue = new TranscriptionQueue({ root: join(root, "transcription"), engine, pathOf: (a) => this.#path(p, a), leaseMs: 60_000, ...(this.#o.contextFor ? { contextFor: this.#o.contextFor } : {}) });
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
  async saveCorrection(courseId: string, assetId: string, basedOnTranscriptId: string, texts: string[]): Promise<{ transcriptId: string }> {
    const { p } = await this.#course(courseId);
    const asset = p.catalog.assets.find((a) => a.id === assetId && a.courseId === courseId) ?? fail("NOT_FOUND", "현재 과목의 원본이 아닙니다.");
    const base = (await this.list(courseId)).transcripts.find((t) => t.id === basedOnTranscriptId && t.sourceAssetId === assetId) ?? fail("NOT_FOUND", "고칠 전사 판을 찾지 못했습니다.");
    if (texts.length !== base.segments.length) fail("INVALID_REQUEST", "전사 문장 수가 바뀌었습니다. 다시 열어 고쳐 주세요.");
    const transcript = Transcript.parse({
      schemaVersion: SCHEMA_VERSION, id: randomUUID(), sourceAssetId: assetId, kind: "corrected",
      engine: { name: MANUAL_ENGINE, version: "user" }, parametersHash: createHash("sha256").update(MANUAL_ENGINE).digest("hex"),
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

  /** One Claude Code request (readable note or announcement search) at a time. */
  #claudeRun: AbortController | undefined;
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
    } finally { this.#claudeRun = undefined; }
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
    try {
      const candidates = await this.#o.mentions({ title: asset.title, text, transcript: version, signal: abort.signal });
      if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
      return { candidates };
    } finally { this.#claudeRun = undefined; }
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
    return { assets, recordings: this.#o.recordings(courseId), jobs, transcripts, transcriptionPaused: p.queue.paused, importedDocs, downloads: p.catalog.downloads.filter((d) => d.courseId === courseId) };
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
    const previous = listed.jobs.find(j => j.id === jobId);
    const asset = p.catalog.assets.find(a => a.id === previous?.sourceAssetId && a.courseId === courseId);
    if (!asset) fail("NOT_FOUND", "현재 과목의 전사 작업이 아닙니다.");
    if (p.key !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
    const current = this.#enqueue(p, asset);
    if (current && (current.status === "failed" || current.status === "cancelled")) p.queue.retry(current.id);
    return {};
  }

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
