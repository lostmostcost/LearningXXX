/**
 * Fixed CLI invocation policy (SPEC-002, ADR-002 결정 5). Flags live in code,
 * never in prompts or user settings: dropping any isolation flag reopens a
 * leak path that WBS-002 measured.
 */

/** Any of these selects a paid or third-party path instead of the subscription login (WBS-001). */
export const FORBIDDEN_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/** Set when the host itself was started from a Claude Code session; the child must not inherit them. */
export const SESSION_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"] as const;

/**
 * Versions the WBS-001/002 evidence was recorded with. Keep equal to
 * infra/dev/toolchain.json `claude_cli.verified`; a new version needs
 * spikes/cli/isolation.py re-run before independent sessions accept it.
 */
export const VERIFIED_CLI_VERSIONS: readonly string[] = ["2.1.316"];

export const INDEPENDENT_TOOLS = ["Read", "Glob", "Grep"] as const;
export const COURSE_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit"] as const;

/** Tools whose successful result changes a file the host should report. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit"]);

/** Same file tools as a course session and still no Bash: the CLI cannot run or delete anything. */
export const APP_MODIFY_TOOLS = COURSE_TOOLS;

export type Mode = "course" | "independent" | "app_modify";

export interface ArgsInput {
  mode: Mode;
  cliSessionId: string;
  resume: boolean;
  attachmentDirs: readonly string[];
  writableDirs?: readonly string[] | undefined;
  model?: string | undefined;
}

/**
 * Builds the argument array. The prompt is never an argument: it goes to
 * stdin, so a prompt that starts with `-` cannot become a flag and a variadic
 * flag such as `--tools` cannot swallow it.
 */
export function buildArgs(input: ArgsInput): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (input.model) args.push("--model", input.model);
  if (input.mode === "independent") {
    // ISOLATION.md: the whole set, verified together on two Macs.
    args.push(
      "--restricted",
      "--safe-mode",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--permission-mode",
      "dontAsk",
      "--tools",
      INDEPENDENT_TOOLS.join(","),
    );
  } else if (input.mode === "app_modify") {
    // SPEC-005: explicit input only. The checkout's CLAUDE.md, hooks and slash
    // commands are skipped because the checkout itself is what is being changed.
    args.push(
      "--restricted",
      "--safe-mode",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--permission-mode",
      "dontAsk",
      "--tools",
      APP_MODIFY_TOOLS.join(","),
      "--allowedTools",
      ...APP_MODIFY_TOOLS,
    );
  } else {
    // --restricted confines file tools to the workspace and --add-dir; no
    // --safe-mode so a course workspace CLAUDE.md still applies.
    args.push(
      "--restricted",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--tools",
      COURSE_TOOLS.join(","),
      "--allowedTools",
      ...COURSE_TOOLS,
    );
  }
  for (const dir of [...input.attachmentDirs, ...(input.writableDirs ?? [])]) args.push("--add-dir", dir);
  args.push(input.resume ? "--resume" : "--session-id", input.cliSessionId);
  return args;
}

export function findForbiddenEnv(env: NodeJS.ProcessEnv): string[] {
  return FORBIDDEN_ENV.filter((name) => Boolean(env[name])).sort();
}

export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of SESSION_ENV) delete out[name];
  return out;
}

/** "2.1.316 (Claude Code)" → "2.1.316". */
export function parseCliVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1];
}
