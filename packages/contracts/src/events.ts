import { z } from "zod";
import { Id, SchemaVersion, UtcTimestamp } from "./common.ts";
import { AppError } from "./errors.ts";

/**
 * ARCH-001 run event envelope. The CLI adapter normalizes stream-json into
 * these events; the renderer never sees raw CLI output. `seq` is added to the
 * ARCH-001 draft so consumers can detect gaps and reordering.
 */
const envelope = {
  schemaVersion: SchemaVersion,
  eventId: Id,
  runId: Id,
  seq: z.number().int().nonnegative(),
  occurredAt: UtcTimestamp,
};

const ev = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({ ...envelope, type: z.literal(type), payload });

export const RunStarted = ev(
  "run.started",
  z.object({
    appSessionId: Id,
    cliSessionId: Id,
    mode: z.enum(["course", "independent", "app_modify"]),
    /** Must be "none": anything else means the subscription login was bypassed. */
    apiKeySource: z.literal("none"),
    tools: z.array(z.string()),
    mcpServers: z.array(z.string()),
  }),
);
export const TextDelta = ev("text.delta", z.object({ text: z.string() }));
export const ToolRequested = ev(
  "tool.requested",
  z.object({
    toolUseId: z.string().min(1),
    tool: z.string().min(1),
    /** Paths the host resolved for display; the host still enforces scope. */
    targetKeys: z.array(z.string()),
    decision: z.enum(["allowed", "denied", "awaiting_user"]),
  }),
);
export const ArtifactCreated = ev(
  "artifact.created",
  z.object({ outputKey: z.string().min(1), operation: z.enum(["created", "modified", "trashed"]) }),
);
export const RunCompleted = ev("run.completed", z.object({ exitCode: z.literal(0) }));
export const RunFailed = ev("run.failed", z.object({ exitCode: z.number().int().optional(), error: AppError }));
export const RunCancelled = ev(
  "run.cancelled",
  z.object({ processExited: z.boolean(), artifactsWritten: z.array(z.string()) }),
);

export const RunEvent = z.discriminatedUnion("type", [
  RunStarted,
  TextDelta,
  ToolRequested,
  ArtifactCreated,
  RunCompleted,
  RunFailed,
  RunCancelled,
]);
export type RunEvent = z.infer<typeof RunEvent>;

export const TERMINAL_EVENT_TYPES = ["run.completed", "run.failed", "run.cancelled"] as const;

/**
 * Stream invariants a consumer can rely on: one run, seq 0..n-1 without gaps,
 * run.started first, at most one terminal event and nothing after it.
 * Returns problems instead of throwing so the host can report them.
 */
export function checkEventStream(events: readonly RunEvent[]): string[] {
  const problems: string[] = [];
  if (events.length === 0) return ["empty stream"];
  const runId = events[0]!.runId;
  if (events[0]!.type !== "run.started") problems.push("first event must be run.started");
  let terminalAt = -1;
  events.forEach((e, i) => {
    if (e.runId !== runId) problems.push(`event ${i} belongs to another run`);
    if (e.seq !== i) problems.push(`seq gap or reorder at index ${i} (seq ${e.seq})`);
    if (i > 0 && e.type === "run.started") problems.push(`duplicate run.started at ${i}`);
    if ((TERMINAL_EVENT_TYPES as readonly string[]).includes(e.type)) {
      if (terminalAt !== -1) problems.push(`second terminal event at ${i}`);
      terminalAt = i;
    } else if (terminalAt !== -1) {
      problems.push(`event after terminal at ${i}`);
    }
  });
  return problems;
}
