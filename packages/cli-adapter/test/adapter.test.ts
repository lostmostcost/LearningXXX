import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AppError, RunEvent, checkEventStream } from "@learningxxx/contracts";
import * as A from "../src/index.ts";

const FAKE_SOURCE = readFileSync(join(import.meta.dirname, "fake-claude.mjs"), "utf8");
const TOOLCHAIN = JSON.parse(readFileSync(join(import.meta.dirname, "../../../infra/dev/toolchain.json"), "utf8"));

interface Fixture {
  root: string;
  cli: string;
  home: string;
  record: string;
  independent: string;
  course: string;
  outside: string;
}

function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wbs014-")));
  const home = join(root, "home");
  const cli = join(home, ".local/bin/claude");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(cli, `#!${process.execPath}\n${FAKE_SOURCE}`);
  chmodSync(cli, 0o755);
  const independent = join(root, "data/sessions", randomUUID());
  const course = join(root, "data/courses/logic-circuits");
  const outside = join(root, "outside");
  for (const d of [independent, course, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "SYNTHETIC-CANARY\n");
  return { root, cli, home, record: join(root, "record.jsonl"), independent, course, outside };
}

const env = (f: Fixture, scenario: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: "/usr/bin:/bin",
  HOME: f.home,
  FAKE_SCENARIO: scenario,
  FAKE_RECORD: f.record,
  ...extra,
});

const request = (f: Fixture, over: Partial<A.RunRequest> = {}): A.RunRequest => ({
  runId: randomUUID(),
  appSessionId: randomUUID(),
  mode: "independent",
  cliSessionId: randomUUID(),
  resume: false,
  workspacePath: f.independent,
  prompt: "hello",
  ...over,
});

const invocations = (f: Fixture) =>
  existsSync(f.record)
    ? readFileSync(f.record, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; stdin: string; cwd: string; claudecode: string | null })
    : [];

async function collect(outcome: A.StartOutcome): Promise<RunEvent[]> {
  assert.ok(outcome.ok, outcome.ok ? "" : `start failed: ${outcome.error.code}`);
  const events: RunEvent[] = [];
  for await (const e of outcome.events) events.push(e);
  for (const e of events) RunEvent.parse(e);
  assert.deepEqual(checkEventStream(events), []);
  return events;
}

async function run(f: Fixture, scenario: string, over: Partial<A.RunRequest> = {}, opts: Partial<A.RunOptions> = {}) {
  return A.startRun(request(f, over), { cliPath: f.cli, env: env(f, scenario), ...opts });
}

function startError(outcome: A.StartOutcome): AppError {
  assert.ok(!outcome.ok, "expected start failure");
  return AppError.parse(outcome.error);
}

const last = (events: RunEvent[]) => events[events.length - 1]!;
const text = (events: RunEvent[]) => events.flatMap((e) => (e.type === "text.delta" ? [e.payload.text] : [])).join("");

