import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { IpcResponse } from "@learningxxx/contracts";

export type BuildInfo = IpcResponse<"app.build">;
type Git = (args: string[]) => Promise<string>;

const defaultGit = (cwd: string): Git => async (args) =>
  (await promisify(execFile)("/usr/bin/git", ["-C", cwd, ...args], { timeout: 5_000, maxBuffer: 65536 })).stdout.trim();

/**
 * CR-061 / WBS-061: which code a development run was built from, so several
 * apps open at once (other worktrees, other sessions' checks) can be told
 * apart. Read once at start from the app folder's git; a packaged app shows
 * nothing. Branch and folder names only — no paths outside the repository.
 */
export async function readBuildInfo(appPath: string, packaged: boolean, git: Git = defaultGit(appPath)): Promise<BuildInfo> {
  if (packaged) return { dev: false };
  try {
    const [branch, commit, top, status] = await Promise.all([
      git(["rev-parse", "--abbrev-ref", "HEAD"]),
      git(["rev-parse", "--short", "HEAD"]),
      git(["rev-parse", "--show-toplevel"]),
      git(["status", "--porcelain", "--untracked-files=no"]),
    ]);
    const task = /WBS-\d{3}/.exec(branch)?.[0];
    return {
      dev: true,
      branch: (branch === "HEAD" ? "(detached)" : branch).slice(0, 200),
      ...(/^[0-9a-f]{4,40}$/.test(commit) ? { commit } : {}),
      ...(task ? { task } : {}),
      dirty: status !== "",
      folder: basename(top).slice(0, 200),
    };
  } catch {
    return { dev: true };
  }
}
