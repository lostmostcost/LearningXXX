import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AccountKey, AppError, CourseMeeting, Id, type IpcResponse } from "@learningxxx/contracts";

/**
 * WBS-085: when each course meets. Times the student entered win; otherwise
 * the times found in the course summary (course.md, WBS-082). Kept on this
 * Mac per school account.
 */

function fail(code: "AUTH_REQUIRED" | "SCOPE_VIOLATION" | "INVALID_REQUEST", message: string): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable: false }) });
}

const Stored = z.object({ courses: z.record(Id, z.array(CourseMeeting)) });

export interface TimetableOptions {
  root: string;
  accountKey: () => string | undefined;
  courses: () => Promise<{ id: string; title: string; accountKey: string }[]>;
  /** Times found in course.md, when it was made. */
  found: (courseId: string) => Promise<CourseMeeting[]>;
}

export class Timetable {
  readonly #o: TimetableOptions;
  #writes: Promise<unknown> = Promise.resolve();
  constructor(options: TimetableOptions) { this.#o = options; }

  #file(): { key: string; file: string } {
    const key = this.#o.accountKey();
    if (!key) fail("AUTH_REQUIRED", "학교 자료를 먼저 수집해 계정을 확인하세요.");
    return { key, file: join(this.#o.root, `${AccountKey.parse(key)}.json`) };
  }
  async #read(file: string): Promise<Record<string, CourseMeeting[]>> {
    try { return Stored.parse(JSON.parse(await readFile(file, "utf8"))).courses; } catch { return {}; }
  }

  async get(): Promise<IpcResponse<"timetable.get">> {
    const { key, file } = this.#file();
    const manual = await this.#read(file);
    const courses = (await this.#o.courses()).filter((c) => c.accountKey === key);
    const out: IpcResponse<"timetable.get">["courses"] = [];
    for (const c of courses) {
      const own = manual[c.id];
      const found = own ? [] : await this.#o.found(c.id).catch(() => []);
      out.push({ courseId: c.id, title: c.title, meetings: own ?? found, source: own ? "manual" : found.length ? "course_md" : "none" });
    }
    return { courses: out };
  }

  /** The student's own times for a course; an empty list means "no class time", null goes back to course.md. */
  set(courseId: string, meetings: CourseMeeting[] | null): Promise<IpcResponse<"timetable.get">> {
    const work = this.#writes.catch(() => undefined).then(async () => {
      const { key, file } = this.#file();
      if (!(await this.#o.courses()).some((c) => c.id === courseId && c.accountKey === key)) fail("INVALID_REQUEST", "현재 계정의 과목이 아닙니다.");
      const all = await this.#read(file);
      if (meetings === null) delete all[courseId]; else all[Id.parse(courseId)] = meetings.slice(0, 20);
      if (this.#o.accountKey() !== key) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다. 저장하지 않았습니다.");
      await mkdir(this.#o.root, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ courses: all }), { mode: 0o600 });
      await rename(temp, file);
    });
    this.#writes = work;
    return work.then(() => this.get());
  }

  /** The effective times of one course (for the preview note before class). */
  async meetings(courseId: string): Promise<CourseMeeting[]> {
    return (await this.get()).courses.find((c) => c.courseId === courseId)?.meetings ?? [];
  }
}
