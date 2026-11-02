import { randomUUID } from "node:crypto";
import { SyncRun } from "@learningxxx/contracts";
import type { CollectionManifest } from "@learningxxx/contracts";
import type { AssetStore } from "./asset-store.ts";
import type { CanvasClient } from "./canvas-client.ts";
import type { LearningXClient } from "./learningx.ts";
import { diffManifests, type ManifestChanges } from "./changes.ts";
import { discoverCourse } from "./discovery.ts";
import { CollectionError } from "./errors.ts";
import { commitManifest, readCurrentManifest, writeSyncRun, type SyncError } from "./manifest-store.ts";
import { collectResources } from "./resources.ts";
import { DEFAULT_RETRY, withRetry, type RetryPolicy } from "./retry.ts";
import { acquireCourseLock, recoverInterruptedRuns } from "./run-lock.ts";

export interface CollectCourseInput {
  client: CanvasClient;
  /** Lecture materials (WBS-039); without it only Canvas files are collected. */
  learningx?: LearningXClient | undefined;
  store: AssetStore;
  /** Data root chosen by the host; manifests and sync runs are written under it. */
  root: string;
  accountKey: string;
  sourceCourseId: string;
  now?: () => Date;
  newId?: () => string;
  retry?: RetryPolicy;
}

export interface CollectCourseResult {
  syncRun: SyncRun;
  /** The active manifest after the run: the new one, or the previous good one if nothing was committed. */
  manifest?: CollectionManifest;
  written: boolean;
  /** Against the manifest that was active before this run; empty when nothing was committed. */
  changes: ManifestChanges;
}

const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * One user-started collection of one course (CR-001: manual only). It is
 * recorded as `running` first, so a crash later shows as `interrupted`; the
 * manifest changes only after all originals are verified. Every outcome is a
 * SyncRun except a second start while one is running, which throws
 * RUN_ALREADY_ACTIVE without touching anything.
 */
export async function collectCourse(input: CollectCourseInput): Promise<CollectCourseResult> {
  const now = input.now ?? (() => new Date());
  const retry = input.retry ?? DEFAULT_RETRY;
  const id = (input.newId ?? randomUUID)();
  const lock = await acquireCourseLock(input.root, { accountKey: input.accountKey, sourceCourseId: input.sourceCourseId, syncRunId: id }, now);
  try {
    await recoverInterruptedRuns(input.root, now, id);
    const base = { schemaVersion: 1 as const, id, accountKey: input.accountKey, trigger: "manual" as const, scope: "course" as const, startedAt: utc(now()) };
    await writeSyncRun(input.root, SyncRun.parse({ ...base, status: "running", errors: [] }));

    let courseId: string | undefined;
    let previous: CollectionManifest | undefined;
    let manifest: CollectionManifest | undefined;
    let written = false;
    let errors: SyncError[] = [];
    let status: SyncRun["status"];
    try {
      const { course, weeks } = await withRetry(() => discoverCourse(input), retry);
      courseId = course.id;
      previous = await readCurrentManifest(input.root, { courseId: course.id, accountKey: input.accountKey });
      manifest = previous;
      const result = await collectResources({ client: input.client, learningx: input.learningx, store: input.store, course, weeks, previous, now, retry });
      const committed = await commitManifest(input.root, input.store, {
        course,
        weeks,
        syncRunId: id,
        generatedAt: utc(now()),
        items: result.items,
        tombstones: result.tombstones,
      });
      manifest = committed.manifest;
      written = committed.written;
      errors = result.errors;
      status = errors.length > 0 ? "partial" : "succeeded";
    } catch (error) {
      status = "failed";
      errors = [
        error instanceof CollectionError
          ? error.appError
          : { code: "INTERNAL", message: "수집 중 알 수 없는 오류가 발생했습니다.", retryable: false },
      ];
    }
    const syncRun = SyncRun.parse({ ...base, ...(courseId ? { courseId } : {}), endedAt: utc(now()), status, errors });
    await writeSyncRun(input.root, syncRun);
    return { syncRun, ...(manifest ? { manifest } : {}), written, changes: diffManifests(previous, written ? manifest : previous) };
  } finally {
    await lock.release();
  }
}
