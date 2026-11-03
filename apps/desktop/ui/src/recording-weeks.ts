import type { CourseLearningStatus, IpcResponse, MediaAsset, Recording, Week } from "@learningxxx/contracts";
import { transcriptLabel } from "./video-lectures.ts";

/**
 * WBS-065: which week (and online lecture) a recording belongs to. Weeks are
 * the collected LMS weeks; their labels ("3주차") carry no dates, so "this
 * week" is estimated from when the LMS opened each week's items. The estimate
 * is only a default or a suggestion; the user always chooses or confirms.
 */

const DAY = 86_400_000;
const SEOUL = 9 * 3600_000;

/** "3주차" → 3. Labels without a week number are never estimated. */
export function weekNumber(label: string): number | undefined {
  const match = /(\d{1,2})\s*주차/.exec(label);
  return match ? Number(match[1]) : undefined;
}

/** Monday 00:00 in Seoul of the week containing `time`, as epoch ms. */
function seoulMonday(time: number): number {
  const day = Math.floor((time + SEOUL) / DAY);
  // 1970-01-01 was a Thursday: with Monday = 0 it is day 3 of its week.
  return (day - ((day + 3) % 7)) * DAY - SEOUL;
}

/**
 * The Monday week 1 starts on. Each numbered week whose LMS items have an
 * opening time votes for "its own Monday minus (n-1) weeks"; the most common
 * vote wins (ties go to the lowest week), so a few late-opened items do not
 * move it.
 */
export function semesterStart(weeks: readonly Week[], status: CourseLearningStatus | undefined): number | undefined {
  const votes = new Map<number, { count: number; week: number }>();
  for (const week of weeks) {
    const n = weekNumber(week.label);
    if (n === undefined || n < 1) continue;
    const opened = (status?.items ?? []).flatMap((i) => (i.weekLabel === week.label && i.unlockAt ? [Date.parse(i.unlockAt)] : []));
    if (!opened.length) continue;
    const vote = seoulMonday(Math.min(...opened)) - (n - 1) * 7 * DAY;
    const old = votes.get(vote);
    votes.set(vote, { count: (old?.count ?? 0) + 1, week: Math.min(old?.week ?? n, n) });
  }
  let best: [number, { count: number; week: number }] | undefined;
  for (const entry of votes) if (!best || entry[1].count > best[1].count || (entry[1].count === best[1].count && entry[1].week < best[1].week)) best = entry;
  return best?.[0];
}

/**
 * The week `at` falls in: the week with that number, or the first/last week
 * before/after the semester. `undefined` when it cannot be told (no opening
 * times, or a gap such as an exam week without its own LMS week).
 */
export function estimateWeek(weeks: readonly Week[], status: CourseLearningStatus | undefined, at: Date): Week | undefined {
  const start = semesterStart(weeks, status);
  if (start === undefined) return undefined;
  const numbered = weeks.flatMap((w) => { const n = weekNumber(w.label); return n === undefined ? [] : [{ w, n }]; }).sort((a, b) => a.n - b.n);
  const n = Math.floor((at.getTime() - start) / (7 * DAY)) + 1;
  if (n < numbered[0]!.n) return numbered[0]!.w;
  if (n > numbered.at(-1)!.n) return numbered.at(-1)!.w;
  return numbered.find((x) => x.n === n)?.w;
}

export interface RecordingRow {
  recording: Recording;
  /** The confirmed original; absent while recording or when nothing was saved. */
  asset?: MediaAsset;
  /** One line: recording, saved, transcription state. */
  status: string;
}

type Media = Pick<IpcResponse<"media.list">, "assets" | "jobs"> & { recordings: readonly Recording[] };

function row(recording: Recording, media: Media): RecordingRow {
  const asset = media.assets.find((a) => a.id === recording.originalAssetId);
  const status = recording.status === "recording" ? "녹음 중" : asset ? `녹음 · ${transcriptLabel(media.jobs, asset.id)}` : "저장하지 못한 녹음";
  return { recording, ...(asset ? { asset } : {}), status };
}

/** Recordings filed under one week, oldest first, as the week was taught. Failed ones (nothing saved) are left out. */
export function weekRecordings(media: Media | undefined, weekId: string): RecordingRow[] {
  return (media?.recordings ?? [])
    .filter((r) => r.weekId === weekId && r.status !== "failed")
    .toSorted((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((r) => row(r, media!));
}

/**
 * Older recordings with no week yet (or whose week the LMS no longer lists),
 * each with the week its date suggests, for the user to confirm.
 */
export function unfiledRecordings(recordings: readonly Recording[], weeks: readonly Week[], status: CourseLearningStatus | undefined): { recording: Recording; suggested?: Week }[] {
  return recordings
    .filter((r) => !weeks.some((w) => w.id === r.weekId) && r.status !== "failed")
    .toSorted((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((recording) => {
      const suggested = estimateWeek(weeks, status, new Date(recording.startedAt));
      return { recording, ...(suggested ? { suggested } : {}) };
    });
}

/** "3주차 · 1차시" for headings; the lecture title only when that lecture is known here. */
export function placeLabel(recording: Recording | undefined, weeks: readonly Week[], lectures: readonly { sourceId: string; title: string }[]): string | undefined {
  if (!recording) return undefined;
  const week = weeks.find((w) => w.id === recording.weekId);
  if (!week) return "주차 미정";
  const lecture = lectures.find((l) => l.sourceId === recording.lectureSourceId);
  return lecture ? `${week.label} · ${lecture.title}` : week.label;
}
