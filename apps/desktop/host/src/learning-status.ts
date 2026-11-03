import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError, CourseLearningStatus, LearningItem, SCHEMA_VERSION } from "@learningxxx/contracts";
import type { Course, ErrorCode } from "@learningxxx/contracts";

/**
 * CR-054 / WBS-055: learning progress as the LMS itself shows it ("완료",
 * "출석", deadlines, submission state), read only. Field meanings come from
 * the WBS-054 measurement (spikes/lms-status/README.md). The only write is
 * WBS-056's view record, and even that is sent by the LMS's own viewer.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/** LMS dates come with an offset; contracts keep UTC without milliseconds. */
export function utc(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const KIND_OF_CONTENT: Record<string, LearningItem["kind"]> = { movie: "video", video: "video", mp4: "video", pdf: "material", zoom: "live", file: "file" };
const ATTENDANCE = new Set(["attendance", "none", "absent"]);
const PERIOD = new Set(["open", "not_open", "late_after"]);

/** Weekly-learning items from LearningX modules; `detailIds` are videos whose watched seconds need the item detail. */
export function mapLearningX(modules: readonly unknown[]): { items: LearningItem[]; detailIds: Map<number, string> } {
  const items: LearningItem[] = [];
  const detailIds = new Map<number, string>();
  for (const module of modules) {
    const m = obj(module);
    const weekLabel = str(m.title)?.slice(0, 200);
    for (const raw of Array.isArray(m.module_items) ? m.module_items : []) {
      const it = obj(raw);
      const type = str(it.content_type);
      if (!type || type === "sub_header") continue;
      const data = obj(it.content_data);
      const icd = obj(data.item_content_data);
      const kind: LearningItem["kind"] = type === "attendance_item" ? (KIND_OF_CONTENT[String(icd.content_type).toLowerCase()] ?? "other") : type === "assignment" ? "assignment" : type === "quiz" ? "quiz" : "other";
      const contentId = str(it.content_id);
      const commonsId = str(icd.content_id);
      const sourceRef = type === "attendance_item" && commonsId ? `commons:${commonsId}` : (type === "assignment" || type === "quiz") && contentId ? `${type}:${contentId}` : undefined;
      const usesAttendance = bool(data.use_attendance) ?? false;
      const status = str(it.attendance_status);
      const period = str(data.lecture_period_status);
      const title = (str(it.title) ?? str(icd.title) ?? "제목 없음").slice(0, 300);
      const item = LearningItem.parse({
        ...(str(it.module_item_id) ? { moduleItemId: str(it.module_item_id) } : {}),
        kind,
        title,
        ...(weekLabel ? { weekLabel } : {}),
        ...(sourceRef ? { sourceRef } : {}),
        completed: bool(it.completion_determinable) === false ? null : (bool(it.completed) ?? null),
        attendance: usesAttendance && status && ATTENDANCE.has(status) ? status : null,
        usesAttendance,
        period: period && PERIOD.has(period) ? period : null,
        unlockAt: utc(data.unlock_at),
        dueAt: utc(data.due_at),
        lockAt: utc(data.lock_at),
        ...(kind === "video" && num(icd.duration) && num(icd.duration)! > 0 ? { durationSec: num(icd.duration) } : {}),
      });
      if (kind === "video" && type === "attendance_item" && contentId && bool(icd.progress_support) !== false) detailIds.set(items.length, contentId);
      items.push(item);
    }
  }
  return { items, detailIds };
}

/** Seconds watched, from `attendance_items/:id` → attendance_data. */
export function watchedSeconds(detail: unknown): number | undefined {
  const progress = num(obj(obj(detail).attendance_data).progress);
  return progress !== undefined && progress >= 0 ? progress : undefined;
}

function submissionOf(a: Json): LearningItem["submission"] {
  const s = obj(a.submission);
  const state = str(s.workflow_state);
  return {
    state: state === "submitted" || state === "pending_review" || state === "graded" ? state : "unsubmitted",
    submittedAt: utc(s.submitted_at),
    late: bool(s.late) ?? false,
    missing: bool(s.missing) ?? false,
    attempt: num(s.attempt) ?? null,
    types: (Array.isArray(a.submission_types) ? a.submission_types : []).map(String).slice(0, 10),
    allowedExtensions: (Array.isArray(a.allowed_extensions) ? a.allowed_extensions : []).map((x) => String(x).toLowerCase()).slice(0, 50),
    allowedAttempts: num(a.allowed_attempts) ?? null,
  };
}

/**
 * Adds Canvas submission state to assignment items and quiz rules to quizzes.
 * Canvas assignments or quizzes the weekly page does not list are added too,
 * so a deadline is never missing from the app.
 */
export function mergeCanvas(items: LearningItem[], assignments: readonly unknown[], quizzes: readonly unknown[]): LearningItem[] {
  const out = items.map((i) => ({ ...i }));
  const byRef = new Map(out.flatMap((i, n) => (i.sourceRef ? [[i.sourceRef, n] as const] : [])));
  const quizById = new Map(quizzes.map((q) => [str(obj(q).id), obj(q)] as const).filter(([id]) => id !== undefined));
  const quizInfo = (q: Json): LearningItem["quiz"] => ({
    lockdownBrowser: bool(q.require_lockdown_browser) ?? false,
    allowedAttempts: num(q.allowed_attempts) ?? null,
    questionCount: num(q.question_count) ?? null,
  });
  const usedQuizzes = new Set<string>();
  for (const raw of assignments) {
    const a = obj(raw);
    const id = str(a.id);
    if (!id) continue;
    const quizId = str(a.quiz_id);
    const quiz = quizId ? quizById.get(quizId) : undefined;
    if (quizId) usedQuizzes.add(quizId);
    const n = byRef.get(`assignment:${id}`) ?? (quizId ? byRef.get(`quiz:${quizId}`) : undefined);
    const extra = { submission: submissionOf(a), ...(quiz ? { quiz: quizInfo(quiz) } : {}) };
    if (n !== undefined) {
      const it = out[n]!;
      out[n] = LearningItem.parse({ ...it, ...extra, dueAt: it.dueAt ?? utc(a.due_at), lockAt: it.lockAt ?? utc(a.lock_at), unlockAt: it.unlockAt ?? utc(a.unlock_at) });
      continue;
    }
    out.push(LearningItem.parse({
      kind: quizId ? "quiz" : "assignment",
      title: (str(a.name) ?? "과제").slice(0, 300),
      sourceRef: `assignment:${id}`,
      completed: null, attendance: null, usesAttendance: false, period: null,
      unlockAt: utc(a.unlock_at), dueAt: utc(a.due_at), lockAt: utc(a.lock_at),
      ...extra,
    }));
  }
  for (const [id, q] of quizById) {
    if (!id || usedQuizzes.has(id)) continue;
    const n = byRef.get(`quiz:${id}`);
    if (n !== undefined) { out[n] = LearningItem.parse({ ...out[n]!, quiz: quizInfo(q) }); continue; }
    out.push(LearningItem.parse({
      kind: "quiz", title: (str(q.title) ?? "퀴즈").slice(0, 300), sourceRef: `quiz:${id}`,
      completed: null, attendance: null, usesAttendance: false, period: null,
      unlockAt: utc(q.unlock_at), dueAt: utc(q.due_at), lockAt: utc(q.lock_at), quiz: quizInfo(q),
    }));
  }
  return out;
}

export interface LearningSources {
  modules: (sourceCourseId: string) => Promise<unknown[]>;
  attendanceItem: (sourceCourseId: string, itemId: string) => Promise<unknown>;
  assignments: (sourceCourseId: string) => Promise<unknown[]>;
  quizzes: (sourceCourseId: string) => Promise<unknown[]>;
}

export interface LearningStatusOptions {
  root: string;
  sources: LearningSources;
  ensureSignedIn: () => Promise<void>;
  courses: () => Promise<Course[]>;
  accountKey: () => string | undefined;
  now?: () => Date;
  /** A cached status younger than this is served without asking the LMS. */
  maxAgeMs?: number;
  /**
   * WBS-056: open the LMS item page out of sight in the sign-in session and
   * resolve true once the LMS viewer itself has reported the view, false when
   * it did not within the time limit. Absent, view records are not offered.
   */
  openItemPage?: (page: { sourceCourseId: string; moduleItemId: string }) => Promise<boolean>;
}

function fail(code: ErrorCode, message: string, retryable = false): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable }) });
}

