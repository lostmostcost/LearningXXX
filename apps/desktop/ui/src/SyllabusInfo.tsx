import { useCallback, useEffect, useRef, useState } from 'react';
import type { CourseSyllabus, SyllabusBlock, SyllabusDoc, SyllabusSource } from '@learningxxx/contracts';
import { invoke } from './host-api.ts';
import { formatSeoul } from './library.ts';
import { RichText } from './RichText.tsx';
import { SOURCE_KIND, currentPlanRow, gradingTotal, needsRead, orderedSources } from './syllabus.ts';

/**
 * WBS-107: the 강의 정보 tab. The app reads the course syllabus itself (the
 * school's syllabus page linked from the LMS, the LMS text, posted syllabus
 * files), read only, and shows it tidied: key facts, grading, the weekly
 * plan with this week marked, books, then every section, and the page as
 * received. Nothing here needs the web; 학교 사이트에서 열기 is only a link.
 */
export function SyllabusInfo({ courseId, courseTitle, weekLabel, onOpenFile }: { courseId: string; courseTitle: string; weekLabel?: string | undefined; onOpenFile?: (resourceId: string) => void }) {
  const [state, setState] = useState<CourseSyllabus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState<string>();
  const [original, setOriginal] = useState(false);
  const autoRead = useRef(false);
  const refresh = useCallback(async () => {
    setBusy(true); setError('');
    try { const r = await invoke('course.refreshSyllabus', { courseId }); if (r.ok) setState(r.data); else setError(r.error.message); }
    catch { setError('강의계획서를 받지 못했습니다. 다시 받기를 눌러 보세요.'); }
    finally { setBusy(false); }
  }, [courseId]);
  useEffect(() => {
    let alive = true; autoRead.current = false;
    setState(undefined); setError(''); setChosen(undefined); setOriginal(false);
    void invoke('course.syllabus', { courseId }).then((r) => { if (!alive) return; if (r.ok) setState(r.data); else setError(r.error.message); })
      .catch(() => { if (alive) setError('강의 정보를 불러오지 못했습니다.'); });
    return () => { alive = false; };
  }, [courseId]);
  useEffect(() => { if (needsRead(state) && !autoRead.current) { autoRead.current = true; void refresh(); } }, [state, refresh]);

  const sources = orderedSources(state);
  const source = sources.find((s) => s.id === chosen) ?? sources[0];
  return <div className="syllabus-info">
    <div className="viewer-head"><h2>강의 정보 · {courseTitle}</h2>
      {source?.url ? <a className="source-link" href={source.url} target="_blank" rel="noreferrer">학교 사이트에서 열기 ↗</a> : null}</div>
    <div className="knowledge-actions">
      {busy ? <span role="status">학교 사이트에서 강의계획서를 받는 중…</span> : <button onClick={() => void refresh()}>다시 받기</button>}
      {state?.refreshedAt ? <span className="meta">{formatSeoul(state.refreshedAt)} 받음 · 이 Mac에 저장됨</span> : null}
    </div>
    {error ? <p className="chat-error" role="alert">{error}</p> : null}
    {state === undefined && !error ? <p className="meta" role="status">불러오는 중…</p> : null}
    {state && !sources.length ? <p className="notice-box">이 과목의 LMS에서 강의계획서를 찾지 못했습니다. 상단의 수집으로 자료를 다시 받은 뒤 다시 받기를 눌러 보세요. 교수님이 계획서를 올리지 않은 과목일 수도 있습니다.</p> : null}
    {sources.length > 1 ? <div className="syllabus-sources" role="tablist" aria-label="강의계획서 출처">{sources.map((s) =>
      <button key={s.id} role="tab" aria-selected={s.id === source?.id} onClick={() => { setChosen(s.id); setOriginal(false); }}>{s.label}<small>{SOURCE_KIND[s.kind]}{s.doc ? '' : ' · 못 읽음'}</small></button>)}</div> : null}
    {source ? <SourceView key={source.id} source={source} weekLabel={weekLabel} original={original} onOriginal={setOriginal} onOpenFile={onOpenFile} busy={busy} /> : null}
  </div>;
}

