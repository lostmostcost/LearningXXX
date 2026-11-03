import type { HostPush, IpcChannel, Run, RunEvent, Session } from "@learningxxx/contracts";
import { INTENT_LABEL } from "./selection.ts";
import type { ComposerDraft } from "@learningxxx/contracts";

/**
 * Stand-in host for `?fixture` only, so the chat flow can be tried in a plain
 * browser. It answers session and run calls in memory and streams a canned
 * reply; it never runs the CLI or touches files. The real app uses preload.
 */
export function installFakeHost(courseTitle: string): void {
  const sessions: Session[] = [];
  const staged = new Map<string, { id: string; appSessionId: string; name: string; bytes: number; confirmed: boolean }>();
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

  const terminalOutput = new Map<string, { seq: number; data: string; closed: boolean }>();
  const handlers: Partial<Record<IpcChannel, (p: Record<string, unknown>) => Promise<unknown>>> = {
    "terminal.open": p => { const id = String(p.appSessionId); if (!terminalOutput.has(id)) terminalOutput.set(id, { seq: 1, data: '\x1b[1mClaude Code · 합성 화면\x1b[0m\r\n실제 계정이나 CLI를 사용하지 않는 UI 예제입니다.\r\n\r\n❯ ', closed: false }); return ok({ terminalId: id }); },
    "terminal.read": p => { const t = terminalOutput.get(String(p.terminalId))!; return ok({ chunks: Number(p.after) < t.seq ? [{ seq: t.seq, data: t.data }] : [], state: t.closed ? 'exited' : 'running', gap: false }); },
    "terminal.write": p => { const t = terminalOutput.get(String(p.terminalId))!; t.data = String(p.data) === '/' ? '\r\n /help       도움말\r\n /model      모델 선택\r\n /compact    문맥 압축\r\n /resume     세션 선택\r\n /skills     스킬 목록\r\n❯ /' : String(p.data); t.seq++; return ok({}); },
    "terminal.resize": () => ok({}),
    "terminal.close": p => { terminalOutput.get(String(p.terminalId))!.closed = true; return ok({}); },
    "terminal.stage": () => ok({ text: '합성 첨부 경로 예제' }),
    "session.list": () => ok({ sessions: [...sessions] }),
    "session.transcript": () => ok({ turns: [] }),
    "session.create": (p) => {
      const id = crypto.randomUUID();
      const session = {
        appSessionId: id, mode: p.mode, ...(p.engine ? { engine: p.engine } : {}), ...(p.mode === "course" ? { courseId: p.courseId } : {}),
        workspaceKey: p.engine === "native" ? `native-sessions/${id}` : p.mode === "course" ? `courses/${String(p.courseId)}/sessions/${id}` : `sessions/${id}`,
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
    "captures.start": (p) => {
      const item = { id: crypto.randomUUID(), appSessionId: String(p.appSessionId), name: "화면 캡처.png", bytes: 68, mediaType: "image/png", contentHash: "0".repeat(64), provenance: "capture", confirmed: false };
      staged.set(item.id, item);
      const preview = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
      return ok({ capture: { attachment: item, preview } });
    },
    "attachments.chooseLocal": (p) => {
      const item = { id: crypto.randomUUID(), appSessionId: String(p.appSessionId), name: "synthetic.txt", bytes: 42, mediaType: "text/plain", contentHash: "0".repeat(64), provenance: "local_file", confirmed: false };
      staged.set(item.id, item); return ok({ attachment: item });
    },
    "attachments.prepareAsset": (p) => {
      const item = { id: crypto.randomUUID(), appSessionId: String(p.appSessionId), name: "synthetic.pdf", bytes: 1200, mediaType: "application/pdf", contentHash: "0".repeat(64), provenance: "course_asset", confirmed: false };
      staged.set(item.id, item); return ok({ attachment: item });
    },
    "attachments.confirm": (p) => {
      const item = staged.get(String(p.attachmentId));
      if (!item || item.appSessionId !== p.appSessionId) return fail("SCOPE_VIOLATION", "다른 세션의 첨부입니다.");
      item.confirmed = true; return ok({ attachment: item });
    },
    "attachments.remove": (p) => ok({ removed: staged.delete(String(p.attachmentId)) }),
    "run.start": (p) => {
      const draft = p.draft as ComposerDraft;
      const session = sessions.find((s) => s.appSessionId === draft.targetSessionId);
      if (!session) return fail("NOT_FOUND", "세션을 찾을 수 없습니다.");
      if ([...runs.values()].some((r) => r.run.appSessionId === session.appSessionId && r.timer)) return fail("RUN_ALREADY_ACTIVE", "이 세션의 응답이 아직 끝나지 않았습니다.");
      const run = { runId: crypto.randomUUID(), appSessionId: session.appSessionId, requestId: String(p.requestId), startedAt: now(), status: "streaming" } as Run;
      const words = `(합성 응답 · 실제 번역 아님) ${INTENT_LABEL[draft.intent]} · ${session.mode === "independent" ? "독립 세션이라 과목 자료 없이" : `${courseTitle} 세션에서`} 답합니다: "${(draft.selection?.text ?? draft.text).slice(0, 80)}"`.split(" ");
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
    // Canned history so the file panel can be tried; nothing touches real files.
    "files.sessionChanges": (p) => ok({
      records: sessions.find((s) => s.appSessionId === p.appSessionId)?.mode === "course"
        ? [{ runId: crypto.randomUUID(), appSessionId: p.appSessionId, recordedAt: now(), snapshotKept: true, externalFolders: [], changes: [
            { key: "notes/summary.md", change: "created", restorable: true },
            { key: "notes/week1.md", change: "modified", restorable: true },
          ] }]
        : [],
    }),
    "files.chooseFolder": (p) => ok({ session: update(String(p.appSessionId), { externalFolders: ["/tmp/synthetic-folder"] }) }),
    "files.removeFolder": (p) => ok({ session: update(String(p.appSessionId), { externalFolders: [] }) }),
    "files.restore": () => ok({ restored: ["notes/week1.md", "notes/summary.md"], skipped: [] }),
    "files.trash": () => ok({ trashed: true }),
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
