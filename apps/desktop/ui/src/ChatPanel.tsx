import { useCallback, useEffect, useState } from "react";
import type { Session } from "@learningxxx/contracts";
import { addTurn, applyEvent, emptyTranscript, errorHelp, isOpen, openRun, type Transcript, type Turn } from "./chat.ts";
import { BLOCK_REASON, emptyDraft, freeze, sendBlock, visibleSessions, type Draft } from "./composer.ts";
import { invoke, onHostPush } from "./host-api.ts";

const STATE_LABEL = { waiting: "응답을 기다리는 중…", streaming: "응답 중…", completed: "", failed: "실패", cancelled: "취소됨" } as const;
const DECISION_LABEL = { allowed: "허용", denied: "거부됨", awaiting_user: "확인 필요" } as const;

function TurnView({ turn, onCancel, onRetry }: { turn: Turn; onCancel: () => void; onRetry: () => void }) {
  const help = turn.error ? errorHelp(turn.error) : undefined;
  return (
    <li className={`turn ${turn.state}`}>
      <div className="you">
        {turn.sent.selection ? <blockquote>{turn.sent.selection.text}</blockquote> : null}
        {turn.sent.text}
      </div>
      <div className="answer" aria-live={isOpen(turn) ? "polite" : "off"}>
        {turn.answer}
        {turn.tools.map((t, i) => (
          <p key={i} className="meta">도구 {t.tool} {t.targets.join(", ")} · {DECISION_LABEL[t.decision]}</p>
        ))}
        {turn.artifacts.length ? <p className="meta">만든·바꾼 파일: {turn.artifacts.join(", ")}</p> : null}
        {STATE_LABEL[turn.state] ? <p className="meta">{STATE_LABEL[turn.state]}</p> : null}
        {help ? <p role="alert" className="notice-box">{help.text}</p> : null}
        {isOpen(turn) ? <button onClick={onCancel}>취소</button> : null}
        {help?.retry ? <button onClick={onRetry} title="보냈던 내용과 같은 요청을 새로 보냅니다">같은 내용으로 다시 보내기</button> : null}
      </div>
    </li>
  );
}

/**
 * Sessions and free chat (WBS-016). Drafts are kept per session and frozen at
 * send time with their target session, so a session switch never re-routes a
 * message. Attachments and captures need host support and are not sent yet.
 */
