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
    const r = await invoke('course.knowledge', { courseId });
    if (r.ok) { setState(r.data); setBusy(r.data.running); } else setError(r.error.message);
  }, [courseId]);
  useEffect(() => { setState(undefined); setError(''); void load(); }, [load]);

  const make = async () => {
    setBusy(true); setError('');
    const r = await invoke('course.makeKnowledge', { courseId });
    setBusy(false);
    if (r.ok) setState(r.data); else setError(r.error.message);
  };

  return <div className="course-knowledge">
    <div className="viewer-head"><h2>과목 정리 · {courseTitle}</h2></div>
    <p className="meta">강의계획서·주차별 자료·강의 전사를 바탕으로 Claude Code가 만든 요약입니다. 이 과목의 채팅은 이 파일을 먼저 읽습니다.</p>
    <div className="knowledge-actions">
      {busy ? <><span role="status">만드는 중… 자료 양에 따라 1~3분 걸립니다.</span><button onClick={() => void invoke('course.cancelKnowledge', { courseId })}>멈추기</button></>
        : <button onClick={() => void make()}>{state?.markdown ? '다시 만들기' : '과목 정리 만들기'}</button>}
      {state?.generatedAt ? <span className="meta">{formatSeoul(state.generatedAt)} 만듦{state.stale ? ' · 그 뒤 자료가 바뀌었습니다(다시 만들면 반영)' : ''}</span> : null}
    </div>
    {error ? <p className="chat-error" role="alert">{error}</p> : null}
    {state?.meetings.length ? <p className="meta">수업 시간: {state.meetings.map((m) => `${m.day} ${m.start}–${m.end}${m.place ? ` ${m.place}` : ''}`).join(' · ')}</p> : null}
    {state === undefined && !error ? <p className="meta" role="status">불러오는 중…</p> : state?.markdown ? <article className="knowledge-body"><MarkdownAnswer text={state.markdown} /></article>
      : state ? <p className="notice-box">아직 과목 정리가 없습니다. "과목 정리 만들기"를 누르면 강의계획서와 지금까지의 자료·전사로 만듭니다. 학교 LMS에는 아무것도 보내지 않습니다.</p> : null}
      {weeks.length ? <StudyNotes courseId={courseId} weeks={weeks} weekId={weekId} /> : null}
  </div>;
}
