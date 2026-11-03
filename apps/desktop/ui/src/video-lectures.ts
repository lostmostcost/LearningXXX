import type { IpcResponse, MediaAsset } from "@learningxxx/contracts";

type Videos = IpcResponse<"media.videos">["videos"];
type Media = IpcResponse<"media.list">;

export interface VideoRow {
  sourceId: string;
  title: string;
  week: string;
  state: "available" | "downloading" | "downloaded" | "failed";
  /** One line for people: download and transcription state, no made-up percentage. */
  status: string;
  asset?: MediaAsset;
  downloadId?: string;
}

const TRANSCRIPT = { queued: "전사 대기", running: "전사 중", succeeded: "전사 완료", failed: "전사 실패", cancelled: "전사 취소" } as const;

/** Each LMS lecture with what this Mac has of it: the original, a running download, or a failure. */
export function videoRows(videos: Videos, media: Media | undefined): VideoRow[] {
  return videos.map((video) => {
    const base = { sourceId: video.sourceId, title: video.title, week: video.week ?? "주차 없음" };
    const asset = media?.assets.find((a) => a.source.type === "lms_video" && a.source.sourceId === video.sourceId);
    if (asset) {
      const job = media?.jobs.find((j) => j.sourceAssetId === asset.id);
      const transcript = job ? TRANSCRIPT[job.status] + (job.status === "running" && job.progress !== undefined ? ` ${Math.round(job.progress * 100)}%` : "") : "전사 대기";
      return { ...base, state: "downloaded", status: `받음 · ${transcript}`, asset };
    }
    const downloads = media?.downloads.filter((d) => d.sourceId === video.sourceId) ?? [];
    const active = downloads.find((d) => d.status === "queued" || d.status === "running");
    if (active) {
      const received = active.receivedBytes, total = active.totalBytes;
      const amount = received !== undefined && total ? ` ${Math.floor((received / total) * 100)}%` : "";
      return { ...base, state: "downloading", status: `받는 중${amount}`, downloadId: active.id };
    }
    const last = downloads.at(-1);
    if (last?.status === "failed") return { ...base, state: "failed", status: "받기 실패 · 다시 받을 수 있음" };
    return { ...base, state: "available", status: "아직 받지 않음" };
  });
}

/** The lectures that belong under one week of the materials menu; `undefined` collects those matching no week. */
export function rowsForWeek(rows: readonly VideoRow[], week: string | undefined, weekLabels: readonly string[]): VideoRow[] {
  return week === undefined ? rows.filter((r) => !weekLabels.includes(r.week)) : rows.filter((r) => r.week === week);
}
