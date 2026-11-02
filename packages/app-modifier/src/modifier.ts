import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppError, ModifyJob } from "@learningxxx/contracts";
import type { ErrorCode, RunEvent } from "@learningxxx/contracts";
import type { RunRequest, StartOutcome } from "@learningxxx/cli-adapter";
import { z } from "zod";
import { git } from "./git.ts";
import type { RestartPlan } from "./watchdog.ts";

export interface VerifyInput {
  jobId: string;
  baseCommit: string;
  /** infra/dev/Dockerfile as of baseCommit: the AI's edits cannot reach it. */
  dockerfile: string;
  snapshotDir: string;
  outDir: string;
  signal: AbortSignal;
}
export interface VerifyResult { ok: boolean; log: string }
export type Verifier = (input: VerifyInput) => Promise<VerifyResult>;

export interface AppModifierOptions {
  root: string;
  /** The repository the running app was started from. */
  expectedSource: string;
  startCli: (request: RunRequest, signal: AbortSignal) => Promise<StartOutcome>;
  verifier: Verifier;
  chooseFolder: () => Promise<string | undefined>;
  /** Shown by the host, so a compromised renderer cannot start or apply anything. */
  confirm: (message: string, detail: string, action: string) => Promise<boolean>;
  restart: (planPath: string) => void;
  launch: { execPath: string; args: string[]; cwd: string };
  onJob?: (job: ModifyJob) => void;
  healthTimeoutMs?: number;
  now?: () => Date;
  newId?: () => string;
}

const DIFF_LIMIT = 200_000;
const EXPLANATION_LIMIT = 20_000;
const BUILDS = ["apps/desktop/host/dist", "apps/desktop/ui/dist"] as const;
const OUT_ENTRIES = ["host/dist/main.cjs", "ui/dist/index.html"];
const OPEN = new Set(["editing", "review", "verifying", "verify_failed", "verified", "restarting", "no_changes", "failed", "cancelled", "interrupted"]);
const IN_MOTION = new Set(["editing", "verifying", "restarting"]);

/** Paths that decide what runs or with which permissions. Shown, never hidden in a long diff. */
const SENSITIVE: readonly [RegExp, string][] = [
  [/(^|\/)package\.json$|^pnpm-(lock|workspace)\.yaml$/, "패키지 스크립트나 의존성이 바뀝니다."],
  [/^(compose\.yaml|infra\/|scripts\/|\.github\/)/, "검사·개발 도구가 바뀝니다."],
  [/^apps\/desktop\/host\//, "Mac 권한으로 실행되는 앱 host 코드가 바뀝니다."],
  [/^packages\/(cli-adapter|app-modifier)\//, "CLI 실행 또는 앱 수정 경계 코드가 바뀝니다."],
];

function fail(code: ErrorCode, message: string): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable: false }) });
}

/** Fixed wrapper: only the user's own words go to the CLI, with no course, session or library context. */
export function buildModifyPrompt(request: string): string {
  return [
    "이 작업 폴더는 LearningXXX 앱의 소스입니다. 아래 요청에 필요한 최소한의 코드만 수정하세요.",
    "파일을 지울 수 없고 명령도 실행할 수 없습니다. 끝나면 무엇을 왜 바꿨는지 짧게 설명하세요.",
    "",
    "요청:",
    request,
  ].join("\n");
}

/**
 * Runs one requested change at a time (SPEC-005): separate worktree → CLI edit →
 * diff → Docker verification → user-confirmed apply → watched restart. The
 * user's checkout is untouched until apply, which needs a passing verification
 * of exactly the commit under review.
 */
export class AppModifier {
  readonly #o: AppModifierOptions;
  readonly #now: () => string;
  readonly #newId: () => string;
  #jobs: ModifyJob[] = [];
  #source: string | undefined;
  #abort: AbortController | undefined;

  constructor(options: AppModifierOptions) {
    this.#o = options;
    const now = options.now ?? (() => new Date());
    this.#now = () => now().toISOString().replace(/\.\d{3}Z$/, "Z");
    this.#newId = options.newId ?? randomUUID;
    mkdirSync(options.root, { recursive: true });
    this.#load();
    this.#recover();
  }

  get #stateFile(): string { return join(this.#o.root, "state.json"); }
  #dir(jobId: string): string { return join(this.#o.root, "jobs", jobId); }
  #worktree(jobId: string): string { return join(this.#dir(jobId), "source"); }
  #ref(jobId: string): string { return `refs/learningxxx/modify/${jobId}`; }

