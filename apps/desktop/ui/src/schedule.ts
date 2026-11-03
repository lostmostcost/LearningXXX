import type { CourseMeeting } from "@learningxxx/contracts";

/** WBS-085: weekdays in the order a Korean timetable shows them. */
export const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"] as const;
const JS_DAY: Record<CourseMeeting["day"], number> = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const minutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number) as [number, number]; return h * 60 + m; };

/** Day of week and minute of day in Seoul. */
function seoul(now: Date): { day: number; minute: number } {
  const t = new Date(now.getTime() + 9 * 3600_000);
  return { day: t.getUTCDay(), minute: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

export interface Slot { courseId: string; meeting: CourseMeeting }
export interface NowAndNext { current?: Slot | undefined; next?: (Slot & { inMinutes: number }) | undefined }

/** The class going on now, and the next one to start (within a week). */
export function nowAndNext(courses: readonly { courseId: string; meetings: readonly CourseMeeting[] }[], now: Date): NowAndNext {
  const { day, minute } = seoul(now);
  let current: Slot | undefined, next: (Slot & { inMinutes: number }) | undefined;
  for (const c of courses) for (const m of c.meetings) {
    const start = minutes(m.start), end = minutes(m.end), d = JS_DAY[m.day];
    if (d === day && start <= minute && minute < end) current ??= { courseId: c.courseId, meeting: m };
    let wait = (d - day) * 1440 + start - minute;
    if (wait <= 0) wait += 7 * 1440;
    if (!next || wait < next.inMinutes) next = { courseId: c.courseId, meeting: m, inMinutes: wait };
  }
  return { current, next };
}

/** Courses for the home screen: the one in class first, then by how soon each meets next; courses without times keep their order at the end. */
export function orderByClass<T extends { id: string }>(courses: readonly T[], times: readonly { courseId: string; meetings: readonly CourseMeeting[] }[], now: Date): T[] {
  const soon = new Map<string, number>();
  for (const t of times) {
    const { current, next } = nowAndNext([t], now);
    if (current) soon.set(t.courseId, -1);
    else if (next) soon.set(t.courseId, next.inMinutes);
  }
  return courses.map((c, i) => ({ c, i })).sort((a, b) => (soon.get(a.c.id) ?? Infinity) - (soon.get(b.c.id) ?? Infinity) || a.i - b.i).map((x) => x.c);
}

/** "40분 뒤", "3시간 뒤", "2일 뒤". */
export function inText(min: number): string {
  if (min < 60) return `${min}분 뒤`;
  if (min < 1440) return `${Math.round(min / 60)}시간 뒤`;
  return `${Math.round(min / 1440)}일 뒤`;
}
