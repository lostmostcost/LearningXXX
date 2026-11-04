import { Details } from './Details.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { IpcResponse } from '@learningxxx/contracts';
import { invoke } from './host-api.ts';

type Scope = { courseId: string; assignmentId: string };
type State = IpcResponse<'assignment.open'>;
/** One in-flight poll per scope; old course/assignment responses cannot retarget the UI. */
export function useAssignment(scope: Scope | undefined) {
  const key = scope ? `${scope.courseId}/${scope.assignmentId}` : '';
  const [snapshot, setSnapshot] = useState<{ key: string; data: State }>();
  const [failure, setFailure] = useState<{ key: string; text: string }>();
  const [opening, setOpening] = useState(false);
  const [pending, setPending] = useState<string>();
  const [reload, setReload] = useState(0);
  const current = useRef(key), epoch = useRef(0);
  const locks = useRef(new Set<string>());
  current.current = key;
  useEffect(() => {
    const generation = ++epoch.current;
    let alive = true, timer: ReturnType<typeof setTimeout>;
    setOpening(!!scope);
    if (!scope) return;
    const poll = async (open: boolean) => {
      try {
        const result = await invoke(open ? 'assignment.open' : 'assignment.state', scope);
        if (!alive || current.current !== key || epoch.current !== generation) return;
        setOpening(false);
        if (result.ok) { setSnapshot({ key, data: result.data }); if (open) setFailure(undefined); }
        else setFailure({ key, text: result.error.message });
        if (result.ok || !open) timer = setTimeout(() => void poll(false), 750);
      } catch { if (alive) { setOpening(false); setFailure({ key, text: '과제 작업공간에 연결하지 못했습니다. 다시 열어 주세요.' }); } }
    };
    void poll(true);
    return () => { alive = false; clearTimeout(timer); };
  }, [key, reload]);
  const action = async (work: (scope: Scope, state: State) => Promise<{ ok: boolean; data?: State; error?: { message: string } }>) => {
    const data = snapshot?.key === key ? snapshot.data : undefined;
    if (!scope || !data || locks.current.has(key)) return;
    locks.current.add(key);
    const generation = epoch.current;
    setPending(key); setFailure(undefined);
    try {
      const result = await work(scope, data);
      if (current.current !== key || generation !== epoch.current) return;
      if (result.ok && result.data?.sessionId) setSnapshot({ key, data: result.data });
      else if (!result.ok) setFailure({ key, text: result.error?.message ?? '요청을 완료하지 못했습니다.' });
    } catch { if (current.current === key && generation === epoch.current) setFailure({ key, text: '요청을 완료하지 못했습니다. 이전 초안은 보존됩니다.' }); }
    finally { locks.current.delete(key); setPending(old => old === key ? undefined : old); }
  };
  return { state: snapshot?.key === key ? snapshot.data : undefined, error: failure?.key === key ? failure.text : '', opening,
    pending: pending === key, action, refresh: () => setReload(n => n + 1),
    cancel: async () => { if (scope) { try { const r = await invoke('assignment.cancel', scope); if (!r.ok && current.current === key) setFailure({ key, text: r.error.message }); } catch { if (current.current === key) setFailure({ key, text: '취소 요청을 전달하지 못했습니다.' }); } } } };
}