  #load(): void {
    if (!existsSync(this.#stateFile)) return;
    const state = z.object({ source: z.string().optional(), jobs: z.array(ModifyJob) }).parse(JSON.parse(readFileSync(this.#stateFile, "utf8")));
    this.#source = state.source;
    this.#jobs = state.jobs;
  }

  #save(): void {
    writeFileSync(this.#stateFile, JSON.stringify({ source: this.#source, jobs: this.#jobs }, null, 2));
  }

  /** Work cut off by a quit is never resumed or resent. */
  #recover(): void {
    for (const job of this.#jobs) {
      if (job.status === "editing" || job.status === "verifying") {
        this.#update(job.jobId, { status: "interrupted", message: "앱이 종료되어 작업이 중단되었습니다. 버리고 다시 요청해 주세요." });
      } else if (job.status === "restarting") {
        this.#settleRestart(job);
      }
    }
  }

  /** The watchdog leaves this marker when the new build never came up. */
  #settleRestart(job: ModifyJob): void {
    const marker = join(this.#dir(job.jobId), "rolled-back.json");
    if (!existsSync(marker)) return;
    const { sourceRestored } = z.object({ sourceRestored: z.boolean() }).parse(JSON.parse(readFileSync(marker, "utf8")));
    this.#update(job.jobId, {
      status: "rolled_back",
      message: sourceRestored ? "새 앱이 정상적으로 시작되지 않아 이전 앱과 소스로 되돌렸습니다." : "새 앱이 정상적으로 시작되지 않아 이전 앱으로 되돌렸습니다. 소스가 그 사이 바뀌어 소스는 되돌리지 않았습니다.",
    });
  }

  #job(jobId: string): ModifyJob {
    return this.#jobs.find((j) => j.jobId === jobId) ?? fail("NOT_FOUND", "수정 작업을 찾을 수 없습니다.");
  }

