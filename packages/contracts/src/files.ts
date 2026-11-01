import { z } from "zod";
import { Id, UtcTimestamp } from "./common.ts";

/**
 * What one run changed on disk, found by comparing the folders before and
 * after it. Keys are workspace-relative, or `external-<n>/...` for a folder the
 * user granted. The UI shows the list and the recovery path (SPEC-002).
 */
export const FileChange = z.object({
  key: z.string().min(1),
  change: z.enum(["created", "modified", "deleted"]),
  /** False when no earlier copy exists, as for external folders. */
  restorable: z.boolean(),
});
export type FileChange = z.infer<typeof FileChange>;

export const RunChanges = z.object({
  runId: Id,
  appSessionId: Id,
  recordedAt: UtcTimestamp,
  changes: z.array(FileChange),
  /** False when the workspace was too large to copy before the run. */
  snapshotKept: z.boolean(),
});
export type RunChanges = z.infer<typeof RunChanges>;
