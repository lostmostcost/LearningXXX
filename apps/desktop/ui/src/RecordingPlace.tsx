import { useState } from "react";
import { Details } from './Details.tsx';
import type { CourseLearningStatus, Recording, Week } from "@learningxxx/contracts";
import { formatSeoul } from "./library.ts";
import { unfiledRecordings, type RecordingRow } from "./recording-weeks.ts";
import { Icon } from "./StudyUI.tsx";

/** An online lecture a recording can belong to: the LMS lectures of the materials menu. */
export interface Lecture {
  sourceId: string;
  title: string;
  /** The LMS week label it is listed under. */
  week: string;
}

export interface Place {
  weekId?: string | undefined;
  lectureSourceId?: string | undefined;
}

/** WBS-065: week, then one of that week's lectures (or none). */
export function WeekPicker({ weeks, lectures, value, onChange, disabled, label = "녹음" }: { weeks: readonly Week[]; lectures: readonly Lecture[]; value: Place; onChange: (place: Place) => void; disabled?: boolean; label?: string }) {
  const week = weeks.find((w) => w.id === value.weekId);
  const choices = week ? lectures.filter((l) => l.week === week.label) : [];
  return (
    <span className="week-picker">
      <select aria-label={`${label} 주차`} value={value.weekId ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value ? { weekId: e.target.value } : {})}>
        {week ? null : <option value="">주차 선택</option>}
        {weeks.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
      </select>
      <select aria-label={`${label} 강의`} value={value.lectureSourceId ?? ""} disabled={disabled || !week || !choices.length} onChange={(e) => onChange({ weekId: value.weekId, ...(e.target.value ? { lectureSourceId: e.target.value } : {}) })}>
        <option value="">{week && !choices.length ? "이 주차 동영상 강의 없음" : "강의 지정 안 함"}</option>
        {choices.map((l) => <option key={l.sourceId} value={l.sourceId}>{l.title}</option>)}
      </select>
    </span>
  );
}

/**
 * Recordings made before weeks were chosen. Each shows the week its date
 * suggests; nothing moves until the user confirms it (WBS-065 acceptance).
 */
export function UnfiledRecordings({ recordings, weeks, lectures, status, onAssign }: { recordings: readonly Recording[]; weeks: readonly Week[]; lectures: readonly Lecture[]; status: CourseLearningStatus | undefined; onAssign: (recordingId: string, place: Place) => Promise<void> }) {
  const rows = unfiledRecordings(recordings, weeks, status);
  const [chosen, setChosen] = useState<Record<string, Place>>({});
  const [busy, setBusy] = useState<string>();
  if (!rows.length || !weeks.length) return null;
  const move = async (id: string, place: Place) => {
    if (!place.weekId || busy) return;
    setBusy(id);
    try { await onAssign(id, place); } finally { setBusy(undefined); }
  };
  return (
    <Details title={`주차 확인 ${rows.length}개`} className="unfiled-recordings">
      <p className="subtle">녹음한 날짜로 주차를 추정했습니다. 맞는지 확인하고 옮기세요.</p>
      <ul>
        {rows.map(({ recording, suggested }) => {
          const place = chosen[recording.id] ?? (suggested ? { weekId: suggested.id } : {});
          return (
            <li key={recording.id}>
              <span className="unfiled-title"><strong>{recording.title}</strong><small>{formatSeoul(recording.startedAt)}{suggested ? ` · 추정 ${suggested.label}` : " · 날짜로 추정할 수 없음"}</small></span>
              <Details title={<>{weeks.find(w => w.id === place.weekId)?.label ?? '주차 선택'}<small>변경</small></>}><WeekPicker weeks={weeks} lectures={lectures} value={place} disabled={busy !== undefined} label={recording.title} onChange={(next) => setChosen((c) => ({ ...c, [recording.id]: next }))} /></Details>
              <button disabled={!place.weekId || busy !== undefined} onClick={() => void move(recording.id, place)}>{busy === recording.id ? "옮기는 중…" : "확인"}</button>
            </li>
          );
        })}
      </ul>
    </Details>
  );
}

/** One recording in the week menu, under its lecture or its week. */
export function RecordingFile({ row, selected, onOpen, nested }: { row: RecordingRow; selected: boolean; onOpen: (row: RecordingRow) => void; nested?: boolean | undefined }) {
  return (
    <button className={`recording-file ${nested ? "nested" : ""}`} aria-pressed={selected} disabled={!row.asset} title={`${row.recording.title} · ${row.status}`} aria-label={`녹음 ${row.recording.title}, ${row.status}`} onClick={() => onOpen(row)}>
      <Icon name="mic" />
      <span><span className="video-title">{row.recording.title}</span><small>{row.status}</small></span>
    </button>
  );
}
