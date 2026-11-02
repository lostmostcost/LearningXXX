import type { AppError, ChatTurn, ComposerDraft, Run, RunEvent } from "@learningxxx/contracts";

/**
 * What the chat panel shows, rebuilt from host events only (the renderer never
 * sees raw CLI output). Earlier turns, including those from before a restart,
 * come from the host's saved transcript (see `withHistory`).
 */
export interface Turn {
  runId: string;
  appSessionId: string;
  /** The frozen draft, so a retry can resend exactly the same request. */
  sent: ComposerDraft;
  answer: string;
  tools: { tool: string; decision: "allowed" | "denied" | "awaiting_user"; targets: string[] }[];
  artifacts: string[];
  state: "waiting" | "streaming" | "completed" | "failed" | "cancelled";
  error?: AppError;
}

export interface Transcript {
  turns: Turn[];
  /**
   * Events that arrived before the host answered `run.start` with their run id.
   * They are replayed when the turn is added, so the first words are not lost.
   */
  early: RunEvent[];
}

export const emptyTranscript = (): Transcript => ({ turns: [], early: [] });
const MAX_EARLY = 500;

/** The host accepted (or refused) a send: add the turn and replay any events that came first. */
export function addTurn(transcript: Transcript, run: Run, sent: ComposerDraft, error?: AppError): Transcript {
  if (transcript.turns.some((t) => t.runId === run.runId)) return transcript;
  const state = run.status === "failed" ? "failed" : run.status === "cancelled" ? "cancelled" : "waiting";
  const turn: Turn = { runId: run.runId, appSessionId: run.appSessionId, sent, answer: "", tools: [], artifacts: [], state, ...(error ? { error } : {}) };
  let next: Transcript = { turns: [...transcript.turns, turn], early: transcript.early.filter((e) => e.runId !== run.runId) };
  for (const event of transcript.early.filter((e) => e.runId === run.runId).sort((a, b) => a.seq - b.seq)) next = applyEvent(next, event);
  return next;
}

/** Applies one host event; one for a run not yet known is held briefly (see `early`). */
export function applyEvent(transcript: Transcript, event: RunEvent): Transcript {
  const index = transcript.turns.findIndex((t) => t.runId === event.runId);
  if (index === -1) return { ...transcript, early: [...transcript.early, event].slice(-MAX_EARLY) };
  const turn = { ...transcript.turns[index]! };
  switch (event.type) {
    case "run.started":
      turn.state = "streaming";
      break;
    case "text.delta":
      turn.answer += event.payload.text;
      turn.state = "streaming";
      break;
    case "tool.requested":
      turn.tools = [...turn.tools, { tool: event.payload.tool, decision: event.payload.decision, targets: event.payload.targetKeys }];
      break;
    case "artifact.created":
      turn.artifacts = [...turn.artifacts, event.payload.outputKey];
      break;
    case "run.completed":
      turn.state = "completed";
      break;
    case "run.failed":
      turn.state = "failed";
      turn.error = event.payload.error;
      break;
    case "run.cancelled":
      turn.state = "cancelled";
      break;
  }
  return { ...transcript, turns: transcript.turns.map((t, i) => (i === index ? turn : t)) };
}

/**
 * Adds a session's saved turns that this window does not have yet, ahead of
 * the ones it does: what this window saw itself is newer and stays as it is.
 */
export function withHistory(transcript: Transcript, saved: readonly ChatTurn[]): Transcript {
  const known = new Set(transcript.turns.map((t) => t.runId));
  const missing: Turn[] = saved.filter((t) => !known.has(t.runId)).map(({ error, ...t }) => ({ ...t, ...(error ? { error } : {}) }));
  return missing.length ? { ...transcript, turns: [...missing, ...transcript.turns] } : transcript;
}

export const isOpen = (turn: Turn) => turn.state === "waiting" || turn.state === "streaming";

/** The run still open in a session, if any (one run per session, SPEC-002). */
export const openRun = (transcript: Transcript, appSessionId: string | undefined) =>
  transcript.turns.find((t) => t.appSessionId === appSessionId && isOpen(t));

/** What the user can do about an error; retry is offered only where it can help. */
export function errorHelp(error: AppError): { text: string; retry: boolean } {
  const when = error.retryAfter ? ` ${new Date(error.retryAfter).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} 이후에 다시 보내세요.` : "";
  switch (error.code) {
    case "USAGE_LIMIT":
      return { text: `${error.message}${when}`, retry: true };
    case "CLI_AUTH_REQUIRED":
    case "CLI_NOT_INSTALLED":
    case "FORBIDDEN_CREDENTIAL_ENV":
      return { text: `${error.message} 해결한 뒤 같은 내용으로 다시 보낼 수 있습니다.`, retry: true };
    case "SESSION_NOT_FOUND":
      return { text: `${error.message} 새 세션을 만들어 이어가세요.`, retry: false };
    case "ISOLATION_VIOLATION":
    case "SCOPE_VIOLATION":
      return { text: `${error.message} 안전을 위해 실행을 멈췄습니다.`, retry: false };
    default:
      return { text: error.message, retry: error.retryable };
  }
}
