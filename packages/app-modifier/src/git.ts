import { execFile } from "node:child_process";

/**
 * Every git call goes through here. The AI can write into the worktree, so
 * nothing configurable from there may execute: hooks, fsmonitor, signing and
 * diff drivers stay off.
 */
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false"];

export function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/env", ["git", ...SAFE, ...args], { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}
