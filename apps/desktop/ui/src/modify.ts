import type { ModifyJob, ModifyStatus } from "@learningxxx/contracts";

export const STATUS_LABEL: Record<ModifyStatus, string> = {
  editing: "AI가 수정하는 중",
  no_changes: "변경 없음",
  failed: "실패",
  cancelled: "취소됨",
  interrupted: "중단됨",
  review: "변경 확인 필요",
  verifying: "Docker에서 검증하는 중",
  verify_failed: "검증 실패",
  verified: "검증 통과",
  restarting: "다시 시작하는 중",
  applied: "적용됨",
  rolled_back: "되돌림",
  discarded: "버림",
};

export type ModifyAction = "cancel" | "verify" | "apply" | "rollback" | "discard";

/** The host enforces the same order; this only decides which buttons to show. */
export function actionsFor(status: ModifyStatus): ModifyAction[] {
  switch (status) {
    case "editing":
    case "verifying": return ["cancel"];
    case "review":
    case "verify_failed": return ["verify", "discard"];
    case "verified": return ["apply", "discard"];
    case "applied": return ["rollback", "discard"];
    case "no_changes":
    case "failed":
    case "cancelled":
    case "interrupted":
    case "rolled_back": return ["discard"];
    default: return [];
  }
}

/** A new request is possible once nothing is left open on this job. */
export function canRequest(job: ModifyJob | undefined): boolean {
  return job === undefined || ["applied", "rolled_back", "discarded"].includes(job.status);
}

/** Retrying is the same action, but it must not read as if nothing happened. */
export function actionLabel(action: ModifyAction, status: ModifyStatus): string {
  return action === "verify" && status === "verify_failed" ? "다시 검증" : ACTION_LABEL[action];
}

/** The lines of a long check log that say what actually broke. */
export function failureLines(log: string): string[] {
  // The test runner prints each failure again in its summary.
  const lines = log.split("\n").filter((line) => /error TS\d+|✖|AssertionError|not ok /.test(line)).map((line) => line.trim());
  return [...new Set(lines)].slice(0, 5);
}

export const ACTION_LABEL: Record<ModifyAction, string> = {
  cancel: "취소",
  verify: "Docker에서 검증",
  apply: "적용하고 재시작",
  rollback: "이전으로 되돌리기",
  discard: "버리기",
};
