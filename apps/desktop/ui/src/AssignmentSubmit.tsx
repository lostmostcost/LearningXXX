import { useCallback, useEffect, useState } from 'react';
import type { IpcResponse } from '@learningxxx/contracts';
import { invoke, onHostPush } from './host-api.ts';
import { formatSeoul } from './library.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';

type Plan = IpcResponse<'submit.choose'>;
type Rule = IpcResponse<'submit.rules'>['rules'][number];
const STATE: Record<Rule['state'], string> = { waiting: '기다리는 중', submitting: '제출하는 중', done: '자동 제출함', already: '직접 제출해 건너뜀', failed: '실패', cancelled: '취소함' };
const BEFORE = [[10, '10분'], [30, '30분'], [60, '1시간'], [180, '3시간'], [1440, '하루']] as const;
const sizeText = (b: number) => (b < 1024 ** 2 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 ** 2).toFixed(1)} MB`);

/**
 * WBS-058: hand in a file for this assignment from the app. The student picks
 * a file and sees exactly what will be sent; then either submits now or sets
 * "submit N before the deadline if I have not submitted by then". Both ask
 * once more in the app's own dialog before anything is sent; nothing else
 * (the AI chat included) can press it. Resubmitting is a new attempt at the
 * LMS, which keeps the earlier ones.
 */
export function AssignmentSubmit({ courseId, resourceId }: { courseId: string; resourceId: string }) {
  const [plan, setPlan] = useState<Plan>();
  const [rules, setRules] = useState<Rule[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [before, setBefore] = useState<number>(60);
  const [asking, setAsking] = useState<'now' | 'rule'>();
  const loadRules = useCallback(async () => { const r = await invoke('submit.rules', {}); if (r.ok) setRules(r.data.rules.filter((x) => x.resourceId === resourceId)); }, [resourceId]);
  useEffect(() => { setPlan(undefined); setNotice(''); setAsking(undefined); void loadRules(); }, [loadRules]);
  // An automatic submission ran while this screen was open.
  useEffect(() => onHostPush((push) => { if (push.kind === 'submit.auto' && push.courseId === courseId) void loadRules(); }), [courseId, loadRules]);

  const choose = async () => {
    setBusy(true); setNotice('');
    const r = await invoke('submit.choose', { courseId, resourceId });
    setBusy(false);
    if (!r.ok) return setNotice(r.error.message);
    if (r.data.planId) setPlan(r.data);
  };
  const submitNow = async () => {
    if (!plan?.planId) return;
    setBusy(true);
    const r = await invoke('submit.confirm', { planId: plan.planId });
    setBusy(false); setAsking(undefined);
    if (!r.ok) return setNotice(`${r.error.message} 다시 제출하기 전에 LMS에서 제출 상태를 확인하세요.`);
    setPlan(undefined);
    setNotice(`제출했습니다 · ${r.data.attempt ?? '?'}번째 제출 · ${r.data.submittedAt ? formatSeoul(r.data.submittedAt) : ''} · ${r.data.files.join(', ')}`);
  };
  const schedule = async () => {
    if (!plan?.planId) return;
    setBusy(true);
    const r = await invoke('submit.schedule', { planId: plan.planId, minutesBefore: before });
    setBusy(false); setAsking(undefined);
    if (!r.ok) return setNotice(r.error.message);
    setPlan(undefined); setNotice(`${formatSeoul(r.data.at)}에 자동 제출합니다(그 전에 직접 제출하면 하지 않음).`);
    await loadRules();
  };

  const a = plan?.assignment;
  const label = BEFORE.find(([m]) => m === before)?.[1];
  return <section className="assignment-submit">
    <h3>앱에서 제출</h3>
    {!plan ? <button disabled={busy} onClick={() => void choose()}>{busy ? '확인하는 중…' : '제출할 파일 고르기'}</button> : null}
    {plan && a ? <div className="submit-plan">
      <p><strong>{a.name}</strong> · 파일 {plan.fileName} ({sizeText(plan.bytes ?? 0)})</p>
      <p className="meta">마감 {a.dueAt ? formatSeoul(a.dueAt) : '없음'}{a.lockAt ? ` · 제출 마감 ${formatSeoul(a.lockAt)}` : ''} · 허용 형식 {a.extensions.length ? a.extensions.join(', ') : '제한 없음'} · 제출 {a.attempt ?? 0}회{a.allowedAttempts ? ` / 최대 ${a.allowedAttempts}회` : ''}{a.files.length ? ` · 지금 제출된 파일: ${a.files.join(', ')}` : ''}</p>
      {plan.problem ? <p className="chat-error" role="alert">{plan.problem}</p> : null}
      {plan.warning ? <p className="meta" role="note">{plan.warning}</p> : null}
      <div className="submit-actions">
        <button className="primary-action" disabled={busy || !!plan.problem} onClick={() => setAsking('now')}>지금 제출</button>
        {a.dueAt ? <><select aria-label="자동 제출 시각" value={before} onChange={(e) => setBefore(Number(e.target.value))}>{BEFORE.map(([m, l]) => <option key={m} value={m}>마감 {l} 전</option>)}</select>
          <button disabled={busy || (!!plan.problem && !/아직 제출 기간/.test(plan.problem))} onClick={() => setAsking('rule')}>자동 제출 걸기</button></> : null}
        <button disabled={busy} onClick={() => setPlan(undefined)}>취소</button>
      </div>
      <ConfirmDialog open={asking !== undefined} title={asking === 'rule' ? '자동 제출 걸기' : 'LMS에 제출'} approve={asking === 'rule' ? '자동 제출 걸기' : '제출하기'} busy={busy}
        onCancel={() => setAsking(undefined)} onApprove={() => void (asking === 'rule' ? schedule() : submitNow())}>
        <p><strong>{a.name}</strong>에 <strong>{plan.fileName}</strong>({sizeText(plan.bytes ?? 0)})을(를) {asking === 'rule' ? `마감 ${label} 전까지 직접 제출하지 않으면 자동으로` : '지금'} 제출합니다.</p>
        <p>마감 {a.dueAt ? formatSeoul(a.dueAt) : '없음'}{a.attempt ? ` · 이미 ${a.attempt}회 제출함(새 제출로 추가됩니다)` : ''}{plan.warning ? ` · ${plan.warning}` : ''}</p>
        <p>{asking === 'rule' ? '그 시각에 앱이 켜져 있어야 합니다. 고른 파일 그대로 보냅니다.' : 'LMS에 실제 제출 기록이 남고, 앱에서 되돌릴 수 없습니다.'}</p>
      </ConfirmDialog>
    </div> : null}
    {notice ? <p className="meta" role="status">{notice}</p> : null}
    {rules.length ? <ul className="submit-rules">{rules.map((r) => <li key={r.id}>{formatSeoul(r.at)} · {r.fileName} · {STATE[r.state]}{r.message ? ` · ${r.message}` : ''}
      {r.state === 'waiting' ? <button className="link-button" onClick={() => void invoke('submit.cancelRule', { ruleId: r.id }).then(() => loadRules())}>취소</button> : null}</li>)}</ul> : null}
  </section>;
}
