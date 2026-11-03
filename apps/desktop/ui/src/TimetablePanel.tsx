import { useState } from 'react';
import type { CourseMeeting, IpcResponse } from '@learningxxx/contracts';
import { invoke } from './host-api.ts';
import { WEEKDAYS } from './schedule.ts';

export type Times = IpcResponse<'timetable.get'>['courses'];
const SOURCE = { manual: '직접 입력', course_md: '과목 정리에서 찾음', none: '시간 없음' } as const;

/**
 * WBS-085: the week at a glance and, per course, its class times — found in
 * the course summary or entered here (entered times win; "과목 정리 값으로"
 * goes back). Times are Seoul time.
 */
export function TimetablePanel({ times, onChange }: { times: Times; onChange: (next: Times) => void }) {
  const [editing, setEditing] = useState<{ courseId: string; rows: CourseMeeting[] }>();
  const [error, setError] = useState('');
  const save = async (courseId: string, meetings: CourseMeeting[] | null) => {
    const bad = meetings?.find((m) => !/^\d{2}:\d{2}$/.test(m.start) || !/^\d{2}:\d{2}$/.test(m.end) || m.start >= m.end);
    if (bad) return setError('시간은 09:00처럼 쓰고, 끝나는 시간이 시작보다 늦어야 합니다.');
    const r = await invoke('timetable.set', { courseId, meetings: meetings?.map((m) => ({ day: m.day, start: m.start, end: m.end, ...(m.place?.trim() ? { place: m.place.trim() } : {}) })) ?? null });
    if (r.ok) { onChange(r.data.courses); setEditing(undefined); setError(''); } else setError(r.error.message);
  };
  const row = (i: number, change: Partial<CourseMeeting>) => setEditing((e) => e && { ...e, rows: e.rows.map((m, n) => (n === i ? { ...m, ...change } : m)) });
  const byDay = WEEKDAYS.map((day) => ({ day, slots: times.flatMap((c) => c.meetings.filter((m) => m.day === day).map((m) => ({ title: c.title, m }))).sort((a, b) => a.m.start.localeCompare(b.m.start)) })).filter((d) => d.slots.length);

  return <div className="timetable">
    {byDay.length ? <div className="timetable-week">{byDay.map((d) => <div key={d.day}><strong>{d.day}</strong>{d.slots.map((s, i) => <span key={i}>{s.m.start}–{s.m.end} {s.title}{s.m.place ? ` · ${s.m.place}` : ''}</span>)}</div>)}</div>
      : <p className="subtle">아직 수업 시간이 없습니다. 아래에서 과목마다 입력하거나, 과목 정리(course.md)를 만들면 강의계획서에 있는 시간을 씁니다.</p>}
    <ul className="timetable-courses">{times.map((c) => <li key={c.courseId}>
      <span>{c.title} <small className="subtle">{SOURCE[c.source]}{c.meetings.length ? ` · ${c.meetings.map((m) => `${m.day} ${m.start}`).join(', ')}` : ''}</small></span>
      {editing?.courseId === c.courseId ? null : <button className="link-button" onClick={() => setEditing({ courseId: c.courseId, rows: c.meetings.length ? [...c.meetings] : [{ day: '월', start: '09:00', end: '10:15' }] })}>시간 편집</button>}
      {editing?.courseId === c.courseId ? <div className="timetable-edit">
        {editing.rows.map((m, i) => <div key={i}>
          <select aria-label="요일" value={m.day} onChange={(e) => row(i, { day: e.target.value as CourseMeeting['day'] })}>{WEEKDAYS.map((d) => <option key={d}>{d}</option>)}</select>
          <input aria-label="시작" type="time" value={m.start} onChange={(e) => row(i, { start: e.target.value })} />
          <input aria-label="끝" type="time" value={m.end} onChange={(e) => row(i, { end: e.target.value })} />
          <input aria-label="강의실" placeholder="강의실(선택)" value={m.place ?? ''} maxLength={100} onChange={(e) => row(i, { place: e.target.value })} />
          <button aria-label="이 시간 지우기" onClick={() => setEditing((e) => e && { ...e, rows: e.rows.filter((_, n) => n !== i) })}>×</button>
        </div>)}
        <div className="timetable-actions">
          <button className="link-button" onClick={() => setEditing((e) => e && { ...e, rows: [...e.rows, { day: '월', start: '09:00', end: '10:15' }] })}>+ 시간 추가</button>
          <button onClick={() => void save(c.courseId, editing.rows)}>저장</button>
          {c.source === 'manual' ? <button onClick={() => void save(c.courseId, null)}>과목 정리 값으로</button> : null}
          <button onClick={() => { setEditing(undefined); setError(''); }}>취소</button>
        </div>
      </div> : null}
    </li>)}</ul>
    {error ? <p role="alert" className="subtle">{error}</p> : null}
  </div>;
}
