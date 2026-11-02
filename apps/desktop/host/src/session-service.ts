import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppError, Run, Session } from "@learningxxx/contracts";
import type { ChatTurn, ErrorCode, IpcRequest, RunChanges, RunEvent } from "@learningxxx/contracts";
import type { RunRequest, StartOutcome } from "@learningxxx/cli-adapter";
import type { AttachmentService } from "./attachment-service.ts";
import { writeCourseBrief } from "./course-context.ts";
import type { RunHistory } from "./run-history.ts";
import type { SessionStore, StoredState } from "./session-store.ts";
import type { TranscriptStore } from "./transcript-store.ts";

export type StartCli = (request: RunRequest, signal: AbortSignal) => Promise<StartOutcome>;

export interface SessionServiceOptions {
  dataRoot: string;
  store: SessionStore;
  startCli: StartCli;
  onEvent?: (event: RunEvent) => void;
  /** Receives the service clock. Omitted only by tests of unrelated behaviour. */
  history?: (now: () => string) => RunHistory;
  attachments?: AttachmentService;
  /**
   * A course session's context: the brief (passed as a system prompt file) and
   * the course's read-only materials folder at `materialsDir`, which the host
   * fills and the CLI may read. Undefined when nothing is collected.
   */
  courseContext?: (
    courseId: string,
    materialsDir: string,
  ) => Promise<{ brief: string; paths: ReadonlyMap<string, { path: string; textPath?: string | undefined }> } | undefined>;
  /** Keeps what the chat showed, so it survives a restart. */
  transcripts?: TranscriptStore;
  model?: string;
  now?: () => Date;
  newId?: () => string;
}

function fail(code: ErrorCode, message: string): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable: false }) });
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (bytes: Uint8Array) => PNG.every((b, i) => bytes[i] === b);

const INTERRUPTED = AppError.parse({
  code: "RUN_INTERRUPTED",
  message: "앱이 종료되어 이 응답은 중간에 끊겼습니다. 같은 내용으로 다시 보낼 수 있습니다.",
  retryable: true,
});

/** The same reading of host events the chat panel does, kept on the host side. */
function applyToTurn(turn: ChatTurn, event: RunEvent): ChatTurn {
  switch (event.type) {
    case "run.started":
      return { ...turn, state: "streaming" };
    case "text.delta":
      return { ...turn, answer: turn.answer + event.payload.text, state: "streaming" };
    case "tool.requested":
      return { ...turn, tools: [...turn.tools, { tool: event.payload.tool, decision: event.payload.decision, targets: event.payload.targetKeys }] };
    case "artifact.created":
      return { ...turn, artifacts: [...turn.artifacts, event.payload.outputKey] };
    case "run.completed":
      return { ...turn, state: "completed" };
    case "run.failed":
      return { ...turn, state: "failed", error: event.payload.error };
    case "run.cancelled":
      return { ...turn, state: "cancelled" };
    default:
      return turn;
  }
}

/** Selection text is part of what the user sent; nothing else is added. */
export function buildPrompt(draft: IpcRequest<"run.start">["draft"]): string {
  const instruction = {
    chat: "",
    translate_en_ko: "다음 영어 텍스트를 한국어로 번역해 주세요.",
    translate_ko_en: "Translate the following Korean text into English.",
    explain_simply: "다음 내용을 쉽게 설명해 주세요.",
  }[draft.intent];
  return [instruction, draft.selection?.text, draft.text].filter((part) => part && part.trim() !== "").join("\n\n");
}

/**
 * Maps app sessions to CLI sessions and owns run lifecycle: one run per session,
 * one run per requestId, and no automatic resend after a restart (SPEC-002).
 */
export class SessionService {
  readonly #options: SessionServiceOptions;
  readonly #state: StoredState;
  readonly #active = new Map<string, { runId: string; abort: AbortController }>();
  readonly #turns = new Map<string, ChatTurn>();
  readonly #now: () => string;
  readonly #newId: () => string;
  readonly history: RunHistory | undefined;

