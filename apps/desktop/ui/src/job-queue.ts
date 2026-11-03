import type { IpcResponse } from "@learningxxx/contracts";

export type QueueItem = IpcResponse<"media.queue">["items"][number];

/** WBS-073: one line for a queue item, e.g. "진행 중 49%" or "대기 · 앞에 2개". */
export function queueStatus(item: QueueItem, paused: boolean): string {
  if (item.status === "running") return `진행 중${item.progress !== undefined ? ` ${Math.round(item.progress * 100)}%` : ""}`;
  if (item.kind === "transcription" && paused) return "일시 정지됨";
  return item.ahead ? `대기 · 앞에 ${item.ahead}개` : "대기";
}