describe("argument policy", () => {
  it("independent sessions carry the full WBS-002 isolation flag set and no prompt", () => {
    const id = randomUUID();
    const args = A.buildArgs({ mode: "independent", cliSessionId: id, resume: false, attachmentDirs: ["/a"] });
    for (const flag of ["-p", "--restricted", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands"]) {
      assert.ok(args.includes(flag), flag);
    }
    assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.equal(args[args.indexOf("--tools") + 1], "Read,Glob,Grep");
    assert.equal(args[args.indexOf("--add-dir") + 1], "/a");
    assert.deepEqual(args.slice(-2), ["--session-id", id]);
    assert.ok(!args.includes("--resume") && !args.includes("--bare"));
  });

  it("course sessions resume their own CLI session with write tools but no Bash", () => {
    const id = randomUUID();
    const args = A.buildArgs({ mode: "course", cliSessionId: id, resume: true, attachmentDirs: [] });
    assert.deepEqual(args.slice(-2), ["--resume", id]);
    assert.ok(args.includes("--restricted") && args.includes("--strict-mcp-config"));
    assert.ok(!args.join(" ").includes("Bash"));
  });

  it("only a course session passes its course brief, as a system prompt file", () => {
    const id = randomUUID();
    const course = A.buildArgs({ mode: "course", cliSessionId: id, resume: true, attachmentDirs: [], contextFile: "/c/brief.md" });
    assert.equal(course[course.indexOf("--append-system-prompt-file") + 1], "/c/brief.md");
    const independent = A.buildArgs({ mode: "independent", cliSessionId: id, resume: false, attachmentDirs: [], contextFile: "/c/brief.md" });
    assert.ok(!independent.includes("--append-system-prompt-file"));
  });

  it("refuses a context file for an independent session before anything starts", async () => {
    const f = fixture();
    const brief = join(f.root, "brief.md");
    writeFileSync(brief, "course");
    assert.equal(startError(await run(f, "ok", { contextFile: brief })).code, "ISOLATION_VIOLATION");
    assert.deepEqual(invocations(f), []);
  });

  it("verified CLI version matches the WBS-005 toolchain pin", () => {
    assert.equal(A.VERIFIED_CLI_VERSIONS.at(-1), TOOLCHAIN.claude_cli.verified);
  });

  it("detects forbidden credential variables by name only", () => {
    assert.deepEqual(A.findForbiddenEnv({ ANTHROPIC_API_KEY: "sk-synthetic", CLAUDE_CODE_USE_VERTEX: "1", PATH: "/bin" }), [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_USE_VERTEX",
    ]);
    assert.deepEqual(A.findForbiddenEnv({ ANTHROPIC_API_KEY: "" }), []);
  });
});

describe("normal runs", () => {
  it("streams text from stdin prompt, validates every event and spawns once", async () => {
    const f = fixture();
    const req = request(f, { prompt: "--version is not a flag here" });
    const events = await collect(await A.startRun(req, { cliPath: f.cli, env: env(f, "ok") }));
    assert.equal(events[0]!.type, "run.started");
    assert.equal(last(events).type, "run.completed");
    // Partial deltas are used once; a message without partials falls back to its full text.
    assert.equal(text(events), "echo:--version is not a flag here (unstreamed)");
    const [call, ...rest] = invocations(f);
    assert.equal(rest.length, 0);
    assert.equal(call!.stdin, req.prompt);
    assert.ok(!call!.argv.includes(req.prompt));
    assert.equal(call!.cwd, realpathSync(f.independent));
  });

  it("course resume passes --resume and completes", async () => {
    const f = fixture();
    const cliSessionId = randomUUID();
    const events = await collect(await run(f, "ok", { mode: "course", workspacePath: f.course, resume: true, cliSessionId }));
    assert.equal(last(events).type, "run.completed");
    const started = events[0]!;
    assert.ok(started.type === "run.started" && started.payload.cliSessionId === cliSessionId);
    assert.ok(invocations(f)[0]!.argv.includes("--resume"));
  });

  it("does not pass the host's own Claude Code session variables to the child", async () => {
    const f = fixture();
    await collect(await A.startRun(request(f), { cliPath: f.cli, env: env(f, "ok", { CLAUDECODE: "1" }) }));
    assert.equal(invocations(f)[0]!.claudecode, null);
  });

  it("reports written files as artifacts relative to the workspace", async () => {
    const f = fixture();
    const events = await collect(await run(f, "write_file", { mode: "course", workspacePath: f.course }));
    const artifacts = events.flatMap((e) => (e.type === "artifact.created" ? [e.payload] : []));
    assert.deepEqual(artifacts, [
      { outputKey: "notes/summary.md", operation: "created" },
      { outputKey: "notes/summary.md", operation: "modified" },
    ]);
    assert.equal(last(events).type, "run.completed");
  });
});

describe("external folders the user granted", () => {
  it("allows writing there, reports the file, and adds the folder to the CLI", async () => {
    const f = fixture();
    const opts = { cliPath: f.cli, env: env(f, "write_external", { FAKE_EXTERNAL: f.outside }) };
    const outcome = await A.startRun(request(f, { mode: "course", workspacePath: f.course, writableDirs: [f.outside] }), opts);
    const events = await collect(outcome);
    assert.deepEqual(
      events.flatMap((e) => (e.type === "artifact.created" ? [e.payload.outputKey] : [])),
      ["external-0/report.md"],
    );
    assert.equal(last(events).type, "run.completed");
    assert.ok(invocations(f)[0]?.argv.includes(f.outside));
  });

  it("treats a decomposed Korean folder name as the same folder on macOS", { skip: process.platform !== "darwin" }, async () => {
    const f = fixture();
    const granted = join(f.root, "무제 폴더".normalize("NFD"));
    mkdirSync(granted);
    const opts = { cliPath: f.cli, env: env(f, "write_external", { FAKE_EXTERNAL: granted.normalize("NFC") }) };
    const events = await collect(await A.startRun(request(f, { mode: "course", workspacePath: f.course, writableDirs: [granted] }), opts));
    assert.deepEqual(
      events.flatMap((e) => (e.type === "artifact.created" ? [e.payload.outputKey] : [])),
      ["external-0/report.md"],
    );
    assert.equal(last(events).type, "run.completed");
  });

  it("stops the run when that folder was not granted", async () => {
    const f = fixture();
    const opts = { cliPath: f.cli, env: env(f, "write_external", { FAKE_EXTERNAL: f.outside }) };
    const events = await collect(await A.startRun(request(f, { mode: "course", workspacePath: f.course }), opts));
    const end = last(events);
    assert.equal(end.type, "run.failed");
    if (end.type === "run.failed") assert.equal(end.payload.error.code, "SCOPE_VIOLATION");
  });

  it("is refused for an independent session before anything starts", async () => {
    const f = fixture();
    const outcome = await run(f, "normal", { writableDirs: [f.outside] });
    assert.equal(startError(outcome).code, "ISOLATION_VIOLATION");
    assert.deepEqual(invocations(f), []);
  });
});

describe("no fallback: each failure is explained and nothing is retried", () => {
  it("refuses forbidden credential variables before spawning, without echoing values", async () => {
    const f = fixture();
    const outcome = await A.startRun(request(f), { cliPath: f.cli, env: env(f, "ok", { ANTHROPIC_API_KEY: "sk-synthetic-123" }) });
    const error = startError(outcome);
    assert.equal(error.code, "FORBIDDEN_CREDENTIAL_ENV");
    assert.ok(!JSON.stringify(error).includes("sk-synthetic-123"));
    assert.equal(invocations(f).length, 0);
  });

  const preStart: [string, string][] = [
    ["api_key", "FORBIDDEN_CREDENTIAL_ENV"],
    ["session_not_found", "SESSION_NOT_FOUND"],
    ["unknown_option", "CLI_VERSION_MISMATCH"],
  ];
  for (const [scenario, code] of preStart) {
    it(`${scenario} → ${code} before run.started`, async () => {
      const f = fixture();
      assert.equal(startError(await run(f, scenario)).code, code);
      assert.equal(invocations(f).length, 1);
    });
  }

  const midRun: [string, string, boolean][] = [
    ["auth_expired", "CLI_AUTH_REQUIRED", false],
    ["usage_limit", "USAGE_LIMIT", true],
    ["crash", "INTERNAL", false],
  ];
  for (const [scenario, code, retryable] of midRun) {
    it(`${scenario} → run.failed ${code}`, async () => {
      const f = fixture();
      const events = await collect(await run(f, scenario));
      const end = last(events);
      assert.ok(end.type === "run.failed");
      assert.equal(end.payload.error.code, code);
      assert.equal(end.payload.error.retryable, retryable);
      assert.equal(invocations(f).length, 1);
      if (code === "USAGE_LIMIT") assert.equal(end.payload.error.retryAfter, new Date(1793534400 * 1000).toISOString().replace(".000", ""));
    });
  }

  it("missing CLI → CLI_NOT_INSTALLED", async () => {
    const f = fixture();
    const outcome = await A.startRun(request(f), { cliPath: join(f.root, "nope/claude"), env: env(f, "ok") });
    assert.equal(startError(outcome).code, "CLI_NOT_INSTALLED");
  });

  it("masks home and workspace paths in diagnostics", async () => {
    const f = fixture();
    const lines: string[] = [];
    await collect(await run(f, "crash", {}, { onDiagnostic: (l) => lines.push(l) }));
    assert.ok(lines.some((l) => l.includes("<home>/private/thing")));
    assert.ok(!lines.some((l) => l.includes(f.home)));
  });
});

describe("isolation and scope checks on the CLI's init event", () => {
  const cases: [string, A.Mode, string][] = [
    ["extra_mcp", "independent", "ISOLATION_VIOLATION"],
    ["extra_tool", "independent", "ISOLATION_VIOLATION"],
    ["extra_tool", "course", "SCOPE_VIOLATION"],
    ["wrong_session", "independent", "ISOLATION_VIOLATION"],
    ["old_version", "independent", "CLI_VERSION_MISMATCH"],
  ];
  for (const [scenario, mode, code] of cases) {
    it(`${mode} ${scenario} → ${code}, process stopped before output`, async () => {
      const f = fixture();
      const t0 = Date.now();
      const outcome = await run(f, scenario, { mode, workspacePath: mode === "course" ? f.course : f.independent });
      assert.equal(startError(outcome).code, code);
      assert.ok(Date.now() - t0 < 4000, "child was killed instead of running to the end");
    });
  }

  it("course sessions accept an unverified CLI version", async () => {
    const f = fixture();
    const events = await collect(await run(f, "old_version", { mode: "course", workspacePath: f.course }));
    assert.equal(last(events).type, "run.completed");
  });

  it("independent workspace must be named by a UUID, checked before spawning", async () => {
    const f = fixture();
    assert.equal(startError(await run(f, "ok", { workspacePath: f.course })).code, "ISOLATION_VIOLATION");
    assert.equal(invocations(f).length, 0);
  });
});

describe("tool scope guard", () => {
  it("an outside read the CLI denied is reported as denied without leaking the path", async () => {
    const f = fixture();
    const events = await collect(await run(f, "outside_denied"));
    const tool = events.find((e) => e.type === "tool.requested");
    assert.ok(tool?.type === "tool.requested");
    assert.equal(tool.payload.decision, "denied");
    assert.deepEqual(tool.payload.targetKeys, ["<outside>"]);
    assert.equal(last(events).type, "run.completed");
    assert.ok(!JSON.stringify(events).includes("/etc/hosts"));
  });

  for (const scenario of ["outside_executed", "symlink_executed"]) {
    it(`${scenario}: an outside read that succeeded stops the run`, async () => {
      const f = fixture();
      symlinkSync(f.outside, join(f.independent, "escape"));
      const t0 = Date.now();
      const events = await collect(await run(f, scenario));
      const end = last(events);
      assert.ok(end.type === "run.failed");
      assert.equal(end.payload.error.code, "ISOLATION_VIOLATION");
      assert.ok(Date.now() - t0 < 4000);
      assert.ok(!JSON.stringify(events).includes("SYNTHETIC-CANARY"));
    });
  }
});

describe("cancellation", () => {
  async function cancelAfterFirstText(f: Fixture, scenario: string, killGraceMs: number) {
    const controller = new AbortController();
    const outcome = await run(f, scenario, { mode: "course", workspacePath: f.course }, { signal: controller.signal, killGraceMs });
    assert.ok(outcome.ok);
    const events: RunEvent[] = [];
    for await (const e of outcome.events) {
      events.push(e);
      if (e.type === "text.delta") controller.abort();
    }
    assert.deepEqual(checkEventStream(events), []);
    return events;
  }

  it("SIGTERM stops the process and reports files it already wrote", async () => {
    const end = last(await cancelAfterFirstText(fixture(), "slow", 3000));
    assert.ok(end.type === "run.cancelled");
    assert.deepEqual(end.payload, { processExited: true, artifactsWritten: ["draft.md"] });
  });

  it("a process ignoring SIGTERM is killed after the grace period", async () => {
    const t0 = Date.now();
    const end = last(await cancelAfterFirstText(fixture(), "stubborn", 200));
    assert.ok(end.type === "run.cancelled" && end.payload.processExited);
    assert.ok(Date.now() - t0 < 3000);
  });

  it("an already-aborted signal never spawns", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    assert.equal(startError(await run(f, "ok", {}, { signal: controller.signal })).code, "RUN_INTERRUPTED");
    assert.equal(invocations(f).length, 0);
  });
});

