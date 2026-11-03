import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppError, SyncRun } from "@learningxxx/contracts";
import type { CollectionManifest, Course, ErrorCode, IpcRequest, IpcResponse } from "@learningxxx/contracts";
import {
  CollectionError,
  collectCourse,
  createDirectoryStore,
  readCurrentManifest,
  readSyncStatus,
  recoverInterruptedRuns,
} from "@learningxxx/collector";
import { materialLayout, syncMaterials, type MaterialEntry } from "./course-materials.ts";
import { pdfPageTexts } from "./pdf-text.ts";
import type { AssetStore, CanvasClient, CollectCourseInput, CollectCourseResult, LearningXClient } from "@learningxxx/collector";

/** The course from WBS-003: 2026-2 논리회로 (Canvas 95899). Used when the enrolled courses cannot be listed. */
export const DEFAULT_SOURCE_COURSES: readonly string[] = ["95899"];

export interface LibraryServiceOptions {
  /** Data root for collected material, e.g. <userData>/data/library. */
  root: string;
  /** Client bound to the in-app LMS sign-in session (WBS-034). */
  client: () => CanvasClient;
  /** Lecture materials through the same sign-in (WBS-039). */
  learningx?: () => LearningXClient;
  sourceCourseIds?: readonly string[];
  /** Lists the enrolled courses for "collect all" (WBS-041); `sourceCourseIds` is the fallback. */
  discoverCourses?: (client: CanvasClient) => Promise<string[]>;
  /** Pushed to the renderer: `running` first, then each final run. */
  onProgress?: (run: SyncRun) => void;
  /** Shown when the LMS says the sign-in is missing or expired. */
  openLogin?: () => void;
  /** Signs in with saved details before a run when the session has lapsed (WBS-040). */
  ensureSignedIn?: () => Promise<void>;
  collect?: (input: CollectCourseInput) => Promise<CollectCourseResult>;
  /** WBS-088: adds the student's own files to what is served; the collected manifest on disk is never changed. */
  extend?: (manifest: CollectionManifest) => Promise<CollectionManifest>;
  now?: () => Date;
  newId?: () => string;
}

function fail(code: ErrorCode, message: string, retryable = false): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable }) });
}

const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Local library on this Mac (WBS-012): runs a user-started collection, and
 * serves manifests and originals from disk so everything already collected
 * stays readable offline or after a failed run. Nothing here deletes files.
 */
export class LibraryService {
  readonly #o: LibraryServiceOptions;
  readonly #store: AssetStore;
  readonly #running = new Set<string>();
  readonly #now: () => Date;
  #accountKey: string | undefined;

  constructor(options: LibraryServiceOptions) {
    this.#o = options;
    this.#store = createDirectoryStore(options.root);
    this.#now = options.now ?? (() => new Date());
  }

