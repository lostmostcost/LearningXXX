import { TranscriptSegment } from "@learningxxx/contracts";
import type { MediaAsset, Transcript, TranscriptionJob } from "@learningxxx/contracts";

/** Renderer projection only; WBS-027 adapts the collector's own job state. */
export interface DownloadViewInput {
  id: string;
  courseId: string;
  title: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  receivedBytes?: number;
  totalBytes?: number;
}
export function downloadView(job: DownloadViewInput): { label: string; progress?: number } {
  const labels = { queued: "다운로드 대기", running: "다운로드 중", succeeded: "원본 다운로드 완료", failed: "다운로드 실패 · 원본 완성 전", cancelled: "다운로드 취소됨" };
  const received = job.receivedBytes, total = job.totalBytes;
  const known = job.status === "running" && received !== undefined && total !== undefined
    && Number.isFinite(received) && Number.isFinite(total) && received >= 0 && total > 0 && received <= total;
  return { label: job.status === "running" && !known ? "다운로드 중 · 진행량 알 수 없음" : labels[job.status], ...(known ? { progress: received / total } : {}) };
}

/** UI-only projection of the WBS-022 contract; no worker, file access or summary calls. */
export function jobView(job: TranscriptionJob): { label: string; progress?: number; retry: boolean } {
  const labels = { queued: "전사 대기", running: "전사 중", succeeded: "전사 완료", failed: "전사 실패", cancelled: "전사 취소됨" };
  const p = job.progress;
  const measurable = job.status === "running" && p !== undefined && Number.isFinite(p) && p >= 0 && p <= 1;
  // Quitting the app interrupts a transcription; it waits for the user's retry instead of restarting.
  const interrupted = job.status === "failed" && job.errorCode === "RUN_INTERRUPTED";
  return { label: interrupted ? "전사 중단됨" : job.status === "running" && !measurable ? "전사 중 · 진행량 알 수 없음" : labels[job.status],
    ...(measurable ? { progress: p } : {}), retry: job.status === "failed" || job.status === "cancelled" };
}

export function mediaTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000), hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60, rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** Keep engine and explicitly corrected versions; never silently replace an earlier transcript. */
export function versionsFor(asset: MediaAsset, versions: readonly Transcript[]): Transcript[] {
  return versions.filter((v) => v.sourceAssetId === asset.id).toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
}

/** Known duration is an upper bound, not permission to seek to a different segment. */
export function playbackRange(segment: TranscriptSegment, durationMs?: number): { startSeconds: number; endSeconds: number } | undefined {
  if (!TranscriptSegment.safeParse(segment).success) return undefined;
  if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs <= 0 || segment.startMs >= durationMs)) return undefined;
  const end = Math.min(segment.endMs, durationMs ?? segment.endMs);
  if (end <= segment.startMs) return undefined;
  return { startSeconds: segment.startMs / 1000, endSeconds: end / 1000 };
}

export interface TranscriptExcerpt {
  courseId: string;
  sourceAssetId: string;
  transcriptId: string;
  segments: TranscriptSegment[];
  text: string;
}
export type ExcerptResult = { ok: true; excerpt: TranscriptExcerpt } | {
  ok: false; reason: "wrong_course" | "wrong_source" | "no_selection" | "invalid_selection" | "empty" | "too_large";
};

/** Copies only explicitly selected rows, with source/version identity, for a later draft preview. */
export function excerptFor(asset: MediaAsset, transcript: Transcript, indices: readonly number[], visibleCourseId: string): ExcerptResult {
  if (asset.courseId !== visibleCourseId) return { ok: false, reason: "wrong_course" };
  if (transcript.sourceAssetId !== asset.id) return { ok: false, reason: "wrong_source" };
  if (!indices.length) return { ok: false, reason: "no_selection" };
  if (indices.some((n) => !Number.isInteger(n) || n < 0 || n >= transcript.segments.length)) return { ok: false, reason: "invalid_selection" };
  const segments = [...new Set(indices)].sort((a, b) => a - b).map((i) => ({ ...transcript.segments[i]! }));
  const text = segments.map((s) => `[${mediaTime(s.startMs)}–${mediaTime(s.endMs)}] ${s.text}`).join("\n");
  if (!segments.some((s) => s.text.trim())) return { ok: false, reason: "empty" };
  if (text.length > 20000) return { ok: false, reason: "too_large" };
  return { ok: true, excerpt: { courseId: asset.courseId, sourceAssetId: asset.id, transcriptId: transcript.id, segments, text } };
}
