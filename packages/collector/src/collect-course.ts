import { randomUUID } from "node:crypto";
import { SyncRun } from "@learningxxx/contracts";
import type { CollectionManifest } from "@learningxxx/contracts";
import type { AssetStore } from "./asset-store.ts";
import type { CanvasClient } from "./canvas-client.ts";
import { discoverCourse } from "./discovery.ts";
import { CollectionError } from "./errors.ts";
import { commitManifest, readCurrentManifest, writeSyncRun, type SyncError } from "./manifest-store.ts";
import { collectResources } from "./resources.ts";

export interface CollectCourseInput {
  client: CanvasClient;
  store: AssetStore;
  /** Data root chosen by the host; manifests and sync runs are written under it. */
  root: string;
  accountKey: string;
  sourceCourseId: string;
  now?: () => Date;
  newId?: () => string;
}

export interface CollectCourseResult {
  syncRun: SyncRun;
  /** The active manifest after the run: the new one, or the previous good one if nothing was committed. */
  manifest?: CollectionManifest;
  written: boolean;
}

const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * One user-started collection of one course (CR-001: manual only). Every run
 * leaves a SyncRun record; the manifest changes only after all originals are
 * verified. Errors never throw past here: they become a failed SyncRun.
 */
export async function collectCourse(input: CollectCourseInput): Promise<CollectCourseResult> {
  const now = input.now ?? (() => new Date());
  const id = (input.newId ?? randomUUID)();
  const startedAt = utc(now());
  let courseId: string | undefined;
  let manifest: CollectionManifest | undefined;
  let written = false;
  let errors: SyncError[] = [];
  let status: SyncRun["status"];
  try {
    const { course, weeks } = await discoverCourse(input);
    courseId = course.id;
    const previous = await readCurrentManifest(input.root, { courseId: course.id, accountKey: input.accountKey });
    manifest = previous;
    const result = await collectResources({ client: input.client, store: input.store, course, weeks, previous, now });
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
  const syncRun = SyncRun.parse({
    schemaVersion: 1,
    id,
    accountKey: input.accountKey,
    ...(courseId ? { courseId } : {}),
    trigger: "manual",
    scope: "course",
    startedAt,
    endedAt: utc(now()),
    status,
    errors,
  });
  await writeSyncRun(input.root, syncRun);
  return { syncRun, ...(manifest ? { manifest } : {}), written };
}
