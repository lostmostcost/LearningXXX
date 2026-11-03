import type { IpcResponse } from "@learningxxx/contracts";

/**
 * CR-061 / WBS-061: "개발 · WBS-061 · a1b2c3d · 수정됨" for a development run, so
 * several apps open at once can be told apart; nothing for a packaged app.
 */
export function buildLabel(info: IpcResponse<"app.build"> | undefined): string | undefined {
  if (!info?.dev) return undefined;
  const parts = [info.task ?? info.branch ?? "개발 실행", info.commit, info.dirty ? "수정됨" : undefined].filter(Boolean);
  return `개발 · ${parts.join(" · ")}`;
}

/** Hover text: the full branch and the worktree folder. */
export function buildDetail(info: IpcResponse<"app.build"> | undefined): string | undefined {
  if (!info?.dev) return undefined;
  return [info.branch && `브랜치 ${info.branch}`, info.folder && `폴더 ${info.folder}`, info.commit && `커밋 ${info.commit}`, info.dirty ? "커밋하지 않은 변경 포함" : undefined].filter(Boolean).join(" · ");
}
