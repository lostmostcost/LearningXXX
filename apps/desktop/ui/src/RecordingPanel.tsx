import { Details } from './Details.tsx';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CourseLearningStatus, MediaAsset, Recording, Week } from "@learningxxx/contracts";
import { invoke } from "./host-api.ts";
import { ImportPanel } from "./ImportPanel.tsx";
import { MediaLibrary } from "./MediaLibrary.tsx";
import { UnfiledRecordings, WeekPicker, type Lecture, type Place } from "./RecordingPlace.tsx";
import { estimateWeek, placeLabel } from "./recording-weeks.ts";
import { Icon } from "./StudyUI.tsx";
import { clock } from "./recorder.ts";
import { elapsedOf, recordingSession, useRecordingSession } from "./recording-session.ts";

export interface RecordingPanelProps {
  courseId: string;
  view?: "recording" | "transcripts" | "combined";
  /** WBS-102: go to the course whose recording is running (when it is another course). */
  onOpenCourse?: (courseId: string) => void;
  /** WBS-065: the course's collected weeks, its LMS lectures (when known) and LMS opening times for "this week". */
  weeks?: readonly Week[];
  lectures?: readonly Lecture[];
  status?: CourseLearningStatus | undefined;
  /** The original shown below (chosen in the week menu, or the recording just saved). */
  selectedAssetId?: string | undefined;
  onSelectAsset?: (assetId: string | undefined) => void;
  /** Something about recordings changed (saved, moved): the week menu reloads. */
  onChanged?: () => void;
}

const NO_WEEKS: readonly Week[] = [];
const NO_LECTURES: readonly Lecture[] = [];

/**
 * Lecture recording for the course on screen (WBS-023). The renderer only
 * captures and forwards PCM; the host checks permission and disk, flushes
 * every chunk and confirms the original when recording stops. Each recording
 * is filed under a week and, optionally, one of its lectures (WBS-065).
 * WBS-102: the capture itself lives in recording-session.ts, so leaving this
 * course (another course, its AI chat) keeps the recording going.
 */
