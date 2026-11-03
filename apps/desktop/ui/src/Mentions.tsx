import { useState } from "react";
import type { LectureMention, MentionCandidate } from "@learningxxx/contracts";
import { mediaTime } from "./transcript-model.ts";

export const MENTION_KIND = { assignment: "과제", exam: "시험", other: "기타" } as const;

/**
 * WBS-070: what Claude Code found in a transcript. Nothing is added until the
 * user ticks the ones that are right; the time and quote are the transcript's.
 */
export function MentionCandidates({ candidates, onPlay, onAdd, onClose }: { candidates: MentionCandidate[]; onPlay: (startMs: number) => void; onAdd: (chosen: MentionCandidate[]) => Promise<void>; onClose: () => void }) {
  const [checked, setChecked] = useState<Set<number>>(new Set(candidates.map((_, i) => i)));
  const [busy, setBusy] = useState(false);
  if (!candidates.length) return <div className="notice-box">이 전사에서 과제·시험 안내를 찾지 못했습니다. <button className="link-button" onClick={onClose}>닫기</button></div>;
  return <div className="mention-candidates" aria-label="과제·시험 안내 후보">
    <p className="meta">Claude Code가 찾은 후보입니다. 맞는 것만 골라 과제 탭에 추가하세요. 시각과 인용은 전사에서 가져왔습니다.</p>
    <ul>{candidates.map((c, i) => <li key={`${c.startMs}:${i}`}>
      <label><input type="checkbox" checked={checked.has(i)} disabled={busy} onChange={() => setChecked((old) => { const next = new Set(old); if (next.has(i)) next.delete(i); else next.add(i); return next; })} />
        <span><strong>[{MENTION_KIND[c.kind]}] {c.title}</strong>{c.due ? <small>말한 마감: {c.due}</small> : null}{c.detail ? <small>{c.detail}</small> : null}</span></label>
      <button className="link-button" onClick={() => onPlay(c.startMs)}>{mediaTime(c.startMs)}</button> <q>{c.quote}</q>
    </li>)}</ul>
    <button disabled={busy || !checked.size} onClick={async () => { setBusy(true); try { await onAdd(candidates.filter((_, i) => checked.has(i))); } finally { setBusy(false); } }}>{busy ? "추가하는 중…" : `${checked.size}개 과제 탭에 추가`}</button>
    <button disabled={busy} onClick={onClose}>닫기</button>
  </div>;
}

/** WBS-070: confirmed announcements in the 과제 section, with where they were said. */
export function MentionList({ mentions, sourceTitle, onOpen, onRemove }: { mentions: readonly LectureMention[]; sourceTitle: (assetId: string) => string; onOpen: (mention: LectureMention) => void; onRemove: (mention: LectureMention) => void }) {
  if (!mentions.length) return null;
  return <section className="mention-list" aria-label="강의에서 언급됨">
    <h2>강의에서 언급됨</h2>
    {mentions.map((m) => <div className="mention-row" key={m.id}>
      <strong>[{MENTION_KIND[m.kind]}] {m.title}</strong>
      {m.due ? <small>말한 마감: {m.due}</small> : null}
      {m.detail ? <small>{m.detail}</small> : null}
      <small><button className="link-button" onClick={() => onOpen(m)}>{sourceTitle(m.assetId)} · {mediaTime(m.startMs)}</button> <q>{m.quote}</q></small>
      <button className="link-button" onClick={() => onRemove(m)}>빼기</button>
    </div>)}
  </section>;
}
