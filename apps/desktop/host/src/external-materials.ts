import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import { AccountKey, AppError, Asset, CollectionManifest, Id, Resource, type IpcRequest, type IpcResponse } from "@learningxxx/contracts";
import type { AssetStore } from "@learningxxx/collector";

/**
 * WBS-088: the student's own files (handouts from elsewhere, papers, a
 * classmate's slides) added to a course week or to "기타 자료". Each file is
 * copied into the app's library store — the original is only read — and is
 * listed with the collected material as "직접 추가한 자료", so the viewer,
 * the course chat and the course summary use it like LMS material. Nothing
 * is sent to the LMS; a collection never removes these.
 */

export const MAX_FILE_BYTES = 300 * 1024 ** 2;
/** Common study files; the viewer opens PDFs, the others open in their own app and the chat can read text. */
export const EXTERNAL_TYPES: Record<string, string> = {
  pdf: "application/pdf", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  hwp: "application/x-hwp", hwpx: "application/hwp+zip", txt: "text/plain", md: "text/markdown", csv: "text/csv",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", zip: "application/zip",
};

function fail(code: "NOT_FOUND" | "INVALID_REQUEST" | "RUN_ALREADY_ACTIVE" | "AUTH_REQUIRED" | "SCOPE_VIOLATION" | "MEDIA_UNREADABLE", message: string): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable: false }) });
}

const Entry = z.object({
  resourceId: Id, assetId: Id, weekId: Id.optional(), title: z.string().min(1).max(300), originalName: z.string().min(1).max(300),
  mediaType: z.string(), bytes: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/), storageKey: z.string().min(1), addedAt: z.string(),
});
type Entry = z.infer<typeof Entry>;
const Index = z.object({ items: z.array(Entry) });

interface Chosen { path: string; name: string; bytes: number; ext: string }

export interface ExternalMaterialsOptions {
  root: string;
  accountKey: () => string | undefined;
  store: AssetStore;
  /** The collected manifest, to check weeks. */
  collected: (courseId: string) => Promise<CollectionManifest | undefined>;
  chooseFiles: () => Promise<string[] | undefined>;
  newId?: () => string;
  now?: () => Date;
}

