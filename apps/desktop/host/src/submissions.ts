import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import { AccountKey, AppError, Id, type CollectionManifest, type IpcResponse } from "@learningxxx/contracts";
import { cannotSubmit, readAssignment, submitFile, type AssignmentCheck, type CanvasHttp } from "./assignment-submit.ts";

/**
 * WBS-058: handing in assignment files from the app. The student picks a
 * file, sees what will be sent (assignment, file, deadline, attempts) and
 * confirms — then the app submits at once, or registers a rule they also
 * confirmed: "submit this file N minutes before the deadline if it is still
 * not submitted". Nothing is sent without one of the two confirmations.
 * Files are copied into the app when chosen, so a rule sends exactly what
 * was confirmed.
 */

const MAX_BYTES = 500 * 1024 ** 2;
const TYPES: Record<string, string> = { pdf: "application/pdf", hwp: "application/x-hwp", hwpx: "application/hwp+zip", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", zip: "application/zip", txt: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", c: "text/plain", cpp: "text/plain", py: "text/plain", java: "text/plain", sql: "text/plain" };

function fail(code: "NOT_FOUND" | "INVALID_REQUEST" | "AUTH_REQUIRED" | "SCOPE_VIOLATION" | "RUN_ALREADY_ACTIVE", message: string): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable: false }) });
}

const Rule = z.object({
  id: Id, courseId: Id, resourceId: Id, title: z.string(), fileName: z.string(), contentType: z.string(), stored: z.string().regex(/^[0-9a-f-]{36}\.[a-z0-9]{1,8}$/),
  sourceCourseId: z.string(), assignmentId: z.string(), at: z.string(), beforeAttempt: z.number().int().nonnegative(),
  state: z.enum(["waiting", "submitting", "done", "already", "failed", "cancelled"]), message: z.string().optional(), finishedAt: z.string().optional(),
});
type Rule = z.infer<typeof Rule>;

interface Plan { id: string; courseId: string; resourceId: string; title: string; sourceCourseId: string; assignmentId: string; fileName: string; contentType: string; bytes: Uint8Array; check: AssignmentCheck }

export interface SubmissionOptions {
  root: string;
  accountKey: () => string | undefined;
  manifest: (courseId: string) => Promise<CollectionManifest | undefined>;
  http: () => CanvasHttp;
  chooseFile: () => Promise<string | undefined>;
  now?: () => Date;
  /** Told after an automatic submission, so the screens read the LMS state again. */
  onAuto?: (rule: { courseId: string; title: string; ok: boolean; message?: string }) => void;
}

