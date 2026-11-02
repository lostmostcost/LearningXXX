import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { RunEvent } from "@learningxxx/contracts";
import type { RunRequest, StartOutcome } from "@learningxxx/cli-adapter";
import { AppModifier, WATCHDOG_SOURCE, createDockerVerifier, verifyCommand, type AppModifierOptions, type Verifier } from "../src/index.ts";
import { buildModifyPrompt } from "../src/modifier.ts";

const temp = mkdtempSync(join(tmpdir(), "modifier-"));
after(() => spawnSync("rm", ["-rf", temp]));
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function makeSource(): string {
  const dir = mkdtempSync(join(temp, "src-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "user.email", "t@example.test");
  writeFileSync(join(dir, ".gitignore"), "dist/\nnode_modules/\n");
  writeFileSync(join(dir, "a.txt"), "before\n");
  mkdirSync(join(dir, "infra/dev"), { recursive: true });
  writeFileSync(join(dir, "infra/dev/Dockerfile"), "FROM scratch # base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  for (const name of ["apps/desktop/host/dist", "apps/desktop/ui/dist"]) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "marker"), "old");
  }
  return dir;
}

type Edit = (workspace: string) => void;
function fakeCli(edit: Edit, end: "completed" | "failed" = "completed") {
  const requests: RunRequest[] = [];
  const startCli = async (request: RunRequest): Promise<StartOutcome> => {
    requests.push(request);
    async function* events() {
      const base = { schemaVersion: 1, eventId: uuid(), runId: request.runId, seq: 0, occurredAt: "2026-11-01T00:00:00Z" };
      yield { ...base, type: "text.delta", payload: { text: "문구를 바꿨습니다." } } as RunEvent;
      edit(request.workspacePath);
      if (end === "completed") yield { ...base, type: "run.completed", payload: { exitCode: 0 } } as RunEvent;
      else yield { ...base, type: "run.failed", payload: { error: { code: "USAGE_LIMIT", message: "한도", retryable: true } } } as RunEvent;
    }
    return { ok: true, events: events() };
  };
  return { requests, startCli };
}

const passing: Verifier = async ({ outDir }) => {
  mkdirSync(join(outDir, "host/dist"), { recursive: true });
  mkdirSync(join(outDir, "ui/dist"), { recursive: true });
  writeFileSync(join(outDir, "host/dist/main.cjs"), "new");
  writeFileSync(join(outDir, "ui/dist/index.html"), "new");
  return { ok: true, log: "ok" };
};

async function setup(edit: Edit, overrides: Partial<AppModifierOptions> & { end?: "completed" | "failed" } = {}) {
  const source = makeSource();
  const cli = fakeCli(edit, overrides.end);
  const restarts: string[] = [];
  const confirms: string[] = [];
  const options: AppModifierOptions = {
    root: mkdtempSync(join(temp, "root-")), expectedSource: source, startCli: cli.startCli, verifier: passing,
    chooseFolder: async () => source,
    confirm: async (message) => { confirms.push(message); return true; },
    restart: (plan) => restarts.push(plan),
    launch: { execPath: "/bin/true", args: [], cwd: "/" },
    newId: uuid, ...overrides,
  };
  const modifier = new AppModifier(options);
  if ((await options.chooseFolder()) !== undefined) await modifier.chooseSource();
  return { modifier, source, options, cli, restarts, confirms };
}

const settle = async (modifier: AppModifier, jobId: string) => {
  for (let i = 0; i < 200; i += 1) {
    const job = modifier.status().job;
    if (job?.jobId === jobId && job.status !== "editing") return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job did not settle");
};
const change: Edit = (w) => writeFileSync(join(w, "a.txt"), "after\n");
const request = { requestId: "10000000-0000-4000-8000-000000000001", prompt: "문구를 바꿔줘" };

test("a request edits a separate worktree and leaves the source alone", async () => {
  const { modifier, source, cli, confirms } = await setup(change);
  const job = await settle(modifier, (await modifier.start(request)).jobId);
  assert.equal(job.status, "review");
  assert.deepEqual(job.files, [{ path: "a.txt", change: "modified" }]);
  assert.match(job.diff, /\+after/);
  assert.equal(job.explanation, "문구를 바꿨습니다.");
  assert.equal(readFileSync(join(source, "a.txt"), "utf8"), "before\n");
  assert.equal(cli.requests[0]!.mode, "app_modify");
  assert.notEqual(cli.requests[0]!.workspacePath, source);
  assert.equal(confirms.length, 1);
});

test("the prompt carries the user's words and no other context", async () => {
  const { modifier, cli } = await setup(change);
  await settle(modifier, (await modifier.start(request)).jobId);
  assert.equal(cli.requests[0]!.prompt, buildModifyPrompt(request.prompt));
  assert.equal(cli.requests[0]!.attachmentDirs, undefined);
  assert.equal(cli.requests[0]!.writableDirs, undefined);
});

test("nothing runs when the user declines", async () => {
  const { modifier, cli } = await setup(change, { confirm: async () => false });
  await assert.rejects(modifier.start(request));
  assert.equal(cli.requests.length, 0);
});

test("the same requestId never starts a second run", async () => {
  const { modifier, cli } = await setup(change);
  const first = await modifier.start(request);
  await settle(modifier, first.jobId);
  assert.equal((await modifier.start(request)).jobId, first.jobId);
  assert.equal(cli.requests.length, 1);
});

test("only the running app's own source can be chosen", async () => {
  const other = makeSource();
  let picked: string | undefined;
  const { modifier, source } = await setup(change, { chooseFolder: async () => picked });
  picked = source;
  await modifier.chooseSource();
  picked = other;
  await assert.rejects(modifier.chooseSource(), (e: { appError?: { code: string } }) => e.appError?.code === "SCOPE_VIOLATION");
});

test("a dirty source is refused before the CLI starts", async () => {
  const { modifier, source, cli } = await setup(change);
  writeFileSync(join(source, "a.txt"), "user work\n");
  await assert.rejects(modifier.start(request));
  assert.equal(cli.requests.length, 0);
});

for (const [name, edit, message] of [
  ["a deletion", (w: string) => spawnSync("rm", [join(w, "a.txt")]), /삭제/],
  ["a symlink", (w: string) => spawnSync("ln", ["-s", "/etc/passwd", join(w, "link")]), /일반 파일/],
  ["an ignored file", (w: string) => { mkdirSync(join(w, "dist")); writeFileSync(join(w, "dist/x"), "x"); }, /diff/],
  ["a rewritten .git link", (w: string) => writeFileSync(join(w, ".git"), "gitdir: /tmp/evil\n"), /저장소/],
] as const) {
  test(`${name} stops the job before review`, async () => {
    const { modifier } = await setup(edit);
    const job = await settle(modifier, (await modifier.start(request)).jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.errorCode, "SCOPE_VIOLATION");
    assert.match(job.message ?? "", message);
  });
}

test("changes to runnable configuration are called out", async () => {
  const { modifier } = await setup((w) => writeFileSync(join(w, "package.json"), "{}\n"));
  const job = await settle(modifier, (await modifier.start(request)).jobId);
  assert.equal(job.warnings.length, 1);
});

test("no change ends without a commit to review", async () => {
  const { modifier } = await setup(() => undefined);
  assert.equal((await settle(modifier, (await modifier.start(request)).jobId)).status, "no_changes");
});

test("a CLI failure is reported and blocks apply", async () => {
  const { modifier } = await setup(change, { end: "failed" });
  const job = await settle(modifier, (await modifier.start(request)).jobId);
  assert.equal(job.errorCode, "USAGE_LIMIT");
  await assert.rejects(modifier.apply(job.jobId));
});

test("apply needs a passing verification", async () => {
  const { modifier, restarts } = await setup(change);
  const job = await settle(modifier, (await modifier.start(request)).jobId);
  await assert.rejects(modifier.apply(job.jobId));
  assert.equal(restarts.length, 0);
});

test("verification uses the Dockerfile from the base commit, not the edited one", async () => {
  let seen = "";
  const { modifier } = await setup((w) => writeFileSync(join(w, "infra/dev/Dockerfile"), "FROM evil\n"), {
    verifier: (input) => { seen = input.dockerfile; return passing(input); },
  });
  const job = await settle(modifier, (await modifier.start(request)).jobId);
  await modifier.verify(job.jobId);
  assert.match(seen, /FROM scratch/);
});

test("a failed verification keeps the good app and source", async () => {
  const { modifier, source, restarts } = await setup(change, { verifier: async () => ({ ok: false, log: "TS2322" }) });
  const job = await settle(modifier, (await modifier.start(request)).jobId);
  const verified = await modifier.verify(job.jobId);
  assert.equal(verified.status, "verify_failed");
  assert.equal(verified.verifyLog, "TS2322");
  await assert.rejects(modifier.apply(job.jobId));
  assert.equal(readFileSync(join(source, "a.txt"), "utf8"), "before\n");
  assert.equal(readFileSync(join(source, "apps/desktop/ui/dist/marker"), "utf8"), "old");
  assert.equal(restarts.length, 0);
});

test("apply moves source and builds forward, keeps a backup and hands off to the watchdog", async () => {
  const { modifier, source, restarts } = await setup(change);
  const { jobId, baseCommit } = await settle(modifier, (await modifier.start(request)).jobId);
  await modifier.verify(jobId);
  const applied = await modifier.apply(jobId);
  assert.equal(applied.status, "restarting");
  assert.equal(readFileSync(join(source, "a.txt"), "utf8"), "after\n");
  assert.equal(readFileSync(join(source, "apps/desktop/ui/dist/index.html"), "utf8"), "new");
  assert.equal(restarts.length, 1);
  const plan = JSON.parse(readFileSync(restarts[0]!, "utf8"));
  assert.equal(plan.previousCommit, baseCommit);
  assert.equal(readFileSync(join(plan.restores[0].backup, "marker"), "utf8"), "old");
  assert.equal(modifier.status().job?.status, "applied");
});

test("apply refuses when the source moved after review", async () => {
  const { modifier, source, restarts } = await setup(change);
  const { jobId } = await settle(modifier, (await modifier.start(request)).jobId);
  await modifier.verify(jobId);
  git(source, "commit", "--allow-empty", "-qm", "moved");
  await assert.rejects(modifier.apply(jobId));
  assert.equal(restarts.length, 0);
});

test("rollback restores the source and the last good build", async () => {
  const { modifier, source, restarts } = await setup(change);
  const { jobId, baseCommit } = await settle(modifier, (await modifier.start(request)).jobId);
  await modifier.verify(jobId);
  await modifier.apply(jobId);
  modifier.status();
  const job = await modifier.rollback(jobId);
  assert.equal(job.status, "rolled_back");
  assert.equal(git(source, "rev-parse", "HEAD"), baseCommit);
  assert.equal(readFileSync(join(source, "apps/desktop/host/dist/marker"), "utf8"), "old");
  assert.equal(restarts.length, 2);
});

test("discard removes the job and leaves the source untouched", async () => {
  const { modifier, source } = await setup(change);
  const { jobId, baseCommit } = await settle(modifier, (await modifier.start(request)).jobId);
  assert.equal((await modifier.discard(jobId)).status, "discarded");
  assert.equal(git(source, "rev-parse", "HEAD"), baseCommit);
  assert.doesNotMatch(git(source, "worktree", "list"), /jobs/);
  assert.equal(modifier.status().job, undefined);
});

test("discarding a rolled back job also removes its internal ref", async () => {
  const { modifier, source } = await setup(change);
  const { jobId } = await settle(modifier, (await modifier.start(request)).jobId);
  await modifier.verify(jobId);
  await modifier.apply(jobId);
  modifier.status();
  await modifier.rollback(jobId);
  await modifier.discard(jobId);
  assert.equal(git(source, "for-each-ref", "refs/learningxxx"), "");
});

test("work cut off by a quit is marked interrupted and not resumed", async () => {
  const { modifier, options, cli } = await setup(change);
  const { jobId } = await settle(modifier, (await modifier.start(request)).jobId);
  const path = join(options.root, "state.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.jobs[0].status = "editing";
  writeFileSync(path, JSON.stringify(state));
  const job = new AppModifier(options).status().job;
  assert.equal(job?.jobId, jobId);
  assert.equal(job?.status, "interrupted");
  assert.equal(cli.requests.length, 1);
});

function runWatchdog(appScript: string, timeoutMs: number) {
  const source = makeSource();
  const dir = mkdtempSync(join(temp, "wd-"));
  const previousCommit = git(source, "rev-parse", "HEAD");
  const target = join(source, "apps/desktop/ui/dist");
  const backup = join(dir, "backup");
  execFileSync("cp", ["-R", target, backup]);
  writeFileSync(join(target, "marker"), "new");
  git(source, "commit", "--allow-empty", "-qm", "applied");
  const app = join(dir, "app.sh");
  const launches = join(dir, "launches");
  writeFileSync(app, `#!/bin/sh\necho x >> ${launches}\n${appScript}\n`);
  chmodSync(app, 0o755);
  const plan = { parentPid: 999999, execPath: app, args: [], cwd: dir, sourceRoot: source, restores: [{ target, backup }], previousCommit, appliedCommit: git(source, "rev-parse", "HEAD"), healthyPath: join(dir, "healthy"), rolledBackPath: join(dir, "rolled"), timeoutMs };
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  writeFileSync(join(dir, "w.cjs"), WATCHDOG_SOURCE);
  execFileSync(process.execPath, [join(dir, "w.cjs"), join(dir, "plan.json")], { timeout: 15_000 });
  return { source, dir, target, plan, launches };
}

test("watchdog: a new build that exits restores the last good app and source", () => {
  const { source, target, plan, launches } = runWatchdog("exit 1", 5000);
  assert.equal(readFileSync(join(target, "marker"), "utf8"), "old");
  assert.equal(git(source, "rev-parse", "HEAD"), plan.previousCommit);
  assert.deepEqual(JSON.parse(readFileSync(plan.rolledBackPath, "utf8")), { sourceRestored: true });
  assert.equal(readFileSync(launches, "utf8").trim().split("\n").length >= 1, true);
});

test("watchdog: a new build that hangs without reporting is stopped and restored", () => {
  const { target, plan } = runWatchdog("exec sleep 30", 400);
  assert.equal(readFileSync(join(target, "marker"), "utf8"), "old");
  assert.ok(existsSync(plan.rolledBackPath));
});

test("watchdog: a healthy build is left alone", () => {
  const { target, plan } = runWatchdog('touch "$PWD/healthy"; exec sleep 2', 5000);
  assert.equal(readFileSync(join(target, "marker"), "utf8"), "new");
  assert.equal(existsSync(plan.rolledBackPath), false);
});

test("docker verifier: fixed arguments mount only the snapshot and output, and pass no environment", async () => {
  const dir = mkdtempSync(join(temp, "docker-"));
  const record = join(dir, "calls");
  const fake = join(dir, "docker");
  writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${record}\nenv | grep -c SECRET_FOR_TEST >> ${record}\ncat > /dev/null\nexit 0\n`);
  chmodSync(fake, 0o755);
  process.env.SECRET_FOR_TEST = "x";
  const result = await createDockerVerifier(fake)({ jobId: uuid(), baseCommit: "a".repeat(40), dockerfile: "FROM x", snapshotDir: "/snap", outDir: "/out-dir", signal: new AbortController().signal });
  delete process.env.SECRET_FOR_TEST;
  assert.equal(result.ok, true);
  const calls = readFileSync(record, "utf8");
  assert.equal(calls.match(/ -v \//g)?.length, 2);
  assert.match(calls, /\/snap:\/workspace:ro/);
  assert.doesNotMatch(calls, /compose/);
  assert.doesNotMatch(calls, /^[1-9]$/m);
});

test("docker verifier: no Docker is a failed verification, not a pass", async () => {
  const result = await createDockerVerifier(undefined)({ jobId: uuid(), baseCommit: "a".repeat(40), dockerfile: "", snapshotDir: "", outDir: "", signal: new AbortController().signal });
  assert.equal(result.ok, false);
});

test("the verify command takes nothing from the environment or the changed compose file", () => {
  assert.doesNotMatch(verifyCommand(), /compose|\$/);
});
