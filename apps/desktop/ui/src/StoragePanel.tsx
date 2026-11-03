import { useCallback, useEffect, useState } from 'react';
import type { IpcResponse } from '@learningxxx/contracts';
import { invoke } from './host-api.ts';
import { formatSeoul } from './library.ts';
import { storageSummary, sizeText } from './storage.ts';

type Storage = IpcResponse<'media.storage'>;

/**
 * WBS-087: what recordings and downloaded lecture videos take on this Mac,
 * per course. Originals whose transcription is finished can be deleted to
 * free space; transcripts, corrections, notes and translations always stay.
 */
export function StoragePanel() {
  const [data, setData] = useState<Storage>();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await invoke('media.storage', {});
    if (r.ok) setData(r.data); else setNotice(r.error.message);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!data) return <p className="subtle">{notice || '확인하는 중…'}</p>;
  const total = storageSummary(data.courses);
  const toggle = (id: string) => setChosen((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const chosenBytes = data.courses.flatMap((c) => c.items).filter((i) => chosen.has(i.assetId)).reduce((a, i) => a + i.bytes, 0);

  const remove = async () => {
    if (!chosen.size || !window.confirm(`선택한 원본 ${chosen.size}개(${sizeText(chosenBytes)})를 이 Mac에서 지울까요?\n전사·정리본·번역·메모는 그대로 남습니다. 지운 녹음은 되살릴 수 없고, 온라인 강의 영상은 다시 받을 수 있습니다.`)) return;
    setBusy(true);
    let removed = 0, freed = 0; const skipped: string[] = [];
    for (const course of data.courses) {
      const ids = course.items.filter((i) => chosen.has(i.assetId)).map((i) => i.assetId);
      if (!ids.length) continue;
      const r = await invoke('media.removeOriginals', { courseId: course.courseId, assetIds: ids });
      if (r.ok) { removed += r.data.removed; freed += r.data.freedBytes; skipped.push(...r.data.skipped.map((s) => s.reason)); } else skipped.push(r.error.message);
    }
    setBusy(false); setChosen(new Set());
    setNotice(`${removed}개를 지워 ${sizeText(freed)}를 비웠습니다.${skipped.length ? ` 못 지운 것: ${[...new Set(skipped)].join(', ')}` : ''}`);
    await load();
  };

  return <div className="storage-panel">
    <p className="subtle">녹음·영상 원본 {sizeText(total.keptBytes)} 사용 · 전사가 끝나 지울 수 있는 것 {sizeText(total.removableBytes)}{total.removedCount ? ` · 이미 지운 원본 ${total.removedCount}개` : ''}</p>
    {data.courses.map((course) => {
      const removable = course.items.filter((i) => i.transcribed && !i.removedAt);
      return <details key={course.courseId}>
        <summary>{course.title} · {sizeText(course.items.filter((i) => !i.removedAt).reduce((a, i) => a + i.bytes, 0))}</summary>
        {removable.length ? <button className="link-button" onClick={() => setChosen((c) => new Set([...c, ...removable.map((i) => i.assetId)]))}>전사 끝난 원본 모두 고르기</button> : null}
        <ul>{course.items.map((i) => <li key={i.assetId}>
          <label className={i.removedAt ? 'is-removed' : ''}>
            <input type="checkbox" disabled={!i.transcribed || !!i.removedAt || busy} checked={chosen.has(i.assetId)} onChange={() => toggle(i.assetId)} />
            {i.kind === 'recording' ? '녹음' : '영상'} · {i.title} <small className="subtle">{sizeText(i.bytes)} · {formatSeoul(i.createdAt)} · {i.removedAt ? '원본 지움 · 전사 보존' : i.transcribed ? '전사 완료' : '전사 전 · 지울 수 없음'}</small>
          </label>
        </li>)}</ul>
      </details>;
    })}
    {!data.courses.length ? <p className="subtle">아직 녹음이나 받은 영상이 없습니다.</p> : null}
    <button disabled={busy || !chosen.size} onClick={() => void remove()}>{busy ? '지우는 중…' : `선택한 원본 지우기${chosen.size ? ` (${chosen.size}개 · ${sizeText(chosenBytes)})` : ''}`}</button>
    {notice ? <p className="subtle" role="status">{notice}</p> : null}
  </div>;
}
