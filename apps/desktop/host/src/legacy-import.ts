import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { AppError, IMPORTED_ENGINE, ImportItem, LectureSourceId, SCHEMA_VERSION, Transcript } from "@learningxxx/contracts";
import type { Course, ImportedDocKind, IpcResponse, MediaAsset, Recording, Week } from "@learningxxx/contracts";
import type { RecordingService } from "./recording-service.ts";

/**
 * WBS-066: brings recordings and lecture audio the user already made (with
 * their transcripts and notes) from their own semester folder into the app.
 *
 * Layout: <학기>/<과목 분반>/<NN주차>/{녹음|강의영상}/<이름>.opus with
 * <이름>.transcript.json/.srt/.transcript.md/.readable.md/.corrections.md/.live.md.
 * Only those files are read; nothing else in the folder (scripts, settings,
 * other folders) is opened. The user's files are never changed.
 */

const KINDS = { 녹음: "recording", 강의영상: "lecture" } as const;
const DOCS: Record<string, ImportedDocKind> = { ".readable.md": "readable", ".corrections.md": "corrections", ".transcript.md": "transcript_md", ".live.md": "live", ".srt": "srt" };
const MAX_AUDIO = 1024 ** 3;
const MAX_TEXT = 30 * 1024 ** 2;

function fail(code: "NOT_FOUND" | "INVALID_REQUEST" | "RUN_ALREADY_ACTIVE" | "SCOPE_VIOLATION", message: string): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable: false }) });
}

/** "03주차" → 3; a week in the app is the collected week whose label carries the same number. */
const folderWeek = (name: string) => { const m = /^(\d{1,2})주차$/.exec(name); return m ? Number(m[1]) : undefined; };
const labelWeek = (label: string) => { const m = /(\d{1,2})\s*주차/.exec(label); return m ? Number(m[1]) : undefined; };

/** What a transcript.json says about itself; anything unexpected is simply left out. */
interface Meta {
  courseId?: string;
  started?: string;
  seconds?: number;
  contentId?: string;
  videoTitle?: string;
}

function metaOf(raw: unknown): Meta {
  const d = (raw ?? {}) as Record<string, unknown>;
  const context = (d.context ?? {}) as Record<string, unknown>;
  const course = (context.course ?? {}) as Record<string, unknown>;
  const video = (context.video ?? {}) as Record<string, unknown>;
  const meta: Meta = {};
  if (typeof course.course_id === "string" && /^\d{1,20}$/.test(course.course_id)) meta.courseId = course.course_id;
  if (typeof context.started === "string" && !Number.isNaN(Date.parse(context.started))) meta.started = context.started;
  const seconds = typeof d.recorded_seconds === "number" ? d.recorded_seconds : typeof video.duration === "number" ? video.duration : undefined;
  if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) meta.seconds = seconds;
  if (LectureSourceId.safeParse(video.content_id).success) meta.contentId = String(video.content_id);
  if (typeof video.title === "string" && video.title.trim()) meta.videoTitle = video.title.trim().slice(0, 200);
  return meta;
}

/** The engine output in the file, as the app's own transcript version. */
export function toTranscript(raw: unknown, transcriptId: string, sourceAssetId: string, createdAt: string): Transcript | undefined {
  const d = (raw ?? {}) as Record<string, unknown>;
  if (!Array.isArray(d.segments)) return undefined;
  const segments = d.segments.flatMap((s) => {
    const seg = s as Record<string, unknown>;
    if (typeof seg.start !== "number" || typeof seg.end !== "number" || typeof seg.text !== "string") return [];
    const startMs = Math.max(0, Math.round(seg.start * 1000));
    return [{ startMs, endMs: Math.max(startMs, Math.round(seg.end * 1000)), text: seg.text.trim() }];
  }).toSorted((a, b) => a.startMs - b.startMs);
  if (!segments.length) return undefined;
  const language = typeof d.language === "string" && d.language.length >= 2 && d.language.length <= 16 ? d.language : "ko";
  const model = typeof d.model === "string" && d.model.trim() ? d.model.trim().slice(0, 200) : "unknown";
  const parsed = Transcript.safeParse({
    schemaVersion: SCHEMA_VERSION, id: transcriptId, sourceAssetId, kind: "engine",
    engine: { name: IMPORTED_ENGINE, version: model }, parametersHash: createHash("sha256").update(`${IMPORTED_ENGINE}\n${model}`).digest("hex"),
    language, createdAt, segments,
  });
  return parsed.success ? parsed.data : undefined;
}

/** "20260907_0900_1주차" → 2026-09-07 09:00 Seoul as UTC. */
function stemTime(stem: string): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/.exec(stem);
  if (!m) return undefined;
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]! - 9, +m[5]!);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