export function RecordingPanel({ courseId, view = "recording", onOpenCourse, weeks = NO_WEEKS, lectures = NO_LECTURES, status, selectedAssetId, onSelectAsset, onChanged }: RecordingPanelProps) {
  const session = useRecordingSession();
  /** The recording running for this course; one running for another course is shown as a note. */
  const mine = session.active?.courseId === courseId ? session.active : undefined;
  const elsewhere = session.active && !mine ? session.active : undefined;
  const active = mine?.recordingId;
  const paused = mine?.paused ?? false;
  const savedMs = mine?.savedMs ?? 0;
  const transcribedMs = mine?.transcribedMs ?? 0;
  const [elapsedMs, setElapsedMs] = useState(0);
  const [localNotice, setNotice] = useState<string>();
  const notice = localNotice ?? (session.notice?.courseId === courseId ? session.notice.text : undefined);
  const busy = session.busy;
  const [recordings, setRecordings] = useState<Recording[]>([]);
  /** The user's choice for the next recording; until they choose, it follows today's estimated week. */
  const [choice, setChoice] = useState<Place>();
  const estimated = useMemo(() => estimateWeek(weeks, status, new Date())?.id, [weeks, status]);
  const place: Place = choice ?? (estimated ? { weekId: estimated } : {});
  const recordingNow = recordings.find((r) => r.id === active);
  const listeners = useRef({ onSelectAsset, onChanged });
  listeners.current = { onSelectAsset, onChanged };

  const reload = useCallback(async () => {
    const result = await invoke("recording.list", { courseId });
    if (!result.ok) return setNotice(result.error.message);
    setRecordings(result.data.recordings);
    listeners.current.onChanged?.();
  }, [courseId]);

  const stop = () => { setNotice(undefined); void recordingSession.stop(); };
  const start = async () => {
    setNotice(undefined); recordingSession.clearNotice();
    // A week is required once the course has weeks; the lecture stays optional.
    if (weeks.length && !place.weekId) return setNotice("녹음할 주차를 먼저 고르세요.");
    const problem = await recordingSession.start(courseId, place);
    if (problem) setNotice(problem);
  };
  const togglePause = () => recordingSession.togglePause();

  const assign = useCallback(async (recordingId: string, next: Place) => {
    if (!next.weekId) return;
    const result = await invoke("recording.assign", { recordingId, weekId: next.weekId, ...(next.lectureSourceId ? { lectureSourceId: next.lectureSourceId } : {}) });
    setNotice(result.ok ? `${placeLabel(result.data.recording, weeks, lectures)}(으)로 옮겼습니다.` : result.error.message);
    await reload();
  }, [weeks, lectures, reload]);

  /** Under the chosen original: where it is filed, and a way to move a recording elsewhere. */
  const placeOf = useCallback((asset: MediaAsset) => {
    if (asset.source.type !== "recording") return <span className="meta">동영상 강의</span>;
    const recordingId = asset.source.recordingId;
    const recording = recordings.find((r) => r.id === recordingId);
    if (!recording || !weeks.length) return null;
    return <MovePlace key={`${recording.id}:${recording.weekId}:${recording.lectureSourceId}`} recording={recording} weeks={weeks} lectures={lectures} onMove={(next) => assign(recording.id, next)} />;
  }, [recordings, weeks, lectures, assign]);

  // Lists follow every start and stop, wherever it happened; a just-saved original of this course is shown.
  useEffect(() => { void reload(); }, [reload, session.changes]);
  const saved = session.saved;
  useEffect(() => { if (saved?.courseId === courseId) listeners.current.onSelectAsset?.(saved.assetId); }, [saved?.seq, saved?.courseId, saved?.assetId, courseId]);

  useEffect(() => {
    if (!mine) return setElapsedMs(0);
    setElapsedMs(elapsedOf(mine));
    const timer = setInterval(() => setElapsedMs(elapsedOf(mine)), 500);
    return () => clearInterval(timer);
  }, [mine]);

  return <section className="recordings" aria-label="녹음과 전사">
    <div className="recording-capture" hidden={view === "transcripts"}>
      {elsewhere ? <p className="notice-box" role="status">다른 과목에서 녹음하고 있습니다(과목을 옮겨도 녹음은 계속됩니다).{onOpenCourse ? <> <button className="link-button" onClick={() => onOpenCourse(elsewhere.courseId)}>그 과목으로 가기</button></> : null}</p> : null}
      <div className={active ? (paused ? "capture-symbol paused" : "capture-symbol active") : "capture-symbol"}><Icon name="mic" /></div>
      <h3>{active ? (paused ? "녹음을 잠시 멈췄어요" : "강의를 녹음하고 있어요") : "강의 녹음"}</h3>
      <p className="capture-clock" role="status">{clock(elapsedMs)}</p>
      {active
        ? <p className="capture-place">{placeLabel(recordingNow, weeks, lectures) ?? ""}</p>
        : weeks.length ? <div className="capture-place"><Details title={<>{!choice && estimated ? "추천 · " : ""}{weeks.find(w=>w.id===place.weekId)?.label ?? "주차 선택"}{place.lectureSourceId ? ` · ${lectures.find(l=>l.sourceId===place.lectureSourceId)?.title ?? "강의"}` : ""}<small>변경</small></>} open={!place.weekId}><WeekPicker weeks={weeks} lectures={lectures} value={place} disabled={busy} onChange={setChoice} /></Details></div> : null}
      <p className="subtle">{active ? (paused ? `일시정지 중 · 멈춘 동안은 녹음되지 않습니다 · 저장됨 ${clock(savedMs)}` : `저장됨 ${clock(savedMs)}`) + (transcribedMs > 0 ? ` · 전사됨 ${clock(transcribedMs)}` : "") : "녹음하는 동안 몇 분마다 전사"}</p>
      <div className="capture-actions">
        {active ? <button className="capture-action secondary" aria-label={paused ? "녹음 이어서 하기" : "녹음 일시정지"} title={paused ? "녹음 이어서 하기" : "녹음 일시정지"} disabled={busy} onClick={togglePause}><Icon name={paused ? "play" : "pause"} /></button> : null}
        <button className="capture-action" aria-label={active ? "녹음 끝내고 저장" : "녹음 시작"} title={active ? "녹음 끝내고 저장" : "녹음 시작"} disabled={busy || !!elsewhere} onClick={() => active ? stop() : void start()}><Icon name={active ? "stop" : "mic"} /></button>
      </div>
    </div>
    {notice ? <p role="status" className="notice-box">{notice}</p> : null}
    {view !== "transcripts" ? <UnfiledRecordings recordings={recordings} weeks={weeks} lectures={lectures} status={status} onAssign={assign} /> : null}
    {view !== "transcripts" && !session.active ? <details className="import-details"><summary>다른 앱으로 녹음한 파일 가져오기</summary><ImportPanel courseId={courseId} weeks={weeks} lectures={lectures} status={status} onDone={() => void reload()} /></details> : null}
    <MediaLibrary key={courseId} courseId={courseId} weeks={weeks} lectures={lectures} view={view === 'combined' ? 'transcripts' : view} selectedAssetId={selectedAssetId ?? undefined} place={placeOf} onSelectAsset={view === 'combined' ? onSelectAsset : undefined} />
  </section>;
}

/** Moves a saved recording to another week or lecture; only on the user's click. */
function MovePlace({ recording, weeks, lectures, onMove }: { recording: Recording; weeks: readonly Week[]; lectures: readonly Lecture[]; onMove: (place: Place) => Promise<void> }) {
  const current: Place = { weekId: recording.weekId, lectureSourceId: recording.lectureSourceId };
  const [next, setNext] = useState<Place>(current);
  const [busy, setBusy] = useState(false);
  const changed = next.weekId !== current.weekId || next.lectureSourceId !== current.lectureSourceId;
  return <span className="move-place">
    <WeekPicker weeks={weeks} lectures={lectures} value={next} disabled={busy} label="이 녹음" onChange={setNext} />
    {changed ? <button disabled={!next.weekId || busy} onClick={() => { setBusy(true); void onMove(next).finally(() => setBusy(false)); }}>{recording.weekId ? "옮기기" : "이 주차로 옮기기"}</button> : null}
  </span>;
}
