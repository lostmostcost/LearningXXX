import { COMMANDS, COMMAND_HELP, commandSuggestions, parseCommand } from "./commands.ts";
import { MarkdownAnswer } from "./MarkdownAnswer.tsx";
import { Icon } from "./StudyUI.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ComposerDraft, Session } from "@learningxxx/contracts";
import { addTurn, applyEvent, emptyTranscript, errorHelp, isOpen, openRun, withHistory, type Transcript, type Turn } from "./chat.ts";
import { BLOCK_REASON, emptyDraft, freeze, viewingFor, restoreIfEmpty, sendBlock, visibleSessions, withSelection, withoutSelection, type Draft, type Attachment } from "./composer.ts";
import { capturePreview } from "./capture-preview.ts";
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
        {turn.sent.captureIds.length ? <p className="meta">확인한 캡처 {turn.sent.captureIds.length}개 포함</p> : null}
        {turn.sent.text}
      </div>
      <div className="answer" aria-live={isOpen(turn) ? "polite" : "off"}>
        <MarkdownAnswer text={turn.answer} />
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
 * message. Attachments are explicitly confirmed; captures use the same explicit confirmation.
 */
export function ChatPanel({ courseId, courseTitle, activeId, onActiveId: setActiveId, selectionRequest, onSelectionUsed, onOpenSelection, selectedAssets = [], viewing, snapshotPage }: {
  selectedAssets?: { id: string; name: string }[];
  /** The material open in the viewer; sent along to a session of this course only. */
  viewing?: ComposerDraft["viewing"];
  /** Draws the page on screen as a PNG, sent along with `viewing`. */
  snapshotPage?: (() => Promise<Uint8Array<ArrayBuffer> | undefined>) | undefined;
  courseId?: string | undefined; courseTitle?: string | undefined; activeId: string | undefined;
  onActiveId: (id: string) => void; selectionRequest?: SelectionRequest | undefined;
  onSelectionUsed: (id: string) => void; onOpenSelection: (s: SelectedText) => boolean;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const [notice, setNotice] = useState<string>();
  const [showArchived, setShowArchived] = useState(false);
  const commandLock = useRef(false);
  const currentContext = useRef({ courseId, activeId });
  currentContext.current = { courseId, activeId };
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [dismissedCommand, setDismissedCommand] = useState<string>();
  const composerInput = useRef<HTMLTextAreaElement>(null);
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

  // Earlier conversation of a session, once per session per window (it survives restarts on the host).
  const historyLoaded = useRef(new Set<string>());
  useEffect(() => {
    if (!activeId || historyLoaded.current.has(activeId)) return;
    historyLoaded.current.add(activeId);
    void invoke("session.transcript", { appSessionId: activeId }).then((result) => {
      if (result.ok) setTranscript((t) => withHistory(t, result.data.turns));
      else historyLoaded.current.delete(activeId);
    });
  }, [activeId]);

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
    if (mode === 'course' && !courseId) { setNotice('과목을 먼저 선택하세요.'); return false; }
    const originActive = activeId;
    const count = sessions.filter((s) => s.mode === mode).length + 1;
    const result =
      mode === "course" && courseId
        ? await invoke("session.create", { mode, courseId, title: `${courseTitle ?? "과목"} 세션 ${count}` })
        : await invoke("session.create", { mode: "independent", title: `독립 세션 ${count}` });
    if (!result.ok) { setNotice(result.error.message); return false; }
    await reload();
    if (currentContext.current.courseId === courseId && currentContext.current.activeId === originActive) setActiveId(result.data.session.appSessionId);
    return true;
  };

  const start = async (sent: ReturnType<typeof freeze>, viewingImage?: Uint8Array<ArrayBuffer>) => {
    const result = await invoke("run.start", { requestId: crypto.randomUUID(), draft: sent, ...(viewingImage ? { viewingImage } : {}) });
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
  const prepareCapture = async (replacing?: string) => {
    if (!active || running || (!replacing && draft.attachments.length >= 8)) return;
    const target = active.appSessionId, placeholder = crypto.randomUUID();
    setDrafts((d) => ({ ...d, [target]: { ...(d[target] ?? emptyDraft()), attachments: [...(d[target]?.attachments.filter((a) => a.id !== replacing) ?? []), { id: placeholder, name: "영역 선택 중… Esc로 취소", status: "preparing", kind: "capture" }] } }));
    const result = await invoke("captures.start", { appSessionId: target });
    if (!result.ok) return patchAttachment(target, placeholder, { id: placeholder, name: "캡처 실패", kind: "capture", status: "failed", error: result.error.message });
    const item = result.data.capture;
    patchAttachment(target, placeholder, item ? { id: item.attachment.id, name: item.attachment.name, bytes: item.attachment.bytes, kind: "capture", preview: capturePreview(item.preview), status: "unconfirmed" } : undefined);
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

  const suggestions = dismissedCommand === `${activeId}:${draft.text}` ? [] : commandSuggestions(draft.text);
  const insertCommand = (name: string) => {
    if (!active) return;
    setDraft(active.appSessionId, { ...draft, text: name + ' ' });
    composerInput.current?.focus();
  };
  const send = async () => {
    if (!active || commandLock.current) return;
    const command = parseCommand(draft.text);
    if (draft.text.trim() === '/') { setNotice(COMMAND_HELP); return; }
    if (command) {
      const known = COMMANDS.find(c => c.name === command.name);
      if (!known?.supported) { setNotice(known?.description ?? '지원하지 않는 앱 명령입니다. /help로 확인하세요. AI에게 전송하지 않았습니다.'); return; }
      const target = active.appSessionId;
      const clearCommand = () => setDrafts(ds => ds[target]?.text === draft.text ? { ...ds, [target]: { ...ds[target]!, text: '' } } : ds);
      if (command.name === '/help') { setNotice(COMMAND_HELP); clearCommand(); return; }
      if (command.name === '/resume') { if (sessionMenu.current) sessionMenu.current.open = true; clearCommand(); return; }
      if (command.name === '/status') { setNotice(`${active.mode === 'independent' ? '독립' : '과목'} 세션 · ${active.title} · ${running ? '응답 중' : active.status}`); clearCommand(); return; }
      if (running) { setNotice('응답이 끝난 뒤 실행하세요.'); return; }
      if (command.name === '/rename' && !command.args) { setRenaming(target); if (active.archivedAt) setShowArchived(true); if (sessionMenu.current) sessionMenu.current.open = true; clearCommand(); return; }
      commandLock.current = true;
      setCommandBusy(true);
      try {
        if (command.name === '/clear') { if (await create(active.mode)) clearCommand(); }
        if (command.name === '/rename') {
          const result = await invoke('session.rename', { appSessionId: target, title: command.args });
          if (result.ok) { await reload(); clearCommand(); } else setNotice(result.error.message);
        }
      } catch { setNotice('명령을 완료하지 못했습니다. 입력은 보존했습니다. 다시 시도하세요.'); }
      finally { commandLock.current = false; setCommandBusy(false); }
      return;
    }
    if (block) return;
    const target = active.appSessionId;
    const sent = freeze(draft, target, viewingFor(active, courseId, viewing));
    setDraft(target, emptyDraft());
    setNotice(undefined);
    // Only with a page: the image shows what the page's text alone may miss.
    const image = sent.viewing?.page ? await snapshotPage?.().catch(() => undefined) : undefined;
    // Refused before it started: give the text back to the same session only.
    if (!(await start(sent, image))) setDrafts((d) => ({ ...d, [target]: restoreIfEmpty(d[target], draft) }));
  };

  const shown = visibleSessions(
    sessions.filter((s) => showArchived || s.archivedAt === undefined),
    courseId,
  );
  const sessionMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (sessionMenu.current && event.target instanceof Node && !sessionMenu.current.contains(event.target)) sessionMenu.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
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
        <button className="entry" aria-pressed={s.appSessionId === activeId} onClick={() => { setActiveId(s.appSessionId); if (sessionMenu.current) { sessionMenu.current.open = false; sessionMenu.current.querySelector('summary')?.focus(); } }}>
          <span className="title">{s.title}</span>
          {s.archivedAt ? <span className="badge">보관됨</span> : null}
          {s.status === "interrupted" ? <span className="badge">중단됨</span> : null}
        </button>
      )}
    </li>
  );

  return (
    <div className="chat">
      <div className="session-toolbar">
        <details className="session-menu" ref={sessionMenu} onKeyDown={(e) => { if (e.key === 'Escape' && sessionMenu.current) { sessionMenu.current.open = false; sessionMenu.current.querySelector('summary')?.focus(); } }}>
          <summary aria-label="세션 목록"><Icon name="chat" /><span>{active?.title ?? '세션 선택'}</span><Icon name="chevron" /></summary>
          <div className="session-dropdown">
            <label className="meta"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> 보관된 세션 보기</label>
            {shown.course.length ? <><p className="meta">{courseTitle ?? "과목"}</p><ul className="entries">{shown.course.map(sessionButton)}</ul></> : null}
            {shown.independent.length ? <><p className="meta">독립 세션</p><ul className="entries">{shown.independent.map(sessionButton)}</ul></> : null}
            {!shown.course.length && !shown.independent.length ? <p className="meta">새 세션을 만들어 시작하세요.</p> : null}
          </div>
        </details>
        <button onClick={() => void create("course")} disabled={!courseId} aria-label="과목 세션 만들기" title={courseId ? "과목 세션 만들기" : "과목 자료를 먼저 수집하세요"}><Icon name="plus" /></button>
        <button onClick={() => void create("independent")} aria-label="독립 세션 만들기" title="독립 세션 만들기"><Icon name="independent" /></button>
      </div>
      {notice ? <p role="alert" className="notice-box chat-notice">{notice}</p> : null}
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
            <span className="meta">{active.mode === "independent" ? "독립 세션" : "과목 세션"}</span>
            <button aria-label="세션 이름 바꾸기" title="세션 이름 바꾸기" onClick={() => { setRenaming(active.appSessionId); if (active.archivedAt) setShowArchived(true); if (sessionMenu.current) sessionMenu.current.open = true; }}><Icon name="edit" /></button>
            <button
              aria-label={active.archivedAt ? "보관 해제" : "세션 보관"} title={active.archivedAt ? "보관 해제" : "세션 보관"}
              onClick={async () => {
                const r = await invoke("session.archive", { appSessionId: active.appSessionId, archived: active.archivedAt === undefined });
                if (!r.ok) setNotice(r.error.message);
                void reload();
              }}
            >
              <Icon name="archive" />
            </button>
          </div>
          {active.mode === "independent" ? (
            <p role="note" className="notice-box">독립 세션: 과목 자료, 이전 대화, 메모를 보지 않습니다. 직접 첨부한 것만 전달됩니다.</p>
          ) : null}
          <details className="file-tools" key={active.appSessionId}><summary aria-label="파일 작업" title="작업 폴더와 변경된 파일"><Icon name="folder" /></summary><FilesSection key={active.appSessionId} session={active} running={running} onChanged={() => void reload()} /></details>
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
                {item.preview ? <img className="capture-preview" src={item.preview} alt="보낼 캡처 미리보기" /> : null}
                <span>{item.name}{item.bytes !== undefined ? ` · ${item.bytes.toLocaleString()} bytes` : ""}</span>
                <span className="meta"> · {item.status === "ready" ? "확인됨" : item.status === "preparing" ? "준비 중" : item.status === "failed" ? item.error : `대상: ${active.title} · 이 파일을 보낼까요?`}</span>
                {item.status === "unconfirmed" ? <button onClick={() => void confirmAttachment(item)}>{item.kind === "capture" ? "캡처 확인" : "첨부 확인"}</button> : null}
                {item.kind === "capture" && item.status === "failed" ? <button disabled={running} onClick={() => void prepareCapture(item.id)}>다시 캡처</button> : null}
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
            {(() => {
              const shown = viewingFor(active, courseId, viewing);
              const name = shown && selectedAssets.find((a) => a.id === shown.assetId)?.name;
              return name ? <p className="meta">함께 전달: 지금 보는 자료 {name}{shown.page ? ` ${shown.page}쪽(화면 포함)` : ""}</p> : null;
            })()}
            {suggestions.length ? <div className="command-menu" role="listbox" id="slash-commands" aria-label="앱 명령어 · CLI 전체 명령과 다름">
              {suggestions.map((item, index) => <button type="button" role="option" id={`slash-option-${index}`} aria-selected={index === commandIndex % suggestions.length} aria-disabled={!item.supported} key={item.name} onMouseDown={e => e.preventDefault()} onClick={() => item.supported ? insertCommand(item.name) : setNotice(item.description)}><strong>{item.name}</strong><span>{item.description}</span></button>)}
            </div> : null}
            <textarea
              ref={composerInput}
              aria-label="메시지 입력"
              aria-controls={suggestions.length ? 'slash-commands' : undefined}
              aria-expanded={suggestions.length > 0}
              aria-activedescendant={suggestions.length ? `slash-option-${commandIndex % suggestions.length}` : undefined}
              value={draft.text}
              placeholder={active.mode === "independent" ? "독립 세션에 보낼 내용" : "자료에 대해 물어보세요"}
              onChange={(e) => { setCommandIndex(0); setDismissedCommand(undefined); setDraft(active.appSessionId, { ...draft, text: e.target.value }); }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (suggestions.length && !e.metaKey && !e.ctrlKey) {
                  if (e.key === 'Escape') { e.preventDefault(); setDismissedCommand(`${activeId}:${draft.text}`); return; }
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setCommandIndex(i => (i + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length); return; }
                  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); const choice = suggestions[commandIndex % suggestions.length]!; if (choice.supported) insertCommand(choice.name); else setNotice(choice.description); return; }
                }
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (parseCommand(draft.text) && !e.shiftKey))) { e.preventDefault(); void send(); }
              }}
            />
            <div className="composer-actions">
              <button disabled={running || draft.attachments.length >= 8} title="로컬 파일 첨부" aria-label="로컬 파일 첨부" onClick={() => void prepare()}><Icon name="plus"/></button>
              {selectedAssets.map((asset) => <button key={asset.id} title={`자료 첨부: ${asset.name}`} aria-label={`자료 첨부: ${asset.name}`} disabled={running || draft.attachments.length >= 8} onClick={() => void prepare(asset.id)}><Icon name="book" /></button>)}
              <button disabled={running || draft.attachments.length >= 8} title="화면 캡처" aria-label="화면 캡처" onClick={() => void prepareCapture()}><Icon name="capture"/></button>
              <button onClick={() => void send()} disabled={commandBusy || (parseCommand(draft.text) ? false : block !== undefined)} aria-describedby="send-block" aria-label="보내기" title="보내기"><Icon name="send"/></button>
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
