import { z } from "zod";

/**
 * Contract major version. Consumers reject any other major with
 * SCHEMA_VERSION_UNSUPPORTED instead of guessing (SPEC-001 로컬 수집 계약).
 * Additive optional fields keep the same major; unknown fields are stripped.
 */
export const SCHEMA_VERSION = 1 as const;
export const SchemaVersion = z.literal(SCHEMA_VERSION);

/** Internal IDs are UUIDs, never LMS IDs or file names (ARCH-001). */
export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

/** Stored in UTC with a trailing Z; displayed in Asia/Seoul by the UI. */
export const UtcTimestamp = z.iso.datetime({ offset: false });
export type UtcTimestamp = z.infer<typeof UtcTimestamp>;

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "lowercase hex sha256");

/**
 * Opaque per-Mac account partition key (e.g. a hash). Never a student number,
 * e-mail or cookie. Course identity = accountKey + termId + sourceCourseId.
 */
export const AccountKey = z.string().regex(/^acct_[0-9a-z]{8,64}$/);
export type AccountKey = z.infer<typeof AccountKey>;

/** Relative storage key inside the app data root; no absolute path or `..`. */
export const StorageKey = z
  .string()
  .min(1)
  .refine((v) => !v.startsWith("/") && !v.split("/").includes("..") && !v.includes("\\"), {
    message: "storage key must be relative and must not escape the data root",
  });
