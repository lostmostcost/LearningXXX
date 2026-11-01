import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AppError, Run, Session } from "@learningxxx/contracts";
import type { ErrorCode, IpcRequest, RunChanges, RunEvent } from "@learningxxx/contracts";
import type { RunRequest, StartOutcome } from "@learningxxx/cli-adapter";
import type { RunHistory } from "./run-history.ts";
import type { SessionStore, StoredState } from "./session-store.ts";

export type StartCli = (request: RunRequest, signal: AbortSignal) => Promise<StartOutcome>;

export interface SessionServiceOptions {
  dataRoot: string;
  store: SessionStore;
  startCli: StartCli;
  onEvent?: (event: RunEvent) => void;
  /** Receives the service clock. Omitted only by tests of unrelated behaviour. */
  history?: (now: () => string) => RunHistory;
  model?: string;
  now?: () => Date;
  newId?: () => string;
}

function fail(code: ErrorCode, message: string): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable: false }) });
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

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

  async startRun({ requestId, draft }: IpcRequest<"run.start">): Promise<Run> {
    const repeated = this.#state.runs.find((r) => r.requestId === requestId);
    if (repeated !== undefined) return repeated;

    const appSessionId = draft.targetSessionId;
    const session = this.#session(appSessionId);
    if (session.archivedAt !== undefined) fail("INVALID_REQUEST", "보관된 세션입니다.");
    if (this.#active.has(appSessionId)) fail("RUN_ALREADY_ACTIVE", "이 세션의 응답이 아직 끝나지 않았습니다.");
    if (draft.attachmentIds.length + draft.captureIds.length > 0) {
      fail("INVALID_REQUEST", "첨부는 아직 지원하지 않습니다.");
    }

    // Everything up to here is synchronous, so a double click cannot pass twice.
    const runId = this.#newId();
    const abort = new AbortController();
    this.#active.set(appSessionId, { runId, abort });
    const startedAt = this.#now();
    this.#state.runs.push(Run.parse({ runId, appSessionId, requestId, startedAt, status: "starting" }));
    this.#updateSession(appSessionId, { status: "running", lastUsedAt: startedAt });

    const cliSessionId = session.cliSessionId ?? this.#newId();
    const workspacePath = join(this.#options.dataRoot, session.workspaceKey);
    const externalFolders = session.externalFolders ?? [];
    try {
      this.history?.begin(runId, appSessionId, workspacePath, externalFolders);
    } catch {
      // No baseline means no recovery path, so the run does not start.
      this.#active.delete(appSessionId);
      this.#updateSession(appSessionId, { status: "idle" });
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
          prompt: buildPrompt(draft),
          ...(this.#options.model === undefined ? {} : { model: this.#options.model }),
        },
        abort.signal,
      )
      .catch(() => ({ ok: false, error: AppError.parse({ code: "INTERNAL", message: "실행을 시작하지 못했습니다.", retryable: false }) }));

    if (!outcome.ok) {
      this.#recordChanges(runId);
      this.#active.delete(appSessionId);
      this.#updateSession(appSessionId, { status: "idle" });
      // Cancelled before the CLI opened: the user stopped it, nothing failed.
      if (abort.signal.aborted) return this.#updateRun(runId, { status: "cancelled", endedAt: this.#now() });
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
        if (event.type === "run.completed" || event.type === "run.cancelled" || event.type === "run.failed") {
          finished = true;
          this.#finish(run, event);
        }
        try {
          this.#options.onEvent?.(event);
        } catch {
          // A closed window must not cut the run short; the record above is already saved.
        }
      }
    } finally {
      if (!finished) {
        this.#updateRun(runId, { status: "interrupted", endedAt: this.#now(), errorCode: "RUN_INTERRUPTED" });
        this.#updateSession(appSessionId, { status: "interrupted" });
      }
      this.#recordChanges(runId);
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