describe("locate and probe (Finder launch has no shell PATH)", () => {
  it("finds the official install location when PATH lacks it", () => {
    const f = fixture();
    const found = A.locateCli({ PATH: "/usr/bin:/bin" }, f.home);
    assert.ok(found.ok && found.path === f.cli);
  });

  it("skips non-executable files and reports CLI_NOT_INSTALLED", () => {
    const f = fixture();
    chmodSync(f.cli, 0o644);
    const found = A.locateCli({ PATH: "" }, f.home);
    assert.ok(!found.ok && found.error.code === "CLI_NOT_INSTALLED");
  });

  it("accepts only a claude.ai subscription login and keeps no e-mail", async () => {
    const f = fixture();
    const ok = await A.probeCli(f.cli, env(f, "ok"));
    assert.ok(ok.ok && ok.probe.versionVerified && ok.probe.authMethod === "claude.ai");
    assert.ok(!JSON.stringify(ok).includes("example.test") && !JSON.stringify(ok).includes("org-synthetic"));
    for (const scenario of ["logged_out", "api_key_auth"]) {
      const bad = await A.probeCli(f.cli, env(f, scenario));
      assert.ok(!bad.ok && bad.error.code === "CLI_AUTH_REQUIRED", scenario);
    }
  });

  it("flags an unverified version and refuses forbidden variables", async () => {
    const f = fixture();
    const newer = await A.probeCli(f.cli, env(f, "ok", { FAKE_VERSION: "2.2.0" }));
    assert.ok(newer.ok && newer.probe.version === "2.2.0" && !newer.probe.versionVerified);
    const forbidden = await A.probeCli(f.cli, env(f, "ok", { CLAUDE_CODE_OAUTH_TOKEN: "synthetic" }));
    assert.ok(!forbidden.ok && forbidden.error.code === "FORBIDDEN_CREDENTIAL_ENV");
  });
});

