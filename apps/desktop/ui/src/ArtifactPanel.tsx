import { useEffect, useRef, useState } from 'react';
import type { ArtifactJob, ArtifactScope, IpcResponse } from '@learningxxx/contracts';
import { invoke } from './host-api.ts';

const PHASE = { generating: '계획 생성 중', needs_review: '내용 검토 필요', exporting: '파일 출력 중', completed: '출력 완료', failed: '실패 · 이전 파일 보존', cancelled: '취소됨', interrupted: '앱 종료로 중단됨' };
/** Scope-keyed by its caller. Polls are versioned against user actions, never replayed sends. */
export function ArtifactPanel({ scope, title }: { scope: ArtifactScope; title: string }) {
  const [inputs, setInputs] = useState<IpcResponse<'artifacts.inputs'>>();
  const [jobs, setJobs] = useState<ArtifactJob[]>([]), [chosen, setChosen] = useState('');
  const [runtime, setRuntime] = useState<IpcResponse<'artifacts.runtime'>>();
  const [error, setError] = useState(''), [pending, setPending] = useState(false), [reload, setReload] = useState(0);
  const [included, setIncluded] = useState<string[]>(), [search, setSearch] = useState('');
  const [partial, setPartial] = useState(false), [reviewed, setReviewed] = useState(false);
  const alive = useRef(false), generation = useRef(0), lock = useRef(false), operation = useRef(0), selected = useRef('');
  const key = `${scope.courseId}/${scope.kind}/${scope.weekId ?? scope.assignmentId}`;
  const matching = jobs.filter(j => j.scope.kind === scope.kind && (scope.kind === 'video' ? j.scope.weekId === scope.weekId : j.scope.assignmentId === scope.assignmentId));
  const job = matching.find(j => j.id === chosen);
  const activeJob = jobs.find(j => j.phase === 'generating' || j.phase === 'exporting');
  const courseBusy = !!activeJob;
  const available = inputs?.sources.filter(s => s.status === 'available') ?? [];
  const selectedSources = new Set(included ?? available.map(s => s.id));
  const missing = inputs?.sources.filter(s => s.status === 'missing' || !selectedSources.has(s.id)) ?? [];
  const characters = available.filter(s => selectedSources.has(s.id)).reduce((sum, s) => sum + s.characters, 0);
  const filtered = available.filter(s => s.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  useEffect(() => { setIncluded(undefined); setPartial(false); }, [inputs?.token]);
  useEffect(() => { setReviewed(false); }, [job?.id, job?.reviewToken]);
  useEffect(() => {
    alive.current = true; const ticket = ++generation.current;
    let active = true, timer: ReturnType<typeof setTimeout>;
    const current = () => active && alive.current && generation.current === ticket;
    setInputs(undefined);
    void invoke('artifacts.inputs', scope).then(r => { if (!current()) return; if (r.ok) setInputs(r.data); else setError(r.error.message); }).catch(() => { if (current()) setError('초기 입력을 읽지 못했습니다. 다시 읽어 주세요.'); });
    const poll = async () => {
      const revision = operation.current;
      const results = await Promise.allSettled([invoke('artifacts.list', { courseId: scope.courseId }), invoke('artifacts.runtime', {})]);
      if (!current()) return;
      const listed = results[0]!, tools = results[1]!;
      if (listed.status === 'fulfilled' && listed.value.ok && revision === operation.current && !lock.current) {
        const values = listed.value.data.jobs;
        setJobs(values);
        if (!selected.current) {
          const latest = values.find(j => j.scope.kind === scope.kind && (scope.kind === 'video' ? j.scope.weekId === scope.weekId : j.scope.assignmentId === scope.assignmentId));
          if (latest) { selected.current = latest.id; setChosen(latest.id); }
        }
      } else if (listed.status === 'fulfilled' && !listed.value.ok) setError(listed.value.error.message);
      if (tools.status === 'fulfilled' && tools.value.ok) setRuntime(tools.value.data);
      timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { active = false; alive.current = false; clearTimeout(timer); };
  }, [key, reload]);

  const action = async (work: (current: () => boolean) => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; operation.current++; setPending(true); setError('');
    const ticket = generation.current, current = () => alive.current && ticket === generation.current;
    try { await work(current); } catch { if (current()) setError('요청을 완료하지 못했습니다. 이전 결과를 먼저 확인한 뒤 다시 시도하세요.'); }
    finally { lock.current = false; if (current()) setPending(false); }
  };
  const accept = (value: ArtifactJob) => { selected.current = value.id; setChosen(value.id); setJobs(old => [value, ...old.filter(j => j.id !== value.id)]); };
  const chooseInputs = (ids: string[] | undefined) => { setIncluded(ids); setPartial(false); };
  const generate = () => action(async current => {
    if (!inputs) return;
    const r = await invoke('artifacts.prepare', { ...scope, sourceToken: inputs.token, allowMissing: partial, ...(included ? { includedSourceIds: included } : {}) });
    if (!current()) return; if (r.ok) accept(r.data); else setError(r.error.message);
  });
  const exportFiles = () => action(async current => {
    if (!job?.reviewToken) return;
    const r = await invoke('artifacts.export', { courseId: scope.courseId, id: job.id, reviewToken: job.reviewToken });
    if (!current()) return; if (r.ok) accept(r.data); else setError(r.error.message);
  });

  return <section className="artifact-workspace" aria-label={scope.kind === 'video' ? '주차 설명 영상' : '과제 발표 초안'}>
    <div className="artifact-input-tools">
      <h2>{title}</h2>
      <p className="meta">{scope.kind === 'video' ? '이 주차 원본·전사·메모와 과목 공통 자료로 장면·대본을 만듭니다. 대본 검토 후 HeyGen 음성과 로컬 MP4를 출력합니다.' : '누적 과목 자료로 발표용 슬라이드 계획을 만들고, 편집 가능한 PPTX와 그 파일을 변환한 PDF를 출력합니다.'}</p>
      {error ? <p className="chat-error" role="alert">{error}</p> : null}
      <details><summary>초기 입력 · 선택 {available.filter(s => selectedSources.has(s.id)).length}개 · 누락/제외 {missing.length}개 · {characters.toLocaleString()}자 / 500,000자</summary>
        <p>PDF 그림·도표는 텍스트 입력에 포함되지 않습니다. 한도를 넘으면 필요한 자료를 명시적으로 선택하세요.</p>
        <div className="assignment-actions"><button disabled={pending || courseBusy} onClick={() => chooseInputs(undefined)}>모두 선택</button><button disabled={pending || courseBusy} onClick={() => chooseInputs(available.filter(s => s.required).map(s => s.id))}>선택 해제 · 과제 안내 유지</button></div>
        <label>자료 검색<input aria-label="생성 입력 자료 검색" value={search} onChange={e => setSearch(e.target.value)} /></label>
        <button disabled={pending || courseBusy || !search.trim()} onClick={() => chooseInputs([...new Set([...selectedSources, ...filtered.map(s => s.id)])])}>검색 결과 추가</button>
        <ul>{filtered.map(s => <li key={s.id}><label><input type="checkbox" checked={selectedSources.has(s.id)} disabled={s.required || pending || courseBusy} onChange={e => chooseInputs(e.target.checked ? [...selectedSources, s.id] : [...selectedSources].filter(id => id !== s.id))} />{s.title} · {s.characters.toLocaleString()}자{s.required ? ' · 필수' : ''}</label></li>)}</ul>
        <ul>{inputs?.sources.filter(s => s.status === 'missing').map(s => <li key={s.id}>누락 · {s.title} — {s.reason}</li>)}</ul>
      </details>
      {missing.length ? <label className="assignment-consent"><input type="checkbox" checked={partial} disabled={pending || courseBusy} onChange={e => setPartial(e.target.checked)} />누락·제외 범위를 확인했고 선택한 텍스트로 부분 계획을 만들겠습니다.</label> : null}
      <div className="assignment-actions">
        <button disabled={!inputs || pending || courseBusy || !characters || characters > 500_000 || !!missing.length && !partial} onClick={() => void generate()}>{scope.kind === 'video' ? '장면·대본 만들기' : '슬라이드 계획 만들기'}</button>
        <button disabled={pending || courseBusy} onClick={() => { setError(''); setReload(n => n + 1); }}>자료 다시 읽기</button>
        {matching.length ? <select aria-label="보존된 생성 작업" value={chosen} onChange={e => { selected.current = e.target.value; setChosen(e.target.value); }}>{matching.map(j => <option key={j.id} value={j.id}>{new Date(j.createdAt).toLocaleString()} · {PHASE[j.phase]}</option>)}</select> : null}
        {job && (job.phase === 'generating' || job.phase === 'exporting') ? <button onClick={() => void action(async current => { const r = await invoke('artifacts.cancel', { courseId: scope.courseId, id: job.id }); if (current() && !r.ok) setError(r.error.message); })}>작업 취소</button> : null}
      </div>
      {pending ? <p role="status">요청을 처리하고 있습니다…</p> : null}
      {job ? <p role="status">{PHASE[job.phase]}</p> : null}
      {job?.error ? <p role="alert" className="chat-error">{job.error}</p> : null}
      {courseBusy && !matching.some(j => j.phase === 'generating' || j.phase === 'exporting') ? <p>같은 과목의 다른 주차/과제 작업이 진행 중입니다. <button onClick={() => void action(async current => { const r = await invoke('artifacts.cancel', { courseId: scope.courseId, id: activeJob!.id }); if (current() && !r.ok) setError(r.error.message); })}>해당 작업 취소</button></p> : null}
      <details><summary>로컬 출력 도구 · {runtime?.message ?? '확인 중'}</summary><div className="assignment-actions"><button disabled={pending || courseBusy || runtime?.preparing} onClick={() => void action(async current => { const r = await invoke('artifacts.setup', { which: scope.kind === 'video' ? 'video' : 'pptx' }); if (!current()) return; if (r.ok) setRuntime(r.data); else setError(r.error.message); })}>이 출력 도구 준비</button></div></details>
    </div>
    <div className="artifact-plan">
      {job?.plan ? <><h2>내용 검토 · {job.plan.title}</h2><p className="meta">생성 시점의 입력 {job.plan.reviewedSourceIds.length}개에 근거한 계획입니다. 입력 선택 변경은 다음 생성에 적용됩니다.</p>
        {job.plan.requirements.length ? <details><summary>요구사항·출처</summary><ul>{job.plan.requirements.map((r, i) => <li key={i}>{r.text}<small> · {r.sourceIds.join(', ')}</small></li>)}</ul></details> : null}
        {(scope.kind === 'video' ? job.plan.scenes : job.plan.slides).map((item, i) => <article className="artifact-scene" key={i}><h3>{i + 1}. {item.title}</h3><ul>{item.bullets.map((b, j) => <li key={j}>{b}</li>)}</ul>{'narration' in item && typeof item.narration === 'string' ? <p className="artifact-narration">{item.narration}</p> : null}<small>근거: {item.sourceIds.join(', ')}</small></article>)}
        {job.plan.openQuestions.length ? <aside><h3>직접 확인할 점</h3><ul>{job.plan.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul></aside> : null}
        {job.phase === 'needs_review' ? <div className="artifact-export"><label className="assignment-consent"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />{scope.kind === 'video' ? '장면·대본을 검토했습니다. 대본을 HeyGen API로 보내고 별도 API 크레딧을 사용해 음성과 MP4를 만들겠습니다.' : '슬라이드 내용을 검토했습니다. 이 계획의 PPTX와 동일 파일을 변환한 PDF를 만들겠습니다.'}</label>
          <button disabled={!reviewed || pending || courseBusy || !(scope.kind === 'video' ? runtime?.video : runtime?.pptx)} onClick={() => void exportFiles()}>{scope.kind === 'video' ? '검토한 대본으로 음성·MP4 만들기' : '검토한 계획으로 PPTX·PDF 만들기'}</button></div> : null}
      </> : <p className="empty-tool">생성할 입력을 확인한 뒤 계획 만들기를 선택하세요. 파일 출력은 계획을 검토한 다음 단계입니다.</p>}
      {job?.phase === 'completed' ? <div className="assignment-actions">{job.files.map(file => <span key={file}><button onClick={() => void action(async current => { const r = await invoke('artifacts.open', { courseId: scope.courseId, id: job.id, file, how: 'open' }); if (current() && !r.ok) setError(r.error.message); })}>{file.toUpperCase()} 열기</button><button onClick={() => void action(async current => { const r = await invoke('artifacts.open', { courseId: scope.courseId, id: job.id, file, how: 'reveal' }); if (current() && !r.ok) setError(r.error.message); })}>Finder에서 보기</button></span>)}</div> : null}
    </div>
  </section>;
}
