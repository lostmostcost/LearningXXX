import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CollectionManifest, SyncRun, parseVersioned } from "@learningxxx/contracts";
import type { AppError } from "@learningxxx/contracts";
import type { AssetStore } from "./asset-store.ts";
import { CollectionError, collectionError } from "./errors.ts";

/**
 * Local record of collection results (WBS-010, CR-001: no HTTP delivery).
 * Layout under the data root the host chooses:
 *   courses/<courseId>/current.json          active manifest, swapped atomically
 *   courses/<courseId>/revisions/<n>.json    every committed revision
 *   sync-runs/<syncRunId>.json               one record per run
 * courseId already includes the account, so accounts never share a folder.
 */
const courseDir = (root: string, courseId: string) => join(root, "courses", courseId);

async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data, { flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function readJson(path: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw collectionError("CHECKSUM_MISMATCH", "저장된 수집 기록이 손상되었습니다. 다시 수집하세요.");
  }
}

/**
 * Reads the active manifest of a course. Another contract major becomes an
 * explicit "update the app" error; a manifest of another account is refused.
 */
export async function readCurrentManifest(root: string, expected: { courseId: string; accountKey: string }): Promise<CollectionManifest | undefined> {
  const raw = await readJson(join(courseDir(root, expected.courseId), "current.json"));
  if (raw === undefined) return undefined;
  const parsed = parseVersioned(CollectionManifest, raw);
  if (!parsed.ok) throw new CollectionError(parsed.error);
  const { course } = parsed.value;
  if (course.id !== expected.courseId || course.accountKey !== expected.accountKey) {
    throw collectionError("SCOPE_VIOLATION", "다른 계정이나 과목의 수집 기록이라 열지 않았습니다.");
  }
  return parsed.value;
}

/** Content that defines a revision; generatedAt and syncRunId are bookkeeping. */
const contentOf = (m: Pick<CollectionManifest, "course" | "weeks" | "items" | "tombstones">) =>
  JSON.stringify([m.course, m.weeks, m.items, m.tombstones]);

export type ManifestDraft = Omit<CollectionManifest, "schemaVersion" | "revision">;

export interface CommitResult {
  manifest: CollectionManifest;
  /** False when nothing changed: the active manifest is left exactly as it was. */
  written: boolean;
}

/**
 * Commits a new manifest only after every referenced original is present and
 * hashes correctly, so a failed or partial download never replaces the last
 * good manifest (SPEC-001 처리 흐름 3–5). Re-running with the same content is
 * a no-op.
 */
export async function commitManifest(root: string, store: AssetStore, draft: ManifestDraft): Promise<CommitResult> {
  const previous = await readCurrentManifest(root, { courseId: draft.course.id, accountKey: draft.course.accountKey });
  if (previous && contentOf(previous) === contentOf(draft)) return { manifest: previous, written: false };

  for (const { assets } of draft.items) {
    for (const asset of assets) {
      if (!(await store.verify(asset.storageKey, asset.sha256))) {
        throw collectionError("CHECKSUM_MISMATCH", `원본 파일 ${asset.originalName}의 해시가 맞지 않아 새 기록을 적용하지 않았습니다.`, { retryable: true });
      }
    }
  }
  const manifest = CollectionManifest.parse({ ...draft, schemaVersion: 1, revision: (previous?.revision ?? 0) + 1 });
  const dir = courseDir(root, manifest.course.id);
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeAtomic(join(dir, "revisions", `${manifest.revision}.json`), body);
  await writeAtomic(join(dir, "current.json"), body);
  return { manifest, written: true };
}

export async function writeSyncRun(root: string, run: SyncRun): Promise<void> {
  const valid = SyncRun.parse(run);
  await writeAtomic(join(root, "sync-runs", `${valid.id}.json`), `${JSON.stringify(valid, null, 2)}\n`);
}

/** For `collection.status`: the latest succeeded run and the latest run of any status. */
export async function readSyncStatus(root: string, accountKey: string): Promise<{ lastSucceeded?: SyncRun; current?: SyncRun }> {
  let names: string[];
  try {
    names = await readdir(join(root, "sync-runs"));
  } catch {
    return {};
  }
  const runs: SyncRun[] = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const parsed = SyncRun.safeParse(await readJson(join(root, "sync-runs", name)).catch(() => undefined));
    if (parsed.success && parsed.data.accountKey === accountKey) runs.push(parsed.data);
  }
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  // A partial run is never reported as success (SPEC-001).
  const lastSucceeded = runs.find((r) => r.status === "succeeded");
  return { ...(lastSucceeded ? { lastSucceeded } : {}), ...(runs[0] ? { current: runs[0] } : {}) };
}

export type SyncError = AppError & { resourceSourceId?: string };
