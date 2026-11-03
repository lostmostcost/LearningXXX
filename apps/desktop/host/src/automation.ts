import type { AutomationSettings, CourseMeeting } from "@learningxxx/contracts";

/**
 * WBS-083: the steps the app takes by itself after a lecture is transcribed
 * (correct → 정리본 → assignment/exam notices → review note → course.md) and
 * before class (preview note), each only when the student turned it on.
 * One step runs at a time, so automatic work never piles up requests to
 * the student's Claude subscription; a failed step is recorded and the
 * next one still runs.
 */

/** course.md is made again at most this often per course. */
export const COURSE_MD_EVERY_MS = 30 * 60_000;
/** A preview note is made this long before class at most. */
export const PREVIEW_AHEAD_MS = 3 * 60 * 60_000;
const RECENT = 20;
const DAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** Milliseconds until the next start of this weekly meeting (Seoul time), from `now`. */
export function untilMeeting(meeting: CourseMeeting, now: Date): number {
  const seoul = new Date(now.getTime() + 9 * 3600_000);
  const [h, m] = meeting.start.split(":").map(Number) as [number, number];
  const dayDiff = (DAYS.indexOf(meeting.day) - seoul.getUTCDay() + 7) % 7;
  const start = Date.UTC(seoul.getUTCFullYear(), seoul.getUTCMonth(), seoul.getUTCDate() + dayDiff, h, m) - 9 * 3600_000;
  return start > now.getTime() ? start - now.getTime() : start + 7 * 86_400_000 - now.getTime();
}

export interface AutomationOptions {
  settings: () => AutomationSettings;
  correct: (input: { courseId: string; assetId: string; transcriptId: string; signal: AbortSignal }) => Promise<{ transcriptId: string }>;
  readable: (input: { courseId: string; assetId: string; transcriptId: string }) => Promise<unknown>;
  /** Finds mentioned assignments/exams and adds them; returns how many. */
  mentions: (input: { courseId: string; assetId: string; transcriptId: string }) => Promise<number>;
  courseMd: (courseId: string) => Promise<unknown>;
  review: (input: { courseId: string; weekId: string; signal: AbortSignal }) => Promise<unknown>;
  weekOf: (courseId: string, assetId: string) => Promise<string | undefined>;
  preview: {
    courses: () => Promise<{ id: string; title: string }[]>;
    meetings: (courseId: string) => Promise<CourseMeeting[]>;
    currentWeek: (courseId: string) => Promise<string | undefined>;
    has: (courseId: string, weekId: string) => Promise<boolean>;
    make: (input: { courseId: string; weekId: string; signal: AbortSignal }) => Promise<unknown>;
  };
  now?: () => Date;
}

interface Task { key: string; title: string; run: (signal: AbortSignal) => Promise<void> }
export interface AutomationStatus { running?: string; waiting: number; recent: { title: string; at: string; ok: boolean; message?: string }[] }

