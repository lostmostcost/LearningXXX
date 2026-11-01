import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { Id, RunEvent, SCHEMA_VERSION, type AppError } from "@learningxxx/contracts";
import { MESSAGES, appError, classifyFailure } from "./classify.ts";
import {
  COURSE_TOOLS,
  INDEPENDENT_TOOLS,
  VERIFIED_CLI_VERSIONS,
  WRITE_TOOLS,
  buildArgs,
  childEnv,
  findForbiddenEnv,
  type Mode,
} from "./policy.ts";

/** ARCH-001 startRun. The host owns Run records and session mapping (WBS-015). */
export interface RunRequest {
  runId: string;
  appSessionId: string;
  mode: Mode;
  /** New UUID for a first run, or the session's own ID with resume=true. */
  cliSessionId: string;
  resume: boolean;
  /** Absolute; independent sessions use a folder named by a UUID. */
  workspacePath: string;
  /** Absolute folders holding copies of user-confirmed attachments, passed as --add-dir. */
  attachmentDirs?: readonly string[];
  prompt: string;
  model?: string;
}

export interface RunOptions {
  /** Absolute path from locateCli. */
  cliPath: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  verifiedVersions?: readonly string[];
  /** SIGTERM → SIGKILL delay on cancel. */
  killGraceMs?: number;
  now?: () => Date;
  newId?: () => string;
  /** stderr and unparsed stdout, with home and workspace paths masked. Never sent to the renderer as events. */
  onDiagnostic?: (line: string) => void;
}

export type StartOutcome = { ok: true; events: AsyncIterable<RunEvent> } | { ok: false; error: AppError };

type Json = Record<string, unknown>;

class Channel<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }
  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

const isDir = (p: string) => isAbsolute(p) && existsSync(p) && statSync(p).isDirectory();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves symlinks of the deepest existing ancestor so a link cannot hide an outside target. */
function realTarget(p: string): string {
  let head = p;
  const rest: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  return join(realpathSync(head), ...rest);
}

const within = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function validate(req: RunRequest, env: NodeJS.ProcessEnv): AppError | undefined {
  const forbidden = findForbiddenEnv(env);
  if (forbidden.length) {
    return appError("FORBIDDEN_CREDENTIAL_ENV", MESSAGES.FORBIDDEN_CREDENTIAL_ENV, { names: forbidden.join(",") });
  }
  const ids = [req.runId, req.appSessionId, req.cliSessionId].every((v) => Id.safeParse(v).success);
  const dirs = isDir(req.workspacePath) && (req.attachmentDirs ?? []).every(isDir);
  if (!ids || !dirs || req.prompt.trim() === "") {
    return appError("INVALID_REQUEST", MESSAGES.INVALID_REQUEST, { ids, dirs });
  }
  if (req.mode === "independent" && !UUID.test(basename(req.workspacePath))) {
    // A course name in the path is itself context (WBS-002 #3).
    return appError("ISOLATION_VIOLATION", MESSAGES.ISOLATION_VIOLATION, { reason: "workspace name" });
  }
  return undefined;
}

/**
 * Spawns the official CLI once with an argument array (no shell) and
 * normalizes stream-json into contract events. Resolves after the CLI's init
 * event passes the subscription and isolation checks, or with the error that
 * stopped it before `run.started`. There is no retry and no alternative
 * credential path.
 */
