import { useEffect, useRef, useState } from 'react';
import type { IpcResponse, PreparedAttachment, Session } from '@learningxxx/contracts';
import { invoke } from './host-api.ts';
import { MarkdownAnswer } from './MarkdownAnswer.tsx';
import { ChatOutputs } from './ChatOutputs.tsx';
import { Icon } from './StudyUI.tsx';
import type { SelectionRequest } from './selection.ts';
import { INTENT_LABEL } from './selection.ts';
import { chatMarkdown, commandItems, MODE_LABEL, parseChatCommand } from './conversation-commands.ts';

type State = IpcResponse<'chat.state'>;
type Attachment = { id: string; name: string; text: string };
type Draft = { text: string; attachments: Attachment[] };
const emptyDraft = (): Draft => ({ text: '', attachments: [] });
/** `settings`: the notice offers to open that macOS Settings pane (WBS-080). */
type Note = { title: string; text: string; settings?: 'screen' | undefined };
type Rewind = { id: string; result: IpcResponse<'chat.rewind'> };

/** Session IDs are captured before every async action; switching views never retargets a send. */
export function RichChatPanel({ courseId, courseTitle, activeId, onActiveId, selectedAssets, selectionRequest, onSelectionUsed, viewing, fixed = false, blocked = false }: {
  courseId: string | undefined; courseTitle: string | undefined; activeId: string | undefined; onActiveId: (id: string) => void;
  selectedAssets: { id: string; name: string }[]; selectionRequest: SelectionRequest | undefined; onSelectionUsed: (id: string) => void;
  /** WBS-082: what is open in the viewer, sent with each message. */
  viewing?: { week?: string; title?: string; page?: number } | undefined;
  fixed?: boolean; blocked?: boolean;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [snapshot, setSnapshot] = useState<{ id: string; state: State }>();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [pending, setPending] = useState<{ sessionId: string; item: PreparedAttachment }>();
  const [rewind, setRewind] = useState<{ sessionId: string; item: Rewind }>();
  const [showArchived, setShowArchived] = useState(false);
  // WBS-081: the files panel, per conversation.
  const [outputsFor, setOutputsFor] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false), [commandIndex, setCommandIndex] = useState(0), [commandsHidden, setCommandsHidden] = useState(false);
  const [locked, setLocked] = useState<Set<string>>(new Set()), [creating, setCreating] = useState(false);
  const requests = useRef(new Map<string, { key: string; requestId: string }>());
  const [createError, setCreateError] = useState('');
  const locks = useRef(new Set<string>()), createLock = useRef(false), context = useRef({ courseId, activeId });
  context.current = { courseId, activeId };
  const input = useRef<HTMLTextAreaElement>(null), list = useRef<HTMLDivElement>(null), nearBottom = useRef(true);
  const commandMenu = useRef<HTMLDivElement>(null);
  const modelPicker = useRef<HTMLSelectElement>(null), effortPicker = useRef<HTMLSelectElement>(null), modePicker = useRef<HTMLSelectElement>(null), menu = useRef<HTMLDivElement>(null);
  const active = sessions.find(s => s.appSessionId === activeId && !s.archivedAt);
  const state = snapshot && snapshot.id === activeId ? snapshot.state : undefined;
  const draft = activeId ? drafts[activeId] ?? emptyDraft() : emptyDraft();
  const busy = !!activeId && locked.has(activeId);
  const note = activeId ? notes[activeId] : undefined;
  const items = commandItems(state?.commands ?? []);
  const commandMatch = /^\/([^\s]*)$/.exec(draft.text);
  const choices = commandMatch ? items.filter(c => c.name.startsWith(commandMatch[1]!.toLowerCase())) : [];
  const showCommands = !!state?.connected && !commandsHidden && choices.length > 0;
  useEffect(() => { if (showCommands) commandMenu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [showCommands, commandIndex, choices.length]);
  const setDraft = (id: string, fn: (old: Draft) => Draft) => setDrafts(old => ({ ...old, [id]: fn(old[id] ?? emptyDraft()) }));
  const tell = (id: string, title: string, text: string, settings?: Note['settings']) => setNotes(old => ({ ...old, [id]: { title, text, ...(settings ? { settings } : {}) } }));
  const accept = (id: string, value: State) => { if (context.current.activeId === id) setSnapshot({ id, state: value }); };
  const action = async (id: string, work: () => Promise<void>) => {
    if (locks.current.has(id)) return;
    locks.current.add(id); setLocked(new Set(locks.current));
    try { await work(); } catch { tell(id, '연결 오류', '요청을 완료하지 못했습니다. 전송 기록을 확인한 뒤 다시 시도하세요.'); }
    finally { locks.current.delete(id); setLocked(new Set(locks.current)); }
  };
  const reload = async () => {
    const r = await invoke('session.list', { includeArchived: true });
    if (r.ok) setSessions(r.data.sessions.filter(s => s.engine === 'chat'));
  };
  useEffect(() => { void reload(); }, [activeId, courseId]);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    nearBottom.current = true;
    if (!active) return;
    const id = active.appSessionId;
    const poll = async (open: boolean) => {
      try {
        const r = await invoke(open ? 'chat.open' : 'chat.state', { appSessionId: id });
        if (!alive) return;
        if (r.ok) { accept(id, r.data); timer = setTimeout(() => void poll(false), r.data.busy ? 120 : 600); }
        else tell(id, '연결할 수 없습니다', r.error.message);
      } catch { if (alive) tell(id, '연결이 끊겼습니다', '다시 연결을 눌러주세요. 보낸 작업은 자동 재전송하지 않습니다.'); }
    };
    void poll(true); return () => { alive = false; clearTimeout(timer); };
  }, [active?.appSessionId]);
  useEffect(() => { if (nearBottom.current && list.current) list.current.scrollTop = list.current.scrollHeight; }, [state?.messages, state?.permissions, note]);
  useEffect(() => { setCommandIndex(0); setCommandsHidden(false); }, [draft.text, activeId]);
  useEffect(() => { if (!menuOpen) return; const close = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node)) setMenuOpen(false); }; const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); }; document.addEventListener('pointerdown', close); document.addEventListener('keydown', esc); return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc); }; }, [menuOpen]);

  const create = async (independent = false) => {
    if (fixed) return;
    if (createLock.current) return;
    createLock.current = true; setCreating(true); const origin = { ...context.current };
    try {
      setCreateError('');
      const r = await invoke('session.create', independent || !courseId ? { mode: 'independent', engine: 'chat', title: `새 대화 ${sessions.filter(s => s.mode === 'independent').length + 1}` } : { mode: 'course', engine: 'chat', courseId, title: `${(courseTitle ?? '과목').slice(0, 150)} · 새 대화 ${sessions.filter(s => s.courseId === courseId).length + 1}` });
      if (r.ok) { await reload(); if (context.current.activeId === origin.activeId && context.current.courseId === origin.courseId) onActiveId(r.data.session.appSessionId); }
      else setCreateError(r.error.message);
    } catch { setCreateError('새 대화를 만들지 못했습니다. 다시 시도하세요.'); } finally { createLock.current = false; setCreating(false); }
  };
  const configure = (change: { model?: string; effort?: string; mode?: string }) => {
    if (!activeId) return;
    const id = activeId;
    void action(id, async () => {
      const r = await invoke('chat.configure', { appSessionId: id, ...change });
      if (r.ok) accept(id, r.data); else tell(id, '설정을 바꾸지 못했습니다', r.error.message);
    });
  };
  const attach = async (kind: 'local' | 'capture' | 'asset', assetId?: string) => {
    if (!activeId || pending) return;
    const id = activeId;
    await action(id, async () => {
      if (kind === 'capture') {
        const r = await invoke('captures.start', { appSessionId: id });
        if (r.ok && r.data.capture) setPending({ sessionId: id, item: r.data.capture.attachment });
        else if (!r.ok) tell(id, '캡처 실패', r.error.message, r.error.code === 'CAPTURE_PERMISSION_DENIED' ? 'screen' : undefined);
      } else {
        const r = kind === 'asset' && courseId && assetId ? await invoke('attachments.prepareAsset', { appSessionId: id, courseId, assetId }) : await invoke('attachments.chooseLocal', { appSessionId: id });
        if (r.ok && r.data.attachment) setPending({ sessionId: id, item: r.data.attachment });
        else if (!r.ok) tell(id, '첨부 실패', r.error.message);
      }
    });
  };
  const send = async () => {
    if (!activeId || !state?.connected || busy || blocked) return;
    const id = activeId, content = { ...draft, attachments: [...draft.attachments] }, command = parseChatCommand(content.text);
    if (pending && command?.name !== 'stop') return;
    if (!content.text.trim() && !content.attachments.length) return;
    if (state.busy && command?.name !== 'stop') return;
    if (command && content.attachments.length) return tell(id, '첨부가 남아 있습니다', '명령을 실행하기 전에 첨부를 전송하거나 제거하세요.');
    await action(id, async () => {
      const clear = () => setDraft(id, old => ({ ...old, text: old.text === content.text ? '' : old.text }));
      if (command) {
        const item = items.find(c => c.name === command.name);
        if (!item || !item.available) { tell(id, `/${command.name}`, '이 명령은 현재 채팅 연결에서 제공되지 않습니다. 고급 터미널에서 사용할 수 있습니다.'); return; }
        if (fixed && ['new', 'resume'].includes(item.action)) return tell(id, '과제 전용 대화', '새 대화는 초안 미리보기의 “새 과제 대화”를 사용하세요. 기존 대화와 초안 판은 보존됩니다.');
        if (['model', 'effort', 'mode', 'plan'].includes(item.action)) {
          if (!command.args && item.action !== 'plan') { ({ model: modelPicker, effort: effortPicker, mode: modePicker }[item.action])?.current?.focus(); clear(); return; }
          const change = item.action === 'plan' ? { mode: /^(off|default|normal)$/i.test(command.args) ? 'default' : 'plan' } : item.action === 'model' ? { model: command.args } : item.action === 'effort' ? { effort: command.args.toLowerCase() } : { mode: ({ normal: 'default', edit: 'acceptEdits', off: 'default' } as Record<string, string>)[command.args] ?? command.args };
          const r = await invoke('chat.configure', { appSessionId: id, ...change });
          if (!r.ok) return tell(id, '설정 변경 실패', r.error.message);
          accept(id, r.data);
          if (item.action === 'plan' && command.args && !/^(on|off|mode|plan|default|normal)$/i.test(command.args)) {
            const key = JSON.stringify(content);
            if (requests.current.get(id)?.key !== key) requests.current.set(id, { key, requestId: crypto.randomUUID() });
            const next = await invoke('chat.send', { appSessionId: id, text: command.args, requestId: requests.current.get(id)!.requestId });
            if (!next.ok) return tell(id, '계획 요청 실패', next.error.message);
            requests.current.delete(id); accept(id, next.data);
          }
          clear();
          return;
        }
        if (item.action === 'new') { if (state.busy) return; const closed = await invoke('chat.detach', { appSessionId: id }); if (!closed.ok) return tell(id, '새 대화', closed.error.message); await create(active?.mode === 'independent'); clear(); return; }
        if (item.action === 'resume') { setMenuOpen(true); clear(); return; }
        if (item.action === 'rename') {
          if (!command.args) return tell(id, '대화 이름', '/rename 뒤에 새 이름을 입력하세요.');
          const r = await invoke('session.rename', { appSessionId: id, title: command.args });
          if (!r.ok) return tell(id, '이름 변경 실패', r.error.message);
          await reload(); clear(); return;
        }
        if (['context', 'cost', 'usage', 'mcp', 'skills'].includes(item.action)) {
          const r = await invoke('chat.info', { appSessionId: id, kind: item.action as 'context' });
          if (!r.ok) return tell(id, item.label, r.error.message);
          tell(id, item.label, r.data.text); clear(); return;
        }
        if (item.action === 'help') { tell(id, '명령 안내', items.map(c => `- **/${c.name}** · ${c.label}${c.available ? '' : ' · 고급 터미널'}\n  ${c.description}`).join('\n')); clear(); return; }
        if (item.action === 'status') { tell(id, '현재 연결', `${state.connected ? '연결됨' : '연결 끊김'} · ${state.model || '기본 모델'} · ${state.effort} · ${MODE_LABEL[state.mode] ?? state.mode}\n일반 Claude Code 환경 · 전역 설정·기억 사용 · 격리 없음`); clear(); return; }
        if (item.action === 'copy') { await navigator.clipboard.writeText([...state.messages].reverse().find(m => m.role === 'assistant')?.text ?? ''); tell(id, '복사됨', '마지막 답변을 Markdown으로 복사했습니다.'); clear(); return; }
        if (item.action === 'export') { const url = URL.createObjectURL(new Blob([chatMarkdown(state.messages)], { type: 'text/markdown;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = 'YOLO-UNIV-chat.md'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); clear(); return; }
        if (item.action === 'rewind') { const message = [...state.messages].reverse().find(m => m.role === 'user'); if (!message) return tell(id, '복구할 체크포인트가 없습니다', '파일 작업을 요청한 메시지부터 사용할 수 있습니다.'); const r = await invoke('chat.rewind', { appSessionId: id, messageId: message.id, preview: true }); if (r.ok) { setRewind({ sessionId: id, item: { id: message.id, result: r.data } }); clear(); } else tell(id, '파일 복구', r.error.message); return; }
        if (item.action === 'stop') { const r = await invoke('chat.interrupt', { appSessionId: id }); if (r.ok) { accept(id, r.data); clear(); } else tell(id, '중지 실패', r.error.message); return; }
        content.text = `/${item.vendorName ?? item.name}${command.args ? ' ' + command.args : ''}`;
      }
      const key = JSON.stringify(content);
      if (requests.current.get(id)?.key !== key) requests.current.set(id, { key, requestId: crypto.randomUUID() });
      const r = await invoke('chat.send', { appSessionId: id, requestId: requests.current.get(id)!.requestId, text: [content.text, ...content.attachments.map(a => a.text)].filter(Boolean).join('\n\n'), ...(viewing ? { viewing } : {}) });
      if (r.ok) { requests.current.delete(id); accept(id, r.data); setDraft(id, old => ({ text: old.text === draft.text ? '' : old.text, attachments: old.attachments.filter(a => !content.attachments.some(b => b.id === a.id)) })); nearBottom.current = true; }
      else tell(id, '전송 실패', r.error.message);
    });
  };
  const currentModel = state?.models.find(m => m.value === state.model || m.resolvedModel === state.model);
  const disabled = blocked || busy || !!state?.busy || !state?.connected;

  return <section className="rich-chat" aria-label="Claude Code 채팅">
    {fixed ? <div className="session-toolbar assignment-chat-heading"><strong>과제 전용 · 전체 주차</strong><small>{active?.title ?? '과제 대화 준비 중…'}</small></div> : <div className="session-toolbar"><div className="session-menu" ref={menu}>
      <button className="session-toggle" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><span>{active?.title ?? '대화 선택'}</span><Icon name="chevron" /></button>
      {menuOpen ? <div className="session-dropdown" role="menu"><button aria-pressed={showArchived} title="보관한 대화 포함" aria-label="보관한 대화 포함" onClick={() => setShowArchived(!showArchived)}><Icon name="archive" />보관한 대화</button>{sessions.filter(s => (!s.archivedAt || showArchived) && (s.mode === 'independent' || s.courseId === courseId)).map(s => <button key={s.appSessionId} role="menuitem" aria-current={s.appSessionId === activeId} onClick={async () => { if (s.archivedAt) { const r = await invoke('session.archive', { appSessionId: s.appSessionId, archived: false }); if (!r.ok) return tell(s.appSessionId, '보관 해제 실패', r.error.message); await reload(); } onActiveId(s.appSessionId); setMenuOpen(false); }}><Icon name={s.mode === 'course' ? 'book' : 'chat'} /><span>{s.title}{s.archivedAt ? " · 보관됨" : ""}</span></button>)}{!sessions.length ? <p>새 대화를 시작하세요.</p> : null}</div> : null}
    </div><button title="새 과목 대화" aria-label="새 과목 대화" disabled={creating} onClick={() => void create()}><Icon name="plus" /></button><button title="새 일반 대화 · 격리 없음" aria-label="새 일반 대화" disabled={creating} onClick={() => void create(true)}><Icon name="independent" /></button>{active ? <button title="이 대화가 만든 파일" aria-label="이 대화가 만든 파일" aria-pressed={outputsFor === active.appSessionId} onClick={() => setOutputsFor(o => (o === active.appSessionId ? undefined : active.appSessionId))}><Icon name="folder" /></button> : null}{active ? <button title="대화 보관" aria-label="대화 보관" disabled={busy || !!state?.busy} onClick={() => { const id = active.appSessionId; void action(id, async () => { const r = await invoke('session.archive', { appSessionId: id, archived: true }); if (r.ok) { await reload(); if (context.current.activeId === id) onActiveId(''); } else tell(id, '보관 실패', r.error.message); }); }}><Icon name="archive" /></button> : null}</div>}

    {createError ? <p className="chat-error" role="alert">{createError}</p> : null}
    {active && outputsFor === active.appSessionId ? <ChatOutputs key={active.appSessionId} appSessionId={active.appSessionId} busy={!!state?.busy} onClose={() => setOutputsFor(undefined)} /> : null}
    {<>
      <div className="conversation-scroll" ref={list} onScroll={() => { if (list.current) nearBottom.current = list.current.scrollHeight - list.current.scrollTop - list.current.clientHeight < 80; }} role="log" aria-label="대화 기록">
        {!state?.messages.length ? <div className="chat-welcome"><span className="claude-spark">✳</span><h3>{fixed ? '과제를 함께 다듬어요' : '함께 생각해볼까요?'}</h3><p>{fixed ? '이 과목의 모든 주차 자료를 읽을 수 있습니다. 초안 작성·수정을 요청하면 미리보기에 반영됩니다.' : '자료에 관해 묻거나, / 로 도구를 찾아보세요.'}</p>{!active && !fixed ? <button onClick={() => void create()} disabled={creating}>대화 시작</button> : null}</div> : null}
        {state?.messages.map(m => <article key={m.id} className={`conversation-message ${m.role}`}><div className="message-author">{m.role === 'user' ? '나' : m.role === 'assistant' ? 'Claude' : 'Claude Code'}</div>{m.text ? <MarkdownAnswer text={m.text} /> : null}{m.tools.map(t => <details className="tool-card" key={t.id}><summary><Icon name="code" /><span>{t.name}</span><Icon name="chevron" /></summary><pre>{t.input}</pre></details>)}</article>)}
        {state?.permissions.map(p => <PermissionCard key={p.id} permission={p} disabled={busy} onAnswer={(allow, answers) => { if (!activeId) return; const id = activeId; void action(id, async () => { const r = await invoke('chat.answer', { appSessionId: id, permissionId: p.id, allow, ...(answers ? { answers } : {}) }); if (r.ok) accept(id, r.data); else tell(id, '확인 요청', r.error.message); }); }} />)}
        {state?.busy ? <div className="working-status" role="status"><span />{state.permissions.length ? '확인을 기다리고 있어요' : 'Claude가 작업하고 있어요'}</div> : null}
        {note ? <aside className="chat-info"><button title="안내 닫기" aria-label="안내 닫기" onClick={() => setNotes(old => { const next = { ...old }; delete next[activeId!]; return next; })}>×</button><strong>{note.title}</strong><MarkdownAnswer text={note.text} />{note.settings ? <button onClick={() => void invoke('app.openSettings', { pane: note.settings! })}>시스템 설정 열기</button> : null}</aside> : null}
        {state?.error ? <p className="chat-error" role="alert">{state.error}</p> : null}
        {active && !state?.connected ? <button disabled={busy} onClick={() => { const id = active.appSessionId; void action(id, async () => { const r = await invoke('chat.open', { appSessionId: id }); if (r.ok) accept(id, r.data); else tell(id, '연결 실패', r.error.message); }); }}><Icon name="refresh" /> 다시 연결</button> : null}
      </div>
      {selectionRequest ? <div className="chat-selection"><span>{INTENT_LABEL[selectionRequest.intent]} · {selectionRequest.selection.page}쪽</span><button disabled={!activeId || !!selectionRequest.targetSessionId && selectionRequest.targetSessionId !== activeId} title="선택 문장을 입력창에 추가" onClick={() => { if (!activeId) return; const r = selectionRequest; setDraft(activeId, d => ({ ...d, text: `${d.text}${d.text ? '\n\n' : ''}${INTENT_LABEL[r.intent]} · ${r.selection.page}쪽 선택 문장\n${r.selection.text}` })); onSelectionUsed(r.id); input.current?.focus(); }}>추가</button>{selectionRequest.targetSessionId && selectionRequest.targetSessionId !== activeId ? <small>선택 당시 대화에서 추가하세요.</small> : null}</div> : null}
      {pending && pending.sessionId === activeId ? <div className="attachment-confirm"><strong>{pending.item.name}</strong><small>읽기 전용 전달 사본을 준비합니다. 전송은 별도입니다.</small><button disabled={busy} onClick={() => { const p = pending; void action(p.sessionId, async () => { const confirm = await invoke('attachments.confirm', { appSessionId: p.sessionId, attachmentId: p.item.id }); if (!confirm.ok) return tell(p.sessionId, '첨부 실패', confirm.error.message); const r = await invoke('terminal.stage', { appSessionId: p.sessionId, attachmentId: p.item.id }); if (!r.ok) return tell(p.sessionId, '첨부 실패', r.error.message); setDraft(p.sessionId, d => ({ ...d, attachments: [...d.attachments, { id: p.item.id, name: p.item.name, text: r.data.text }] })); setPending(undefined); }); }}>첨부 확인</button><button disabled={busy} onClick={() => { const p = pending; void action(p.sessionId, async () => { const r = await invoke('attachments.remove', { appSessionId: p.sessionId, attachmentId: p.item.id }); if (r.ok) setPending(undefined); else tell(p.sessionId, '첨부 취소 실패', r.error.message); }); }}>취소</button></div> : null}
      {rewind && rewind.sessionId === activeId ? <div className="attachment-confirm"><strong>파일 복구 미리보기</strong><pre>{rewind.item.result.error ?? ((rewind.item.result.filesChanged ?? []).join('\n') || '변경할 파일이 없습니다.')}</pre><small>체크포인트에 기록된 파일만 복구합니다. 새로 만든 파일은 삭제됩니다. Bash·외부 변경과 대화 기록은 복구하지 않습니다.</small><button disabled={busy || !rewind.item.result.canRewind || !rewind.item.result.filesChanged?.length} onClick={() => { const target = rewind; void action(target.sessionId, async () => { const r = await invoke('chat.rewind', { appSessionId: target.sessionId, messageId: target.item.id, preview: false }); if (r.ok) { tell(target.sessionId, '파일 복구', r.data.canRewind ? `엔진이 파일 복구를 완료했습니다.${r.data.skippedLinks ? ' 안전하게 복구할 수 없어 제외한 파일: ' + r.data.skippedLinks + '개' : ''}` : r.data.error ?? '복구하지 못했습니다.'); setRewind(undefined); } else tell(target.sessionId, '복구 실패', r.error.message); }); }}>이 파일 복구</button><button onClick={() => setRewind(undefined)}>취소</button></div> : null}
      {activeId ? <div className="rich-composer"><div className="composer">
        {showCommands ? <div ref={commandMenu} id="chat-command-menu" className="command-menu" role="listbox" aria-label="Claude Code 명령">{choices.map((c, i) => <button id={`chat-command-${i}`} key={c.name} type="button" role="option" aria-selected={i === commandIndex} onMouseDown={e => e.preventDefault()} onClick={() => { setDraft(activeId, d => ({ ...d, text: '/' + c.name + ' ' })); input.current?.focus(); }}><strong>/{c.name} <em>{c.label}</em></strong><span>{c.available ? c.description : '고급 터미널에서 사용'}</span></button>)}</div> : null}
        {draft.attachments.length ? <div className="attachment-chips">{draft.attachments.map(a => <span key={a.id}><Icon name="book" />{a.name}<button title="입력에서 첨부 제거" aria-label="입력에서 첨부 제거" onClick={() => setDraft(activeId, d => ({ ...d, attachments: d.attachments.filter(x => x.id !== a.id) }))}>×</button></span>)}</div> : null}
        <textarea ref={input} value={draft.text} disabled={!state?.connected || blocked} maxLength={90000} aria-label="Claude에게 메시지" aria-controls={showCommands ? "chat-command-menu" : undefined} aria-activedescendant={showCommands ? `chat-command-${Math.min(commandIndex, choices.length - 1)}` : undefined} placeholder={blocked ? '초안 생성 완료 후 수정할 수 있습니다.' : fixed ? '과제 초안을 어떻게 수정할까요?' : '무엇이든 물어보세요. / 명령'} onChange={e => setDraft(activeId, d => ({ ...d, text: e.target.value }))} onKeyDown={e => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') { setCommandsHidden(true); return; }
          if (showCommands && ['ArrowDown', 'ArrowUp', 'Tab', 'Enter'].includes(e.key)) { e.preventDefault(); if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setCommandIndex(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length); else { setDraft(activeId, d => ({ ...d, text: '/' + choices[Math.min(commandIndex, choices.length - 1)]!.name + ' ' })); } return; }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
        }} />
        <div className="composer-actions"><button disabled={busy || !!pending} aria-label="파일 첨부" title="파일 첨부" onClick={() => void attach('local')}><Icon name="plus" /></button><button disabled={busy || !!pending} aria-label="화면 캡처" title="화면 캡처" onClick={() => void attach('capture')}><Icon name="capture" /></button>{selectedAssets.map(a => <button key={a.id} disabled={busy || !!pending} title={`자료 첨부: ${a.name}`} aria-label={`자료 첨부: ${a.name}`} onClick={() => void attach('asset', a.id)}><Icon name="book" /></button>)}<span className="composer-spacer" />{state?.busy ? <button disabled={busy} className="send-button" aria-label="응답 중지" title="응답 중지" onClick={() => { const id = activeId; void action(id, async () => { const r = await invoke('chat.interrupt', { appSessionId: id }); if (r.ok) accept(id, r.data); else tell(id, '중지 실패', r.error.message); }); }}><Icon name="stop" /></button> : <button className="send-button" disabled={blocked || busy || !state?.connected || !!pending || !draft.text.trim() && !draft.attachments.length} aria-label="메시지 전송" title="메시지 전송" onClick={() => void send()}><Icon name="send" /></button>}</div>
      </div><div className="chat-controls"><select ref={modelPicker} aria-label="모델" title="/model" disabled={disabled} value={currentModel?.value ?? ''} onChange={e => configure({ model: e.target.value })}><option value="" disabled>기본 모델</option>{state?.models.map(m => <option key={m.value} value={m.value}>{m.displayName}</option>)}</select><select ref={effortPicker} aria-label="추론 강도" title="/effort · 다음 요청부터" disabled={disabled || !currentModel} value={state?.effort ?? 'default'} onChange={e => configure({ effort: e.target.value })}><option value="default">기본 강도</option>{currentModel?.supportedEffortLevels?.map(l => <option key={l} value={l}>{l}</option>)}</select><select ref={modePicker} aria-label="실행 모드" title="/plan · /permissions" disabled={disabled} value={state?.mode ?? 'default'} onChange={e => configure({ mode: e.target.value })}>{Object.entries(MODE_LABEL).filter(([key]) => key !== 'auto' || currentModel?.supportsAutoMode).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div><div className="chat-environment">Claude Code · 구독 로그인 · 일반 환경{state?.mode === 'acceptEdits' ? ' · 파일 편집 자동 승인' : ''}</div></div> : null}
    </>}
  </section>;
}

function PermissionCard({ permission, disabled, onAnswer }: { permission: State['permissions'][number]; disabled: boolean; onAnswer: (allow: boolean, answers?: Record<string, string>) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = permission.tool === 'AskUserQuestion' && Array.isArray(permission.input.questions) ? permission.input.questions.filter((q): q is { question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean } => !!q && typeof q === 'object' && typeof q.question === 'string').map(q => ({ ...q, options: Array.isArray(q.options) ? q.options.filter(o => !!o && typeof o.label === 'string').map(o => ({ label: o.label, description: typeof o.description === 'string' ? o.description : '' })) : [] })) : [];
  return <section className="permission-card"><strong>{questions.length ? 'Claude의 질문' : '실행 확인'} · {permission.tool}</strong>{questions.length ? questions.map((q, i) => <label key={i}><span>{q.question}</span>{q.options?.filter(o => typeof o.label === 'string').map(o => <button key={o.label} type="button" disabled={disabled} title={o.description} aria-pressed={(answers[q.question] ?? '').split(', ').includes(o.label)} onClick={() => setAnswers(old => { const selected = (old[q.question] ?? '').split(', ').filter(Boolean); return { ...old, [q.question]: q.multiSelect ? (selected.includes(o.label) ? selected.filter(x => x !== o.label) : [...selected, o.label]).join(', ') : o.label }; })}>{o.label}</button>)}<input value={answers[q.question] ?? ''} placeholder="직접 입력" onChange={e => setAnswers(old => ({ ...old, [q.question]: e.target.value }))} /></label>) : <pre>{JSON.stringify(permission.input, null, 2)}</pre>}<div><button disabled={disabled} onClick={() => onAnswer(false)}>거부</button><button disabled={disabled || questions.some(q => !answers[q.question]?.trim())} onClick={() => onAnswer(true, questions.length ? answers : undefined)}>{questions.length ? '답변 보내기' : '이번 요청 허용'}</button></div></section>;
}
