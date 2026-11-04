import { Details } from './Details.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Memo, Week } from '@learningxxx/contracts';
import { invoke } from './host-api.ts';
import { MarkdownAnswer } from './MarkdownAnswer.tsx';
import { formatSeoul } from './library.ts';
import { pageQuote } from './memo.ts';

/** How long typing pauses before the memo is saved. */
const SAVE_DELAY_MS = 800;

/**
 * WBS-086: the student's memo for a course week, saved as they type. The page
 * being read can be added in one click, and "AI로 정리" asks Claude Code for a
 * tidied copy (using the course summary and that week's material) shown next
 * to the memo; the memo changes only if the student chooses to use it.
 */
export function MemoPanel({ courseId, weeks, weekId: shownWeek, page }: {
  courseId: string; weeks: readonly Week[]; weekId: string | undefined;
  /** The PDF page open in the viewer, if any. */
  page: { assetId: string; title: string; page: number } | undefined;
}) {
  const [weekId, setWeekId] = useState(shownWeek);
  useEffect(() => setWeekId(shownWeek), [shownWeek]);
  const [memo, setMemo] = useState<Memo>();
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = useRef<string | null>(null);
  const pending = useRef<{ text: string; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const where = { courseId, ...(weekId ? { weekId } : {}) };

  const accept = (m: Memo) => { setMemo(m); base.current = m.updatedAt; };
  const save = useCallback(async (value: string) => {
    setStatus('저장 중…');
    const r = await invoke('memo.save', { courseId, ...(weekId ? { weekId } : {}), text: value, base: base.current });
    if (r.ok) { accept(r.data); setStatus(`저장됨 · ${formatSeoul(r.data.updatedAt!)}`); setError(''); }
    else { setStatus(''); setError(r.error.message); }
  }, [courseId, weekId]);
  /** Saves now what is waiting to be saved (before switching week or tidying). */
  const flush = useCallback(async () => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer); pending.current = undefined;
    await save(p.text);
  }, [save]);

  const load = useCallback(async () => {
    setError(''); setStatus('');
    const r = await invoke('memo.get', { courseId, ...(weekId ? { weekId } : {}) });
    if (r.ok) { accept(r.data); setText(r.data.text); } else setError(r.error.message);
  }, [courseId, weekId]);
  useEffect(() => { void load(); return () => { void flush(); }; }, [load, flush]);

  const edit = (value: string) => {
    setText(value);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { text: value, timer: setTimeout(() => { pending.current = undefined; void save(value); }, SAVE_DELAY_MS) };
  };

  const addPage = async () => {
    if (!page) return;
    const r = await invoke('memo.pageText', { courseId, assetId: page.assetId, page: page.page });
    edit(text + pageQuote(text, page.title, page.page, r.ok ? r.data.text : ''));
  };

  const tidy = async () => {
    await flush();
    setBusy(true); setError('');
    const r = await invoke('memo.cleanup', where);
    setBusy(false);
    if (r.ok) accept(r.data); else setError(r.error.message);
  };
  const apply = async (action: 'use_cleaned' | 'undo' | 'discard_cleaned') => {
    await flush();
    const r = await invoke('memo.apply', { ...where, action });
    if (r.ok) { accept(r.data); setText(r.data.text); } else setError(r.error.message);
  };

  return <div className="memo-panel">
    <div className="memo-head">
      <Details title={<>{weeks.find(w=>w.id===weekId)?.label ?? "주차 없음"}<small>변경</small></>}><select aria-label="메모 주차" value={weekId ?? ''} onChange={(e) => { void flush(); setWeekId(e.target.value || undefined); }}>
        {weeks.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
        <option value="">주차 없음</option>
      </select></Details>
      <button disabled={!page} title={page ? `${page.title} ${page.page}쪽을 메모에 넣기` : '자료 보기에서 PDF를 열면 쓸 수 있습니다'} onClick={() => void addPage()}>쪽 추가</button>
      <button disabled={busy || !text.trim()} title="과목 정리와 이 주차 자료를 참고해 정리본을 만듭니다(메모는 그대로)" onClick={() => void tidy()}>{busy ? '정리하는 중…' : 'AI로 정리'}</button>
      {memo?.canUndo ? <button onClick={() => void apply('undo')} title="정리본으로 바꾸기 전 메모로">되돌리기</button> : null}
    </div>
    <textarea aria-label="메모" value={text} placeholder="메모하세요. 자동으로 저장됩니다." onChange={(e) => edit(e.target.value)} onBlur={() => void flush()} />
    <p className="meta" role="status">{error ? null : status}</p>
    {error ? <p className="chat-error" role="alert">{error}{error.includes('다른 곳에서') ? <> <button className="link-button" onClick={() => void load()}>다시 불러오기</button></> : null}</p> : null}
    {memo?.cleaned ? <section className="memo-cleaned" aria-label="AI 정리본">
      <div className="memo-head"><strong>AI 정리본</strong><span className="meta">{formatSeoul(memo.cleaned.at)}</span><button onClick={() => void apply('use_cleaned')}>이 정리본으로 바꾸기</button><button onClick={() => void apply('discard_cleaned')}>버리기</button></div>
      <MarkdownAnswer text={memo.cleaned.text} />
    </section> : null}
  </div>;
}