  #update(jobId: string, patch: Partial<ModifyJob>): ModifyJob {
    const updated = ModifyJob.parse({ ...this.#job(jobId), ...patch, updatedAt: this.#now() });
    this.#jobs = this.#jobs.map((j) => (j.jobId === jobId ? updated : j));
    this.#save();
    try { this.#o.onJob?.(updated); } catch { /* A closed window must not break the job. */ }
    return updated;
  }

  /** Called by the renderer on load: a renderer that can ask has really started. */
  status(): { sourceConfigured: boolean; job?: ModifyJob } {
    const restarting = this.#jobs.find((j) => j.status === "restarting");
    if (restarting) this.#confirmHealthy(restarting);
    const job = this.#jobs.findLast((j) => j.status !== "discarded");
    return { sourceConfigured: this.#source !== undefined, ...(job ? { job } : {}) };
  }

  #confirmHealthy(job: ModifyJob): void {
    writeFileSync(join(this.#dir(job.jobId), "healthy"), "");
    this.#update(job.jobId, { status: "applied", message: "새 앱이 정상적으로 시작되었습니다." });
  }

  async chooseSource(): Promise<boolean> {
    const picked = await this.#o.chooseFolder();
    if (picked === undefined) return this.#source !== undefined;
    const top = (await git(picked, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
    if (top === "" || realpathSync(top) !== realpathSync(this.#o.expectedSource)) {
      fail("SCOPE_VIOLATION", "지금 실행 중인 앱의 소스 폴더만 선택할 수 있습니다.");
    }
    this.#source = realpathSync(top);
    this.#save();
    return true;
  }

  #sourceRoot(): string {
    return this.#source ?? fail("INVALID_REQUEST", "먼저 앱 소스 폴더를 선택해 주세요.");
  }

  async #requireClean(source: string, head: string): Promise<void> {
    if ((await git(source, ["rev-parse", "HEAD"])).trim() !== head) fail("INVALID_REQUEST", "소스가 작업 시작 후 바뀌었습니다. 버리고 다시 요청해 주세요.");
    if ((await git(source, ["status", "--porcelain"])).trim() !== "") fail("INVALID_REQUEST", "소스 폴더에 커밋되지 않은 변경이 있습니다. 정리한 뒤 다시 시도해 주세요.");
  }

  async start({ requestId, prompt }: { requestId: string; prompt: string }): Promise<ModifyJob> {
    const repeated = this.#jobs.find((j) => j.requestId === requestId);
    if (repeated) return repeated;
    const source = this.#sourceRoot();
    if (this.#jobs.some((j) => OPEN.has(j.status))) fail("RUN_ALREADY_ACTIVE", "진행 중이거나 정리하지 않은 수정 작업이 있습니다.");
    const head = (await git(source, ["rev-parse", "HEAD"])).trim();
    await this.#requireClean(source, head);
    // A second click can arrive during the awaits above.
    if (this.#jobs.some((j) => OPEN.has(j.status))) fail("RUN_ALREADY_ACTIVE", "진행 중이거나 정리하지 않은 수정 작업이 있습니다.");
    if (!await this.#o.confirm("AI에게 앱 코드 수정을 맡길까요?", prompt, "수정 시작")) fail("INVALID_REQUEST", "수정을 시작하지 않았습니다.");

    const jobId = this.#newId();
    const now = this.#now();
    const job = ModifyJob.parse({ jobId, requestId, prompt, status: "editing", baseCommit: head, explanation: "", files: [], diff: "", diffTruncated: false, warnings: [], verifyLog: "", createdAt: now, updatedAt: now });
    this.#jobs.push(job);
    this.#save();
    const worktree = this.#worktree(jobId);
    mkdirSync(this.#dir(jobId), { recursive: true });
    try {
      await git(source, ["worktree", "add", "--quiet", "--detach", worktree, head]);
    } catch {
      return this.#update(jobId, { status: "failed", errorCode: "INTERNAL", message: "작업 폴더를 만들지 못했습니다." });
    }
    const gitLink = readFileSync(join(worktree, ".git"), "utf8");
    const abort = new AbortController();
    this.#abort = abort;
    const outcome = await this.#o.startCli({
      runId: this.#newId(), appSessionId: jobId, mode: "app_modify", cliSessionId: this.#newId(),
      resume: false, workspacePath: worktree, prompt: buildModifyPrompt(prompt),
    }, abort.signal).catch((): StartOutcome => ({ ok: false, error: AppError.parse({ code: "INTERNAL", message: "실행을 시작하지 못했습니다.", retryable: false }) }));
    if (!outcome.ok) {
      this.#abort = undefined;
      return this.#update(jobId, abort.signal.aborted ? { status: "cancelled" } : { status: "failed", errorCode: outcome.error.code, message: outcome.error.message });
    }
    void this.#pump(jobId, gitLink, outcome.events);
    return this.#job(jobId);
  }

  async #pump(jobId: string, gitLink: string, events: AsyncIterable<RunEvent>): Promise<void> {
    let explanation = "";
    let done = false;
    try {
      for await (const event of events) {
        if (event.type === "text.delta") explanation = (explanation + event.payload.text).slice(0, EXPLANATION_LIMIT);
        else if (event.type === "run.failed") { done = true; this.#update(jobId, { status: "failed", explanation, errorCode: event.payload.error.code, message: event.payload.error.message }); }
        else if (event.type === "run.cancelled") { done = true; this.#update(jobId, { status: "cancelled", explanation }); }
        else if (event.type === "run.completed") { done = true; this.#update(jobId, { explanation }); await this.#collect(jobId, gitLink); }
      }
      if (!done) this.#update(jobId, { status: "interrupted", explanation, message: "실행이 끝나지 않고 멈췄습니다." });
    } catch {
      this.#update(jobId, { status: "failed", errorCode: "INTERNAL", message: "변경 내용을 읽지 못했습니다." });
    } finally {
      this.#abort = undefined;
    }
  }

  /** Reads what the CLI left behind. Anything `git diff` would not show stops the job here. */
  async #collect(jobId: string, gitLink: string): Promise<void> {
    const worktree = this.#worktree(jobId);
    const rejected = (message: string) => this.#update(jobId, { status: "failed", errorCode: "SCOPE_VIOLATION", message });
    // Rewriting this link would point every later git call at a repository of the AI's choosing.
    if (readFileSync(join(worktree, ".git"), "utf8") !== gitLink) return void rejected("허용되지 않은 저장소 설정 변경이 있어 중단했습니다.");
    const { baseCommit } = this.#job(jobId);
    await git(worktree, ["add", "-A"]);
    const ignored = (await git(worktree, ["status", "--porcelain", "--ignored"])).split("\n").filter((l) => l.startsWith("!!"));
    if (ignored.length) return void rejected("diff에 나타나지 않는 파일이 만들어져 중단했습니다.");
    const raw = (await git(worktree, ["diff", "--cached", "--raw", "--no-abbrev", "--no-renames", "-z", baseCommit])).split("\0").filter(Boolean);
    if (raw.length === 0) return void this.#update(jobId, { status: "no_changes", message: "변경된 파일이 없습니다." });
    const files: ModifyJob["files"] = [];
    for (let i = 0; i < raw.length; i += 2) {
      // ":<old mode> <new mode> <old sha> <new sha> <status>"
      const [, mode = "", , , status = ""] = raw[i]!.split(" ");
      const path = raw[i + 1]!;
      if (status === "D") return void rejected("파일 삭제는 허용되지 않아 중단했습니다.");
      if (!/^1006[0-9]{2}$/.test(mode)) return void rejected("일반 파일이 아닌 항목이 있어 중단했습니다.");
      files.push({ path, change: status === "A" ? "added" : "modified" });
    }
    const fullDiff = await git(worktree, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", baseCommit]);
    await git(worktree, ["-c", "user.name=LearningXXX app modifier", "-c", "user.email=app-modifier@learningxxx.invalid", "commit", "--quiet", "--no-verify", "-m", `app-modify: ${this.#job(jobId).prompt.slice(0, 60).replaceAll("\n", " ")}`]);
    const commit = (await git(worktree, ["rev-parse", "HEAD"])).trim();
    await git(worktree, ["update-ref", this.#ref(jobId), commit]);
    const warnings = [...new Set(files.flatMap(({ path }) => SENSITIVE.filter(([pattern]) => pattern.test(path)).map(([, text]) => text)))];
    this.#update(jobId, { status: "review", commit, files, warnings, diff: fullDiff.slice(0, DIFF_LIMIT), diffTruncated: fullDiff.length > DIFF_LIMIT });
  }

  cancel(jobId: string): ModifyJob {
    const job = this.#job(jobId);
    if (job.status === "editing" || job.status === "verifying") this.#abort?.abort();
    return job;
  }

  async verify(jobId: string): Promise<ModifyJob> {
    const job = this.#job(jobId);
    if (job.status !== "review" && job.status !== "verify_failed") fail("INVALID_REQUEST", "지금은 검증할 수 없습니다.");
    const source = this.#sourceRoot();
    const dir = this.#dir(jobId);
    const snapshotDir = join(dir, "snapshot");
    const outDir = join(dir, "out");
    rmSync(snapshotDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(snapshotDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    this.#update(jobId, { status: "verifying", verifyLog: "" });
    const abort = new AbortController();
    this.#abort = abort;
    try {
      // A plain clone of one commit: no link back to the user's repository enters the container.
      await git(snapshotDir, ["init", "--quiet"]);
      await git(snapshotDir, ["fetch", "--quiet", "--depth", "1", source, this.#ref(jobId)]);
      await git(snapshotDir, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
      const dockerfile = await git(source, ["show", `${job.baseCommit}:infra/dev/Dockerfile`]);
      const result = await this.#o.verifier({ jobId, baseCommit: job.baseCommit, dockerfile, snapshotDir, outDir, signal: abort.signal });
      const built = OUT_ENTRIES.every((entry) => existsSync(join(outDir, entry)));
      if (abort.signal.aborted) return this.#update(jobId, { status: "review", verifyLog: result.log, message: "검증을 취소했습니다." });
      if (!result.ok || !built) return this.#update(jobId, { status: "verify_failed", verifyLog: result.log, message: "검증에 실패했습니다. 현재 앱과 소스는 그대로입니다." });
      return this.#update(jobId, { status: "verified", verifyLog: result.log, message: "검증을 통과했습니다." });
    } catch {
      return this.#update(jobId, { status: "verify_failed", message: "검증을 실행하지 못했습니다. 현재 앱과 소스는 그대로입니다." });
    } finally {
      this.#abort = undefined;
      rmSync(snapshotDir, { recursive: true, force: true });
    }
  }

  async apply(jobId: string): Promise<ModifyJob> {
    const job = this.#job(jobId);
    if (job.status !== "verified" || job.commit === undefined) fail("INVALID_REQUEST", "검증을 통과한 변경만 적용할 수 있습니다.");
    const source = this.#sourceRoot();
    await this.#requireClean(source, job.baseCommit);
    const detail = [...job.files.map((f) => f.path), ...job.warnings].join("\n");
    if (!await this.#o.confirm("이 변경을 적용하고 앱을 다시 시작할까요?", detail, "적용 후 재시작")) return job;
    await this.#requireClean(source, job.baseCommit);

    const dir = this.#dir(jobId);
    const restores = BUILDS.map((build, index) => ({ target: join(source, build), backup: join(dir, "backup", String(index)) }));
    for (const { target, backup } of restores) {
      if (!existsSync(target)) fail("INVALID_REQUEST", "현재 앱 빌드를 찾을 수 없어 되돌릴 수 없습니다. 적용하지 않았습니다.");
      rmSync(backup, { recursive: true, force: true });
      cpSync(target, backup, { recursive: true });
    }
    await git(source, ["merge", "--quiet", "--ff-only", job.commit]);
    try {
      for (const [index, { target }] of restores.entries()) {
        rmSync(target, { recursive: true, force: true });
        cpSync(join(dir, "out", index === 0 ? "host/dist" : "ui/dist"), target, { recursive: true });
      }
    } catch {
      this.#restore(restores);
      await git(source, ["reset", "--quiet", "--keep", job.baseCommit]);
      return this.#update(jobId, { status: "verified", message: "적용하지 못해 이전 상태로 되돌렸습니다." });
    }
    const plan: RestartPlan = {
      parentPid: process.pid, ...this.#o.launch, sourceRoot: source, restores,
      previousCommit: job.baseCommit, appliedCommit: job.commit,
      healthyPath: join(dir, "healthy"), rolledBackPath: join(dir, "rolled-back.json"),
      timeoutMs: this.#o.healthTimeoutMs ?? 90_000,
    };
    const planPath = join(dir, "restart.json");
    writeFileSync(planPath, JSON.stringify(plan));
    const updated = this.#update(jobId, { status: "restarting", message: "새 앱으로 다시 시작합니다." });
    this.#o.restart(planPath);
    return updated;
  }

  #restore(restores: { target: string; backup: string }[]): void {
    for (const { target, backup } of restores) {
      rmSync(target, { recursive: true, force: true });
      cpSync(backup, target, { recursive: true });
    }
  }

  /** Puts back the last good build and source after a change turned out to be unwanted. */
  async rollback(jobId: string): Promise<ModifyJob> {
    const job = this.#job(jobId);
    if (job.status !== "applied" || job.commit === undefined) fail("INVALID_REQUEST", "적용된 변경만 되돌릴 수 있습니다.");
    const source = this.#sourceRoot();
    await this.#requireClean(source, job.commit);
    if (!await this.#o.confirm("이 변경 전으로 되돌리고 앱을 다시 시작할까요?", job.prompt, "되돌리기")) return job;
    const plan = RestartPlanFile.parse(JSON.parse(readFileSync(join(this.#dir(jobId), "restart.json"), "utf8")));
    this.#restore(plan.restores);
    await git(source, ["reset", "--quiet", "--keep", job.baseCommit]);
    const updated = this.#update(jobId, { status: "rolled_back", message: "이전 앱과 소스로 되돌렸습니다." });
    // Already the known good build, so the watchdog only has to start it.
    writeFileSync(plan.healthyPath, "");
    const planPath = join(this.#dir(jobId), "restart.json");
    writeFileSync(planPath, JSON.stringify({ ...plan, parentPid: process.pid }));
    this.#o.restart(planPath);
    return updated;
  }

  /** Removes only this job's own worktree and ref. The user's source is not involved. */
  async discard(jobId: string): Promise<ModifyJob> {
    const job = this.#job(jobId);
    if (IN_MOTION.has(job.status)) fail("RUN_ALREADY_ACTIVE", "진행 중인 작업은 먼저 취소해 주세요.");
    if (job.status === "discarded") return job;
    const source = this.#sourceRoot();
    await git(source, ["worktree", "remove", "--force", this.#worktree(jobId)]).catch(() => undefined);
    await git(source, ["update-ref", "-d", this.#ref(jobId)]).catch(() => undefined);
    rmSync(this.#dir(jobId), { recursive: true, force: true });
    await git(source, ["worktree", "prune"]).catch(() => undefined);
    return this.#update(jobId, { status: "discarded" });
  }
}

const RestartPlanFile = z.looseObject({
  restores: z.array(z.object({ target: z.string(), backup: z.string() })),
  healthyPath: z.string(),
});
