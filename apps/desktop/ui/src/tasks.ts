import type { CourseLearningStatus, LearningItem } from "@learningxxx/contracts";
import type { Entry, Library } from "./library.ts";
import { itemForResource } from "./learning.ts";

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
}

export interface TaskWeek {
  key: string;
  label: string;
  todo: TaskRow[];
  done: TaskRow[];
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
export function tasksByWeek(library: Library, status: CourseLearningStatus | undefined): TaskWeek[] {
  const rows = new Map<string, { row: TaskRow; weekId: string | undefined }>();
  const used = new Set<LearningItem>();
  for (const entry of [...library.weeks.flatMap((w) => w.entries), ...library.other]) {
    if (entry.resource.kind !== "assignment") continue;
    const item = itemForResource(status, entry.resource);
    if (item) used.add(item);
    rows.set(entry.resource.id, {
      weekId: entry.resource.weekId,
      row: { key: entry.resource.id, kind: item?.kind === "quiz" ? "quiz" : "assignment", title: entry.resource.title, entry, ...(item ? { item } : {}), done: doneOf(item), dueAt: entry.assignment?.dueAt ?? item?.dueAt ?? null },
    });
  }
  const weekByLabel = new Map(library.weeks.map((w) => [w.week.label, w.week.id]));
  for (const item of status?.items ?? []) {
    if (used.has(item) || (item.kind !== "assignment" && item.kind !== "quiz")) continue;
    const key = item.sourceRef ?? item.moduleItemId ?? item.title;
    rows.set(key, { weekId: item.weekLabel ? weekByLabel.get(item.weekLabel) : undefined, row: { key, kind: item.kind, title: item.title, item, done: doneOf(item), dueAt: item.dueAt } });
  }
  const groups: TaskWeek[] = [...library.weeks.map((w) => ({ key: w.week.id, label: w.week.label })), { key: "none", label: "주차 없음" }].map((g) => ({ ...g, todo: [], done: [] }));
  for (const { row, weekId } of rows.values()) {
    const group = groups.find((g) => g.key === weekId) ?? groups.at(-1)!;
    (row.done ? group.done : group.todo).push(row);
  }
  return groups.filter((g) => g.todo.length || g.done.length).map((g) => ({ ...g, todo: g.todo.sort(byDue), done: g.done.sort(byDue) }));
}