export function startRun(req: RunRequest, opts: RunOptions): Promise<StartOutcome> {
  const invalid = validate(req, opts.env);
  if (invalid) return Promise.resolve({ ok: false, error: invalid });
  if (opts.signal?.aborted) {
    return Promise.resolve({ ok: false, error: appError("RUN_INTERRUPTED", MESSAGES.RUN_INTERRUPTED) });
  }

  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? randomUUID;
  const grace = opts.killGraceMs ?? 3000;
  const verified = opts.verifiedVersions ?? VERIFIED_CLI_VERSIONS;
  const expectedTools = new Set<string>(req.mode === "independent" ? INDEPENDENT_TOOLS : COURSE_TOOLS);
  const violation = req.mode === "independent" ? "ISOLATION_VIOLATION" : "SCOPE_VIOLATION";
  const workspace = realpathSync(req.workspacePath);
  const attachments = (req.attachmentDirs ?? []).map((d) => realpathSync(d));
  const home = opts.env.HOME;
  const mask = (text: string) => {
    let out = text.split(req.workspacePath).join("<workspace>").split(workspace).join("<workspace>");
    if (home) out = out.split(home).join("<home>");
    return out;
  };

  const channel = new Channel<RunEvent>();
  let seq = 0;
  let phase: "starting" | "running" | "finished" = "starting";
  let cancelled = false;
  let pendingFailure: AppError | undefined;
  let result: Json | undefined;
  let rateLimitResetsAt: number | undefined;
  let stderr = "";
  let currentMessageId: string | undefined;
  const partialMessages = new Set<string>();
  const tools = new Map<string, { name: string; decision: "allowed" | "denied"; targets: string[] }>();
  const written = new Set<string>();
  let resolveStart!: (o: StartOutcome) => void;
  const started = new Promise<StartOutcome>((r) => (resolveStart = r));

  const emit = (type: RunEvent["type"], payload: unknown) => {
    // Producer-side contract check: a mismatch here is an adapter bug.
    channel.push(
      RunEvent.parse({ schemaVersion: SCHEMA_VERSION, eventId: newId(), runId: req.runId, seq: seq++, occurredAt: now().toISOString(), type, payload }),
    );
  };

  const child = spawn(opts.cliPath, buildArgs({ ...req, attachmentDirs: attachments }), {
    cwd: workspace,
    env: childEnv(opts.env),
    stdio: ["pipe", "pipe", "pipe"],
    // Own process group so cancel also stops tools the CLI started.
    detached: true,
  });
  const kill = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {
      // already gone
    }
  };
  let stopping = false;
  /** SIGTERM, then SIGKILL; if even that never closes the process, finish without it. */
  const stop = () => {
    if (stopping) return;
    stopping = true;
    kill("SIGTERM");
    setTimeout(() => kill("SIGKILL"), grace).unref();
    setTimeout(() => finish(null, false), grace * 2).unref();
  };
  const fail = (error: AppError) => {
    if (pendingFailure || phase === "finished") return;
    pendingFailure = error;
    stop();
  };

  const finish = (exitCode: number | null, processExited: boolean) => {
    if (phase === "finished") return;
    const wasStarting = phase === "starting";
    phase = "finished";
    opts.signal?.removeEventListener("abort", onAbort);
    if (wasStarting) {
      const error =
        pendingFailure ??
        (cancelled
          ? appError("RUN_INTERRUPTED", MESSAGES.RUN_INTERRUPTED)
          : classifyFailure({ exitCode, resultText: resultText(), subtype: str(result?.subtype), stderr, rateLimitResetsAt }));
      resolveStart({ ok: false, error });
      return;
    }
    if (pendingFailure) {
      emit("run.failed", { ...(exitCode !== null ? { exitCode } : {}), error: pendingFailure });
    } else if (cancelled) {
      // Report what the run already changed on disk before it stopped.
      const kept = [...written].filter((key) => existsSync(join(workspace, key)));
      emit("run.cancelled", { processExited, artifactsWritten: kept });
    } else if (exitCode === 0 && result && result.is_error === false && result.subtype === "success") {
      emit("run.completed", { exitCode: 0 });
    } else {
      const error = classifyFailure({ exitCode, resultText: resultText(), subtype: str(result?.subtype), stderr, rateLimitResetsAt });
      emit("run.failed", { ...(exitCode !== null ? { exitCode } : {}), error });
    }
    channel.close();
  };
  const resultText = () => (result?.is_error === true ? str(result.result) : undefined);

  const onAbort = () => {
    if (phase === "finished" || cancelled) return;
    cancelled = true;
    stop();
  };
  opts.signal?.addEventListener("abort", onAbort);

  const targetKey = (raw: string): string => {
    const target = realTarget(isAbsolute(raw) ? raw : resolve(workspace, raw));
    if (within(workspace, target)) return relative(workspace, target).split(sep).join("/") || ".";
    const i = attachments.findIndex((root) => within(root, target));
    return i === -1 ? "<outside>" : `attachment-${i}/${relative(attachments[i]!, target).split(sep).join("/")}`;
  };

  const onInit = (init: Json) => {
    const toolList = Array.isArray(init.tools) ? init.tools.map(String) : [];
    const mcp = Array.isArray(init.mcp_servers)
      ? init.mcp_servers.map((s) => (typeof s === "string" ? s : str((s as Json).name) ?? "?"))
      : [];
    if (init.apiKeySource !== "none") {
      return fail(appError("FORBIDDEN_CREDENTIAL_ENV", MESSAGES.API_KEY_SOURCE, { apiKeySource: String(init.apiKeySource) }));
    }
    const version = str(init.claude_code_version) ?? "unknown";
    if (req.mode === "independent" && !verified.includes(version)) {
      return fail(appError("CLI_VERSION_MISMATCH", MESSAGES.CLI_VERSION_MISMATCH, { found: version }));
    }
    const sameTools = toolList.length === expectedTools.size && toolList.every((t) => expectedTools.has(t));
    if (!sameTools || mcp.length > 0) {
      return fail(appError(violation, MESSAGES[violation], { tools: toolList.length, mcpServers: mcp.length }));
    }
    if (init.session_id !== req.cliSessionId) {
      return fail(appError("ISOLATION_VIOLATION", MESSAGES.ISOLATION_VIOLATION, { reason: "session id" }));
    }
    phase = "running";
    emit("run.started", {
      appSessionId: req.appSessionId,
      cliSessionId: req.cliSessionId,
      mode: req.mode,
      apiKeySource: "none",
      tools: toolList,
      mcpServers: mcp,
    });
    resolveStart({ ok: true, events: channel });
  };

  const onToolUse = (block: Json) => {
    const id = str(block.id) ?? "";
    const name = str(block.name) ?? "";
    const input = (block.input ?? {}) as Json;
    const paths = ["file_path", "path", "notebook_path"].map((k) => input[k]).filter((v): v is string => typeof v === "string");
    if (typeof input.pattern === "string" && isAbsolute(input.pattern)) paths.push(input.pattern);
    const targets = paths.map(targetKey);
    // Host-side scope decision; the CLI enforces too, and a mismatch is caught on the result.
    const decision = expectedTools.has(name) && !targets.includes("<outside>") ? "allowed" : "denied";
    tools.set(id, { name, decision, targets });
    emit("tool.requested", { toolUseId: id || "unknown", tool: name || "unknown", targetKeys: targets, decision });
  };

  const onToolResult = (block: Json, event: Json) => {
    const tool = tools.get(str(block.tool_use_id) ?? "");
    if (!tool || block.is_error === true) return;
    if (tool.decision === "denied") {
      return fail(appError(violation, MESSAGES[violation], { tool: tool.name }));
    }
    if (!WRITE_TOOLS.has(tool.name)) return;
    const meta = event.tool_use_result as Json | undefined;
    for (const key of tool.targets) {
      if (key.startsWith("attachment-")) continue;
      written.add(key);
      const operation = tool.name === "Edit" || meta?.type === "update" ? "modified" : "created";
      emit("artifact.created", { outputKey: key, operation });
    }
  };

  const onLine = (line: string) => {
    if (!line.trim() || phase === "finished") return;
    let event: Json;
    try {
      event = JSON.parse(line) as Json;
    } catch {
      opts.onDiagnostic?.(`unparsed stdout: ${mask(line).slice(0, 200)}`);
      return;
    }
    if (event.type === "result") result = event;
    if (event.type === "rate_limit_event") {
      const info = (event.rate_limit_info ?? {}) as Json;
      if (info.status === "rejected" && typeof info.resetsAt === "number") rateLimitResetsAt = info.resetsAt;
    }
    if (pendingFailure || cancelled) return;
    if (event.type === "system" && event.subtype === "init" && phase === "starting") return onInit(event);
    if (phase !== "running") return;
    if (event.type === "stream_event") {
      const inner = (event.event ?? {}) as Json;
      if (inner.type === "message_start") currentMessageId = str((inner.message as Json | undefined)?.id);
      const delta = (inner.delta ?? {}) as Json;
      if (inner.type === "content_block_delta" && delta.type === "text_delta" && typeof delta.text === "string") {
        if (currentMessageId) partialMessages.add(currentMessageId);
        emit("text.delta", { text: delta.text });
      }
    } else if (event.type === "assistant") {
      const message = (event.message ?? {}) as Json;
      const streamed = partialMessages.has(str(message.id) ?? "");
      for (const block of (message.content ?? []) as Json[]) {
        if (block.type === "text" && !streamed && typeof block.text === "string") emit("text.delta", { text: block.text });
        if (block.type === "tool_use") onToolUse(block);
        if (phase !== "running" || pendingFailure) return;
      }
    } else if (event.type === "user") {
      for (const block of (((event.message ?? {}) as Json).content ?? []) as Json[]) {
        if (block.type === "tool_result") onToolResult(block, event);
      }
    }
  };

  createInterface({ input: child.stdout }).on("line", onLine);
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    if (stderr.length < 8192) stderr += chunk.slice(0, 8192 - stderr.length);
    for (const line of chunk.split("\n")) if (line.trim()) opts.onDiagnostic?.(`stderr: ${mask(line).slice(0, 500)}`);
  });
  child.on("error", (error: NodeJS.ErrnoException) => {
    if (phase !== "starting") return;
    pendingFailure ??= error.code === "ENOENT" || error.code === "EACCES"
      ? appError("CLI_NOT_INSTALLED", MESSAGES.CLI_NOT_INSTALLED)
      : appError("INTERNAL", MESSAGES.INTERNAL, { spawn: error.code ?? "unknown" });
    finish(null, true);
  });
  child.on("close", (code) => finish(code, true));
  child.stdin.on("error", () => undefined);
  child.stdin.end(req.prompt);

  return started;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
