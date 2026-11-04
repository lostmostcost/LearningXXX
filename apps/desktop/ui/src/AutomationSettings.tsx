import { useEffect, useRef, useState } from 'react';
import { Details } from './Details.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import type { AutomationSettings as Settings, IpcResponse } from '@learningxxx/contracts';
import { invoke } from './host-api.ts';
import { formatSeoul } from './library.ts';

const ITEMS: { key: keyof Settings; label: string; detail: string; ai: boolean }[] = [
  { key: 'transcribe', label: '녹음 직후 전사', detail: '새 녹음과 받은 강의 영상을 바로 받아 적습니다(이 Mac에서, 구독 사용 없음). 끄면 전사가 멈춰 기다립니다.', ai: false },
  { key: 'correct', label: '전사 직후 자동 교정', detail: '잘못 알아들은 용어·띄어쓰기를 고친 판을 새로 만듭니다(원래 판은 남음).', ai: true },
  { key: 'readable', label: '정리본 자동 만들기', detail: '교정한 전사(없으면 원래 전사)로 읽기 쉬운 정리본을 만듭니다.', ai: true },
  { key: 'mentions', label: '과제·시험 안내 자동 추가', detail: '강의에서 말한 과제·시험을 찾아 과제 목록에 넣습니다(나중에 지울 수 있음).', ai: true },
  { key: 'courseMd', label: '과목 정리(course.md) 자동 갱신', detail: '전사가 끝나거나 자료가 바뀌면 다시 만듭니다(과목마다 30분에 한 번까지).', ai: true },
  { key: 'review', label: '수업 뒤 복습 노트', detail: '강의 전사가 끝나면 그 주차 복습 노트(요점·확인 질문)를 만듭니다.', ai: true },
  { key: 'preview', label: '수업 전 예습 노트', detail: '수업 3시간 전부터, 이번 주 자료로 "이번 수업 따라가기" 노트를 만듭니다(과목 정리나 시간표에 수업 시간이 있어야 함).', ai: true },
];

/**
 * WBS-083: what the app does by itself. Transcription is on; every step that
 * uses the student's Claude subscription is off until they turn it on.
 */
export function AutomationSettings() {
  const [settings, setSettings] = useState<Settings>();
  const [status, setStatus] = useState<IpcResponse<'automation.status'>>();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false), [confirmAi, setConfirmAi] = useState(false);
  const lock = useRef(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    void invoke('app.preferences', {}).then(r => { if (alive) { if (r.ok) { setSettings(r.data.automation); setNote(''); } else setNote(r.error.message); } }).catch(() => { if (alive) setNote('설정을 불러오지 못했습니다.'); });
    void invoke('automation.status', {}).then(r => { if (alive && r.ok) setStatus(r.data); }).catch(() => undefined);
    return () => { alive = false; };
  }, [reload]);
  const save = async (automation: Partial<Settings>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setNote('');
    try {
      const r = await invoke('app.setPreferences', { automation });
      if (r.ok) { setSettings(r.data.automation); setConfirmAi(false); setNote('저장했습니다.'); } else setNote(r.error.message);
    } catch { setNote('저장하지 못했습니다. 다시 시도하세요.'); }
    finally { lock.current = false; setBusy(false); }
  };
  const aiKeys = ITEMS.filter(i => i.ai).map(i => i.key);
  const aiCount = aiKeys.filter(key => settings?.[key]).length;
  const profile = (enabled: boolean) => Object.fromEntries(aiKeys.map(key => [key, enabled])) as Partial<Settings>;
  return <section className="automation-setting">
    <p className="meta">{!settings ? '불러오는 중…' : `자동 전사 ${settings.transcribe ? '켜짐' : '꺼짐'} · AI 보조 ${aiCount}개`}</p>
    <div className="automation-presets"><button disabled={!settings || busy} aria-pressed={!!settings?.transcribe && !aiCount} onClick={() => void save({ ...profile(false), transcribe: true })}>전사만 자동</button><button disabled={!settings || busy} aria-pressed={aiCount === aiKeys.length} onClick={() => { setNote(''); setConfirmAi(true); }}>AI 학습 보조</button></div>
    <Details title="기능별 맞춤 설정">
    <p className="meta">✦ 기능은 Claude 구독 사용량을 씁니다. 선택한 기능만 자동 실행합니다.</p>
    {ITEMS.map((item) => <label key={item.key} className="automation-item">
      <input type="checkbox" disabled={!settings || busy} checked={settings?.[item.key] ?? false} onChange={(e) => void save({ [item.key]: e.target.checked })} />
      <span><strong>{item.ai ? '✦ ' : ''}{item.label}</strong><small className="meta">{item.detail}</small></span>
    </label>)}
    </Details>
    {note ? <p className="meta" role="status">{note}</p> : null}
    {!settings && note ? <button onClick={() => setReload(v => v + 1)}>다시 읽기</button> : null}
    {status && (status.running || status.waiting || status.recent.length) ? <details><summary>최근 자동 작업{status.running ? ` · 지금: ${status.running}` : ''}{status.waiting ? ` · 대기 ${status.waiting}` : ''}</summary>
      <ul>{status.recent.map((r, i) => <li key={i} className="meta">{formatSeoul(r.at)} · {r.title} · {r.ok ? '완료' : `실패: ${r.message ?? ''}`}</li>)}</ul>
    </details> : null}
    <ConfirmDialog open={confirmAi} title="AI 학습 보조를 켤까요?" approve="확인하고 켜기" busy={busy} onCancel={() => setConfirmAi(false)} onApprove={() => void save(profile(true))}>
      <p>교정·정리·과제 안내 추출·과목 요약·복습·예습을 자동화합니다. 전사나 자료가 갱신되면 <strong>Claude 구독 사용량</strong>이 발생합니다.</p>
      <p>자동 전사 설정은 유지하며, 언제든 전사만 자동으로 되돌릴 수 있습니다.</p>
      {note ? <p role="alert">{note}</p> : null}
    </ConfirmDialog>
  </section>;
}
