import { z } from "zod";
import { UtcTimestamp } from "./common.ts";

/** SPEC-001 collection errors. */
export const CollectionErrorCode = z.enum([
  "AUTH_REQUIRED",
  "SOURCE_CHANGED",
  "RATE_LIMITED",
  "DOWNLOAD_FAILED",
  "CHECKSUM_MISMATCH",
  "UNSUPPORTED_FORMAT",
]);

/** SPEC-002 CLI/session errors, each explained separately to the user. */
export const CliErrorCode = z.enum([
  "CLI_NOT_INSTALLED",
  "CLI_AUTH_REQUIRED",
  "FORBIDDEN_CREDENTIAL_ENV",
  "USAGE_LIMIT",
  "SESSION_NOT_FOUND",
  "CLI_VERSION_MISMATCH",
  "ISOLATION_VIOLATION",
  "RUN_INTERRUPTED",
  "RUN_ALREADY_ACTIVE",
]);

/** Host boundary errors shared by every IPC call. */
export const HostErrorCode = z.enum([
  "SCHEMA_VERSION_UNSUPPORTED",
  "INVALID_REQUEST",
  "SCOPE_VIOLATION",
  "NOT_FOUND",
  "INTERNAL",
  "CAPTURE_PERMISSION_DENIED",
  "CAPTURE_FAILED",
]);

export const ErrorCode = z.enum([
  ...CollectionErrorCode.options,
  ...CliErrorCode.options,
  ...HostErrorCode.options,
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Codes that a retry can never fix without user action. */
const NEVER_RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "AUTH_REQUIRED",
  "CLI_NOT_INSTALLED",
  "CLI_AUTH_REQUIRED",
  "FORBIDDEN_CREDENTIAL_ENV",
  "ISOLATION_VIOLATION",
  "SCHEMA_VERSION_UNSUPPORTED",
  "SCOPE_VIOLATION",
  "UNSUPPORTED_FORMAT",
  "CAPTURE_PERMISSION_DENIED",
]);

/**
 * `retryable` and `retryAfter` are separate (SPEC-001): an error may be
 * retryable without a known time. Messages are user-facing and must not carry
 * prompts, cookies, credentials or recordings (ARCH-001 품질과 관측).
 */
export const AppError = z
  .object({
    code: ErrorCode,
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    retryAfter: UtcTimestamp.optional(),
    detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.retryable && NEVER_RETRYABLE.has(e.code)) {
      ctx.addIssue({ code: "custom", message: `${e.code} requires user action, not retry` });
    }
    if (e.retryAfter && !e.retryable) {
      ctx.addIssue({ code: "custom", message: "retryAfter requires retryable=true" });
    }
  });
export type AppError = z.infer<typeof AppError>;
