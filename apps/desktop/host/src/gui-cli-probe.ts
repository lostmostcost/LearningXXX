import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

/**
 * Temporary ADR-002 check: does the subscription CLI work from a process that
 * Finder launched? Runs only with --probe-out=<file>. Removed once WBS-014 owns
 * this path. Records outcomes only, never tokens, prompts or account details.
 */
const BASE = ["--model", "haiku", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk", "--tools", ""];
const ISOLATED = ["--restricted", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands"];
const ORDINARY = ["--setting-sources", "project", "--strict-mcp-config"];

function call(binary: string, flags: string[], cwd: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(binary, ["-p", "Reply with exactly: PONG", ...BASE, ...flags], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ spawnError: error.code });
    });
    child.on("close", (exit) => {
      clearTimeout(timer);
      const events = out.split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
      const init = events.find((e) => e.type === "system" && e.subtype === "init");
      const result = events.find((e) => e.type === "result");
      resolve({ exit, apiKeySource: init?.apiKeySource, isError: result?.is_error, answer: result?.result });
    });
  });
}

export async function runGuiCliProbe(out: string, binary: string, cwd: string): Promise<void> {
  const result = {
    hasShellPath: (process.env.PATH ?? "").includes("/opt/homebrew/bin"),
    byName: await call("claude", ORDINARY, cwd),
    absolute: await call(binary, ORDINARY, cwd),
    isolated: await call(binary, ISOLATED, cwd),
  };
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
}