export class AutomationService {
  readonly #o: AutomationOptions;
  readonly #queue: Task[] = [];
  #running: { task: Task; abort: AbortController } | undefined;
  readonly #recent: AutomationStatus["recent"] = [];
  readonly #courseMdAt = new Map<string, number>();
  readonly #courseMdLater = new Map<string, ReturnType<typeof setTimeout>>();
  #idle: Promise<void> = Promise.resolve();
  constructor(options: AutomationOptions) { this.#o = options; }

  #now(): Date { return this.#o.now?.() ?? new Date(); }

  status(): AutomationStatus {
    return { ...(this.#running ? { running: this.#running.task.title } : {}), waiting: this.#queue.length, recent: [...this.#recent] };
  }

  /** Resolves when nothing is waiting or running (tests). */
  idle(): Promise<void> { return this.#idle; }

  #add(task: Task): void {
    if (this.#queue.some((t) => t.key === task.key) || this.#running?.task.key === task.key) return;
    this.#queue.push(task);
    if (!this.#running) this.#idle = this.#drain();
  }

  async #drain(): Promise<void> {
    for (let task = this.#queue.shift(); task; task = this.#queue.shift()) {
      const abort = new AbortController();
      this.#running = { task, abort };
      try {
        await task.run(abort.signal);
        this.#record(task.title, true);
      } catch (error) {
        this.#record(task.title, false, (error as { appError?: { message?: string } }).appError?.message ?? "실패했습니다.");
      } finally { this.#running = undefined; }
    }
  }

  #record(title: string, ok: boolean, message?: string): void {
    this.#recent.unshift({ title, at: this.#now().toISOString().replace(/\.\d{3}Z$/, "Z"), ok, ...(message ? { message } : {}) });
    this.#recent.length = Math.min(this.#recent.length, RECENT);
  }

  /** Stops what is running and drops what waits (app quit, account change). */
  stop(): void { this.#queue.length = 0; this.#running?.abort.abort(); for (const t of this.#courseMdLater.values()) clearTimeout(t); this.#courseMdLater.clear(); }

  /** After a lecture's transcription finished. */
  transcribed(input: { courseId: string; assetId: string; transcriptId: string; title: string }): void {
    const s = this.#o.settings();
    const { courseId, assetId } = input;
    let transcriptId = input.transcriptId;
    if (s.correct) this.#add({ key: `correct:${assetId}:${transcriptId}`, title: `자동 교정 · ${input.title}`, run: async (signal) => {
      transcriptId = (await this.#o.correct({ courseId, assetId, transcriptId, signal })).transcriptId;
    } });
    // Later steps read the corrected version when one was made just before.
    if (s.readable) this.#add({ key: `readable:${assetId}`, title: `정리본 · ${input.title}`, run: async () => { await this.#o.readable({ courseId, assetId, transcriptId }); } });
    if (s.mentions) this.#add({ key: `mentions:${assetId}`, title: `과제·시험 안내 찾기 · ${input.title}`, run: async () => { await this.#o.mentions({ courseId, assetId, transcriptId }); } });
    if (s.review) this.#add({ key: `review:${assetId}`, title: `복습 노트 · ${input.title}`, run: async (signal) => {
      const weekId = await this.#o.weekOf(courseId, assetId);
      if (!weekId) throw Object.assign(new Error("no week"), { appError: { message: "녹음의 주차가 정해지지 않아 건너뛰었습니다." } });
      await this.#o.review({ courseId, weekId, signal });
    } });
    if (s.courseMd) this.changed(courseId);
  }

  /** Material of a course changed (collection, transcript): course.md again, at most every 30 minutes. */
  changed(courseId: string): void {
    if (!this.#o.settings().courseMd || this.#courseMdLater.has(courseId)) return;
    const wait = (this.#courseMdAt.get(courseId) ?? -Infinity) + COURSE_MD_EVERY_MS - this.#now().getTime();
    const queue = () => {
      this.#courseMdLater.delete(courseId);
      this.#courseMdAt.set(courseId, this.#now().getTime());
      this.#add({ key: `courseMd:${courseId}`, title: "과목 정리(course.md) 갱신", run: async () => { await this.#o.courseMd(courseId); } });
    };
    if (wait <= 0) queue();
    else { const timer = setTimeout(queue, wait); timer.unref?.(); this.#courseMdLater.set(courseId, timer); }
  }

  /** Checked every few minutes: a preview note for this week when class starts within 3 hours. */
  async tick(): Promise<void> {
    if (!this.#o.settings().preview) return;
    const now = this.#now();
    for (const course of await this.#o.preview.courses()) {
      const meetings = await this.#o.preview.meetings(course.id).catch(() => []);
      if (!meetings.some((m) => untilMeeting(m, now) <= PREVIEW_AHEAD_MS)) continue;
      const weekId = await this.#o.preview.currentWeek(course.id).catch(() => undefined);
      if (!weekId || await this.#o.preview.has(course.id, weekId).catch(() => true)) continue;
      this.#add({ key: `preview:${course.id}:${weekId}`, title: `예습 노트 · ${course.title}`, run: async (signal) => { await this.#o.preview.make({ courseId: course.id, weekId, signal }); } });
    }
  }
}
