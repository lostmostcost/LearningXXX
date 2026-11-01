import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SyncRun } from "@learningxxx/contracts";
import { stableId } from "./discovery.ts";
import { collectionError } from "./errors.ts";
import { writeSyncRun } from "./manifest-store.ts";

/** A lock older than this is treated as left behind even if its pid was reused. */
export const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

interface LockBody {
  pid: number;
  syncRunId: string;
  startedAt: string;
}

const lockPath = (root: string, accountKey: string, sourceCourseId: string) =>
  join(root, "locks", `${stableId("collect", accountKey, sourceCourseId)}.lock`);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export interface CourseLock {
  release(): Promise<void>;
}

/**
 * One collection per account and course at a time. A second start while the
 * first is alive is refused with RUN_ALREADY_ACTIVE; a lock whose process is
 * gone (crash, force quit) is taken over.
 */
export async function acquireCourseLock(
  root: string,
  owner: { accountKey: string; sourceCourseId: string; syncRunId: string },
  now: () => Date = () => new Date(),
): Promise<CourseLock> {
  const path = lockPath(root, owner.accountKey, owner.sourceCourseId);
  await mkdir(join(root, "locks"), { recursive: true });
  const body: LockBody = { pid: process.pid, syncRunId: owner.syncRunId, startedAt: now().toISOString() };
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      await writeFile(path, JSON.stringify(body), { flag: "wx" });
      return { release: () => rm(path, { force: true }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let held: LockBody | undefined;
    try {
      held = JSON.parse(await readFile(path, "utf8")) as LockBody;
    } catch {
      held = undefined; // unreadable lock: treat as left behind
    }
    const age = held ? now().getTime() - new Date(held.startedAt).getTime() : Infinity;
    if (held && alive(held.pid) && age < STALE_LOCK_MS) {
      throw collectionError("RUN_ALREADY_ACTIVE", "이 과목의 수집이 이미 진행 중입니다. 끝난 뒤 다시 실행하세요.");
    }
    await rm(path, { force: true });
  }
  throw collectionError("RUN_ALREADY_ACTIVE", "이 과목의 수집이 이미 진행 중입니다. 끝난 뒤 다시 실행하세요.");
}

/**
 * After a crash: sync runs still marked `running` with no live lock become
 * `interrupted`, and half-written downloads are removed. Nothing is resent
 * automatically; the user starts the next run.
 */
export async function recoverInterruptedRuns(
  root: string,
  now: () => Date = () => new Date(),
  /** The caller's own run: it has not downloaded anything yet, so it does not protect tmp files. */
  ownRunId?: string,
): Promise<SyncRun[]> {
  const recovered: SyncRun[] = [];
  const liveRuns = new Set<string>();
  for (const name of await readdir(join(root, "locks")).catch(() => [] as string[])) {
    try {
      const held = JSON.parse(await readFile(join(root, "locks", name), "utf8")) as LockBody;
      if (alive(held.pid) && held.syncRunId !== ownRunId) liveRuns.add(held.syncRunId);
    } catch {
      // unreadable lock: its run is not live
    }
  }
  for (const name of await readdir(join(root, "sync-runs")).catch(() => [] as string[])) {
    let run: SyncRun;
    try {
      run = SyncRun.parse(JSON.parse(await readFile(join(root, "sync-runs", name), "utf8")));
    } catch {
      continue;
    }
    if (run.status !== "running" || liveRuns.has(run.id)) continue;
    const interrupted = SyncRun.parse({
      ...run,
      status: "interrupted",
      endedAt: now().toISOString().replace(/\.\d{3}Z$/, "Z"),
      errors: [...run.errors, collectionError("RUN_INTERRUPTED", "수집 중에 앱이 종료되었습니다. 다시 실행하면 이어서 받습니다.", { retryable: true }).appError],
    });
    await writeSyncRun(root, interrupted);
    recovered.push(interrupted);
  }
  if (liveRuns.size === 0) {
    for (const name of await readdir(join(root, "tmp")).catch(() => [] as string[])) {
      if (name.endsWith(".part") && (await stat(join(root, "tmp", name)).catch(() => undefined))?.isFile()) {
        await rm(join(root, "tmp", name), { force: true });
      }
    }
  }
  return recovered;
}
