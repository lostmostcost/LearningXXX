import type { HostPush, IpcChannel, Run, RunEvent, Session } from "@learningxxx/contracts";

/**
 * Stand-in host for `?fixture` only, so the chat flow can be tried in a plain
 * browser. It answers session and run calls in memory and streams a canned
 * reply; it never runs the CLI or touches files. The real app uses preload.
 */
export function installFakeHost(courseTitle: string): void {
  const sessions: Session[] = [];
  const runs = new Map<string, { run: Run; seq: number; timer?: ReturnType<typeof setInterval> }>();
  const listeners = new Set<(m: unknown) => void>();
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const push = (message: HostPush) => listeners.forEach((l) => l(message));
  const ok = (data: unknown) => Promise.resolve({ ok: true, data });
  const fail = (code: string, message: string) => Promise.resolve({ ok: false, error: { code, message, retryable: false } });
  const update = (id: string, patch: Partial<Session>) => {
    const i = sessions.findIndex((s) => s.appSessionId === id);
    sessions[i] = { ...sessions[i]!, ...patch } as Session;
    return sessions[i]!;
  };

  const event = (run: Run, seq: number, type: RunEvent["type"], payload: unknown) =>
    push({ kind: "run.event", event: { schemaVersion: 1, eventId: crypto.randomUUID(), runId: run.runId, seq, occurredAt: now(), type, payload } as RunEvent });

  const handlers: Partial<Record<IpcChannel, (p: Record<string, unknown>) => Promise<unknown>>> = {
    "session.list": () => ok({ sessions: [...sessions] }),
    "session.create": (p) => {
      const id = crypto.randomUUID();
      const session = {
        appSessionId: id, mode: p.mode, ...(p.mode === "course" ? { courseId: p.courseId } : {}),
        workspaceKey: p.mode === "course" ? `courses/${String(p.courseId)}/sessions/${id}` : `sessions/${id}`,
        title: p.title, createdAt: now(), lastUsedAt: now(), status: "idle",
      } as Session;
      sessions.push(session);
      return ok({ session });
    },
    "session.rename": (p) => ok({ session: update(String(p.appSessionId), { title: String(p.title) }) }),
    "session.archive": (p) => {
      const { archivedAt: _a, ...rest } = sessions.find((s) => s.appSessionId === p.appSessionId)!;
      const next = (p.archived ? { ...rest, archivedAt: now() } : rest) as Session;
      return ok({ session: update(String(p.appSessionId), next) });
    },
    "run.start": (p) => {
      const draft = p.draft as { targetSessionId: string; text: string };
      const session = sessions.find((s) => s.appSessionId === draft.targetSessionId);
      if (!session) return fail("NOT_FOUND", "세션을 찾을 수 없습니다.");
      if ([...runs.values()].some((r) => r.run.appSessionId === session.appSessionId && r.timer)) return fail("RUN_ALREADY_ACTIVE", "이 세션의 응답이 아직 끝나지 않았습니다.");
      const run = { runId: crypto.randomUUID(), appSessionId: session.appSessionId, requestId: String(p.requestId), startedAt: now(), status: "streaming" } as Run;
      const words = `(합성 응답) ${session.mode === "independent" ? "독립 세션이라 과목 자료 없이" : `${courseTitle} 세션에서`} 답합니다: "${draft.text.slice(0, 40)}"`.split(" ");
      const entry: { run: Run; seq: number; timer?: ReturnType<typeof setInterval> } = { run, seq: 0 };
      event(run, entry.seq++, "run.started", { appSessionId: session.appSessionId, cliSessionId: crypto.randomUUID(), mode: session.mode, apiKeySource: "none", tools: [], mcpServers: [] });
      entry.timer = setInterval(() => {
        const word = words.shift();
        if (word !== undefined) return event(run, entry.seq++, "text.delta", { text: `${word} ` });
        clearInterval(entry.timer);
        delete entry.timer;
        if (draft.text.includes("실패")) event(run, entry.seq++, "run.failed", { exitCode: 1, error: { code: "USAGE_LIMIT", message: "Claude 구독 사용량 한도에 도달했습니다.", retryable: true } });
        else event(run, entry.seq++, "run.completed", { exitCode: 0 });
      }, 120);
      runs.set(run.runId, entry);
      update(session.appSessionId, { lastUsedAt: now() });
      return ok({ run });
    },
    "run.cancel": (p) => {
      const entry = runs.get(String(p.runId));
      if (!entry) return fail("NOT_FOUND", "실행을 찾을 수 없습니다.");
      if (entry.timer) {
        clearInterval(entry.timer);
        delete entry.timer;
        event(entry.run, entry.seq++, "run.cancelled", { processExited: true, artifactsWritten: [] });
      }
      return ok({ run: entry.run });
    },
  };

  window.host = {
    invoke: (channel, payload) => handlers[channel as IpcChannel]?.(payload as Record<string, unknown>) ?? fail("INTERNAL", "합성 모드에서는 지원하지 않습니다."),
    onPush: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
