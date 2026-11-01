import { ComposerDraft } from "@learningxxx/contracts";
import type { Session } from "@learningxxx/contracts";
import type { SelectedText, SelectionIntent } from "./selection.ts";

/**
 * Composer state per session (SPEC-003). Each session keeps its own draft, so
 * switching sessions can never send one session's text to another.
 */
export interface Attachment {
  id: string;
  name: string;
  status: "preparing" | "unconfirmed" | "ready" | "failed";
  bytes?: number;
  kind?: "file" | "capture";
  preview?: string;
  error?: string;
}

export interface Draft {
  text: string;
  attachments: Attachment[];
  selection?: SelectedText;
  intent: ComposerDraft["intent"];
}

export const emptyDraft = (): Draft => ({ text: "", attachments: [], intent: "chat" });

/** A selection is copied to one explicit session draft, never attached as a whole file. */
export function withSelection(draft: Draft, selection: SelectedText, intent: SelectionIntent): Draft {
  return { ...draft, selection: { ...selection }, intent };
}

export function withoutSelection(draft: Draft): Draft {
  const { selection: _selection, ...rest } = draft;
  return { ...rest, intent: "chat" };
}

/** A refused send must not erase a selection or overwrite a new draft typed during the request. */
export function restoreIfEmpty(current: Draft | undefined, previous: Draft): Draft {
  return current && (current.text.trim() || current.selection || current.attachments.length) ? current : previous;
}

export type SendBlock =
  | "no_session"
  | "archived"
  | "running"
  | "empty"
  | "preparing"
  | "failed_attachment"
  | "unconfirmed_attachment";

export const BLOCK_REASON: Record<SendBlock, string> = {
  no_session: "세션을 먼저 고르거나 만드세요.",
  archived: "보관된 세션입니다. 보관을 해제한 뒤 보내세요.",
  running: "이 세션의 응답이 끝난 뒤 보낼 수 있습니다.",
  empty: "내용을 입력하세요.",
  preparing: "첨부를 준비하는 중입니다.",
  unconfirmed_attachment: "첨부할 파일과 대상 세션을 확인해 주세요.",
  failed_attachment: "준비하지 못한 첨부가 있습니다. 빼거나 다시 추가하세요.",
};

/** Why the send button is locked, or undefined when it may send. */
export function sendBlock(draft: Draft, session: Session | undefined, running: boolean): SendBlock | undefined {
  if (!session) return "no_session";
  if (session.archivedAt !== undefined) return "archived";
  if (running) return "running";
  if (draft.attachments.some((a) => a.status === "preparing")) return "preparing";
  if (draft.attachments.some((a) => a.status === "failed")) return "failed_attachment";
  if (draft.attachments.some((a) => a.status === "unconfirmed")) return "unconfirmed_attachment";
  if (draft.text.trim() === "" && draft.attachments.length === 0 && !draft.selection) return "empty";
  return undefined;
}

/**
 * Freezes what is sent: the target session is fixed here, at click time, and
 * later edits or session switches do not change it. Throws if the contract
 * would reject the draft, so nothing half-valid reaches the host.
 */
export function freeze(draft: Draft, targetSessionId: string): ComposerDraft {
  if (draft.attachments.some((a) => a.status !== "ready")) throw new Error("attachment is not confirmed");
  return ComposerDraft.parse({
    text: draft.text,
    attachmentIds: draft.attachments.filter((a) => a.kind !== "capture").map((a) => a.id),
    captureIds: draft.attachments.filter((a) => a.kind === "capture").map((a) => a.id),
    targetSessionId,
    intent: draft.intent,
    ...(draft.selection ? { selection: draft.selection } : {}),
  });
}

/** Sessions for the panel: the current course's sessions and independent ones, newest first. */
export function visibleSessions(sessions: Session[], courseId: string | undefined): { course: Session[]; independent: Session[] } {
  const byRecent = (a: Session, b: Session) => b.lastUsedAt.localeCompare(a.lastUsedAt);
  return {
    course: sessions.filter((s) => s.mode === "course" && s.courseId === courseId).sort(byRecent),
    independent: sessions.filter((s) => s.mode === "independent").sort(byRecent),
  };
}
