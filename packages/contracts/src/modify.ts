import { z } from "zod";
import { Id, UtcTimestamp } from "./common.ts";
import { ErrorCode } from "./errors.ts";

/**
 * One requested change to the app's own source (REQ-011, SPEC-005). Nothing in
 * the user's checkout changes before `restarting`; every earlier state lives in
 * a separate worktree the host can throw away.
 */
export const ModifyStatus = z.enum([
  "editing",
  "no_changes",
  "failed",
  "cancelled",
  "interrupted",
  "review",
  "verifying",
  "verify_failed",
  "verified",
  "restarting",
  "applied",
  "rolled_back",
  "discarded",
]);
export type ModifyStatus = z.infer<typeof ModifyStatus>;

export const ModifyJob = z.object({
  jobId: Id,
  requestId: Id,
  prompt: z.string().min(1),
  status: ModifyStatus,
  baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
  commit: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  /** What the CLI said about the change. */
  explanation: z.string(),
  files: z.array(z.object({ path: z.string().min(1), change: z.enum(["added", "modified"]) })),
  diff: z.string(),
  diffTruncated: z.boolean(),
  /** Changed files that decide what runs or with which permissions. */
  warnings: z.array(z.string()),
  verifyLog: z.string(),
  errorCode: ErrorCode.optional(),
  message: z.string().optional(),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
});
export type ModifyJob = z.infer<typeof ModifyJob>;
