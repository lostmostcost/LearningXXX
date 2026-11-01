import type { SyncRun } from "@learningxxx/contracts";
import { formatSeoul } from "./library.ts";

/**
 * One status line for the top bar. A partial run is never shown as a plain
 * success (SPEC-001), and a failure says the previous material is still there.
 */
export function syncStatusText(status: { current?: SyncRun | undefined; lastSucceeded?: SyncRun | undefined }): string {
  const { current, lastSucceeded } = status;
  if (!current) return "아직 수집하지 않음";
  const last = lastSucceeded?.endedAt ? ` · 마지막 완료 ${formatSeoul(lastSucceeded.endedAt)}` : "";
  switch (current.status) {
    case "running":
      return "수집 중…";
    case "succeeded":
      return `수집 완료 · ${formatSeoul(current.endedAt ?? current.startedAt)}`;
    case "partial": {
      const items = current.errors.filter((e) => "resourceSourceId" in e && e.resourceSourceId).length;
      return `${items > 0 ? `자료 ${items}개를 받지 못함` : "일부 목록을 받지 못함"} · 나머지는 최신${last}`;
    }
    case "interrupted":
      return `지난 수집이 중간에 멈춤 · 다시 실행하세요${last}`;
    case "failed": {
      const auth = current.errors.some((e) => e.code === "AUTH_REQUIRED");
      return `${auth ? "학교 로그인이 필요합니다. 로그인 창에서 로그인한 뒤 다시 실행하세요" : (current.errors[0]?.message ?? "수집 실패")}${last}`;
    }
  }
}