  constructor(options: SessionServiceOptions) {
    this.#options = options;
    const now = options.now ?? (() => new Date());
    this.#now = () => now().toISOString().replace(/\.\d{3}Z$/, "Z");
    this.#newId = options.newId ?? randomUUID;
    this.history = options.history?.(this.#now);
    this.#state = options.store.load();
    // Page images live only while their run does; any left by a quit go now.
    rmSync(join(options.dataRoot, "viewing"), { recursive: true, force: true });
    this.#recover();
  }

  /** A run still open on startup was cut off by a quit or crash. Never resent. */
  #recover(): void {
    const endedAt = this.#now();
    let changed = false;
    this.#state.runs = this.#state.runs.map((run) => {
      if (TERMINAL.has(run.status)) return run;
      changed = true;
      // The summary of what the cut-off run left behind is the recovery path.
      this.#recordChanges(run.runId);
      return Run.parse({ ...run, status: "interrupted", endedAt, errorCode: "RUN_INTERRUPTED" });
    });
    this.#state.sessions = this.#state.sessions.map((session) => {
      if (session.status !== "running") return session;
      changed = true;
      return Session.parse({ ...session, status: "interrupted" });
    });
    if (changed) this.#save();
  }

  #recordChanges(runId: string): void {
    try {
      this.history?.finish(runId);
    } catch {
      // A failed summary must not turn a finished run into a failed one.
    }
  }

  get(appSessionId: string): Session {
    return this.#session(appSessionId);
  }

  /** Runs that changed something in this session, newest first. */
  changesFor(appSessionId: string): RunChanges[] {
    this.#session(appSessionId);
    return this.#state.runs
      .filter((run) => run.appSessionId === appSessionId)
      .flatMap((run) => this.history?.changes(run.runId) ?? [])
      .filter((record) => record.changes.length > 0)
      .reverse();
  }

  /** What the chat showed in this session. A turn left open by a quit reads as interrupted. */
  transcript(appSessionId: string): ChatTurn[] {
    this.#session(appSessionId);
    const live = this.#active.get(appSessionId)?.runId;
    return (this.#options.transcripts?.read(appSessionId) ?? []).map((turn) => {
      if (turn.runId === live) return this.#turns.get(turn.runId) ?? turn;
      return turn.state === "waiting" || turn.state === "streaming" ? { ...turn, state: "failed", error: INTERRUPTED } : turn;
    });
  }

  /** Saving the transcript is best effort: it must never change how a run ends. */
  #keepTurn(turn: ChatTurn): void {
    try {
      this.#options.transcripts?.put(turn);
    } catch {
      // The run itself is recorded in app-state.json either way.
    }
  }

  #endTurn(runId: string, patch: Pick<ChatTurn, "state"> & { error?: ChatTurn["error"] }): void {
    const turn = this.#turns.get(runId);
    if (!turn) return;
    this.#turns.delete(runId);
    this.#keepTurn({ ...turn, ...patch });
  }

  isActive(appSessionId: string): boolean {
    return this.#active.has(appSessionId);
  }

  setExternalFolders(appSessionId: string, externalFolders: string[]): Session {
    return this.#updateSession(appSessionId, { externalFolders });
  }

  #save(): void {
    this.#options.store.save(this.#state);
  }

  #session(appSessionId: string): Session {
    return this.#state.sessions.find((s) => s.appSessionId === appSessionId) ?? fail("NOT_FOUND", "세션을 찾을 수 없습니다.");
  }

  #updateSession(appSessionId: string, patch: Partial<Session>): Session {
    const updated = Session.parse({ ...this.#session(appSessionId), ...patch });
    this.#state.sessions = this.#state.sessions.map((s) => (s.appSessionId === appSessionId ? updated : s));
    this.#save();
    return updated;
  }

  #updateRun(runId: string, patch: Partial<Run>): Run {
    const current = this.#state.runs.find((r) => r.runId === runId) ?? fail("NOT_FOUND", "실행을 찾을 수 없습니다.");
    const updated = Run.parse({ ...current, ...patch });
    this.#state.runs = this.#state.runs.map((r) => (r.runId === runId ? updated : r));
    this.#save();
    return updated;
  }

  create(request: IpcRequest<"session.create">): Session {
    const appSessionId = this.#newId();
    const now = this.#now();
    // Independent folders carry a UUID only: a course name in a path is context.
    const workspaceKey =
      request.mode === "independent" ? `sessions/${appSessionId}` : `courses/${request.courseId}/sessions/${appSessionId}`;
    mkdirSync(join(this.#options.dataRoot, workspaceKey), { recursive: true });
    const session = Session.parse({
      appSessionId,
      mode: request.mode,
      ...(request.mode === "course" ? { courseId: request.courseId } : {}),
      workspaceKey,
      title: request.title,
      createdAt: now,
      lastUsedAt: now,
      status: "idle",
    });
    this.#state.sessions.push(session);
    this.#save();
    return session;
  }

  list(request: IpcRequest<"session.list">): Session[] {
    return this.#state.sessions
      .filter((s) => request.includeArchived || s.archivedAt === undefined)
      .filter((s) => request.courseId === undefined || s.courseId === request.courseId)
      .toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  rename(request: IpcRequest<"session.rename">): Session {
    return this.#updateSession(request.appSessionId, { title: request.title });
  }

  /** Hides a session. It deletes nothing and does not reset CLI memory. */
  archive({ appSessionId, archived }: IpcRequest<"session.archive">): Session {
    if (this.#active.has(appSessionId)) fail("RUN_ALREADY_ACTIVE", "응답이 끝난 뒤 보관할 수 있습니다.");
    const { archivedAt: _removed, ...rest } = this.#session(appSessionId);
    const updated = Session.parse(archived ? { ...rest, archivedAt: this.#now() } : rest);
    this.#state.sessions = this.#state.sessions.map((s) => (s.appSessionId === appSessionId ? updated : s));
    this.#save();
    return updated;
  }

  #releaseRun(runId: string): void {
    this.#options.attachments?.releaseRun(runId);
    rmSync(join(this.#options.dataRoot, "viewing", runId), { recursive: true, force: true });
  }

  async startRun({ requestId, draft, viewingImage }: IpcRequest<"run.start">): Promise<Run> {
    const repeated = this.#state.runs.find((r) => r.requestId === requestId);
    if (repeated !== undefined) return repeated;

    const appSessionId = draft.targetSessionId;
    const session = this.#session(appSessionId);
    if (session.archivedAt !== undefined) fail("INVALID_REQUEST", "보관된 세션입니다.");
    if (this.#active.has(appSessionId)) fail("RUN_ALREADY_ACTIVE", "이 세션의 응답이 아직 끝나지 않았습니다.");
    if (draft.attachmentIds.length + draft.captureIds.length > 0 && !this.#options.attachments) {
      fail("INVALID_REQUEST", "지원하지 않거나 준비되지 않은 첨부입니다.");
    }

    // Everything up to here is synchronous, so a double click cannot pass twice.
    const runId = this.#newId();
    const inputs = this.#options.attachments?.forRun(appSessionId, runId, draft.attachmentIds, draft.captureIds);
    const abort = new AbortController();
    this.#active.set(appSessionId, { runId, abort });
    const startedAt = this.#now();
    this.#state.runs.push(Run.parse({ runId, appSessionId, requestId, startedAt, status: "starting" }));
    this.#updateSession(appSessionId, { status: "running", lastUsedAt: startedAt });
    const turn: ChatTurn = { runId, appSessionId, sent: draft, answer: "", tools: [], artifacts: [], state: "waiting" };
    this.#turns.set(runId, turn);
    this.#keepTurn(turn);

    const cliSessionId = session.cliSessionId ?? this.#newId();
    const workspacePath = join(this.#options.dataRoot, session.workspaceKey);
    const externalFolders = session.externalFolders ?? [];
    let contextFile: string | undefined;
    let materialsDir: string | undefined;
    let viewingNote: string | undefined;
    let viewingDir: string | undefined;
    if (session.mode === "course" && session.courseId !== undefined) {
      try {
        const courseDir = join(this.#options.dataRoot, "courses", session.courseId);
        const context = await this.#options.courseContext?.(session.courseId, join(courseDir, "materials"));
        if (context !== undefined) {
          const file = join(courseDir, "course-context.md");
          writeCourseBrief(file, context.brief);
          contextFile = file;
          if (context.paths.size > 0) materialsDir = join(courseDir, "materials");
          const shown = draft.viewing && context.paths.get(draft.viewing.assetId);
          if (shown && materialsDir) {
            const page = draft.viewing?.page;
            const parts = [
              `[지금 보고 있는 자료: ${join(materialsDir, shown.path)}${page ? `, ${page}쪽` : ""}`,
              ...(shown.textPath ? [`쪽별 텍스트: ${join(materialsDir, shown.textPath)}${page ? ` (=== ${page}쪽 ===)` : ""}`] : []),
            ];
            if (page && viewingImage && isPng(viewingImage)) {
              viewingDir = join(this.#options.dataRoot, "viewing", runId);
              mkdirSync(viewingDir, { recursive: true });
              const image = join(viewingDir, `${page}쪽.png`);
              writeFileSync(image, viewingImage, { mode: 0o444 });
              parts.push(`이 쪽 화면: ${image}`);
            }
            viewingNote = parts.join(" · ") + "]";
          }
        }
      } catch {
        // Without it the session still works; it just knows less.
      }
    }
    try {
      this.history?.begin(runId, appSessionId, workspacePath, externalFolders);
    } catch {
      // No baseline means no recovery path, so the run does not start.
      this.#releaseRun(runId);
      this.#active.delete(appSessionId);
      this.#updateSession(appSessionId, { status: "idle" });
      this.#endTurn(runId, { state: "failed", error: AppError.parse({ code: "INTERNAL", message: "실행 전 상태를 기록하지 못해 시작하지 않았습니다.", retryable: true }) });
      return this.#updateRun(runId, { status: "failed", endedAt: this.#now(), errorCode: "INTERNAL" });
    }
    const outcome: StartOutcome = await this.#options
      .startCli(
        {
          runId,
          appSessionId,
          mode: session.mode,
          cliSessionId,
          resume: session.cliSessionId !== undefined,
          workspacePath,
          ...(externalFolders.length > 0 ? { writableDirs: externalFolders } : {}),
          ...(contextFile === undefined ? {} : { contextFile }),
          // The materials folder is read-only for the CLI, like attachment copies.
          attachmentDirs: [...(inputs?.dirs ?? []), ...(materialsDir ? [materialsDir] : []), ...(viewingDir ? [viewingDir] : [])],
          prompt: [buildPrompt(draft), inputs?.prompt, viewingNote].filter(Boolean).join("\n\n"),
          ...(this.#options.model === undefined ? {} : { model: this.#options.model }),
        },
        abort.signal,
      )
      .catch(() => ({ ok: false, error: AppError.parse({ code: "INTERNAL", message: "실행을 시작하지 못했습니다.", retryable: false }) }));

    if (!outcome.ok) {
      this.#recordChanges(runId);
      this.#releaseRun(runId);
      this.#active.delete(appSessionId);
      this.#updateSession(appSessionId, { status: "idle" });
      // Cancelled before the CLI opened: the user stopped it, nothing failed.
      if (abort.signal.aborted) {
        this.#endTurn(runId, { state: "cancelled" });
        return this.#updateRun(runId, { status: "cancelled", endedAt: this.#now() });
      }
      this.#endTurn(runId, { state: "failed", error: outcome.error });
      return this.#updateRun(runId, { status: "failed", endedAt: this.#now(), errorCode: outcome.error.code });
    }
    const run = this.#updateRun(runId, { status: "streaming" });
    void this.#pump(run, cliSessionId, outcome.events);
    return run;
  }

  async #pump(run: Run, cliSessionId: string, events: AsyncIterable<RunEvent>): Promise<void> {
    const { runId, appSessionId } = run;
    let finished = false;
    try {
      for await (const event of events) {
        // The mapping is kept only once the CLI has really opened this session.
        if (event.type === "run.started") this.#updateSession(appSessionId, { cliSessionId });
        const turn = this.#turns.get(runId);
        if (turn) this.#turns.set(runId, applyToTurn(turn, event));
        if (event.type === "run.completed" || event.type === "run.cancelled" || event.type === "run.failed") {
          finished = true;
          this.#finish(run, event);
          const ended = this.#turns.get(runId);
          if (ended) this.#endTurn(runId, { state: ended.state, ...(ended.error ? { error: ended.error } : {}) });
        }
        try {
          this.#options.onEvent?.(event);
        } catch {
          // A closed window must not cut the run short; the record above is already saved.
        }
      }
    } finally {
      if (!finished) {
        this.#endTurn(runId, { state: "failed", error: INTERRUPTED });
        this.#updateRun(runId, { status: "interrupted", endedAt: this.#now(), errorCode: "RUN_INTERRUPTED" });
        this.#updateSession(appSessionId, { status: "interrupted" });
      }
      this.#recordChanges(runId);
      this.#releaseRun(runId);
      this.#active.delete(appSessionId);
    }
  }

  #finish({ runId, appSessionId }: Run, event: RunEvent): void {
    const endedAt = this.#now();
    if (event.type === "run.completed") {
      this.#updateRun(runId, { status: "completed", endedAt, exitCode: 0 });
    } else if (event.type === "run.failed") {
      const { error, exitCode } = event.payload;
      this.#updateRun(runId, { status: "failed", endedAt, errorCode: error.code, ...(exitCode === undefined ? {} : { exitCode }) });
    } else {
      this.#updateRun(runId, { status: "cancelled", endedAt });
    }
    this.#updateSession(appSessionId, { status: "idle" });
  }

  cancel({ runId }: IpcRequest<"run.cancel">): Run {
    const run = this.#state.runs.find((r) => r.runId === runId) ?? fail("NOT_FOUND", "실행을 찾을 수 없습니다.");
    this.#active.get(run.appSessionId)?.abort.abort();
    return run;
  }
}
