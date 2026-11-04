import { Details } from './Details.tsx';
import { useCallback, useEffect, useState } from 'react';
import type { IpcResponse } from '@learningxxx/contracts';
import { invoke } from './host-api.ts';
import { MarkdownAnswer } from './MarkdownAnswer.tsx';
import { formatSeoul } from './library.ts';
import { StudyNotes } from './StudyNotes.tsx';
import type { Week } from '@learningxxx/contracts';

type Knowledge = IpcResponse<'course.knowledge'>;

/**
 * WBS-082: the course summary file (course.md). Claude Code writes it on
 * request from the syllabus, the week-by-week material and the lecture
 * transcripts; the course chat reads it first. Made again whenever the
 * student asks, e.g. after new material or recordings.
 */
export function CourseKnowledge({ courseId, courseTitle, weeks = [], weekId }: { courseId: string; courseTitle: string; weeks?: readonly Week[]; weekId?: string | undefined }) {
  const [state, setState] = useState<Knowledge>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { const r = await invoke('course.knowledge', { courseId });
      if (r.ok) { setState(r.data); setBusy(r.data.running); } else setError(r.error.message);
    } catch { setError('과목 정리를 불러오지 못했습니다. 다시 시도하세요.'); }
  }, [courseId]);
  useEffect(() => { setState(undefined); setError(''); void load(); }, [load]);

  const make = async () => {
    setBusy(true); setError('');
    try { const r = await invoke('course.makeKnowledge', { courseId });
      if (r.ok) setState(r.data); else setError(r.error.message);
    } catch { setError('과목 정리를 만들지 못했습니다. 다시 시도하세요.'); }
    finally { setBusy(false); }
  };

  return <div className="course-knowledge">
    <div className="viewer-head"><h2>과목 정리 · {courseTitle}</h2></div>
    <Details title="요약에 사용되는 자료"><p>강의계획서·주차 자료·전사로 만든 AI 요약입니다. 과목 채팅에서 참고합니다.</p></Details>
    <div className="knowledge-actions">
      {busy ? <><span role="status">만드는 중… 자료 양에 따라 1~3분 걸립니다.</span><button onClick={() => void invoke('course.cancelKnowledge', { courseId })}>멈추기</button></>
        : <button className="primary-action" onClick={() => void make()}>{state?.markdown ? '다시 만들기' : '과목 정리 만들기'}</button>}
      {state?.generatedAt ? <span className="meta">{formatSeoul(state.generatedAt)} 만듦{state.stale ? ' · 그 뒤 자료가 바뀌었습니다(다시 만들면 반영)' : ''}</span> : null}
    </div>
    {error ? <p className="chat-error" role="alert">{error}</p> : null}
    {state?.meetings.length ? <p className="meta">수업 시간: {state.meetings.map((m) => `${m.day} ${m.start}–${m.end}${m.place ? ` ${m.place}` : ''}`).join(' · ')}</p> : null}
    {state === undefined && !error ? <p className="meta" role="status">불러오는 중…</p> : state?.markdown ? <article className="knowledge-body"><MarkdownAnswer text={state.markdown} /></article>
      : state ? <p className="notice-box">자료를 모아 과목 정리를 만들어 보세요.</p> : null}
      {weeks.length ? <StudyNotes courseId={courseId} weeks={weeks} weekId={weekId} /> : null}
  </div>;
}
