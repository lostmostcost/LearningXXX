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
  const [allowMissing, setAllowMissing] = useState(false);
  const [included, setIncluded] = useState<string[] | undefined>();
  const [search, setSearch] = useState('');
  const [selectedVersion, setSelectedVersion] = useState('');
  useEffect(() => { setAllowMissing(false); setIncluded(undefined); }, [state?.sourceToken]);
  const available = state?.sources.filter(s => s.status === 'available') ?? [];
  const selected = new Set(included ?? available.map(s => s.id));
  const excluded = available.filter(s => !selected.has(s.id));
  const missing = state?.sources.filter(s => s.status === 'missing') ?? [];
  const partial = missing.length + excluded.length;
  const characters = available.filter(s => selected.has(s.id)).reduce((sum, s) => sum + s.characters, 0);
  const matches = available.filter(s => s.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const selectSources = (ids: string[] | undefined) => { setIncluded(ids); setAllowMissing(false); };
  const version = state?.versions.find(v => v.id === (selectedVersion || state.revision));
  const working = state?.phase === 'generating' || state?.phase === 'exporting';
  // The URL comes only from the host. Older versions replace only its last UUID.
  const preview = version && state?.previewUrl ? state.previewUrl.replace(/[^/]+$/, version.id) : undefined;
  return <section className="assignment-workspace" aria-label="과제 작업공간">
    <div className="assignment-tabs" role="tablist" aria-label="과제 화면">
      <button role="tab" aria-selected={tab === 'instructions'} onClick={() => setTab('instructions')}>과제 안내</button>
      <button role="tab" aria-selected={tab === 'draft'} onClick={() => setTab('draft')}>AI 제출용 초안 미리보기</button>
    </div>
    <div hidden={tab !== 'instructions'} className="assignment-instructions" role="tabpanel">{instructions}</div>
    <div hidden={tab !== 'draft'} className="assignment-draft" role="tabpanel">
      <div className="assignment-tools">
        <p>오른쪽 과제 전용 채팅에서 수정을 요청하면 새 판이 자동으로 표시됩니다. 제출 전에 내용과 도표를 확인하세요.</p>
        {opening ? <p role="status">전 주차 자료와 과제 대화를 준비하고 있습니다…</p> : null}
        {error || state?.error ? <p role="alert" className="chat-error">{error || state?.error}</p> : null}
        <details><summary>초기 생성 입력 · 선택 {available.length - excluded.length}개 · 누락/제외 {partial}개 · {characters.toLocaleString()}자 / 500,000자</summary>
          <p>한도보다 많으면 필요한 자료를 선택하세요. 제외한 자료를 검토했다고 표시하지 않습니다. 과제 안내는 항상 포함됩니다.</p>
          <div className="assignment-actions"><button disabled={working || pending} onClick={() => selectSources(undefined)}>모두 선택</button><button disabled={working || pending} onClick={() => selectSources(available.filter(s => s.required).map(s => s.id))}>과제 안내만 선택</button></div>
          <label>자료 이름 검색<input aria-label="초안 입력 자료 검색" value={search} onChange={e => setSearch(e.target.value)} /></label>
          <button disabled={working || pending || !search.trim()} onClick={() => selectSources([...new Set([...selected, ...matches.map(s => s.id)])])}>검색 결과를 입력에 추가</button>
          <ul>{matches.map(s => <li key={s.id}><label><input type="checkbox" disabled={s.required || working || pending} checked={selected.has(s.id)} onChange={e => selectSources(e.target.checked ? [...selected, s.id] : [...selected].filter(id => id !== s.id))} />{s.title} · {s.characters.toLocaleString()}자{s.required ? ' · 필수' : ''}</label></li>)}</ul>
          <ul>{missing.map(s => <li key={s.id}>누락 · {s.title} — {s.reason}</li>)}</ul>
        </details>
        {partial ? <label className="assignment-consent"><input type="checkbox" checked={allowMissing} onChange={e => setAllowMissing(e.target.checked)} />누락·제외 범위를 확인했습니다. 선택한 텍스트로 부분 초안을 만들고, 그림·원본은 과제 채팅에서 확인하겠습니다.</label> : null}
        {characters > 500_000 ? <p role="status">초기 생성 한도를 넘습니다. 입력 자료를 선택하거나 오른쪽 과제 채팅에서 원본을 나눠 검토해 주세요.</p> : null}
        <div className="assignment-actions">
          <button disabled={opening || !state?.sourceToken || pending || working || characters > 500_000 || !!partial && !allowMissing} onClick={() => void action((scope, s) => invoke('assignment.generate', { ...scope, sourceToken: s.sourceToken, allowMissing, ...(included ? { includedSourceIds: included } : {}) }))}>{state?.revision ? '새 초안 만들기' : 'AI 초안 만들기'}</button>
          <button disabled={opening || pending || working} onClick={refresh}>자료 다시 읽기</button>
          {working ? <button onClick={() => void cancel()}>작업 취소</button> : null}
          <button disabled={opening || !state || pending || working} onClick={() => void action(scope => invoke('assignment.open', { ...scope, reset: true }))}>새 과제 대화</button>
          {version ? <><select aria-label="초안 판" value={selectedVersion} onChange={e => setSelectedVersion(e.target.value)}><option value="">최신 판 · 실시간</option>{[...state!.versions].reverse().map((v, i) => <option key={v.id} value={v.id}>보존 판 {state!.versions.length - i} · {new Date(v.createdAt).toLocaleString()}</option>)}</select>
            <button disabled={pending || working} onClick={() => void action(scope => invoke('assignment.export', { ...scope, revision: version.id }))}>{version.pdf ? 'PDF 준비됨' : '이 판을 PDF로 만들기'}</button>
            {version.pdf ? <><button onClick={() => void action(async scope => { const r = await invoke('assignment.showPdf', { ...scope, revision: version.id, how: 'open' }); return r.ok ? { ok: true } : r; })}>PDF 열기</button><button onClick={() => void action(async scope => { const r = await invoke('assignment.showPdf', { ...scope, revision: version.id, how: 'reveal' }); return r.ok ? { ok: true } : r; })}>Finder에서 보기</button></> : null}</> : null}
        </div>
        {working ? <p role="status">{state?.phase === 'generating' ? 'Claude가 초안을 만들고 있습니다…' : '선택한 판을 PDF로 출력하고 있습니다…'}</p> : null}
      </div>
      {preview ? <iframe sandbox="" title="제출용 과제 초안" src={preview} /> : <p className="empty-tool">아직 초안이 없습니다. AI 초안 만들기 또는 오른쪽 채팅에서 작성을 요청하세요.</p>}
    </div>
  </section>;
}
