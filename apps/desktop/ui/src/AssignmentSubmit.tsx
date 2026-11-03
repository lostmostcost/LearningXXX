import { useCallback, useEffect, useState } from 'react';
import type { IpcResponse } from '@learningxxx/contracts';
import { invoke } from './host-api.ts';
import { formatSeoul } from './library.ts';

type Plan = IpcResponse<'submit.choose'>;
type Rule = IpcResponse<'submit.rules'>['rules'][number];
const STATE: Record<Rule['state'], string> = { waiting: '기다리는 중', submitting: '제출하는 중', done: '자동 제출함', already: '직접 제출해 건너뜀', failed: '실패', cancelled: '취소함' };
const BEFORE = [[10, '10분'], [30, '30분'], [60, '1시간'], [180, '3시간'], [1440, '하루']] as const;
const sizeText = (b: number) => (b < 1024 ** 2 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 ** 2).toFixed(1)} MB`);

/**
 * WBS-058: hand in a file for this assignment from the app. The student picks
 * a file and sees exactly what will be sent; then either submits now or sets
 * "submit N before the deadline if I have not submitted by then". Both ask
 * once more before anything is sent. The LMS keeps the right to accept,
 * and resubmitting replaces nothing here — it is a new attempt at the LMS.
 */
export function AssignmentSubmit({ courseId, resourceId }: { courseId: string; resourceId: string }) {
  const [plan, setPlan] = useState<Plan>();
  const [rules, setRules] = useState<Rule[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [before, setBefore] = useState<number>(60);
  const loadRules = useCallback(async () => { const r = await invoke('submit.rules', {}); if (r.ok) setRules(r.data.rules.filter((x) => x.resourceId === resourceId)); }, [resourceId]);
  useEffect(() => { setPlan(undefined); setNotice(''); void loadRules(); }, [loadRules]);

  const choose = async () => {
    setBusy(true); setNotice('');
    const r = await invoke('submit.choose', { courseId, resourceId });
    setBusy(false);
    if (!r.ok) return setNotice(r.error.message);
    if (r.data.planId) setPlan(r.data);
  };
  const submitNow = async () => {
    if (!plan?.planId || !window.confirm(`"${plan.assignment?.name}"에 ${plan.fileName}을(를) 지금 LMS에 제출할까요?`)) return;
    setBusy(true);
    const r = await invoke('submit.confirm', { planId: plan.planId });
    setBusy(false);
    if (!r.ok) return setNotice(`${r.error.message} (LMS에서 제출 상태를 확인하세요)`);
    setPlan(undefined);
    setNotice(`제출했습니다 · ${r.data.attempt ?? ''}번째 제출 · ${r.data.submittedAt ? formatSeoul(r.data.submittedAt) : ''} · ${r.data.files.join(', ')}`);
  };
  const schedule = async () => {
    const label = BEFORE.find(([m]) => m === before)?.[1];
    if (!plan?.planId || !window.confirm(`마감 ${label} 전까지 직접 제출하지 않으면 ${plan.fileName}을(를) 자동으로 제출할까요? (앱이 켜져 있어야 합니다)`)) return;
    const r = await invoke('submit.schedule', { planId: plan.planId, minutesBefore: before });
    if (!r.ok) return setNotice(r.error.message);
    setPlan(undefined); setNotice(`${formatSeoul(r.data.at)}에 자동 제출합니다(그 전에 직접 제출하면 하지 않음).`);
    await loadRules();
  };

  const a = plan?.assignment;
  return <section className="assignment-submit">
    <h3>앱에서 제출</h3>
    {!plan ? <button disabled={busy} onClick={() => void choose()}>{busy ? '확인하는 중…' : '제출할 파일 고르기'}</button> : null}
    {plan && a ? <div className="submit-plan">
      <p><strong>{a.name}</strong> · 파일 {plan.fileName} ({sizeText(plan.bytes ?? 0)})</p>
      <p className="meta">마감 {a.dueAt ? formatSeoul(a.dueAt) : '없음'}{a.lockAt ? ` · 제출 마감 ${formatSeoul(a.lockAt)}` : ''} · 허용 형식 {a.extensions.length ? a.extensions.join(', ') : '제한 없음'} · 제출 {a.attempt ?? 0}회{a.allowedAttempts ? ` / 최대 ${a.allowedAttempts}회` : ''}{a.files.length ? ` · 지금 제출된 파일: ${a.files.join(', ')}` : ''}</p>
      {plan.problem ? <p className="chat-error" role="alert">{plan.problem}</p> : null}
      <div className="submit-actions">
        <button disabled={busy || !!plan.problem} onClick={() => void submitNow()}>{busy ? '제출하는 중…' : '지금 제출'}</button>
        {a.dueAt ? <><select aria-label="자동 제출 시각" value={before} onChange={(e) => setBefore(Number(e.target.value))}>{BEFORE.map(([m, l]) => <option key={m} value={m}>마감 {l} 전</option>)}</select>
          <button disabled={busy || (!!plan.problem && !/아직 제출 기간/.test(plan.problem))} onClick={() => void schedule()}>자동 제출 걸기</button></> : null}
        <button disabled={busy} onClick={() => setPlan(undefined)}>취소</button>
      </div>
    </div> : null}
    {notice ? <p className="meta" role="status">{notice}</p> : null}
    {rules.length ? <ul className="submit-rules">{rules.map((r) => <li key={r.id}>{formatSeoul(r.at)} · {r.fileName} · {STATE[r.state]}{r.message ? ` · ${r.message}` : ''}
      {r.state === 'waiting' ? <button className="link-button" onClick={() => void invoke('submit.cancelRule', { ruleId: r.id }).then(() => loadRules())}>취소</button> : null}</li>)}</ul> : null}
  </section>;
}