function appError(error: unknown, part: string): AppError {
  const known = (error as { appError?: { code?: string } }).appError?.code;
  const code: ErrorCode = known === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "DOWNLOAD_FAILED";
  return AppError.parse({ code, message: `${part}을(를) 읽지 못했습니다.`, retryable: code !== "AUTH_REQUIRED" });
}

export class LearningStatusService {
  readonly #o: LearningStatusOptions;
  readonly #inflight = new Map<string, Promise<CourseLearningStatus>>();
  readonly #views = new Map<string, Promise<CourseLearningStatus | undefined>>();
  /** One hidden LMS page at a time. */
  #viewQueue: Promise<unknown> = Promise.resolve();

  constructor(options: LearningStatusOptions) {
    this.#o = options;
  }

  #file(account: string, courseId: string): string {
    return join(this.#o.root, account, `${courseId}.json`);
  }

  #cached(account: string, courseId: string): CourseLearningStatus | undefined {
    try {
      const parsed = CourseLearningStatus.safeParse(JSON.parse(readFileSync(this.#file(account, courseId), "utf8")));
      return parsed.success && parsed.data.courseId === courseId ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async status(courseId: string, refresh = false): Promise<CourseLearningStatus | undefined> {
    const account = this.#o.accountKey();
    if (!account) return undefined;
    const course = (await this.#o.courses()).find((c) => c.id === courseId && c.accountKey === account);
    if (!course) return undefined;
    const cached = this.#cached(account, courseId);
    const now = (this.#o.now ?? (() => new Date()))();
    if (cached && !refresh && now.getTime() - Date.parse(cached.fetchedAt) < (this.#o.maxAgeMs ?? 10 * 60_000)) return cached;
    const key = `${account}:${courseId}`;
    const running = this.#inflight.get(key);
    if (running) return running;
    const work = this.#read(account, course, now).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, work);
    return work;
  }

  /**
   * CR-054 / WBS-056: the user opened this LMS material in the app, so let the
   * LMS record the view the way its own viewer does. Only PDF materials
   * ("material") that are open and not yet complete qualify — never videos,
   * whose attendance needs real watching (WBS-057). Returns the status read
   * again afterwards.
   */
  async recordView(courseId: string, moduleItemId: string): Promise<CourseLearningStatus | undefined> {
    const open = this.#o.openItemPage;
    if (!open) fail("NOT_FOUND", "열람 기록을 쓸 수 없습니다.");
    const account = this.#o.accountKey();
    const course = account ? (await this.#o.courses()).find((c) => c.id === courseId && c.accountKey === account) : undefined;
    if (!account || !course) fail("NOT_FOUND", "과목을 찾을 수 없습니다.");
    const key = `${account}:${courseId}:${moduleItemId}`;
    const running = this.#views.get(key);
    if (running) return running;
    const work = (async () => {
      const before = await this.status(courseId);
      const item = before?.items.find((i) => i.moduleItemId === moduleItemId);
      if (!item || item.kind !== "material") fail("SCOPE_VIOLATION", "열람 기록은 LMS 강의 자료(PDF)에만 남깁니다.");
      if (item.completed === true) return before;
      if (item.completed === null || item.period === "not_open") fail("SCOPE_VIOLATION", "LMS가 아직 열람을 받지 않는 자료입니다.");
      if (item.lockAt && Date.parse(item.lockAt) <= (this.#o.now ?? (() => new Date()))().getTime()) fail("SCOPE_VIOLATION", "열람 기간이 끝난 자료입니다.");
      const turn = this.#viewQueue.then(async () => {
        await this.#o.ensureSignedIn().catch(() => undefined);
        return open({ sourceCourseId: course.sourceCourseId, moduleItemId });
      });
      this.#viewQueue = turn.catch(() => undefined);
      if (!(await turn)) fail("DOWNLOAD_FAILED", "LMS가 열람을 기록하지 않았습니다. 학교 로그인을 확인하고 다시 시도하세요.", true);
      // The account may have changed while the page was open.
      if (this.#o.accountKey() !== account) return undefined;
      return this.status(courseId, true);
    })().finally(() => this.#views.delete(key));
    this.#views.set(key, work);
    return work;
  }

  async #read(account: string, course: Course, now: Date): Promise<CourseLearningStatus> {
    const { sources } = this.#o;
    const errors: AppError[] = [];
    await this.#o.ensureSignedIn().catch(() => undefined);
    let items: LearningItem[] = [];
    try {
      const mapped = mapLearningX(await sources.modules(course.sourceCourseId));
      items = mapped.items;
      // A few at a time: one detail call per video.
      const pending = [...mapped.detailIds];
      const worker = async () => {
        for (let next = pending.shift(); next; next = pending.shift()) {
          const [index, id] = next;
          try {
            const seconds = watchedSeconds(await sources.attendanceItem(course.sourceCourseId, id));
            if (seconds !== undefined) items[index] = { ...items[index]!, progressSec: seconds };
          } catch {
            // The badge still shows; only the watched time is missing.
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    } catch (error) {
      errors.push(appError(error, "주차학습 상태"));
    }
    const assignments = await sources.assignments(course.sourceCourseId).catch((error: unknown) => (errors.push(appError(error, "과제 제출 상태")), []));
    const quizzes = await sources.quizzes(course.sourceCourseId).catch(() => [] as unknown[]); // some courses turn quizzes off
    const status = CourseLearningStatus.parse({
      schemaVersion: SCHEMA_VERSION,
      courseId: course.id,
      fetchedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      items: mergeCanvas(items, assignments, quizzes),
      errors,
    });
    // Keep the last good reading when the LMS could not be read at all.
    const previous = this.#cached(account, course.id);
    if (errors.length && !status.items.length && previous) return { ...previous, errors };
    const file = this.#file(account, course.id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(status));
    renameSync(`${file}.tmp`, file);
    return status;
  }
}

/** Counts only, for the --learning-status-dump check: no titles or dates leave the app. */
export function summarizeLearning(status: CourseLearningStatus): Record<string, unknown> {
  const count = (pick: (i: LearningItem) => unknown) => {
    const tally: Record<string, number> = {};
    for (const item of status.items) tally[String(pick(item))] = (tally[String(pick(item))] ?? 0) + 1;
    return tally;
  };
  return {
    items: status.items.length,
    kinds: count((i) => i.kind),
    completed: count((i) => i.completed),
    attendance: count((i) => i.attendance),
    submission: count((i) => i.submission?.state ?? "-"),
    withDue: status.items.filter((i) => i.dueAt).length,
    watchedVideos: status.items.filter((i) => i.progressSec !== undefined).length,
    errors: status.errors.map((e) => e.code),
  };
}