describe("classifyFailure", () => {
  const cases: [Partial<A.FailureSignals>, string][] = [
    [{ stderr: "No conversation found with session ID: x" }, "SESSION_NOT_FOUND"],
    [{ resultText: "Invalid API key · Fix external API key" }, "CLI_AUTH_REQUIRED"],
    [{ resultText: "Not logged in · Please run /login" }, "CLI_AUTH_REQUIRED"],
    [{ resultText: "Claude usage limit reached" }, "USAGE_LIMIT"],
    [{ stderr: "error: unknown option '--restricted'" }, "CLI_VERSION_MISMATCH"],
    [{ stderr: "segfault" }, "INTERNAL"],
  ];
  for (const [signals, code] of cases) {
    it(code, () => {
      const error = A.classifyFailure({ exitCode: 1, stderr: "", ...signals });
      assert.equal(AppError.parse(error).code, code);
    });
  }
});


describe("read-only confirmed attachment boundary", () => {
  it("reads only explicitly granted copies", async () => {
    const f = fixture();
    const events = await collect(await run(f, "attachment_read", { attachmentDirs: [f.outside] }));
    assert.equal(last(events).type, "run.completed");
    assert.match(text(events), /SYNTHETIC-CANARY/);
  });
  it("rejects a successful write report for an attachment even in a course session", async () => {
    const f = fixture();
    writeFileSync(join(f.outside, "input.txt"), "original");
    const events = await collect(await run(f, "write_attachment", { mode: "course", workspacePath: f.course, attachmentDirs: [f.outside] }));
    const end = last(events);
    assert.equal(end.type, "run.failed");
    if (end.type === "run.failed") assert.equal(end.payload.error.code, "SCOPE_VIOLATION");
    assert.equal(readFileSync(join(f.outside, "input.txt"), "utf8"), "original");
  });
});
