import { useEffect, useRef, useState } from 'react';
import type { IpcResponse } from '@learningxxx/contracts';
import { AssignmentPanel, type useAssignment } from './AssignmentPanel.tsx';
import { SignInSettings } from './SignInSettings.tsx';

type State = IpcResponse<'assignment.open'>;
const scope = { courseId: '11111111-1111-4111-8111-111111111111', assignmentId: '22222222-2222-4222-8222-222222222222' };
const initial: State = { sessionId: '33333333-3333-4333-8333-333333333333', title: '합성 과제', phase: 'idle', error: '', sourceToken: 'a'.repeat(64), sources: [
  { id: 'instructions', title: '과제 안내', status: 'available', required: true, characters: 150 },
  { id: 'lecture', title: '강의 자료', status: 'available', required: false, characters: 1200 },
  { id: 'diagram', title: 'PDF 그림', status: 'missing', required: false, characters: 0, reason: '텍스트로 읽을 수 없는 도표' },
], versions: [] };

/** Browser-only, in-memory acceptance fixture. main.tsx never mounts this over a real preload. */
export function GuidedPreview() {
  const [state, setState] = useState<State>(initial), current = useRef(state);
  current.current = state;
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const [calls, setCalls] = useState({ generate: 0, pdf: 0 });
  useEffect(() => {
    const host = window.host!;
    const invoke = host.invoke;
    host.invoke = async (channel, payload) => {
      if (channel === 'assignment.generate') {
        if (!(payload as { allowMissing: boolean }).allowMissing) return { ok: false, error: { message: '부분 입력 동의 필요' } };
        setCalls(c => ({ ...c, generate: c.generate + 1 }));
        const next = { ...current.current, revision: '44444444-4444-4444-8444-444444444444', versions: [{ id: '44444444-4444-4444-8444-444444444444', sha256: 'b'.repeat(64), createdAt: new Date().toISOString(), pdf: false }] };
        return { ok: true, data: next };
      }
      if (channel === 'assignment.export') { setCalls(c => ({ ...c, pdf: c.pdf + 1 })); return { ok: true, data: { ...current.current, versions: current.current.versions.map(v => ({ ...v, pdf: true })) } }; }
      if (channel === 'assignment.showPdf') return { ok: true, data: {} };
      if (channel === 'assignment.open') return { ok: true, data: current.current };
      return invoke(channel, payload);
    };
    return () => { host.invoke = invoke; };
  }, []);
  const action: ReturnType<typeof useAssignment>['action'] = async work => {
    setPending(true); setError('');
    try { const r = await work(scope, current.current); if (r.ok && r.data) setState(r.data); else if (!r.ok) setError(r.error?.message ?? '합성 오류'); }
    finally { setPending(false); }
  };
  return <main className="guided-preview"><header><strong>합성 UI 검사</strong><span>실제 AI·파일·계정 호출 없음</span><SignInSettings /></header>
    <output aria-label="합성 요청 횟수">생성 {calls.generate}회 · PDF {calls.pdf}회</output>
    <AssignmentPanel workspace={{ state, error, opening: false, pending, action, refresh: () => {}, cancel: async () => {} }} instructions={<article><h2>주차 학습 과제</h2><p>강의 내용을 정리하고 도표의 관계를 설명하세요.</p></article>} />
  </main>;
}
