import { useEffect, useRef, useState } from 'react';
import type { PreparedAttachment, Session } from '@learningxxx/contracts';
import { NativeTerminal } from './NativeTerminal.tsx';
import { Icon } from './StudyUI.tsx';
import { invoke } from './host-api.ts';
import type { SelectionRequest } from './selection.ts';
import { INTENT_LABEL } from './selection.ts';
export function NativeChatPanel({ courseId, courseTitle, activeId, onActiveId, selectionRequest, onSelectionUsed, selectedAssets }: {
  selectedAssets: { id: string; name: string }[];
  courseId: string | undefined; courseTitle: string | undefined; activeId: string | undefined; onActiveId: (id: string) => void;
  selectionRequest: SelectionRequest | undefined; onSelectionUsed: (id: string) => void;
}) {
  const context = useRef({ courseId, activeId }); context.current = { courseId, activeId };
  const [pending, setPending] = useState<{ sessionId: string; item: PreparedAttachment }>();
  const createLock = useRef(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]), [notice, setNotice] = useState('');
  const reload = async () => { const r = await invoke('session.list', { includeArchived: false }); if (r.ok) setSessions(r.data.sessions.filter(s => s.engine === 'native')); else setNotice(r.error.message); };
  useEffect(() => { void reload(); }, [courseId, activeId]);
  const active = sessions.find(s => s.appSessionId === activeId);
  const create = async (independent = false) => {
    if (createLock.current) return;
    createLock.current = true; setCreating(true);
    const origin = { courseId, activeId };
    try {
      const r = await invoke('session.create', independent || !courseId ? { mode: 'independent', engine: 'native', title: `일반 Claude Code 대화 ${sessions.filter(s => s.mode === 'independent').length + 1}` } : { mode: 'course', engine: 'native', courseId, title: `${(courseTitle ?? '과목').slice(0, 150)} · Claude Code ${sessions.filter(s => s.courseId === courseId).length + 1}` });
      if (r.ok) { await reload(); if (context.current.courseId === origin.courseId && context.current.activeId === origin.activeId) onActiveId(r.data.session.appSessionId); } else setNotice(r.error.message);
    } catch { setNotice('새 대화를 만들지 못했습니다. 다시 시도하세요.'); }
    finally { createLock.current = false; setCreating(false); }
  };
  const attach = async (assetId?: string) => {
    if (!active || busy) return;
    setBusy(true);
    try {
      const r = assetId && courseId ? await invoke('attachments.prepareAsset', { appSessionId: active.appSessionId, courseId, assetId }) : await invoke('attachments.chooseLocal', { appSessionId: active.appSessionId });
      if (r.ok && r.data.attachment) setPending({ sessionId: active.appSessionId, item: r.data.attachment });
      else if (!r.ok) setNotice(r.error.message);
    } catch { setNotice('첨부를 준비하지 못했습니다.'); } finally { setBusy(false); }
  };
  return <div className="native-chat"><div className="native-session-bar"><select aria-label="Claude Code 세션" value={activeId ?? ''} onChange={e => onActiveId(e.target.value)}><option value="" disabled>세션 선택</option>{sessions.filter(s => s.mode === 'independent' || s.courseId === courseId).map(s => <option key={s.appSessionId} value={s.appSessionId}>{s.title}</option>)}</select><button disabled={creating} aria-label="새 과목 대화" title="새 과목 대화" onClick={() => void create()}><Icon name="plus" /></button><button disabled={creating} aria-label="새 일반 대화" title="새 일반 대화 · 격리 없음" onClick={() => void create(true)}><Icon name="independent" /></button></div>
    <p className="native-mode-note">Claude Code · 일반 환경 · 권한은 CLI에서 확인</p>
    {notice ? <p role="alert">{notice}</p> : null}
    {selectionRequest ? <div className="selection-preview"><span>{INTENT_LABEL[selectionRequest.intent]} · {selectionRequest.selection.page}쪽</span><button onClick={async () => { try { await navigator.clipboard.writeText(`${INTENT_LABEL[selectionRequest.intent]}\n${selectionRequest.selection.text}`); onSelectionUsed(selectionRequest.id); setNotice('선택 문장을 복사했습니다. Claude Code 입력창에 붙여넣으세요.'); } catch { setNotice('복사하지 못했습니다. 다시 시도하세요.'); } }}>선택 문장 복사</button></div> : null}
    {active ? <div className="native-attachments"><button disabled={busy} title="로컬 파일 준비" aria-label="로컬 파일 준비" onClick={() => void attach()}><Icon name="plus" /></button>{selectedAssets.map(a => <button key={a.id} disabled={busy} title={`자료 준비: ${a.name}`} aria-label={`자료 준비: ${a.name}`} onClick={() => void attach(a.id)}><Icon name="book" /></button>)}</div> : null}
    {pending ? <div className="selection-preview"><span>{pending.item.name}</span><button disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const confirmation = await invoke('attachments.confirm', { appSessionId: pending.sessionId, attachmentId: pending.item.id });
        if (!confirmation.ok) return setNotice(confirmation.error.message);
        const result = await invoke('terminal.stage', { appSessionId: pending.sessionId, attachmentId: pending.item.id });
        if (!result.ok) return setNotice(result.error.message);
        await navigator.clipboard.writeText(result.data.text); setPending(undefined); setNotice('첨부 경로를 복사했습니다. 원하는 Claude Code 대화에 직접 붙여넣으세요. 아직 전송하지 않았습니다.');
      } catch { setNotice('첨부 경로를 복사하지 못했습니다. 다시 시도하세요.'); } finally { setBusy(false); }
    }}>확인하고 첨부 경로 복사</button><button disabled={busy} onClick={async () => { const r = await invoke('attachments.remove', { appSessionId: pending.sessionId, attachmentId: pending.item.id }); if (r.ok) setPending(undefined); else setNotice(r.error.message); }}>취소</button></div> : null}
    {active ? <NativeTerminal key={active.appSessionId} appSessionId={active.appSessionId} /> : <div className="empty-tool"><Icon name="chat" /><p>새 대화를 열면 실제 Claude Code가 시작됩니다.</p><small>/ 명령과 목록은 Claude Code가 직접 제공합니다.</small></div>}
  </div>;
}