export function ChatPanel({ courseId, courseTitle }: { courseId?: string | undefined; courseTitle?: string | undefined }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const [notice, setNotice] = useState<string>();
  const [showArchived, setShowArchived] = useState(false);
  const [renaming, setRenaming] = useState<string>();

  const reload = useCallback(async () => {
    const result = await invoke("session.list", { includeArchived: true });
    if (result.ok) setSessions(result.data.sessions);
    else setNotice(result.error.message);
  }, []);

  useEffect(() => {
    void reload();
    return onHostPush((push) => {
      if (push.kind !== "run.event") return;
      setTranscript((t) => applyEvent(t, push.event));
      if (push.event.type === "run.completed" || push.event.type === "run.failed" || push.event.type === "run.cancelled") void reload();
    });
  }, [reload]);

  const active = sessions.find((s) => s.appSessionId === activeId);
  const draft = (activeId && drafts[activeId]) || emptyDraft();
  const running = openRun(transcript, activeId) !== undefined;
  const block = sendBlock(draft, active, running);
  const setDraft = (id: string, next: Draft) => setDrafts((d) => ({ ...d, [id]: next }));

  const create = async (mode: "course" | "independent") => {
    const count = sessions.filter((s) => s.mode === mode).length + 1;
    const result =
      mode === "course" && courseId
        ? await invoke("session.create", { mode, courseId, title: `${courseTitle ?? "과목"} 세션 ${count}` })
        : await invoke("session.create", { mode: "independent", title: `독립 세션 ${count}` });
    if (!result.ok) return setNotice(result.error.message);
    await reload();
    setActiveId(result.data.session.appSessionId);
  };

  const start = async (sent: ReturnType<typeof freeze>) => {
    const result = await invoke("run.start", { requestId: crypto.randomUUID(), draft: sent });
    if (!result.ok) {
      setNotice(result.error.message);
      return false;
    }
    setTranscript((t) => addTurn(t, result.data.run, sent));
    return true;
  };

  const send = async () => {
    if (!active || block) return;
    const target = active.appSessionId;
    const sent = freeze(draft, target);
    setDraft(target, emptyDraft());
    setNotice(undefined);
    // Refused before it started: give the text back to the same session only.
    if (!(await start(sent))) setDrafts((d) => (d[target]?.text ? d : { ...d, [target]: { ...emptyDraft(), text: sent.text } }));
  };

  const shown = visibleSessions(
    sessions.filter((s) => showArchived || s.archivedAt === undefined),
    courseId,
  );
  const sessionButton = (s: Session) => (
    <li key={s.appSessionId}>
      {renaming === s.appSessionId ? (
        <input
          aria-label="세션 이름"
          defaultValue={s.title}
          autoFocus
          onKeyDown={async (e) => {
            if (e.key === "Escape") setRenaming(undefined);
            if (e.key !== "Enter" || !e.currentTarget.value.trim()) return;
            const r = await invoke("session.rename", { appSessionId: s.appSessionId, title: e.currentTarget.value.trim() });
            if (!r.ok) setNotice(r.error.message);
            setRenaming(undefined);
            void reload();
          }}
        />
      ) : (
        <button className="entry" aria-pressed={s.appSessionId === activeId} onClick={() => setActiveId(s.appSessionId)}>
          <span className="title">{s.title}</span>
          {s.archivedAt ? <span className="badge">보관됨</span> : null}
          {s.status === "interrupted" ? <span className="badge">중단됨</span> : null}
        </button>
      )}
    </li>
  );

  return (
    <div className="chat">
      <h2>채팅</h2>
      <div className="session-actions">
        <button onClick={() => void create("course")} disabled={!courseId} title={courseId ? "" : "과목 자료를 먼저 수집하세요"}>과목 세션 만들기</button>
        <button onClick={() => void create("independent")}>독립 세션 만들기</button>
        <label className="meta"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> 보관된 세션 보기</label>
      </div>
      {shown.course.length ? <><p className="meta">{courseTitle ?? "과목"}</p><ul className="entries">{shown.course.map(sessionButton)}</ul></> : null}
      {shown.independent.length ? <><p className="meta">독립 세션</p><ul className="entries">{shown.independent.map(sessionButton)}</ul></> : null}
      {notice ? <p role="alert" className="notice-box">{notice}</p> : null}

      {active ? (
        <>
          <div className="session-head">
            <strong>{active.title}</strong>
            <button onClick={() => setRenaming(active.appSessionId)}>이름 바꾸기</button>
            <button
              onClick={async () => {
                const r = await invoke("session.archive", { appSessionId: active.appSessionId, archived: active.archivedAt === undefined });
                if (!r.ok) setNotice(r.error.message);
                void reload();
              }}
            >
              {active.archivedAt ? "보관 해제" : "보관"}
            </button>
          </div>
          {active.mode === "independent" ? (
            <p role="note" className="notice-box">독립 세션: 과목 자료, 이전 대화, 메모를 보지 않습니다. 직접 첨부한 것만 전달됩니다.</p>
          ) : null}
          <ol className="transcript">
            {transcript.turns.filter((t) => t.appSessionId === active.appSessionId).map((turn) => (
              <TurnView
                key={turn.runId}
                turn={turn}
                onCancel={() => void invoke("run.cancel", { runId: turn.runId })}
                onRetry={() => void start(turn.sent)}
              />
            ))}
          </ol>
          <div className="composer">
            {draft.selection ? <blockquote>{draft.selection.text}</blockquote> : null}
            <textarea
              aria-label="메시지 입력"
              value={draft.text}
              placeholder={active.mode === "independent" ? "독립 세션에 보낼 내용" : "자료에 대해 물어보세요"}
              onChange={(e) => setDraft(active.appSessionId, { ...draft, text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
              }}
            />
            <div className="composer-actions">
              <button disabled title="첨부 전달은 host 지원 후 제공됩니다">자료 첨부</button>
              <button disabled title="화면 캡처는 host 지원 후 제공됩니다">화면 캡처</button>
              <button onClick={() => void send()} disabled={block !== undefined} aria-describedby="send-block">보내기</button>
            </div>
            <p id="send-block" className="meta">{block && block !== "empty" ? BLOCK_REASON[block] : "⌘+Enter로 보내기"}</p>
          </div>
        </>
      ) : (
        <p>세션을 고르거나 새로 만드세요. 과목 세션은 이 과목에서 이어지는 대화이고, 독립 세션은 아무 문맥 없이 시작합니다.</p>
      )}
    </div>
  );
}
