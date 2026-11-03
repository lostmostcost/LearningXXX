import { z } from "zod";
import { SCHEMA_VERSION } from "./common.ts";
import type { AppError } from "./errors.ts";

export * from "./common.ts";
export * from "./errors.ts";
export * from "./lms.ts";
export * from "./sessions.ts";
export * from "./files.ts";
export * from "./modify.ts";
export * from "./media.ts";
export * from "./events.ts";
export * from "./ipc.ts";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: AppError };

/**
 * Consumer entry point for any versioned document (manifest, sync run, event,
 * IPC envelope). A different major version becomes an explicit
 * "update needed" error instead of a best-effort parse (SPEC-001).
 */
export function parseVersioned<S extends z.ZodType>(schema: S, input: unknown): Parsed<z.infer<S>> {
  const version = (input as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version === "number" && version !== SCHEMA_VERSION) {
    return {
      ok: false,
      error: {
        code: "SCHEMA_VERSION_UNSUPPORTED",
        message: `이 데이터는 계약 버전 ${version}이며 앱은 ${SCHEMA_VERSION}만 읽습니다. 앱을 업데이트하세요.`,
        retryable: false,
        detail: { found: version, supported: SCHEMA_VERSION },
      },
    };
  }
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "계약에 맞지 않는 데이터입니다.",
      retryable: false,
      detail: { issues: result.error.issues.length, first: result.error.issues[0]?.message ?? "" },
    },
  };
}

export { CHAT_COMMANDS, parseChatCommand } from "./chat-commands.ts";