const utc = (iso: string) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");

interface Found {
  item: ImportItem;
  audio: string;
  json?: string;
  docs: { kind: ImportedDocKind; path: string }[];
  startedAt: string;
  seconds?: number;
}

export interface ImporterOptions {
  /** Opens the folder picker; undefined when the user cancels. */
  chooseFolder: () => Promise<string | undefined>;
  courses: () => Promise<Course[]>;
  weeks: (courseId: string) => Promise<Week[]>;
  recordings: (courseId: string) => Recording[];
  /** Keeps the transcript/notes, then stores the original, then hands it on (see MediaService.adoptImport). */
  store: (input: { found: Omit<Found, "item"> & { item: ImportItem & { courseId: string } }; bytes: Uint8Array; sha256: string; transcriptJson?: unknown; docs: { kind: ImportedDocKind; text: string }[] }) => Promise<void>;
}

export class LegacyImporter {
  readonly #o: ImporterOptions;
  #plan: { id: string; root: string; found: Map<string, Found> } | undefined;
  #status = { running: false, done: 0, total: 0 };

  constructor(options: ImporterOptions) { this.#o = options; }

  status(): IpcResponse<"media.importStatus"> { return { ...this.#status }; }

  async scan(): Promise<IpcResponse<"media.importScan">> {
    if (this.#status.running) fail("RUN_ALREADY_ACTIVE", "가져오는 중입니다. 끝난 뒤 다시 고르세요.");
    const chosen = await this.#o.chooseFolder();
    if (!chosen) return { items: [] };
    const root = await realpath(chosen);
    const courses = await this.#o.courses();
    const found = new Map<string, Found>();
    for (const courseDir of await dirs(root)) {
      for (const weekDir of await dirs(join(root, courseDir))) {
        const weekNo = folderWeek(weekDir);
        if (weekNo === undefined) continue;
        for (const [kindDir, kind] of Object.entries(KINDS)) {
          const dir = join(root, courseDir, weekDir, kindDir);
          const files = await regularFiles(dir);
          for (const audio of files.filter((f) => f.toLowerCase().endsWith(".opus"))) {
            const stem = audio.slice(0, -".opus".length);
            const json = files.includes(`${stem}.transcript.json`) ? join(dir, `${stem}.transcript.json`) : undefined;
            const meta = json ? metaOf(await readJson(json)) : {};
            const course = courses.find((c) => meta.courseId !== undefined && c.sourceCourseId === meta.courseId) ?? courses.find((c) => c.title === courseDir);
            const week = course ? (await this.#o.weeks(course.id)).find((w) => labelWeek(w.label) === weekNo) : undefined;
            const path = [courseDir, weekDir, kindDir, stem].join("/").slice(0, 400);
            const id = createHash("sha256").update(path).digest("hex").slice(0, 32);
            const docs = Object.entries(DOCS).flatMap(([suffix, docKind]) => (files.includes(`${stem}${suffix}`) ? [{ kind: docKind, path: join(dir, `${stem}${suffix}`) }] : []));
            const imported = course ? this.#o.recordings(course.id).some((r) => r.importedFrom === path) : false;
            const title = (kind === "lecture" ? meta.videoTitle ?? stem : stemTime(stem) ? `${stem.slice(0, 4)}-${stem.slice(4, 6)}-${stem.slice(6, 8)} ${stem.slice(9, 11)}:${stem.slice(11, 13)} 녹음` : stem).slice(0, 200) || "가져온 녹음";
            const bytes = (await lstat(join(dir, audio))).size;
            const item = ImportItem.parse({
              id, path, kind, title, bytes, hasTranscript: json !== undefined, docs: docs.map((d) => d.kind),
              status: !course ? "no_course" : imported ? "imported" : "new",
              ...(course ? { courseId: course.id, courseTitle: course.title.slice(0, 200) } : {}),
              ...(week ? { weekId: week.id, weekLabel: week.label } : {}),
              ...(kind === "lecture" && week && meta.contentId ? { lectureSourceId: meta.contentId } : {}),
            });
            found.set(id, {
              item, audio: join(dir, audio), docs, startedAt: utc(meta.started ?? stemTime(stem) ?? new Date().toISOString()),
              ...(json ? { json } : {}), ...(meta.seconds ? { seconds: meta.seconds } : {}),
            });
          }
        }
      }
    }
    this.#plan = { id: randomUUID(), root, found };
    const items = [...found.values()].map((f) => f.item).toSorted((a, b) => a.path.localeCompare(b.path, "ko"));
    return { planId: this.#plan.id, folder: basename(root).slice(0, 200), items };
  }

  async run({ planId, itemIds }: { planId: string; itemIds: string[] }): Promise<IpcResponse<"media.importRun">> {
    const plan = this.#plan;
    if (!plan || plan.id !== planId) fail("NOT_FOUND", "폴더를 다시 골라 주세요.");
    if (this.#status.running) fail("RUN_ALREADY_ACTIVE", "이미 가져오는 중입니다.");
    const chosen = [...new Set(itemIds)].map((id) => plan.found.get(id) ?? fail("INVALID_REQUEST", "목록에 없는 항목입니다."));
    this.#status = { running: true, done: 0, total: chosen.length };
    let imported = 0, skipped = 0;
    const failed: { itemId: string; message: string }[] = [];
    try {
      for (const found of chosen) {
        try {
          const { item } = found;
          if (item.status !== "new" || !item.courseId || this.#o.recordings(item.courseId).some((r) => r.importedFrom === item.path)) { skipped++; continue; }
          await inside(plan.root, found.audio);
          const audio = await readSmall(found.audio, MAX_AUDIO);
          const transcriptJson = found.json ? await readJson(found.json, plan.root) : undefined;
          const docs: { kind: ImportedDocKind; text: string }[] = [];
          for (const doc of found.docs) docs.push({ kind: doc.kind, text: (await readSmall(doc.path, MAX_TEXT, plan.root)).toString("utf8") });
          await this.#o.store({ found: { ...found, item: { ...item, courseId: item.courseId } }, bytes: audio, sha256: createHash("sha256").update(audio).digest("hex"), ...(transcriptJson !== undefined ? { transcriptJson } : {}), docs });
          imported++;
        } catch (error) {
          const appError = (error as { appError?: { message: string } }).appError;
          failed.push({ itemId: found.item.id, message: appError?.message ?? "읽거나 저장하지 못했습니다. 원래 파일은 그대로입니다." });
        } finally { this.#status.done++; }
      }
    } finally { this.#status = { ...this.#status, running: false }; }
    return { imported, skipped, failed };
  }
}

async function dirs(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_")).map((e) => e.name);
}

/** Regular files only (no links), by name. */
async function regularFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => e.name);
}

/** The file must still be a regular file inside the chosen folder (not swapped for a link). */
async function inside(root: string, path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile()) fail("SCOPE_VIOLATION", "일반 파일이 아니라 가져오지 않았습니다.");
  const rel = relative(root, await realpath(path));
  if (rel.startsWith("..") || rel.startsWith(sep)) fail("SCOPE_VIOLATION", "고른 폴더 밖의 파일이라 가져오지 않았습니다.");
}

async function readSmall(path: string, max: number, root?: string): Promise<Buffer> {
  if (root) await inside(root, path);
  const stat = await lstat(path);
  if (stat.size > max) fail("INVALID_REQUEST", "파일이 너무 커서 가져오지 않았습니다.");
  return readFile(path);
}

async function readJson(path: string, root?: string): Promise<unknown> {
  try { return JSON.parse((await readSmall(path, MAX_TEXT, root)).toString("utf8")); } catch { return undefined; }
}

/** The import steps in a crash-safe order: transcript and notes first, then the original, then transcription bookkeeping. */
export function importStore(deps: {
  adoptImport: (courseId: string, input: { sha256: string; transcript?: Transcript; model?: string; docs: { kind: ImportedDocKind; text: string }[] }) => Promise<void>;
  importOriginal: (input: Parameters<RecordingService["importOriginal"]>[0]) => { asset: MediaAsset };
  register: (asset: MediaAsset) => Promise<unknown>;
  now?: () => Date;
  newId?: () => string;
}): ImporterOptions["store"] {
  const newId = deps.newId ?? randomUUID;
  return async ({ found, bytes, sha256, transcriptJson, docs }) => {
    const { item } = found;
    const assetId = newId(), recordingId = newId();
    const createdAt = utc((deps.now?.() ?? new Date()).toISOString());
    const transcript = transcriptJson !== undefined ? toTranscript(transcriptJson, newId(), assetId, createdAt) : undefined;
    await deps.adoptImport(item.courseId, { sha256, ...(transcript ? { transcript, model: transcript.engine.version } : {}), docs });
    const lastMs = transcript?.segments.at(-1)?.endMs;
    const { asset } = deps.importOriginal({
      courseId: item.courseId, weekId: item.weekId, lectureSourceId: item.lectureSourceId, title: item.title, startedAt: found.startedAt,
      durationMs: found.seconds !== undefined ? found.seconds * 1000 : lastMs ?? 1, importedFrom: item.path, bytes, mediaType: "audio/ogg", ext: "opus", recordingId, assetId,
    });
    await deps.register(asset);
  };
}
