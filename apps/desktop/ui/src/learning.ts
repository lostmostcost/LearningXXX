import type { CourseLearningStatus, LearningItem, Resource } from "@learningxxx/contracts";

/**
 * CR-054 / WBS-055: the LMS's own learning progress shown in the app. Pure
 * helpers so badges and the to-do list can be tested without a host.
 */

export type Tone = "done" | "todo" | "warn" | "muted";
export interface Badge {
  text: string;
  tone: Tone;
}

/** The status entry for a collected resource: LearningX files by commons id, assignments by Canvas id. */
export function itemForResource(status: CourseLearningStatus | undefined, resource: Resource): LearningItem | undefined {
  if (!status) return undefined;
  const ref = resource.kind === "assignment" ? `assignment:${resource.sourceId}` : resource.sourceId;
  return status.items.find((i) => i.sourceRef === ref);
}

const SUBMISSION: Record<NonNullable<LearningItem["submission"]>["state"], Badge> = {
  unsubmitted: { text: "미제출", tone: "todo" },
  submitted: { text: "제출함", tone: "done" },
  pending_review: { text: "검토 중", tone: "done" },
  graded: { text: "채점됨", tone: "done" },
};

/** What the LMS would show next to the item, plus watched share for videos. */
export function badges(item: LearningItem): Badge[] {
  const out: Badge[] = [];
  if (item.submission) {
    out.push(SUBMISSION[item.submission.state]);
    if (item.submission.late) out.push({ text: "지각 제출", tone: "warn" });
    else if (item.submission.missing && item.submission.state === "unsubmitted") out.push({ text: "누락", tone: "warn" });
  } else if (item.attendance) {
    out.push(item.attendance === "attendance" ? { text: "출석", tone: "done" } : item.attendance === "absent" ? { text: "결석", tone: "warn" } : { text: "미출석", tone: "todo" });
  } else if (item.completed !== null) {
    out.push(item.completed ? { text: "완료", tone: "done" } : { text: "미완료", tone: "todo" });
  }
  if (item.kind === "video" && item.durationSec && item.progressSec !== undefined && item.attendance !== "attendance") {
    out.push({ text: `시청 ${Math.min(100, Math.floor((item.progressSec / item.durationSec) * 100))}%`, tone: "muted" });
  }
  if (item.quiz?.lockdownBrowser) out.push({ text: "전용 브라우저 필요", tone: "muted" });
  if (item.period === "not_open") out.push({ text: "공개 전", tone: "muted" });
  return out;
}

/**
 * CR-054 / WBS-056: whether opening this item in the app should let the LMS
 * record the view — an LMS PDF material, open, not yet complete. Videos are
 * never recorded this way: their attendance needs real watching (WBS-057).
 */
export function canRecordView(item: LearningItem | undefined, now: Date): item is LearningItem & { moduleItemId: string } {
  return !!item && item.kind === "material" && !!item.moduleItemId && item.completed === false && item.period !== "not_open"
    && !(item.lockAt && Date.parse(item.lockAt) <= now.getTime());
}

/** "3/5 완료" for a week; only items whose completion the LMS can judge are counted. */
export function weekProgress(items: readonly LearningItem[]): { done: number; total: number } {
  const judged = items.filter((i) => i.submission || i.attendance || i.completed !== null);
  const done = judged.filter((i) => (i.submission ? i.submission.state !== "unsubmitted" : i.attendance ? i.attendance === "attendance" : i.completed === true)).length;
  return { done, total: judged.length };
}

export interface Todo {
  courseId: string;
  item: LearningItem;
  /** The time the user acts against: the due date, or the end of the late period. */
  until: string | null;
  overdue: boolean;
}

/**
 * Things still to do, as the LMS counts them: unsubmitted work, lectures not
 * attended, materials not completed, quizzes not taken. Only items still open
 * (the end date has not passed) are listed; earliest deadline first.
 */