export class Submissions {
  readonly #o: SubmissionOptions;
  #plan: Plan | undefined;
  #busy = false;
  #writes: Promise<unknown> = Promise.resolve();
  constructor(options: SubmissionOptions) { this.#o = options; }

  #now(): Date { return this.#o.now?.() ?? new Date(); }
  #dir(): { key: string; dir: string } {
    const key = this.#o.accountKey();
    if (!key) fail("AUTH_REQUIRED", "학교 자료를 먼저 수집해 계정을 확인하세요.");
    return { key, dir: join(this.#o.root, AccountKey.parse(key)) };
  }
  async #rules(dir: string): Promise<Rule[]> {
    try { return z.array(Rule).parse(JSON.parse(await readFile(join(dir, "rules.json"), "utf8"))); } catch { return []; }
  }
  #update(change: (rules: Rule[]) => Rule[] | Promise<Rule[]>): Promise<Rule[]> {
    const work = this.#writes.catch(() => undefined).then(async () => {
      const { dir } = this.#dir();
      const next = await change(await this.#rules(dir));
      await mkdir(dir, { recursive: true });
      const temp = join(dir, `rules.json.${process.pid}.tmp`);
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      await rename(temp, join(dir, "rules.json"));
      return next;
    });
    this.#writes = work;
    return work;
  }

  /** The collected assignment behind a resource, with its LMS numbers. */
  async #target(courseId: string, resourceId: string) {
    const manifest = await this.#o.manifest(courseId) ?? fail("NOT_FOUND", "이 과목의 수집 자료가 없습니다.");
    const item = manifest.items.find((i) => i.resource.id === resourceId && i.resource.kind === "assignment" && i.resource.source === "lms") ?? fail("NOT_FOUND", "LMS 과제를 찾지 못했습니다.");
    return { title: item.resource.title, sourceCourseId: manifest.course.sourceCourseId, assignmentId: item.resource.sourceId };
  }

  /** Picks the file and reads the assignment; nothing is sent. */
  async choose(courseId: string, resourceId: string): Promise<IpcResponse<"submit.choose">> {
    if (this.#busy) fail("RUN_ALREADY_ACTIVE", "제출하는 중입니다.");
    this.#dir();
    const target = await this.#target(courseId, resourceId);
    const path = await this.#o.chooseFile();
    if (!path) return {};
    const stat = await lstat(path).catch(() => undefined);
    const fileName = basename(path).slice(0, 200), ext = extname(fileName).slice(1).toLowerCase();
    if (!stat?.isFile()) fail("INVALID_REQUEST", "일반 파일을 골라 주세요.");
    if (stat.size === 0 || stat.size > MAX_BYTES) fail("INVALID_REQUEST", "비어 있거나 500MB보다 큰 파일은 제출할 수 없습니다.");
    const check = await readAssignment(this.#o.http(), target.sourceCourseId, target.assignmentId);
    const bytes = new Uint8Array(await readFile(path));
    this.#plan = { id: randomUUID(), courseId, resourceId, ...target, fileName, contentType: TYPES[ext] ?? "application/octet-stream", bytes, check };
    const problem = cannotSubmit(check, fileName, this.#now());
    return {
      planId: this.#plan.id, fileName, bytes: bytes.byteLength,
      assignment: { name: check.name, dueAt: check.dueAt, lockAt: check.lockAt, extensions: check.extensions, attempt: check.submission.attempt, allowedAttempts: check.allowedAttempts, submittedAt: check.submission.submittedAt, files: check.submission.files },
      ...(problem ? { problem } : {}),
    };
  }

  #take(planId: string): Plan {
    const plan = this.#plan;
    if (!plan || plan.id !== planId) fail("NOT_FOUND", "파일을 다시 골라 주세요.");
    return plan;
  }

  /** Confirmed by the student: submits now. */
  async confirm(planId: string): Promise<IpcResponse<"submit.confirm">> {
    const plan = this.#take(planId);
    if (this.#busy) fail("RUN_ALREADY_ACTIVE", "제출하는 중입니다.");
    this.#busy = true;
    try {
      const key = this.#dir().key;
      const result = await submitFile(this.#o.http(), { courseId: plan.sourceCourseId, assignmentId: plan.assignmentId, file: { name: plan.fileName, bytes: plan.bytes, contentType: plan.contentType }, before: plan.check, now: this.#now() });
      if (this.#o.accountKey() !== key) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다.");
      this.#plan = undefined;
      return result;
    } finally { this.#busy = false; }
  }

  /** Confirmed by the student: submits this file `minutesBefore` the deadline if still not submitted then. */
  async schedule(planId: string, minutesBefore: number): Promise<IpcResponse<"submit.schedule">> {
    const plan = this.#take(planId);
    const due = plan.check.dueAt ?? fail("INVALID_REQUEST", "마감이 없는 과제는 자동 제출을 걸 수 없습니다.");
    const at = new Date(Date.parse(due) - minutesBefore * 60_000);
    if (at.getTime() <= this.#now().getTime()) fail("INVALID_REQUEST", "자동 제출 시각이 이미 지났습니다. 지금 제출하세요.");
    const problem = cannotSubmit({ ...plan.check, unlockAt: null }, plan.fileName, at);
    if (problem && !/아직 제출 기간/.test(problem)) fail("INVALID_REQUEST", problem);
    const { dir } = this.#dir();
    const id = randomUUID(), ext = extname(plan.fileName).slice(1).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin";
    await mkdir(join(dir, "files"), { recursive: true });
    await writeFile(join(dir, "files", `${id}.${ext}`), plan.bytes, { mode: 0o600 });
    const rule: Rule = { id, courseId: plan.courseId, resourceId: plan.resourceId, title: plan.title, fileName: plan.fileName, contentType: plan.contentType, stored: `${id}.${ext}`, sourceCourseId: plan.sourceCourseId, assignmentId: plan.assignmentId, at: at.toISOString().replace(/\.\d{3}Z$/, "Z"), beforeAttempt: plan.check.submission.attempt ?? 0, state: "waiting" };
    await this.#update((rules) => [...rules.filter((r) => !(r.resourceId === plan.resourceId && r.state === "waiting")), rule]);
    this.#plan = undefined;
    return { ruleId: id, at: rule.at };
  }

  async rules(): Promise<IpcResponse<"submit.rules">> {
    let dir: string;
    try { dir = this.#dir().dir; } catch { return { rules: [] }; }
    return { rules: (await this.#rules(dir)).map(({ id, courseId, resourceId, title, fileName, at, state, message, finishedAt }) => ({ id, courseId, resourceId, title, fileName, at, state, ...(message ? { message } : {}), ...(finishedAt ? { finishedAt } : {}) })) };
  }

  async cancel(ruleId: string): Promise<IpcResponse<"submit.cancelRule">> {
    const { dir } = this.#dir();
    let stored: string | undefined;
    await this.#update((rules) => rules.map((r) => {
      if (r.id !== ruleId || r.state !== "waiting") return r;
      stored = r.stored;
      return { ...r, state: "cancelled" as const, finishedAt: this.#now().toISOString() };
    }));
    if (!stored) fail("NOT_FOUND", "기다리는 자동 제출이 없습니다.");
    await rm(join(dir, "files", stored), { force: true });
    return {};
  }

  /** Checked every minute: rules whose time came are submitted, unless the student already submitted. */
  async tick(): Promise<void> {
    if (this.#busy) return;
    let dir: string;
    try { dir = this.#dir().dir; } catch { return; }
    const now = this.#now();
    // "submitting" too: a run cut off by a quit is finished now (the attempt check prevents a second submission).
    for (const rule of (await this.#rules(dir)).filter((r) => (r.state === "waiting" || r.state === "submitting") && Date.parse(r.at) <= now.getTime())) {
      this.#busy = true;
      let state: Rule["state"] = "failed", message: string | undefined;
      try {
        await this.#update((rules) => rules.map((r) => (r.id === rule.id ? { ...r, state: "submitting" as const } : r)));
        const http = this.#o.http();
        const check = await readAssignment(http, rule.sourceCourseId, rule.assignmentId);
        if ((check.submission.attempt ?? 0) > rule.beforeAttempt) { state = "already"; message = "그 사이에 직접 제출해 자동 제출은 하지 않았습니다."; }
        else {
          const bytes = new Uint8Array(await readFile(join(dir, "files", rule.stored)));
          await submitFile(http, { courseId: rule.sourceCourseId, assignmentId: rule.assignmentId, file: { name: rule.fileName, bytes, contentType: rule.contentType }, before: { ...check, submission: { ...check.submission, attempt: rule.beforeAttempt } }, now });
          state = "done";
        }
      } catch (error) {
        message = (error as { appError?: { message: string } }).appError?.message ?? "자동 제출에 실패했습니다. LMS에서 확인하세요.";
      } finally {
        this.#busy = false;
        await this.#update((rules) => rules.map((r) => (r.id === rule.id ? { ...r, state, ...(message ? { message } : {}), finishedAt: new Date().toISOString() } : r))).catch(() => undefined);
        if (state !== "failed") await rm(join(dir, "files", rule.stored), { force: true }).catch(() => undefined);
        this.#o.onAuto?.({ courseId: rule.courseId, title: rule.title, ok: state !== "failed", ...(message ? { message } : {}) });
      }
    }
  }
}