export function AssignmentPanel({ workspace, instructions }: { workspace: ReturnType<typeof useAssignment>; instructions: ReactNode }) {
  const { state, error, opening, pending, action, refresh, cancel } = workspace;
  const [tab, setTab] = useState<'instructions' | 'draft'>('instructions');
  const [included, setIncluded] = useState<string[] | undefined>();
  const [search, setSearch] = useState('');
  const [selectedVersion, setSelectedVersion] = useState('');
  const [confirmMissing, setConfirmMissing] = useState(false);
  const sources = useRef<HTMLDetailsElement>(null);
  useEffect(() => { setIncluded(undefined); setConfirmMissing(false); }, [state?.sourceToken]);
  const available = state?.sources.filter(s => s.status === 'available') ?? [];
  const selected = new Set(included ?? available.map(s => s.id));
  const excluded = available.filter(s => !selected.has(s.id));
  const missing = state?.sources.filter(s => s.status === 'missing') ?? [];
  const partial = missing.length + excluded.length;
  const characters = available.filter(s => selected.has(s.id)).reduce((sum, s) => sum + s.characters, 0);
  const matches = available.filter(s => s.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const version = state?.versions.find(v => v.id === (selectedVersion || state.revision));
  const working = state?.phase === 'generating' || state?.phase === 'exporting';
  const locked = opening || pending || working || !state?.sourceToken;
  const preview = version && state?.previewUrl ? state.previewUrl.replace(/[^/]+$/, version.id) : undefined;
  const generate = async (allowMissing: boolean) => {
    await action((scope, s) => invoke('assignment.generate', { ...scope, sourceToken: s.sourceToken, allowMissing, ...(included ? { includedSourceIds: included } : {}) }));
    setConfirmMissing(false);
  };
  const requestDraft = () => {
    if (locked) return;
    if (characters > 500_000) { if (sources.current) { sources.current.open = true; sources.current.querySelector('summary')?.focus(); } return; }
    if (partial) setConfirmMissing(true); else void generate(false);
  };
  const pdf = () => void action(async scope => {
    if (version?.pdf) { const r = await invoke('assignment.showPdf', { ...scope, revision: version.id, how: 'open' }); return r.ok ? { ok: true } : r; }
    return invoke('assignment.export', { ...scope, revision: version!.id });
  });
  return <section className="assignment-workspace" aria-label="과제 작업공간">
    <div className="assignment-tabs" role="tablist" aria-label="과제 화면">
      <button role="tab" aria-selected={tab === 'instructions'} onClick={() => setTab('instructions')}>과제 안내</button>
      <button role="tab" aria-selected={tab === 'draft'} onClick={() => setTab('draft')}>초안 미리보기</button>
    </div>
    <div hidden={tab !== 'instructions'} className="assignment-instructions" role="tabpanel">{instructions}<button className="primary-action assignment-next" onClick={() => setTab('draft')}>초안 준비하기 <span aria-hidden="true">→</span></button></div>
    <div hidden={tab !== 'draft'} className="assignment-draft" role="tabpanel">
      <div className="assignment-tools">
        <ol className="flow-steps" aria-label="과제 준비 단계"><li aria-current={!version ? 'step' : undefined} className={!version ? 'current' : ''}>자료 확인</li><li aria-current={version && !version.pdf ? 'step' : undefined} className={version && !version.pdf ? 'current' : ''}>초안 검토</li><li aria-current={version?.pdf ? 'step' : undefined} className={version?.pdf ? 'current' : ''}>PDF 저장</li></ol>
        {opening ? <p role="status">과제 자료를 준비하고 있습니다…</p> : null}
        {error || state?.error ? <p role="alert" className="chat-error">{error || state?.error}</p> : null}
        <div className="assignment-actions assignment-main-actions">
          {version ? <button className="primary-action" disabled={locked} onClick={pdf}>{version.pdf ? 'PDF 열기' : '검토한 초안 PDF로 저장'}</button>
            : <button className="primary-action" disabled={locked || !characters} onClick={requestDraft}>{characters > 500_000 ? '자료 범위 확인' : '초안 만들기'}</button>}
          {working ? <button onClick={() => void cancel()}>작업 취소</button> : null}
          <Details title="더보기" className="assignment-more">
            <div className="assignment-actions">
              {version ? <button disabled={locked} onClick={requestDraft}>새 초안 만들기</button> : null}
              <button disabled={locked} onClick={refresh}>자료 새로고침</button>
              <button disabled={locked} onClick={() => void action(scope => invoke('assignment.open', { ...scope, reset: true }))}>새 과제 대화</button>
              {version?.pdf ? <button onClick={() => void action(async scope => { const r = await invoke('assignment.showPdf', { ...scope, revision: version.id, how: 'reveal' }); return r.ok ? { ok: true } : r; })}>파일 위치</button> : null}
            </div>
            {state?.versions.length ? <label>보존된 초안 <select aria-label="초안 판" value={selectedVersion} onChange={e => setSelectedVersion(e.target.value)}><option value="">최신 판 · 실시간</option>{[...state.versions].reverse().map((v, i) => <option key={v.id} value={v.id}>보존 판 {state.versions.length - i} · {new Date(v.createdAt).toLocaleString()}</option>)}</select></label> : null}
          </Details>
        </div>
        <p className="meta">채팅으로 수정하면 새 판이 자동 저장됩니다. 제출 전 내용·도표를 확인하세요.</p>
        <details ref={sources} className="ui-details assignment-sources"><summary>사용 자료 <small>{available.length - excluded.length}개{partial ? ` · 누락·제외 ${partial}개` : ''} · 변경</small></summary><div className="ui-details-body">
          <p>{characters.toLocaleString()} / 500,000자 · 과제 안내는 항상 포함됩니다.</p>
          <div className="assignment-actions"><button disabled={locked} onClick={() => setIncluded(undefined)}>모두 사용</button><button disabled={locked} onClick={() => setIncluded(available.filter(s => s.required).map(s => s.id))}>과제 안내만 사용</button></div>
          <label>자료 검색<input aria-label="초안 입력 자료 검색" value={search} onChange={e => setSearch(e.target.value)} /></label>
          <button disabled={locked || !search.trim()} onClick={() => setIncluded([...new Set([...selected, ...matches.map(s => s.id)])])}>검색 결과 추가</button>
          <ul>{matches.map(s => <li key={s.id}><label><input type="checkbox" disabled={s.required || locked} checked={selected.has(s.id)} onChange={e => setIncluded(e.target.checked ? [...selected, s.id] : [...selected].filter(id => id !== s.id))} />{s.title} · {s.characters.toLocaleString()}자{s.required ? ' · 필수' : ''}</label></li>)}</ul>
          <ul>{missing.map(s => <li key={s.id}>누락 · {s.title} — {s.reason}</li>)}</ul>
        </div></details>
        {characters > 500_000 ? <p role="status">입력 한도를 넘었습니다. 사용할 자료를 줄여 주세요.</p> : null}
        {working ? <p role="status">{state?.phase === 'generating' ? '초안을 만들고 있습니다…' : '선택한 판을 PDF로 저장하고 있습니다…'}</p> : null}
      </div>
      {preview ? <iframe sandbox="" title="제출용 과제 초안" src={preview} /> : <p className="empty-tool">자료를 확인하고 초안을 만들어 보세요.</p>}
    </div>
    <ConfirmDialog open={confirmMissing} title="사용할 자료 확인" approve="이 범위로 초안 만들기" busy={locked} onCancel={() => setConfirmMissing(false)} onApprove={() => void generate(true)}>
      <p>선택한 텍스트 <strong>{available.length - excluded.length}개</strong>로 만듭니다. 누락 {missing.length}개와 제외 {excluded.length}개는 읽지 않습니다.</p>
      <p>PDF 그림·도표와 빠진 원본은 채팅에서 확인하고, 제출 전에 초안을 검토하세요.</p>
      <Details title="빠진 자료 확인"><ul>{[...missing, ...excluded].map(s => <li key={s.id}>{s.title}</li>)}</ul></Details>
    </ConfirmDialog>
  </section>;
}