export function todos(statuses: readonly CourseLearningStatus[], now: Date): Todo[] {
  const t = now.getTime();
  const list: Todo[] = [];
  for (const status of statuses) {
    for (const item of status.items) {
      if (item.period === "not_open") continue;
      if (item.lockAt && Date.parse(item.lockAt) <= t) continue;
      const pending = item.submission
        ? item.submission.state === "unsubmitted" && !item.submission.types.every((x) => x === "none" || x === "on_paper")
        : item.usesAttendance
          ? item.attendance !== "attendance"
          : item.completed === false;
      if (!pending) continue;
      const until = item.dueAt ?? item.lockAt;
      list.push({ courseId: status.courseId, item, until, overdue: until !== null && Date.parse(until) <= t });
    }
  }
  return list.sort((a, b) => (a.until ?? "9999").localeCompare(b.until ?? "9999"));
}

const KIND_LABEL: Record<LearningItem["kind"], string> = { video: "강의", material: "자료", live: "실시간", file: "파일", assignment: "과제", quiz: "퀴즈", other: "항목" };
export const kindLabel = (item: LearningItem): string => KIND_LABEL[item.kind];

/**
 * WBS-057: the lecture to watch next — the earliest-due online lecture that
 * counts toward attendance, is open (or in its late period) and is not yet
 * attended. Undefined when there is none.
 */
export function nextUnwatched(status: CourseLearningStatus | undefined, now: Date): (LearningItem & { moduleItemId: string }) | undefined {
  const t = now.getTime();
  const open = (status?.items ?? []).filter((i): i is LearningItem & { moduleItemId: string } =>
    (i.kind === "video" || i.kind === "live") && !!i.moduleItemId && i.usesAttendance && i.attendance !== "attendance"
    && i.period !== "not_open" && !(i.lockAt && Date.parse(i.lockAt) <= t));
  return open.sort((a, b) => (a.dueAt ?? a.lockAt ?? "9999").localeCompare(b.dueAt ?? b.lockAt ?? "9999"))[0];
}

/** WBS-057: whether a lecture item can be opened in the LMS watch window. */
export const canWatch = (item: LearningItem | undefined): item is LearningItem & { moduleItemId: string } =>
  !!item && (item.kind === "video" || item.kind === "live") && !!item.moduleItemId && item.period !== "not_open";

export interface QuizRow {
  item: LearningItem;
  /** One line: taken or not, when it opens/closes, attempts. */
  status: string;
  /** Why it cannot be opened in the app, or undefined when it can. */
  blocked?: string;
}

/**
 * WBS-059: quizzes as the LMS lists them, read only. Opening one shows the
 * LMS's own quiz page; the user takes it there. Earliest deadline first.
 */
export function quizRows(status: CourseLearningStatus | undefined, now: Date, format: (utc: string) => string): QuizRow[] {
  const t = now.getTime();
  return (status?.items ?? []).filter((i) => i.kind === "quiz")
    .sort((a, b) => (a.dueAt ?? a.lockAt ?? "9999").localeCompare(b.dueAt ?? b.lockAt ?? "9999"))
    .map((item) => {
      const taken = item.submission && item.submission.state !== "unsubmitted";
      const notYet = item.unlockAt && Date.parse(item.unlockAt) > t;
      const closed = item.lockAt && Date.parse(item.lockAt) <= t;
      const parts = [
        taken ? (item.submission!.state === "graded" ? "응시함 · 채점됨" : "응시함") : "미응시",
        notYet ? `${format(item.unlockAt!)}부터` : closed ? "마감됨" : item.dueAt ? `마감 ${format(item.dueAt)}` : "기한 없음",
        item.quiz?.allowedAttempts === -1 ? "응시 횟수 제한 없음" : item.quiz?.allowedAttempts ? `응시 ${item.quiz.allowedAttempts}회` : "",
        item.quiz?.questionCount ? `${item.quiz.questionCount}문항` : "",
      ].filter(Boolean);
      const blocked = item.quiz?.lockdownBrowser ? "학교 전용 브라우저(LockDown Browser)가 필요합니다" : !item.moduleItemId && !item.quiz?.quizId ? "LMS에서 직접 여세요" : undefined;
      return { item, status: parts.join(" · "), ...(blocked ? { blocked } : {}) };
    });
}