  /** Call once at app start: crashed runs become `interrupted`, the last account is restored. */
  async init(): Promise<void> {
    await recoverInterruptedRuns(this.#o.root, this.#now);
    try {
      this.#accountKey = (JSON.parse(await readFile(this.#accountFile(), "utf8")) as { accountKey?: string }).accountKey;
    } catch {
      this.#accountKey = undefined;
    }
  }

  #accountFile() {
    return join(this.#o.root, "account.json");
  }

  /**
   * Opaque per-account key: a hash of the LMS origin and user id, never the
   * student number, name or e-mail (contracts AccountKey). Kept on disk so the
   * library opens offline.
   */
  async #resolveAccount(client: CanvasClient): Promise<string> {
    let me: unknown;
    try {
      me = await client.getObject("/api/v1/users/self");
    } catch (error) {
      // Real KHU Canvas answers users/self with 404, not 401, when nobody is signed in (WBS-038).
      const signedOut =
        error instanceof CollectionError &&
        (error.appError.code === "AUTH_REQUIRED" || (error.appError.code === "SOURCE_CHANGED" && error.appError.detail?.httpStatus === 404));
      if (!signedOut) throw error;
      this.#o.openLogin?.();
      // The school cookie lasts only while the app runs, so each launch may need a new sign-in.
      fail("AUTH_REQUIRED", "학교 로그인이 필요합니다. 열린 로그인 창에서 로그인한 뒤 수집 실행을 다시 누르세요. 설정(사람 아이콘)의 학교 로그인에 저장해 두면 다음부터 자동으로 로그인합니다.");
    }
    const id = (me as { id?: unknown } | null)?.id;
    if (typeof id !== "number" && typeof id !== "string") fail("SOURCE_CHANGED", "LMS 사용자 정보를 읽지 못했습니다.");
    const accountKey = `acct_${createHash("sha256").update(`${client.origin}|${id}`).digest("hex").slice(0, 24)}`;
    if (accountKey !== this.#accountKey) {
      await mkdir(this.#o.root, { recursive: true });
      await writeFile(this.#accountFile(), `${JSON.stringify({ accountKey })}\n`);
      this.#accountKey = accountKey;
    }
    return accountKey;
  }

  /**
   * Starts a collection and returns at once with the first run id; progress
   * arrives through `onProgress`. One collection at a time from this app.
   */
  async run(request: IpcRequest<"collection.run">): Promise<{ syncRunId: string }> {
    if (this.#running.size > 0) fail("RUN_ALREADY_ACTIVE", "수집이 이미 진행 중입니다. 끝난 뒤 다시 실행하세요.");
    let targets: string[];
    if (request.scope === "course") {
      if (request.courseId === undefined) fail("INVALID_REQUEST", "수집할 과목을 고르세요.");
      const known = (await this.courses()).find((c) => c.id === request.courseId);
      if (!known) fail("NOT_FOUND", "이 과목은 아직 수집한 적이 없습니다. 전체 수집을 실행하세요.");
      targets = [known.sourceCourseId];
    } else {
      targets = [];
    }
    const marker = randomUUID();
    this.#running.add(marker);
    try {
      await this.#o.ensureSignedIn?.();
      const client = this.#o.client();
      // CollectionError carries `appError`, which the router passes to the renderer as is.
      const accountKey = await this.#resolveAccount(client);
      if (targets.length === 0) targets = await this.#allCourses(client);
      const ids = targets.map(() => (this.#o.newId ?? randomUUID)());
      void this.#collectAll(client, accountKey, targets, ids).finally(() => this.#running.delete(marker));
      return { syncRunId: ids[0]! };
    } catch (error) {
      this.#running.delete(marker);
      throw error;
    }
  }

  /** Enrolled courses when they can be listed; otherwise the configured ones, so collection still runs. */
  async #allCourses(client: CanvasClient): Promise<string[]> {
    const fallback = [...(this.#o.sourceCourseIds ?? DEFAULT_SOURCE_COURSES)];
    if (!this.#o.discoverCourses) return fallback;
    try {
      const found = await this.#o.discoverCourses(client);
      return found.length > 0 ? found : fallback;
    } catch (error) {
      if (error instanceof CollectionError && error.appError.code === "AUTH_REQUIRED") throw error;
      return fallback;
    }
  }

  async #collectAll(client: CanvasClient, accountKey: string, targets: string[], ids: string[]): Promise<void> {
    const collect = this.#o.collect ?? collectCourse;
    for (const [i, sourceCourseId] of targets.entries()) {
      const id = ids[i]!;
      this.#o.onProgress?.(
        SyncRun.parse({ schemaVersion: 1, id, accountKey, trigger: "manual", scope: "course", startedAt: utc(this.#now()), status: "running", errors: [] }),
      );
      let result: CollectCourseResult;
      try {
        result = await collect({ client, learningx: this.#o.learningx?.(), store: this.#store, root: this.#o.root, accountKey, sourceCourseId, now: this.#now, newId: () => id });
      } catch (error) {
        // RUN_ALREADY_ACTIVE from the collector's own lock, or an unexpected bug.
        const appError =
          error instanceof CollectionError ? error.appError : AppError.parse({ code: "INTERNAL", message: "수집을 시작하지 못했습니다.", retryable: false });
        this.#o.onProgress?.(
          SyncRun.parse({ schemaVersion: 1, id, accountKey, trigger: "manual", scope: "course", startedAt: utc(this.#now()), endedAt: utc(this.#now()), status: "failed", errors: [appError] }),
        );
        continue;
      }
      this.#o.onProgress?.(result.syncRun);
      if (result.syncRun.errors.some((e) => e.code === "AUTH_REQUIRED")) {
        this.#o.openLogin?.();
        return; // the other courses would fail the same way
      }
    }
  }

  async status(): Promise<{ lastSucceeded?: SyncRun; current?: SyncRun }> {
    return this.#accountKey ? readSyncStatus(this.#o.root, this.#accountKey) : {};
  }

  /** Courses with a manifest on disk for the current account; works offline. */
  async courses(): Promise<Course[]> {
    const accountKey = this.#accountKey;
    if (!accountKey) return [];
    const dirs = await readdir(join(this.#o.root, "courses")).catch(() => [] as string[]);
    const courses: Course[] = [];
    for (const courseId of dirs) {
      const manifest = await readCurrentManifest(this.#o.root, { courseId, accountKey }).catch(() => undefined);
      if (manifest) courses.push(manifest.course);
    }
    return courses.sort((a, b) => a.title.localeCompare(b.title, "ko"));
  }

  async manifest(courseId: string): Promise<CollectionManifest | undefined> {
    if (!this.#accountKey) return undefined;
    const manifest = await readCurrentManifest(this.#o.root, { courseId, accountKey: this.#accountKey });
    return manifest && this.#o.extend ? this.#o.extend(manifest) : manifest;
  }

  /**
   * Refreshes the course's read-only materials folder for a course session's
   * CLI (WBS-044) and returns what is in it. Current account only.
   */
  async materials(courseId: string, dir: string): Promise<{ manifest: CollectionManifest; entries: MaterialEntry[] } | undefined> {
    const manifest = await this.manifest(courseId);
    if (!manifest) return undefined;
    const entries = await syncMaterials(dir, materialLayout(manifest), {
      path: (storageKey) => join(this.#o.root, storageKey),
      verify: (storageKey, sha256) => this.#store.verify(storageKey, sha256),
      pageTexts: pdfPageTexts,
    });
    return { manifest, entries };
  }

  /** Opaque account boundary for staged attachments; never sent as CLI context. */
  accountKey(): string | undefined { return this.#accountKey; }

  async attachmentSource(courseId: string, assetId: string) {
    const accountKey = this.#accountKey;
    const manifest = await this.manifest(courseId);
    const asset = manifest?.items.flatMap((i) => i.assets).find((a) => a.id === assetId);
    if (!asset) fail("NOT_FOUND", "첨부할 자료를 찾을 수 없습니다.");
    const data = await this.asset({ courseId, assetId });
    if (accountKey !== this.#accountKey) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다. 자료를 다시 선택하세요.");
    return { ...data, name: asset.originalName, accountKey };
  }

  /** An original named by its manifest entry only, re-hashed before it is handed out. */
  async asset({ courseId, assetId }: IpcRequest<"library.asset">): Promise<IpcResponse<"library.asset">> {
    const manifest = await this.manifest(courseId);
    const asset = manifest?.items.flatMap((i) => i.assets).find((a) => a.id === assetId);
    if (!asset) fail("NOT_FOUND", "자료 정보를 찾을 수 없습니다.");
    if (!(await this.#store.verify(asset.storageKey, asset.sha256))) {
      fail("CHECKSUM_MISMATCH", "저장된 원본이 없거나 손상되었습니다. 수집을 다시 실행하세요.", true);
    }
    const bytes = await readFile(join(this.#o.root, asset.storageKey));
    // A copy, not a view on Node's shared buffer pool, so nothing else rides along over IPC.
    return { mediaType: asset.mediaType, bytes: new Uint8Array(bytes) };
  }
}