function SourceView({ source, weekLabel, original, onOriginal, onOpenFile, busy }: { source: SyllabusSource; weekLabel?: string | undefined; original: boolean; onOriginal: (on: boolean) => void; onOpenFile?: ((resourceId: string) => void) | undefined; busy: boolean }) {
  const doc = source.doc;
  return <>
    {source.error ? <p className="notice-box" role="alert">{source.error}</p> : null}
    {!doc ? (busy ? null : <p className="notice-box">아직 읽은 내용이 없습니다. 다시 받기를 눌러 보세요.</p>) : <>
      <div className="syllabus-switch" role="group" aria-label="보기">
        <button aria-pressed={!original} onClick={() => onOriginal(false)}>정리해서 보기</button>
        {source.original ? <button aria-pressed={original} onClick={() => onOriginal(true)}>원본 보기</button>
          : source.kind === 'file' && source.resourceId && onOpenFile ? <button onClick={() => onOpenFile(source.resourceId!)}>원본 파일 열기</button> : null}
        {source.fetchedAt ? <span className="meta">{formatSeoul(source.fetchedAt)} 기준</span> : null}
      </div>
      {original && source.original ? <article className="syllabus-original"><RichText html={source.original} /></article> : <Tidy doc={doc} weekLabel={weekLabel} />}
    </>}
  </>;
}

function Tidy({ doc, weekLabel }: { doc: SyllabusDoc; weekLabel?: string | undefined }) {
  const current = currentPlanRow(doc.weeks, weekLabel);
  const total = gradingTotal(doc.grading);
  const max = Math.max(1, ...doc.grading.map((g) => g.weight ?? 0));
  const nothing = !doc.facts.length && !doc.grading.length && !doc.weeks.length && !doc.books.length;
  return <div className="syllabus-tidy">
    {doc.title ? <p className="meta">{doc.title}</p> : null}
    {doc.facts.length ? <section id="syllabus-facts" className="syllabus-card"><h3>한눈에 보기</h3>
      <dl className="syllabus-facts">{doc.facts.map((f) => <div key={f.label}><dt>{f.label}</dt><dd className={f.hidden ? 'meta' : undefined}>{f.value}{f.hidden ? ' (원본 사이트에서 로그인하면 보입니다)' : ''}</dd></div>)}</dl></section> : null}
    {doc.grading.length ? <section id="syllabus-grading" className="syllabus-card"><h3>평가 비율{total ? <small className="meta"> · 합계 {total.total}{total.unit}</small> : null}</h3>
      <ul className="syllabus-grading">{doc.grading.map((g) => <li key={g.item}>
        <span className="grade-item">{g.item}</span><span className="grade-bar" aria-hidden="true"><span style={{ width: `${Math.round(((g.weight ?? 0) / max) * 100)}%` }} /></span><strong>{g.share}</strong>
        {g.note ? <small className="grade-note">{g.note}</small> : null}</li>)}</ul></section> : null}
    {doc.weeks.length ? <section id="syllabus-weeks" className="syllabus-card"><h3>주차별 계획</h3>
      <table className="syllabus-table"><thead><tr><th>주차</th><th>날짜</th><th>내용</th></tr></thead><tbody>
        {doc.weeks.map((w, i) => <tr key={`${w.label}-${i}`} className={i === current ? 'is-current' : undefined} aria-current={i === current ? 'true' : undefined}>
          <td>{w.label}{i === current ? <small className="now-tag">이번 주</small> : null}</td><td>{w.date ?? ''}</td><td><Lines text={w.topic} />{w.note ? <small className="meta"><Lines text={w.note} /></small> : null}</td></tr>)}
      </tbody></table></section> : null}
    {doc.books.length ? <section id="syllabus-books" className="syllabus-card"><h3>교재·참고자료</h3><ul>{doc.books.map((b) => <li key={b}>{b}</li>)}</ul></section> : null}
    {nothing ? <p className="notice-box">이 계획서에서는 교수·평가·주차 정보를 따로 찾지 못했습니다. 아래 전체 내용이나 원본을 확인하세요.</p> : null}
    <details id="syllabus-all" className="syllabus-card" open={nothing}><summary><h3>전체 내용</h3></summary>
      {doc.sections.map((s, i) => <section key={`${s.heading}-${i}`} className="syllabus-section"><h4>{s.heading}</h4>{s.blocks.map((b, j) => <Block key={j} block={b} />)}</section>)}
    </details>
  </div>;
}

function Block({ block }: { block: SyllabusBlock }) {
  if (block.type === 'text') return <p className="syllabus-text"><Lines text={block.text} /></p>;
  if (block.type === 'fields') return <dl className="syllabus-facts">{block.fields.map((f, i) => <div key={`${f.label}-${i}`}>{f.label ? <dt>{f.label}</dt> : null}<dd><Lines text={f.value} /></dd></div>)}</dl>;
  return <div className="syllabus-scroll"><table className="syllabus-table"><thead><tr>{block.head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
    <tbody>{block.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}><Lines text={c} /></td>)}</tr>)}</tbody></table></div>;
}

const Lines = ({ text }: { text: string }) => <>{text.split('\n').map((line, i) => <span key={i}>{i ? <br /> : null}{line}</span>)}</>;
