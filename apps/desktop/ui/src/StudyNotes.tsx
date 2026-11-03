import { useCallback, useEffect, useState } from 'react';
import type { IpcResponse, Week } from '@learningxxx/contracts';
import { invoke } from './host-api.ts';
import { MarkdownAnswer } from './MarkdownAnswer.tsx';
import { formatSeoul } from './library.ts';

type Note = IpcResponse<'study.list'>['notes'][number];
const LABEL = { review: '복습 노트', preview: '예습 노트' } as const;

/**
 * WBS-083: review and preview notes per week, made automatically (when turned
 * on in settings) or here on request. The course chat reads them too.
 */
export function StudyNotes({ courseId, weeks, weekId }: { courseId: string; weeks: readonly Week[]; weekId: string | undefined }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [week, setWeek] = useState(weekId ?? weeks[0]?.id ?? '');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const r = await invoke('study.list', { courseId });
    if (r.ok) setNotes(r.data.notes); else setError(r.error.message);
  }, [courseId]);
  useEffect(() => { void load(); }, [load]);
  const make = async (kind: 'review' | 'preview') => {
    if (!week) return;
    setBusy(kind); setError('');
    const r = await invoke('study.make', { courseId, weekId: week, kind });
    setBusy(undefined);
    if (r.ok) await load(); else setError(r.error.message);
  };
  const label = (id: string) => weeks.find((w) => w.id === id)?.label ?? '주차';
  const order = (id: string) => weeks.findIndex((w) => w.id === id);
  return <section className="study-notes">
    <h3>주차별 복습·예습 노트</h3>
    <div className="knowledge-actions">
      <select aria-label="노트 주차" value={week} onChange={(e) => setWeek(e.target.value)}>{weeks.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}</select>
      <button disabled={!!busy || !week} onClick={() => void make('review')}>{busy === 'review' ? '만드는 중…' : '복습 노트 만들기'}</button>
      <button disabled={!!busy || !week} onClick={() => void make('preview')}>{busy === 'preview' ? '만드는 중…' : '예습 노트 만들기'}</button>
    </div>
    {error ? <p className="chat-error" role="alert">{error}</p> : null}
    {notes.length ? notes.toSorted((a, b) => order(b.weekId) - order(a.weekId) || a.kind.localeCompare(b.kind)).map((n) => <details key={`${n.weekId}:${n.kind}`}>
      <summary>{label(n.weekId)} · {LABEL[n.kind]} <small className="meta">{formatSeoul(n.generatedAt)}</small></summary>
      <article className="knowledge-body"><MarkdownAnswer text={n.markdown} /></article>
    </details>) : <p className="meta">아직 노트가 없습니다. 설정의 "자동으로 할 일"에서 켜거나 위 버튼으로 만들 수 있습니다.</p>}
  </section>;
}