export class ExternalMaterials {
  readonly #o: ExternalMaterialsOptions;
  #plan: { id: string; files: Map<string, Chosen> } | undefined;
  #busy = false;
  #writes: Promise<unknown> = Promise.resolve();
  constructor(options: ExternalMaterialsOptions) { this.#o = options; }

  #id(): string { return (this.#o.newId ?? randomUUID)(); }
  #file(courseId: string): { key: string; file: string } {
    const key = this.#o.accountKey();
    if (!key) fail("AUTH_REQUIRED", "학교 자료를 먼저 수집해 계정을 확인하세요.");
    return { key, file: join(this.#o.root, AccountKey.parse(key), `${Id.parse(courseId)}.json`) };
  }
  async #read(file: string): Promise<Entry[]> {
    try { return Index.parse(JSON.parse(await readFile(file, "utf8"))).items; } catch { return []; }
  }
  #update(courseId: string, change: (items: Entry[]) => Promise<Entry[]> | Entry[]): Promise<Entry[]> {
    const work = this.#writes.catch(() => undefined).then(async () => {
      const { key, file } = this.#file(courseId);
      const next = await change(await this.#read(file));
      if (this.#o.accountKey() !== key) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다. 저장하지 않았습니다.");
      await mkdir(join(file, ".."), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ items: next }), { mode: 0o600 });
      await rename(temp, file);
      return next;
    });
    this.#writes = work;
    return work;
  }
  async #checkWeek(courseId: string, weekId: string | undefined): Promise<void> {
    if (weekId !== undefined && !(await this.#o.collected(courseId))?.weeks.some((w) => w.id === weekId)) fail("INVALID_REQUEST", "이 과목에 없는 주차입니다.");
  }

  /** The file picker: what can be added, and why not for the rest. */
  async choose(): Promise<IpcResponse<"materials.choose">> {
    if (this.#busy) fail("RUN_ALREADY_ACTIVE", "자료를 추가하는 중입니다.");
    const picked = await this.#o.chooseFiles();
    if (!picked?.length) return { files: [] };
    const files = new Map<string, Chosen>();
    const out: IpcResponse<"materials.choose">["files"] = [];
    for (const path of picked.slice(0, 50)) {
      const id = this.#id(), name = basename(path).slice(0, 300), ext = extname(path).slice(1).toLowerCase();
      const stat = await lstat(path).catch(() => undefined);
      const problem = !stat?.isFile() ? "일반 파일이 아닙니다" : !(ext in EXTERNAL_TYPES) ? "지원하지 않는 형식입니다(PDF·문서·표·한글·이미지 등)" : stat.size === 0 ? "빈 파일입니다" : stat.size > MAX_FILE_BYTES ? "300MB보다 큰 파일입니다" : undefined;
      out.push({ id, name, bytes: stat?.size ?? 0, ...(problem ? { problem } : {}) });
      if (!problem && stat) files.set(id, { path: await realpath(path), name, bytes: stat.size, ext });
    }
    this.#plan = { id: this.#id(), files };
    return { planId: this.#plan.id, files: out };
  }

  /** Copies the chosen files into the course; each fails on its own. */
  async add({ planId, courseId, files }: IpcRequest<"materials.add">): Promise<IpcResponse<"materials.add">> {
    const plan = this.#plan;
    if (!plan || plan.id !== planId) fail("NOT_FOUND", "파일을 다시 골라 주세요.");
    if (this.#busy) fail("RUN_ALREADY_ACTIVE", "자료를 추가하는 중입니다.");
    this.#busy = true;
    const added: Entry[] = [], failed: { id: string; message: string }[] = [];
    try {
      for (const choice of files) {
        try {
          await this.#checkWeek(courseId, choice.weekId);
          const file = plan.files.get(choice.id) ?? fail("INVALID_REQUEST", "목록에 없는 파일입니다.");
          const stat = await lstat(file.path);
          if (!stat.isFile() || stat.size !== file.bytes) fail("MEDIA_UNREADABLE", "고른 뒤 파일이 바뀌었습니다. 다시 골라 주세요.");
          const stored = await this.#o.store.put(Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>, { expectedBytes: file.bytes, extension: file.ext });
          added.push({ resourceId: this.#id(), assetId: this.#id(), ...(choice.weekId ? { weekId: choice.weekId } : {}), title: choice.title.trim() || file.name, originalName: file.name, mediaType: EXTERNAL_TYPES[file.ext]!, bytes: stored.bytes, sha256: stored.sha256, storageKey: stored.storageKey, addedAt: (this.#o.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z") });
          plan.files.delete(choice.id);
        } catch (error) {
          failed.push({ id: choice.id, message: (error as { appError?: { message: string } }).appError?.message ?? "읽거나 저장하지 못했습니다. 원래 파일은 그대로입니다." });
        }
      }
      if (added.length) await this.#update(courseId, (items) => [...items, ...added]);
      return { added: added.length, failed };
    } finally { this.#busy = false; }
  }

  /** Moves to another week (or 기타 자료), renames, or takes the file off the course (the app's copy only). */
  async change({ courseId, resourceId, ...change }: IpcRequest<"materials.change">): Promise<IpcResponse<"materials.change">> {
    if ("weekId" in change) await this.#checkWeek(courseId, change.weekId ?? undefined);
    await this.#update(courseId, (items) => {
      const i = items.findIndex((x) => x.resourceId === resourceId);
      if (i < 0) fail("NOT_FOUND", "직접 추가한 자료를 찾을 수 없습니다.");
      if (change.remove) return items.filter((_, n) => n !== i);
      const { weekId: _old, ...rest } = items[i]!;
      const weekId = "weekId" in change ? change.weekId ?? undefined : items[i]!.weekId;
      items[i] = { ...rest, ...(weekId ? { weekId } : {}), ...(change.title?.trim() ? { title: change.title.trim().slice(0, 300) } : {}) };
      return items;
    });
    return {};
  }

  /**
   * The collected manifest with the student's files added as manual file
   * resources (week kept only when it still exists, else 기타 자료).
   */
  async merge(manifest: CollectionManifest): Promise<CollectionManifest> {
    let items: Entry[];
    try { items = await this.#read(this.#file(manifest.course.id).file); } catch { return manifest; }
    if (!items.length) return manifest;
    const weeks = new Set(manifest.weeks.map((w) => w.id));
    const extra = items.map((e) => ({
      resource: Resource.parse({ id: e.resourceId, courseId: manifest.course.id, ...(e.weekId && weeks.has(e.weekId) ? { weekId: e.weekId } : {}), kind: "file", source: "manual", sourceId: `manual:${e.resourceId}`, title: e.title, revision: 1, updatedAt: e.addedAt }),
      assets: [Asset.parse({ id: e.assetId, resourceId: e.resourceId, mediaType: e.mediaType, bytes: e.bytes, sha256: e.sha256, storageKey: e.storageKey, originalName: e.originalName })],
    }));
    const merged = CollectionManifest.safeParse({ ...manifest, items: [...manifest.items, ...extra] });
    return merged.success ? merged.data : manifest;
  }
}
