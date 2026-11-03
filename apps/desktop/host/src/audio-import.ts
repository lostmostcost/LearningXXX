import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, extname } from "node:path";
import { promisify } from "node:util";
import { AppError, AUDIO_IMPORT_TYPES } from "@learningxxx/contracts";
import type { AudioImportType, IpcRequest, IpcResponse, MediaAsset } from "@learningxxx/contracts";

/**
 * WBS-077: recordings a student made elsewhere (phone voice memo, another
 * recorder app) imported as files. Any common audio format macOS can decode
 * is accepted; each file is copied as a finished recording and transcribed
 * like one made in the app. The user's files are only read.
 */

/** Largest file accepted; a three-hour lecture as WAV is well below this. */
export const MAX_AUDIO_BYTES = 2 * 1024 ** 3;

function fail(code: "NOT_FOUND" | "INVALID_REQUEST" | "RUN_ALREADY_ACTIVE" | "SCOPE_VIOLATION" | "MEDIA_UNREADABLE", message: string): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable: false }) });
}

/** Seconds from `afinfo` ("estimated duration: 3601.2 sec"); undefined when macOS cannot read the file. */
export async function probeDuration(path: string): Promise<number | undefined> {
  try {
    const { stdout } = await promisify(execFile)("/usr/bin/afinfo", [path], { timeout: 30_000, maxBuffer: 1024 ** 2 });
    const m = /estimated duration:\s*([\d.]+)\s*sec/i.exec(stdout);
    const seconds = m ? Number(m[1]) : NaN;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch { return undefined; }
}

/** A date written in the file name (voice memos often have one): "20260907 0900", "2026-09-07_09-00", "2026.09.07". */
export function dateInName(name: string): string | undefined {
  const m = /(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[ _T-]?(\d{2})[:.\-h]?(\d{2}))?/.exec(name);
  if (!m) return undefined;
  const [y, mo, d, h = "12", mi = "00"] = m.slice(1).map((x) => x ?? undefined) as string[];
  const t = Date.UTC(+y!, +mo! - 1, +d!, +h - 9, +mi); // the student's local (Seoul) time
  const date = new Date(t);
  return Number.isNaN(t) || +mo! < 1 || +mo! > 12 || +d! < 1 || +d! > 31 || +h > 23 || +mi > 59 || date.getUTCFullYear() !== +y! ? undefined : date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

interface Chosen { path: string; name: string; bytes: number; type: AudioImportType; durationMs?: number; startedAt: string }

export interface AudioImporterOptions {
  /** The file picker; undefined or [] when the user cancels. */
  chooseFiles: () => Promise<string[] | undefined>;
  probe?: (path: string) => Promise<number | undefined>;
  /** Copies one file as a finished recording and hands it to transcription. */
  store: (input: { courseId: string; weekId?: string | undefined; lectureSourceId?: string | undefined; title: string; startedAt: string; durationMs: number; importedFrom: string; bytes: Uint8Array; type: AudioImportType }) => Promise<MediaAsset>;
  newId?: () => string;
}

export class AudioImporter {
  readonly #o: AudioImporterOptions;
  #plan: { id: string; files: Map<string, Chosen> } | undefined;
  #status = { running: false, done: 0, total: 0 };

  constructor(options: AudioImporterOptions) { this.#o = options; }

  status(): { running: boolean; done: number; total: number } { return { ...this.#status }; }

  async choose(): Promise<IpcResponse<"media.chooseAudio">> {
    if (this.#status.running) fail("RUN_ALREADY_ACTIVE", "가져오는 중입니다. 끝난 뒤 다시 고르세요.");
    const picked = await this.#o.chooseFiles();
    if (!picked?.length) return { files: [] };
    const files = new Map<string, Chosen>();
    const out: IpcResponse<"media.chooseAudio">["files"] = [];
    for (const path of picked.slice(0, 200)) {
      const id = (this.#o.newId ?? randomUUID)();
      const name = basename(path).slice(0, 200);
      const ext = extname(path).slice(1).toLowerCase();
      const type = (AUDIO_IMPORT_TYPES as readonly string[]).includes(ext) ? (ext as AudioImportType) : undefined;
      const stat = await lstat(path).catch(() => undefined);
      const problem = !stat?.isFile() ? "일반 파일이 아닙니다" : !type ? "지원하지 않는 형식입니다(mp3·m4a·wav·aac·flac·ogg·opus 등)" : stat.size === 0 ? "빈 파일입니다" : stat.size > MAX_AUDIO_BYTES ? "2GB보다 큰 파일입니다" : undefined;
      const seconds = problem ? undefined : await (this.#o.probe ?? probeDuration)(path);
      const reason = problem ?? (seconds === undefined ? "이 Mac에서 읽을 수 없는 오디오입니다" : undefined);
      const startedAt = dateInName(name) ?? (stat ? stat.mtime.toISOString().replace(/\.\d{3}Z$/, "Z") : new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
      out.push({ id, name, bytes: stat?.size ?? 0, startedAt, ...(seconds ? { durationMs: Math.round(seconds * 1000) } : {}), ...(reason ? { problem: reason } : {}) });
      if (!reason && type && stat) files.set(id, { path: await realpath(path), name, bytes: stat.size, type, durationMs: Math.round(seconds! * 1000), startedAt });
    }
    this.#plan = { id: (this.#o.newId ?? randomUUID)(), files };
    return { planId: this.#plan.id, files: out };
  }

  async run({ planId, courseId, files }: IpcRequest<"media.importAudio">): Promise<IpcResponse<"media.importAudio">> {
    const plan = this.#plan;
    if (!plan || plan.id !== planId) fail("NOT_FOUND", "파일을 다시 골라 주세요.");
    if (this.#status.running) fail("RUN_ALREADY_ACTIVE", "이미 가져오는 중입니다.");
    this.#status = { running: true, done: 0, total: files.length };
    let imported = 0;
    const failed: { id: string; message: string }[] = [];
    try {
      for (const choice of files) {
        try {
          const file = plan.files.get(choice.id) ?? fail("INVALID_REQUEST", "목록에 없는 파일입니다.");
          // The file must still be the one the user chose: a regular file of the same size.
          const stat = await lstat(file.path);
          if (!stat.isFile() || stat.size !== file.bytes) fail("MEDIA_UNREADABLE", "고른 뒤 파일이 바뀌었습니다. 다시 골라 주세요.");
          const bytes = new Uint8Array(await readFile(file.path));
          await this.#o.store({ courseId, weekId: choice.weekId, lectureSourceId: choice.lectureSourceId, title: choice.title, startedAt: file.startedAt, durationMs: file.durationMs ?? 1, importedFrom: `${file.name} · ${file.bytes}`, bytes, type: file.type });
          imported++;
          plan.files.delete(choice.id);
        } catch (error) {
          failed.push({ id: choice.id, message: (error as { appError?: { message: string } }).appError?.message ?? "읽거나 저장하지 못했습니다. 원래 파일은 그대로입니다." });
        } finally { this.#status.done++; }
      }
    } finally { this.#status = { ...this.#status, running: false }; }
    return { imported, failed };
  }
}
