import { Details } from './Details.tsx';
import { useState } from 'react';
import type { IpcResponse, Week } from '@learningxxx/contracts';
import { invoke } from './host-api.ts';

type Plan = IpcResponse<'materials.choose'>;
interface Choice { include: boolean; title: string; weekId: string }

const titleOf = (name: string) => name.replace(/\.[^.]+$/, '').trim().slice(0, 300) || '추가한 자료';
export const sizeText = (bytes: number) => bytes < 1024 ** 2 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

/**
 * WBS-088: the student's own files (PDF, slides, documents, pictures) added
 * to a week or to 기타 자료. Copies go into the app; the files themselves are
 * only read, and nothing is sent to the LMS.
 */
export function AddMaterials({ courseId, weeks, weekId, onDone }: { courseId: string; weeks: readonly Week[]; weekId: string | undefined; onDone: () => void }) {
  const [plan, setPlan] = useState<Plan>();
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  const choose = async () => {
    setBusy(true); setNotice(undefined);
    try {
    const r = await invoke('materials.choose', {});
    if (!r.ok) return setNotice(r.error.message);
    if (!r.data.files.length) return;
    setPlan(r.data);
    setChoices(Object.fromEntries(r.data.files.filter((f) => !f.problem).map((f) => [f.id, { include: true, title: titleOf(f.name), weekId: weekId ?? '' }])));
    } catch { setNotice('파일을 고르지 못했습니다. 다시 시도하세요.'); }
    finally { setBusy(false); }
  };
  const add = async () => {
    if (!plan?.planId) return;
    const files = Object.entries(choices).filter(([, c]) => c.include).map(([id, c]) => ({ id, title: c.title, ...(c.weekId ? { weekId: c.weekId } : {}) }));
    if (!files.length) return;
    setBusy(true);
    try {
    const r = await invoke('materials.add', { planId: plan.planId, courseId, files });
    if (!r.ok) return setNotice(r.error.message);
    setNotice(`${r.data.added}개를 추가했습니다.${r.data.failed.length ? ` ${r.data.failed.length}개는 못 했습니다: ${r.data.failed.map((f) => f.message).join(' / ')}` : ''}`);
    setPlan(undefined); setChoices({});
    onDone();
    } catch { setNotice('자료를 추가하지 못했습니다. 선택한 파일을 확인하고 다시 시도하세요.'); }
    finally { setBusy(false); }
  };
  const set = (id: string, change: Partial<Choice>) => setChoices((c) => ({ ...c, [id]: { ...c[id]!, ...change } }));

  return <div className="add-materials">
    {!plan ? <button disabled={busy} onClick={() => void choose()}>{busy ? '여는 중…' : '내 파일 고르기'}</button> : null}
    <p className="meta">{plan ? '선택한 주차' : weeks.find(w=>w.id===weekId)?.label ?? '기타 자료'} · 앱에만 사본 추가 · 원본 유지</p>
    {plan ? <>
      <ul>{plan.files.map((f) => <li key={f.id}>
        {f.problem ? <span className="meta">{f.name} — {f.problem}</span> : <>
          <label><input type="checkbox" checked={choices[f.id]!.include} onChange={(e) => set(f.id, { include: e.target.checked })} /> <small className="meta">{f.name} · {sizeText(f.bytes)} · {weeks.find(w => w.id === choices[f.id]!.weekId)?.label ?? '기타 자료'}</small></label>
          <Details title="이름·주차 변경"><input aria-label={`${f.name} 제목`} value={choices[f.id]!.title} maxLength={300} onChange={(e) => set(f.id, { title: e.target.value })} />
          <select aria-label={`${f.name} 주차`} value={choices[f.id]!.weekId} onChange={(e) => set(f.id, { weekId: e.target.value })}>
            {weeks.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}<option value="">기타 자료</option>
          </select></Details>
        </>}
      </li>)}</ul>
      <button disabled={busy || !Object.values(choices).some((c) => c.include)} onClick={() => void add()}>{busy ? '추가하는 중…' : '추가'}</button> <button disabled={busy} onClick={() => { setPlan(undefined); setChoices({}); }}>취소</button>
    </> : null}
    {notice ? <p className="meta" role="status">{notice}</p> : null}
  </div>;
}

/** WBS-088: on a file the student added — another week, or off the course (the app's copy only). */
export function ManualControls({ courseId, resourceId, weeks, weekId, onDone }: { courseId: string; resourceId: string; weeks: readonly Week[]; weekId: string | undefined; onDone: (removed: boolean) => void }) {
  const [error, setError] = useState<string>();
  const change = async (request: { weekId?: string | null; remove?: boolean }) => {
    const r = await invoke('materials.change', { courseId, resourceId, ...request });
    if (r.ok) { setError(undefined); onDone(!!request.remove); } else setError(r.error.message);
  };
  return <span className="manual-controls">
    <select aria-label="자료 주차 바꾸기" value={weekId ?? ''} onChange={(e) => void change({ weekId: e.target.value || null })}>
      {weeks.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}<option value="">기타 자료</option>
    </select>
    <button title="이 과목 목록에서 뺍니다(원래 파일은 그대로)" onClick={() => { if (window.confirm('이 자료를 과목 목록에서 뺄까요? 원래 파일은 그대로입니다.')) void change({ remove: true }); }}>목록에서 빼기</button>
    {error ? <small role="alert">{error}</small> : null}
  </span>;
}
