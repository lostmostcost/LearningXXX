import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@learningxxx/contracts";
import { addTurn, applyEvent, emptyTranscript, errorHelp, isOpen, openRun, type Transcript, type Turn } from "./chat.ts";
import { BLOCK_REASON, emptyDraft, freeze, restoreIfEmpty, sendBlock, visibleSessions, withSelection, withoutSelection, type Draft, type Attachment } from "./composer.ts";
import { FilesSection } from "./FilesSection.tsx";
import { invoke, onHostPush } from "./host-api.ts";
import { INTENT_LABEL, type SelectedText, type SelectionRequest } from "./selection.ts";

const STATE_LABEL = { waiting: "응답을 기다리는 중…", streaming: "응답 중…", completed: "", failed: "실패", cancelled: "취소됨" } as const;
const DECISION_LABEL = { allowed: "허용", denied: "거부됨", awaiting_user: "확인 필요" } as const;

function TurnView({ turn, onCancel, onRetry, onOpenSelection }: { turn: Turn; onCancel: () => void; onRetry: () => void; onOpenSelection: (s: SelectedText) => void }) {
  const help = turn.error ? errorHelp(turn.error) : undefined;
  return (
    <li className={`turn ${turn.state}`}>
      <div className="you">
        {turn.sent.selection ? <>
          <p className="meta">{INTENT_LABEL[turn.sent.intent]} · {turn.sent.selection.page ?? "?"}쪽
            <button onClick={() => onOpenSelection(turn.sent.selection!)}>원문 보기</button></p>
          <blockquote>{turn.sent.selection.text}</blockquote>
        </> : null}
        {turn.sent.attachmentIds.length ? <p className="meta">확인한 첨부 {turn.sent.attachmentIds.length}개 포함</p> : null}
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
 * message. Attachments are explicitly confirmed; captures still need host support.
 */
export function ChatPanel({ courseId, courseTitle, activeId, onActiveId: setActiveId, selectionRequest, onSelectionUsed, onOpenSelection, selectedAssets = [] }: {
  selectedAssets?: { id: string; name: string }[];
  courseId?: string | undefined; courseTitle?: string | undefined; activeId: string | undefined;
  onActiveId: (id: string) => void; selectionRequest?: SelectionRequest | undefined;
  onSelectionUsed: (id: string) => void; onOpenSelection: (s: SelectedText) => boolean;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const [notice, setNotice] = useState<string>();
  const [showArchived, setShowArchived] = useState(false);
  const [renaming, setRenaming] = useState<string>();
  const handledSelection = useRef<string | undefined>(undefined);

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

  useEffect(() => {
    if (!selectionRequest || handledSelection.current === selectionRequest.id) return;
    handledSelection.current = selectionRequest.id;
    // Bind to the session captured at the PDF action, not a later session switch.
    const target = sessions.find((s) => s.appSessionId === selectionRequest.targetSessionId);
    if (!target || target.archivedAt) return; // An explicit target choice is shown below.
    setDrafts((d) => ({ ...d, [target.appSessionId]: withSelection(d[target.appSessionId] ?? emptyDraft(), selectionRequest.selection, selectionRequest.intent) }));
    onSelectionUsed(selectionRequest.id);
  }, [selectionRequest, sessions, onSelectionUsed]);

  const openSource = (selection: SelectedText) => {
    if (!onOpenSelection(selection)) setNotice("현재 자료 목록에서 원문을 찾지 못했습니다. 다시 수집하거나 자료 목록을 확인하세요.");
  };

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

  const patchAttachment = (target: string, id: string, patch?: Attachment) => setDrafts((d) => {
    const current = d[target] ?? emptyDraft();
    return { ...d, [target]: { ...current, attachments: current.attachments.flatMap((a) => a.id === id ? (patch ? [patch] : []) : [a]) } };
  });
  const prepare = async (assetId?: string) => {
    if (!active || running || draft.attachments.length >= 8) return;
    const target = active.appSessionId, placeholder = crypto.randomUUID();
    setDrafts((d) => ({ ...d, [target]: { ...(d[target] ?? emptyDraft()), attachments: [...(d[target]?.attachments ?? []), { id: placeholder, name: "첨부 준비 중…", status: "preparing" }] } }));
    const result = assetId && courseId
      ? await invoke("attachments.prepareAsset", { appSessionId: target, courseId, assetId })
      : await invoke("attachments.chooseLocal", { appSessionId: target });
    if (!result.ok) return patchAttachment(target, placeholder, { id: placeholder, name: "첨부 준비 실패", status: "failed", error: result.error.message });
    const item = result.data.attachment;
    patchAttachment(target, placeholder, item ? { id: item.id, name: item.name, bytes: item.bytes, status: "unconfirmed" } : undefined);
  };
  const confirmAttachment = async (item: Attachment) => {
    if (!active) return;
    const target = active.appSessionId;
    patchAttachment(target, item.id, { ...item, status: "preparing" });
    const result = await invoke("attachments.confirm", { appSessionId: target, attachmentId: item.id });
    patchAttachment(target, item.id, result.ok ? { ...item, status: "ready" } : { ...item, status: "failed", error: result.error.message });
  };
  const removeAttachment = async (item: Attachment) => {
    if (!active || item.status === "preparing") return;
    const target = active.appSessionId;
    if (item.status !== "failed") {
      const result = await invoke("attachments.remove", { appSessionId: target, attachmentId: item.id });
      if (!result.ok) setNotice(result.error.message);
    }
    patchAttachment(target, item.id);
  };

  const send = async () => {
    if (!active || block) return;
    const target = active.appSessionId;
    const sent = freeze(draft, target);
    setDraft(target, emptyDraft());
    setNotice(undefined);
    // Refused before it started: give the text back to the same session only.
    if (!(await start(sent))) setDrafts((d) => ({ ...d, [target]: restoreIfEmpty(d[target], draft) }));
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
      {selectionRequest ? <div className="notice-box selection-preview">
        <p>{INTENT_LABEL[selectionRequest.intent]} · {selectionRequest.selection.page}쪽 선택 문장</p>
        <blockquote>{selectionRequest.selection.text}</blockquote>
        <p>대상 세션을 고른 뒤 초안에 넣으세요. 아직 전송하지 않았습니다.</p>
        <button disabled={!active || active.archivedAt !== undefined} onClick={() => {
          if (!active || active.archivedAt) return;
          setDraft(active.appSessionId, withSelection(draft, selectionRequest.selection, selectionRequest.intent));
          onSelectionUsed(selectionRequest.id);
        }}>이 세션의 초안에 넣기</button>
        <button onClick={() => onSelectionUsed(selectionRequest.id)}>선택 취소</button>
      </div> : null}

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
          <FilesSection key={active.appSessionId} session={active} running={running} onChanged={() => void reload()} />
          <ol className="transcript">
            {transcript.turns.filter((t) => t.appSessionId === active.appSessionId).map((turn) => (
              <TurnView
                key={turn.runId}
                turn={turn}
                onCancel={() => void invoke("run.cancel", { runId: turn.runId })}
                onRetry={() => void start(turn.sent)}
                onOpenSelection={openSource}
              />
            ))}
          </ol>
          <div className="composer">
            {draft.attachments.length ? <ul aria-label="보낼 첨부" className="entries">
              {draft.attachments.map((item) => <li key={item.id}>
                <span>{item.name}{item.bytes !== undefined ? ` · ${item.bytes.toLocaleString()} bytes` : ""}</span>
                <span className="meta"> · {item.status === "ready" ? "확인됨" : item.status === "preparing" ? "준비 중" : item.status === "failed" ? item.error : `대상: ${active.title} · 이 파일을 보낼까요?`}</span>
                {item.status === "unconfirmed" ? <button onClick={() => void confirmAttachment(item)}>첨부 확인</button> : null}
                <button disabled={running || item.status === "preparing"} onClick={() => void removeAttachment(item)}>첨부 빼기</button>
              </li>)}
            </ul> : null}
            {draft.selection ? <div className="selection-preview">
              <label>선택 문장 작업 <select aria-label="선택 문장 작업" value={draft.intent} onChange={(e) => setDraft(active.appSessionId, { ...draft, intent: e.target.value as Draft["intent"] })}>
                {Object.entries(INTENT_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select></label>
              <span className="meta"> · {draft.selection.page ?? "?"}쪽 · 선택한 문장만 포함</span>
              <blockquote>{draft.selection.text}</blockquote>
              <button onClick={() => openSource(draft.selection!)}>원문 보기</button>
              <button onClick={() => setDraft(active.appSessionId, withoutSelection(draft))}>선택 문장 빼기</button>
            </div> : null}
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
              <button disabled={running || draft.attachments.length >= 8} onClick={() => void prepare()}>로컬 파일 첨부</button>
              {selectedAssets.map((asset) => <button key={asset.id} disabled={running || draft.attachments.length >= 8} onClick={() => void prepare(asset.id)}>자료 첨부: {asset.name}</button>)}
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
