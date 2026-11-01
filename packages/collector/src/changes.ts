import type { CollectionManifest, SyncRun } from "@learningxxx/contracts";

export interface ManifestChanges {
  added: string[];
  /** Revision went up: the content changed at the source. */
  updated: string[];
  /** Newly tombstoned since the previous manifest. */
  removed: string[];
}

/** What a run changed, by resource id. Title-only edits are not changes (WBS-008 revision rule). */
export function diffManifests(previous: CollectionManifest | undefined, next: CollectionManifest | undefined): ManifestChanges {
  const before = new Map((previous?.items ?? []).map((i) => [i.resource.id, i.resource.revision]));
  const wasRemoved = new Set((previous?.tombstones ?? []).map((t) => t.resourceId));
  const changes: ManifestChanges = { added: [], updated: [], removed: [] };
  for (const { resource } of next?.items ?? []) {
    const old = before.get(resource.id);
    if (old === undefined) changes.added.push(resource.id);
    else if (resource.revision > old) changes.updated.push(resource.id);
  }
  for (const t of next?.tombstones ?? []) if (!wasRemoved.has(t.resourceId)) changes.removed.push(t.resourceId);
  return changes;
}

export interface RunSummary {
  tone: "ok" | "warning" | "error";
  /** Korean lines for the collection status area; no URLs or credentials. */
  lines: string[];
}

/** Status text the UI shows after a run: login needed, partial failure, removals and what changed. */
export function summarizeRun(run: SyncRun, changes: ManifestChanges): RunSummary {
  const lines: string[] = [];
  const auth = run.errors.some((e) => e.code === "AUTH_REQUIRED");
  if (run.status === "running") return { tone: "ok", lines: ["수집 중입니다."] };
  if (auth) lines.push("학교 로그인이 필요합니다. 다시 로그인한 뒤 수집을 실행하세요. 이전에 받은 자료는 그대로 볼 수 있습니다.");
  else if (run.status === "interrupted") lines.push("지난 수집이 중간에 멈췄습니다. 다시 실행하면 받지 못한 자료만 이어서 받습니다.");
  else if (run.status === "failed") lines.push(`수집하지 못했습니다: ${run.errors[0]?.message ?? "알 수 없는 오류"} 이전에 받은 자료는 그대로입니다.`);
  const failedItems = run.errors.filter((e) => "resourceSourceId" in e && e.resourceSourceId !== undefined).length;
  if (run.status === "partial") {
    lines.push(failedItems > 0 ? `자료 ${failedItems}개를 받지 못했습니다. 나머지는 최신입니다. 다시 실행하면 그 자료만 다시 받습니다.` : "일부 목록을 받지 못했습니다. 받지 못한 부분은 이전 자료를 유지합니다.");
    const later = run.errors.map((e) => e.retryAfter).filter((t): t is string => t !== undefined).sort()[0];
    if (later) lines.push(`LMS 요청 제한으로 ${later} 이후에 다시 시도할 수 있습니다.`);
  }
  if (run.status === "succeeded" || run.status === "partial") {
    const { added, updated, removed } = changes;
    lines.push(added.length + updated.length + removed.length === 0 ? "새로 바뀐 자료가 없습니다." : `새 자료 ${added.length}개, 바뀐 자료 ${updated.length}개, LMS에서 사라진 자료 ${removed.length}개.`);
    if (removed.length > 0) lines.push("사라진 자료의 받은 원본과 내 메모는 지우지 않았습니다.");
  }
  const tone = run.status === "succeeded" ? "ok" : run.status === "partial" || run.status === "interrupted" ? "warning" : "error";
  return { tone, lines };
}
