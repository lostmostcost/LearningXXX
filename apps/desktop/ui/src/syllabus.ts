import type { CourseSyllabus, SyllabusDoc, SyllabusSource } from "@learningxxx/contracts";

/**
 * WBS-107: what the 강의 정보 tab decides without React — whether to read
 * the syllabus now, which week of the plan is this week, and how grading
 * adds up.
 */

/** Read from the school once by itself when a listed source was never read (a failed one waits for 다시 받기). */
export const needsRead = (s: CourseSyllabus | undefined): boolean => !!s && s.sources.some((x) => !x.doc && !x.error);

/** "10주", "10주차", "제10주", "Week 10" → 10. */
export function planWeekNumber(label: string): number | undefined {
  const m = /(\d{1,2})\s*(?:주|차시|회차)|week\s*(\d{1,2})/i.exec(label);
  const n = Number(m?.[1] ?? m?.[2]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Index of the plan row for the week being studied (by week number), or -1. */
export function currentPlanRow(weeks: SyllabusDoc["weeks"], weekLabel: string | undefined): number {
  const n = weekLabel ? planWeekNumber(weekLabel) : undefined;
  return n === undefined ? -1 : weeks.findIndex((w) => planWeekNumber(w.label) === n);
}

/** Total of the stated weights and their unit (%, 점), when every item states one in the same unit. */
export function gradingTotal(grading: SyllabusDoc["grading"]): { total: number; unit: string } | undefined {
  if (!grading.length || grading.some((g) => g.weight === null)) return undefined;
  const units = new Set(grading.map((g) => /%/.test(g.share) ? "%" : /점/.test(g.share) ? "점" : ""));
  if (units.size !== 1) return undefined;
  return { total: Math.round(grading.reduce((n, g) => n + (g.weight ?? 0), 0) * 10) / 10, unit: [...units][0]! };
}

export const SOURCE_KIND: Record<SyllabusSource["kind"], string> = { school: "학교 강의계획서", lms: "LMS 강의계획서", file: "LMS에 올린 계획서 파일" };

/** Sources in tab order: read ones first (school page, LMS text, files), then the rest. */
export const orderedSources = (s: CourseSyllabus | undefined): SyllabusSource[] => (s?.sources ?? []).toSorted((a, b) => Number(!a.doc) - Number(!b.doc));
