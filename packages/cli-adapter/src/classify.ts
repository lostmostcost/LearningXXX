import type { AppError } from "@learningxxx/contracts";

/**
 * Turns CLI failure signals into the SPEC-002 codes, each with its own user
 * explanation. Nothing here retries or switches to another credential: the
 * adapter reports and stops (no automatic fallback, REQ-001).
 */

export const MESSAGES = {
  CLI_NOT_INSTALLED: "Claude Code CLI를 찾지 못했습니다. 공식 설치 후 터미널에서 claude로 로그인하세요.",
  CLI_AUTH_REQUIRED: "Claude 로그인이 없거나 만료되었습니다. 터미널에서 claude를 실행해 구독 계정으로 다시 로그인하세요.",
  FORBIDDEN_CREDENTIAL_ENV: "API 키 또는 다른 공급자 설정이 켜져 있어 구독 로그인으로 실행할 수 없습니다. 해당 환경변수를 지우고 앱을 다시 실행하세요.",
  API_KEY_SOURCE: "CLI가 구독 로그인 대신 다른 인증을 선택해 실행을 중단했습니다. API 키 설정을 지우세요.",
  USAGE_LIMIT: "Claude 구독 사용량 한도에 도달했습니다. 한도가 풀린 뒤 다시 보내세요.",
  SESSION_NOT_FOUND: "이 세션의 Claude 대화 기록을 찾지 못했습니다. 새 세션으로 시작해야 합니다.",
  CLI_VERSION_MISMATCH: "설치된 Claude Code CLI 버전이 앱이 검증한 버전과 다릅니다. 버전 검증 후 사용할 수 있습니다.",
  ISOLATION_VIOLATION: "독립 세션 경계가 지켜지지 않아 실행을 중단했습니다.",
  SCOPE_VIOLATION: "허용하지 않은 위치의 파일에 접근해 실행을 중단했습니다.",
  RUN_INTERRUPTED: "시작하기 전에 실행을 취소했습니다.",
  INVALID_REQUEST: "실행 요청이 올바르지 않습니다.",
  INTERNAL: "Claude Code CLI 실행이 알 수 없는 이유로 실패했습니다. 진단 기록을 확인하세요.",
} as const;

type Detail = NonNullable<AppError["detail"]>;

export function appError(code: AppError["code"], message: string, detail?: Detail): AppError {
  return { code, message, retryable: false, ...(detail ? { detail } : {}) };
}

export interface FailureSignals {
  exitCode: number | null;
  /** `result.result` when the CLI reported is_error. */
  resultText?: string | undefined;
  subtype?: string | undefined;
  stderr: string;
  /** Epoch seconds from a rejected rate_limit_event. */
  rateLimitResetsAt?: number | undefined;
}

const PATTERNS: [AppError["code"], RegExp][] = [
  ["SESSION_NOT_FOUND", /no conversation found with session id/i],
  ["CLI_AUTH_REQUIRED", /invalid api key|not logged in|\/login|oauth token (has )?expired|authentication_error|unauthorized/i],
  ["USAGE_LIMIT", /usage limit|limit reached|rate[ _]limit|too many requests/i],
  ["CLI_VERSION_MISMATCH", /unknown option|unrecognized option|unknown command/i],
];

export function classifyFailure(s: FailureSignals): AppError {
  const detail: Detail = { exitCode: s.exitCode ?? -1, ...(s.subtype ? { subtype: s.subtype } : {}) };
  if (s.rateLimitResetsAt !== undefined) return usageLimit(s.rateLimitResetsAt, detail);
  const text = `${s.resultText ?? ""}\n${s.stderr}`;
  for (const [code, pattern] of PATTERNS) {
    if (!pattern.test(text)) continue;
    if (code === "USAGE_LIMIT") return usageLimit(undefined, detail);
    return appError(code, MESSAGES[code as keyof typeof MESSAGES], detail);
  }
  return appError("INTERNAL", MESSAGES.INTERNAL, detail);
}

function usageLimit(resetsAt: number | undefined, detail: Detail): AppError {
  const retryAfter = resetsAt !== undefined ? new Date(resetsAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined;
  return { code: "USAGE_LIMIT", message: MESSAGES.USAGE_LIMIT, retryable: true, ...(retryAfter ? { retryAfter } : {}), detail };
}
