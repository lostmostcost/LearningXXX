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
