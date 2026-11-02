import type { CredentialStatus } from "@learningxxx/contracts";

/** One line for the top bar: what is saved, never the values (WBS-040). */
export function signInSummary(status: CredentialStatus | undefined): string {
  if (!status) return "로그인 설정";
  if (!status.available) return "로그인 설정 (저장 불가)";
  if (status.schoolRejected) return "로그인 설정 ⚠︎ 비밀번호 거부됨";
  if (status.school) return "자동 로그인 켜짐";
  return "로그인 설정";
}
