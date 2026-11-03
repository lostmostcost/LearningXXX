import type { CourseLearningStatus, LearningItem } from "@learningxxx/contracts";
import type { Entry, Library } from "./library.ts";
import { itemForResource, notOpenYet } from "./learning.ts";
import { itemKey, resourceKey } from "./hidden-todos.ts";

/** One assignment or quiz in the 과제 section. */
export interface TaskRow {
  key: string;
  kind: "assignment" | "quiz";
  title: string;
  /** The collected assignment, when there is one (opens in the viewer). */
  entry?: Entry;
  /** What the LMS says about it (submission, quiz rules), when read. */
  item?: LearningItem;
  /** Submitted (or taken) as the LMS counts it; undefined when the LMS state is not known yet. */
  done: boolean | undefined;
  dueAt: string | null;
  /** WBS-084: the key it is hidden under, and when it opens if not yet open. */
  hideKey: string;
  opensAt?: string | undefined;
}

export interface TaskWeek {
  key: string;
  label: string;
  todo: TaskRow[];
  done: TaskRow[];
  /** WBS-084: not open yet, and taken off the list by the student. */
  later: TaskRow[];
  hidden: TaskRow[];
}

const doneOf = (item: LearningItem | undefined): boolean | undefined =>
  item?.submission ? item.submission.state !== "unsubmitted" : item?.completed ?? undefined;

const byDue = (a: TaskRow, b: TaskRow) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") || a.title.localeCompare(b.title, "ko");

/**
 * WBS-075: the course's assignments and quizzes grouped by week (in the
 * course's week order, then "주차 없음"), each week split into what is still
 * to do and what is submitted. Collected assignments are joined with the LMS
 * state; assignments and quizzes only the LMS lists are included too. Weeks
 * without any task are left out.
 */
export function tasksByWeek(library: Library, status: CourseLearningStatus | undefined, now: Date = new Date(), isHidden: (key: string) => boolean = () => false): TaskWeek[] {
  const courseId = library.course.id;
  const rows = new Map<string, { row: TaskRow; weekId: string | undefined }>();
  const used = new Set<LearningItem>();
  for (const entry of [...library.weeks.flatMap((w) => w.entries), ...library.other]) {
    if (entry.resource.kind !== "assignment") continue;
    const item = itemForResource(status, entry.resource);
    if (item) used.add(item);
    rows.set(entry.resource.id, {
      weekId: entry.resource.weekId,
      row: { key: entry.resource.id, kind: item?.kind === "quiz" ? "quiz" : "assignment", title: entry.resource.title, entry, ...(item ? { item } : {}), done: doneOf(item), dueAt: entry.assignment?.dueAt ?? item?.dueAt ?? null, hideKey: item ? itemKey(courseId, item) : resourceKey(courseId, entry.resource.id), opensAt: item && notOpenYet(item, now) ? item.unlockAt ?? "" : undefined },
    });
  }
  const weekByLabel = new Map(library.weeks.map((w) => [w.week.label, w.week.id]));
  for (const item of status?.items ?? []) {
    if (used.has(item) || (item.kind !== "assignment" && item.kind !== "quiz")) continue;
    const key = item.sourceRef ?? item.moduleItemId ?? item.title;
    rows.set(key, { weekId: item.weekLabel ? weekByLabel.get(item.weekLabel) : undefined, row: { key, kind: item.kind, title: item.title, item, done: doneOf(item), dueAt: item.dueAt, hideKey: itemKey(courseId, item), opensAt: notOpenYet(item, now) ? item.unlockAt ?? "" : undefined } });
  }
  const groups: TaskWeek[] = [...library.weeks.map((w) => ({ key: w.week.id, label: w.week.label })), { key: "none", label: "주차 없음" }].map((g) => ({ ...g, todo: [] as TaskRow[], done: [] as TaskRow[], later: [] as TaskRow[], hidden: [] as TaskRow[] }));
  for (const { row, weekId } of rows.values()) {
    const group = groups.find((g) => g.key === weekId) ?? groups.at(-1)!;
    (row.done ? group.done : isHidden(row.hideKey) ? group.hidden : row.opensAt !== undefined ? group.later : group.todo).push(row);
  }
  return groups.filter((g) => g.todo.length || g.done.length || g.later.length || g.hidden.length)
    .map((g) => ({ ...g, todo: g.todo.sort(byDue), done: g.done.sort(byDue), later: g.later.sort(byDue), hidden: g.hidden.sort(byDue) }));
}
