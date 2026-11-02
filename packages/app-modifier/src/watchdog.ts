import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";

export interface RestartPlan {
  parentPid: number;
  execPath: string;
  args: string[];
  cwd: string;
  sourceRoot: string;
  /** Replaced build folders and where the last good copy of each is. */
  restores: { target: string; backup: string }[];
  previousCommit: string;
  appliedCommit: string;
  healthyPath: string;
  rolledBackPath: string;
  timeoutMs: number;
}

/**
 * Runs with the old app's Node, outside the app, so a broken new build cannot
 * stop its own recovery. Starts the new app and waits for its renderer to report
 * in. If it crashes or stays silent, it restores the last good build and source
 * and starts that instead. The source is reset only if nothing moved it since.
 */
export const WATCHDOG_SOURCE = String.raw`"use strict";
const { execFileSync, spawn } = require("node:child_process");
const { cpSync, existsSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const plan = JSON.parse(readFileSync(process.argv[2], "utf8"));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const launch = () => spawn(plan.execPath, plan.args, { cwd: plan.cwd, env, detached: true, stdio: "ignore" });
const git = (...args) => execFileSync("/usr/bin/env", ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd: plan.sourceRoot, encoding: "utf8" }).trim();
(async () => {
  while (alive(plan.parentPid)) await sleep(100);
  const child = launch();
  let exited = false;
  child.on("exit", () => { exited = true; });
  child.on("error", () => { exited = true; });
  child.unref();
  const deadline = Date.now() + plan.timeoutMs;
  while (Date.now() < deadline && !exited) {
    if (existsSync(plan.healthyPath)) process.exit(0);
    await sleep(200);
  }
  if (existsSync(plan.healthyPath)) process.exit(0);
  if (!exited) { try { process.kill(-child.pid, "SIGTERM"); } catch {} await sleep(1500); try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  for (const { target, backup } of plan.restores) { rmSync(target, { recursive: true, force: true }); cpSync(backup, target, { recursive: true }); }
  let sourceRestored = false;
  try {
    if (git("rev-parse", "HEAD") === plan.appliedCommit) { git("reset", "--keep", plan.previousCommit); sourceRestored = true; }
  } catch {}
  writeFileSync(plan.rolledBackPath, JSON.stringify({ sourceRestored }));
  launch().unref();
  process.exit(0);
})();
`;

/** Writes the script beside the plan and detaches it, so it outlives this process. */
export function launchWatchdog(execPath: string, planPath: string): void {
  const script = join(dirname(planPath), "watchdog.cjs");
  writeFileSync(script, WATCHDOG_SOURCE);
  spawn(execPath, [script, planPath], { detached: true, stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }).unref();
}
