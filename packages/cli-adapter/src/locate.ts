import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { AppError } from "@learningxxx/contracts";
import { MESSAGES, appError } from "./classify.ts";
import { VERIFIED_CLI_VERSIONS, childEnv, findForbiddenEnv, parseCliVersion } from "./policy.ts";

/**
 * An app opened from Finder does not get the login shell PATH (ADR-002 미검증),
 * so the CLI is resolved to an absolute path from PATH plus the official
 * install locations.
 */
export function cliCandidates(env: NodeJS.ProcessEnv, home: string): string[] {
  const fromPath = (env.PATH ?? "").split(delimiter).filter((d) => isAbsolute(d)).map((d) => join(d, "claude"));
  const known = [
    join(home, ".local/bin/claude"),
    join(home, ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  return [...new Set([...fromPath, ...known])];
}

export type Located = { ok: true; path: string } | { ok: false; error: AppError };

export function locateCli(env: NodeJS.ProcessEnv, home: string): Located {
  const candidates = cliCandidates(env, home);
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      if (!statSync(real).isFile()) continue;
      accessSync(real, constants.X_OK);
      return { ok: true, path: candidate };
    } catch {
      // missing or not executable: try the next location
    }
  }
  return { ok: false, error: appError("CLI_NOT_INSTALLED", MESSAGES.CLI_NOT_INSTALLED, { searched: candidates.length }) };
}

export interface CliProbe {
  version: string;
  /** Independent sessions refuse unverified versions (ADR-002 결정 5). */
  versionVerified: boolean;
  authMethod: string;
  apiProvider: string;
  subscriptionType?: string;
}

const run = (path: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number; stdout: string; spawnError?: NodeJS.ErrnoException }>((resolve) => {
    execFile(path, args, { env: childEnv(env), timeout: 30_000 }, (error, stdout) => {
      const err = error as (NodeJS.ErrnoException & { code?: unknown }) | null;
      if (err && typeof err.code === "string") resolve({ code: -1, stdout: "", spawnError: err });
      else resolve({ code: err ? Number(err.code ?? 1) : 0, stdout: String(stdout) });
    });
  });

/**
 * Preflight before the first run: installed, version, and logged in with the
 * subscription (`auth status` → claude.ai / firstParty). Sends no model
 * request. Only allowlisted auth fields are kept: e-mail and organization
 * never leave this function.
 */
export async function probeCli(
  path: string,
  env: NodeJS.ProcessEnv,
  verified: readonly string[] = VERIFIED_CLI_VERSIONS,
): Promise<{ ok: true; probe: CliProbe } | { ok: false; error: AppError }> {
  const forbidden = findForbiddenEnv(env);
  if (forbidden.length) {
    return { ok: false, error: appError("FORBIDDEN_CREDENTIAL_ENV", MESSAGES.FORBIDDEN_CREDENTIAL_ENV, { names: forbidden.join(",") }) };
  }
  const version = await run(path, ["--version"], env);
  if (version.spawnError) return { ok: false, error: appError("CLI_NOT_INSTALLED", MESSAGES.CLI_NOT_INSTALLED) };
  const parsed = parseCliVersion(version.stdout);
  if (version.code !== 0 || !parsed) {
    return { ok: false, error: appError("CLI_VERSION_MISMATCH", MESSAGES.CLI_VERSION_MISMATCH, { exitCode: version.code }) };
  }
  const status = await run(path, ["auth", "status"], env);
  let auth: Record<string, unknown> = {};
  try {
    auth = JSON.parse(status.stdout) as Record<string, unknown>;
  } catch {
    // not JSON: treated as not logged in below
  }
  const authMethod = String(auth.authMethod ?? "");
  const apiProvider = String(auth.apiProvider ?? "");
  if (auth.loggedIn !== true || authMethod !== "claude.ai" || apiProvider !== "firstParty") {
    return {
      ok: false,
      error: appError("CLI_AUTH_REQUIRED", MESSAGES.CLI_AUTH_REQUIRED, {
        loggedIn: auth.loggedIn === true,
        authMethod: authMethod || "unknown",
      }),
    };
  }
  const probe: CliProbe = { version: parsed, versionVerified: verified.includes(parsed), authMethod, apiProvider };
  if (typeof auth.subscriptionType === "string") probe.subscriptionType = auth.subscriptionType;
  return { ok: true, probe };
}
