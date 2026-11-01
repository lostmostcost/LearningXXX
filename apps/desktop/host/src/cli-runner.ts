import { homedir } from "node:os";
import { locateCli, probeCli, startRun } from "@learningxxx/cli-adapter";
import type { StartCli } from "./session-service.ts";

/** Finds and checks the official CLI before every run, so a logout or update surfaces at once. */
export function createCliRunner(env: NodeJS.ProcessEnv = process.env, home = homedir()): StartCli {
  return async (request, signal) => {
    const located = locateCli(env, home);
    if (!located.ok) return located;
    const probe = await probeCli(located.path, env);
    if (!probe.ok) return probe;
    return startRun(request, { cliPath: located.path, env, signal });
  };
}
