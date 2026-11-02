import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Verifier, VerifyInput, VerifyResult } from "./modifier.ts";

const TIMEOUT_MS = 20 * 60 * 1000;
const LOG_LIMIT = 16_000;

/**
 * Fixed here, never read from the changed source. Same steps as the tools
 * service in compose.yaml, plus copying the two builds out. The source mount is
 * read-only; /out is the only way anything leaves the container.
 */
export function verifyCommand(): string {
  return [
    "python scripts/check.py",
    "python -m unittest discover -s tests/tooling -v",
    "mkdir -p /tmp/ws",
    "tar -C /workspace --exclude=./.git --exclude='*/node_modules' --exclude=./node_modules -cf - . | tar -C /tmp/ws -xf -",
    "cd /tmp/ws",
    "pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store --reporter=append-only",
    "pnpm -r run check",
    "mkdir -p /out/host /out/ui",
    "cp -R apps/desktop/host/dist /out/host/dist",
    "cp -R apps/desktop/ui/dist /out/ui/dist",
  ].join(" && ");
}

/** Finder-started apps do not get the shell PATH. */
export function locateDocker(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  const fromPath = (env.PATH ?? "").split(":").filter(Boolean).map((dir) => join(dir, "docker"));
  return [...fromPath, "/usr/local/bin/docker", "/opt/homebrew/bin/docker", join(home, ".docker/bin/docker"), "/Applications/Docker.app/Contents/Resources/bin/docker"].find(existsSync);
}

/**
 * Nothing in this run reads the changed compose.yaml or Dockerfile: the AI could
 * otherwise mount the home folder. The image comes from the Dockerfile of the
 * commit the job started from, and the arguments are built here. Only the
 * source snapshot and an empty output folder are mounted; no user data, no
 * credentials and no host environment enter the container.
 */
export function createDockerVerifier(dockerPath: string | undefined): Verifier {
  return async (input: VerifyInput): Promise<VerifyResult> => {
    if (dockerPath === undefined) return { ok: false, log: "Docker를 찾을 수 없습니다. Docker Desktop을 설치하고 실행해 주세요." };
    let log = "";
    const append = (text: string) => { log = (log + text).slice(-LOG_LIMIT); };
    const run = (args: string[], stdin?: string) => new Promise<number>((resolve) => {
      const child = spawn(dockerPath, args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", HOME: homedir() } });
      child.stdout.on("data", (d: Buffer) => append(d.toString()));
      child.stderr.on("data", (d: Buffer) => append(d.toString()));
      child.on("error", (e) => { append(`${e.message}\n`); resolve(-1); });
      child.on("close", (code) => resolve(code ?? -1));
      child.stdin.end(stdin ?? "");
    });
    const image = `learningxxx-modify:${input.baseCommit.slice(0, 12)}`;
    if (await run(["build", "-t", image, "-"], input.dockerfile) !== 0) return { ok: false, log };
    if (input.signal.aborted) return { ok: false, log };
    const name = `learningxxx-modify-${input.jobId}`;
    const stop = () => void run(["kill", name]);
    const timer = setTimeout(stop, TIMEOUT_MS);
    input.signal.addEventListener("abort", stop, { once: true });
    const code = await run([
      "run", "--rm", "--init", "--name", name,
      "-e", "PYTHONDONTWRITEBYTECODE=1",
      "-v", `${input.snapshotDir}:/workspace:ro`,
      "-v", `${input.outDir}:/out`,
      "-w", "/workspace",
      image, "sh", "-c", verifyCommand(),
    ]);
    clearTimeout(timer);
    input.signal.removeEventListener("abort", stop);
    return { ok: code === 0, log };
  };
}
