import type { Asset, AssignmentMetadata, CollectionManifest, Course, Resource, Week } from "@learningxxx/contracts";

/** One row in the library panel: a resource with what the viewer needs. */
export interface Entry {
  resource: Resource;
  assets: Asset[];
  assignment?: AssignmentMetadata;
  /** WBS-067: notice/assignment body HTML as the LMS sent it; shown only through RichText. */
  body?: string;
}

export interface Library {
  course: Course;
  /** Course-level notices (no week). Week notices stay in their week. */
  notices: Entry[];
  weeks: { week: Week; entries: Entry[] }[];
  /** Files or assignments without a week, e.g. manual uploads. */
  other: Entry[];
}

const KIND_ORDER = { notice: 0, file: 1, assignment: 2 } as const;
const byKindThenTitle = (a: Entry, b: Entry) =>
  KIND_ORDER[a.resource.kind] - KIND_ORDER[b.resource.kind] || a.resource.title.localeCompare(b.resource.title, "ko");

/** Groups a validated manifest for display. Week labels are the LMS originals; order comes from `order`. */
export function buildLibrary(manifest: CollectionManifest): Library {
  const entries: Entry[] = manifest.items.map(({ resource, assets, assignment, body }) => ({
    resource,
    assets,
    ...(assignment ? { assignment } : {}),
    ...(body ? { body } : {}),
  }));
  const weeks = [...manifest.weeks]
    .sort((a, b) => a.order - b.order)
    .map((week) => ({ week, entries: entries.filter((e) => e.resource.weekId === week.id).sort(byKindThenTitle) }));
  const noWeek = entries.filter((e) => e.resource.weekId === undefined);
  return {
    course: manifest.course,
    notices: noWeek.filter((e) => e.resource.kind === "notice").sort((a, b) => b.resource.updatedAt.localeCompare(a.resource.updatedAt)),
    weeks,
    other: noWeek.filter((e) => e.resource.kind !== "notice").sort(byKindThenTitle),
  };
}

const SEOUL = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "long",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Stored times are UTC; the UI always shows Asia/Seoul (SPEC-001). */
export const formatSeoul = (utc: string): string => SEOUL.format(new Date(utc));

export const SOON_MS = 48 * 60 * 60 * 1000;

export interface Deadline {
  status: "none" | "overdue" | "soon" | "open";
  text: string;
  /** Shown when the LMS gave no time zone and Seoul was assumed. */
  note?: string;
}

export function deadline(assignment: AssignmentMetadata, now: Date): Deadline {
  if (assignment.dueAt === null) return { status: "none", text: "마감 정보 없음" };
  const note = assignment.timezoneBasis === "assumed_asia_seoul" ? { note: "LMS에 시간대가 없어 서울 시간으로 해석했습니다." } : {};
  const due = new Date(assignment.dueAt).getTime();
  const left = due - now.getTime();
  const status = left < 0 ? "overdue" : left <= SOON_MS ? "soon" : "open";
  const label = { overdue: "마감 지남", soon: "마감 임박", open: "마감" }[status];
  return {
    status,
    text: `${label} · ${formatSeoul(assignment.dueAt)}`,
    ...note,
  };
}

/** Only https LMS links open outside; the host opens them in the default browser. */
export const externalUrl = (resource: Resource): string | undefined =>
  resource.sourceUrl?.startsWith("https://") ? resource.sourceUrl : undefined;
