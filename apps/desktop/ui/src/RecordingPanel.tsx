import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CourseLearningStatus, MediaAsset, Recording, Week } from "@learningxxx/contracts";
import { invoke, onHostPush } from "./host-api.ts";
import { MediaLibrary } from "./MediaLibrary.tsx";
import { UnfiledRecordings, WeekPicker, type Lecture, type Place } from "./RecordingPlace.tsx";
import { estimateWeek, placeLabel } from "./recording-weeks.ts";
import { Icon } from "./StudyUI.tsx";
import { ChunkBuffer, SAMPLE_RATE, clock, recordedMs, toPcm16, type RecordingState } from "./recorder.ts";
// Its own file under the CSP's script-src 'self' (a small asset would otherwise be inlined as data:).
import workletUrl from "./pcm-worklet.js?url&no-inline";

interface Capture {
  recordingId: string;
  stream: MediaStream;
  context: AudioContext;
  buffer: ChunkBuffer;
  seq: number;
  /** Chunks go to the host one after another, never in parallel. */
  sending: Promise<void>;
  startedAt: number;
  stopping?: boolean;
  /** WBS-064: while paused, captured sound is dropped, so the original continues without the gap. */
  pausedAt?: number | undefined;
  pausedTotalMs: number;
}

export interface RecordingPanelProps {
  courseId: string;
  view?: "recording" | "transcripts";
  onState?: (state: RecordingState) => void;
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
 */
export function RecordingPanel({ courseId, view = "recording", onState, weeks = NO_WEEKS, lectures = NO_LECTURES, status, selectedAssetId, onSelectAsset, onChanged }: RecordingPanelProps) {
  const [active, setActive] = useState<string>();
  const [paused, setPaused] = useState(false);
  const [savedMs, setSavedMs] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const starting = useRef(false);
  const capture = useRef<Capture | undefined>(undefined);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  /** The user's choice for the next recording; until they choose, it follows today's estimated week. */
  const [choice, setChoice] = useState<Place>();
  const estimated = useMemo(() => estimateWeek(weeks, status, new Date())?.id, [weeks, status]);
  const place: Place = choice ?? (estimated ? { weekId: estimated } : {});
  const recordingNow = recordings.find((r) => r.id === active);
  // Read through refs: `stop` must keep its identity, since a new one stops the recording (course-change cleanup below).
  const listeners = useRef({ onSelectAsset, onChanged });
  listeners.current = { onSelectAsset, onChanged };

  const reload = useCallback(async () => {
    const result = await invoke("recording.list", { courseId });
    if (!result.ok) return setNotice(result.error.message);
    setRecordings(result.data.recordings);
    listeners.current.onChanged?.();
  }, [courseId]);

  const release = (expected = capture.current) => {
    if (capture.current !== expected) return;
    const c = capture.current;
    capture.current = undefined;
    c?.stream.getTracks().forEach((t) => t.stop());
    void c?.context.close().catch(() => undefined);
    setActive(undefined);
    setPaused(false);
  };

  const stop = useCallback(async (reason: "user" | "device_lost" = "user") => {
    const c = capture.current;
    if (!c || c.stopping) return;
    c.stopping = true;
    setBusy(true);
    try {
      c.stream.getTracks().forEach((t) => t.stop());
      const last = c.buffer.take();
      if (last) c.sending = c.sending.then(() => send(c, last));
      await c.sending.catch(() => setNotice("일부 녹음 전송을 확인하지 못했습니다. 저장된 부분을 확정합니다."));
      const result = await invoke("recording.stop", { recordingId: c.recordingId, reason });
      if (result.ok && result.data.asset) listeners.current.onSelectAsset?.(result.data.asset.id);
      if (!result.ok) setNotice(result.error.message);
      else if (reason === "device_lost") setNotice("마이크 연결이 끊겨 녹음을 멈추고 지금까지의 녹음을 저장했습니다.");
      else setNotice(result.data.recording.status === "failed" ? "녹음된 내용이 없어 저장하지 않았습니다." : "녹음을 저장했습니다.");
      await reload();
    } catch { setNotice("녹음 저장 상태를 확인해 주세요. 저장된 원본은 유지됩니다."); }
    finally { release(c); setBusy(false); }
  }, [reload]);

  const send = async (c: Capture, pcm: Uint8Array<ArrayBuffer>) => {
    if (capture.current !== c) return;
    const result = await invoke("recording.chunk", { recordingId: c.recordingId, seq: c.seq, pcm });
    if (capture.current !== c) return;
    if (result.ok) {
      c.seq += 1;
      setSavedMs(result.data.savedMs);
    } else {
      // The host already stopped and saved (e.g. low disk); stop capturing too.
      setNotice(result.error.message);
      release();
      await reload();
    }
  };

  const start = async () => {
    if (starting.current || capture.current) return;
    starting.current = true;
    const current = generation.current;
    try {
      setNotice(undefined);
      setBusy(true);
      // A week is required once the course has weeks; the lecture stays optional.
      if (weeks.length && !place.weekId) { setBusy(false); return setNotice("녹음할 주차를 먼저 고르세요."); }
      const started = await invoke("recording.start", { courseId, ...(place.weekId ? { weekId: place.weekId } : {}), ...(place.lectureSourceId ? { lectureSourceId: place.lectureSourceId } : {}) });
      if (!started.ok) {
        setBusy(false);
        return setNotice(started.error.message);
      }
      const recordingId = started.data.recording.id;
      let stream: MediaStream | undefined, context: AudioContext | undefined;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
        context = new AudioContext({ sampleRate: SAMPLE_RATE });
        await context.audioWorklet.addModule(workletUrl);
        if (current !== generation.current) throw new Error("Course changed");
        const node = new AudioWorkletNode(context, "pcm-forward");
        const c: Capture = { recordingId, stream, context, buffer: new ChunkBuffer(), seq: 0, sending: Promise.resolve(), startedAt: Date.now(), pausedTotalMs: 0 };
        node.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (capture.current !== c || c.stopping || c.pausedAt !== undefined) return;
          const full = c.buffer.push(toPcm16(event.data));
          if (full) c.sending = c.sending.then(() => send(c, full));
        };
        context.createMediaStreamSource(stream).connect(node);
        stream.getAudioTracks()[0]?.addEventListener("ended", () => { if (capture.current === c) void stop("device_lost"); });
        capture.current = c;
        setSavedMs(0);
        setElapsedMs(0);
        setActive(recordingId);
        void reload();
      } catch {
        stream?.getTracks().forEach(t => t.stop());
        await context?.close().catch(() => undefined);
        // Nothing was captured: the host marks this recording as failed.
        await invoke("recording.stop", { recordingId });
        setNotice("마이크를 열지 못했습니다. 시스템 설정 > 개인정보 보호 및 보안 > 마이크에서 이 앱을 켜고 다시 시도하세요.");
        await reload();
      } finally {
        setBusy(false);
      }
    } catch { setNotice("녹음을 시작하지 못했습니다. 다시 시도해 주세요."); }
    finally { starting.current = false; setBusy(false); }
  };

  /** Pause keeps the microphone and the recording open; what was buffered is sent now so a crash keeps it. */
  const togglePause = () => {
    const c = capture.current;
    if (!c || c.stopping) return;
    if (c.pausedAt === undefined) {
      c.pausedAt = Date.now();
      const part = c.buffer.take();
      if (part) c.sending = c.sending.then(() => send(c, part));
      setPaused(true);
    } else {
      c.pausedTotalMs += Date.now() - c.pausedAt;
      c.pausedAt = undefined;
      setPaused(false);
    }
    setElapsedMs(recordedMs(c.startedAt, Date.now(), c.pausedTotalMs, c.pausedAt));
  };

  useEffect(() => { onState?.(active ? (paused ? "paused" : "recording") : "idle"); }, [active, paused, onState]);
  useEffect(() => () => onState?.("idle"), [onState]);

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

  useEffect(() => {
    void reload();
    return onHostPush((push) => {
      if (push.kind !== "recording.stopped" || push.recording.courseId !== courseId) return;
      if (capture.current?.recordingId === push.recording.id) release();
      setNotice(push.recording.errorCode === "DISK_FULL" ? "저장 공간이 부족해 녹음을 멈추고 저장했습니다." : "Mac이 잠자기에 들어가 녹음을 멈추고 지금까지의 녹음을 저장했습니다.");
      void reload();
    });
  }, [reload]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { const c = capture.current; if (c) setElapsedMs(recordedMs(c.startedAt, Date.now(), c.pausedTotalMs, c.pausedAt)); }, 500);
    return () => clearInterval(timer);
  }, [active]);

  // Leaving the course or closing the window stops capture; the host confirms what was saved.
  useEffect(() => { generation.current++; return () => { generation.current++; void stop(); }; }, [courseId, stop]);

  return <section className="recordings" aria-label="녹음과 전사">
    <div className="recording-capture" hidden={view !== "recording"}>
      <div className={active ? (paused ? "capture-symbol paused" : "capture-symbol active") : "capture-symbol"}><Icon name="mic" /></div>
      <h3>{active ? (paused ? "녹음을 잠시 멈췄어요" : "강의를 녹음하고 있어요") : "강의 녹음"}</h3>
      <p className="capture-clock" role="status">{clock(elapsedMs)}</p>
      {active
        ? <p className="capture-place">{placeLabel(recordingNow, weeks, lectures) ?? ""}</p>
        : weeks.length ? <div className="capture-place"><WeekPicker weeks={weeks} lectures={lectures} value={place} disabled={busy} onChange={setChoice} />{!choice && estimated ? <small className="subtle">오늘 날짜로 고른 주차</small> : null}</div> : null}
      <p className="subtle">{active ? (paused ? `일시정지 중 · 멈춘 동안은 녹음되지 않습니다 · 저장됨 ${clock(savedMs)}` : `저장됨 ${clock(savedMs)}`) : "녹음이 끝나면 자동으로 전사합니다"}</p>
      <div className="capture-actions">
        {active ? <button className="capture-action secondary" aria-label={paused ? "녹음 이어서 하기" : "녹음 일시정지"} title={paused ? "녹음 이어서 하기" : "녹음 일시정지"} disabled={busy} onClick={togglePause}><Icon name={paused ? "play" : "pause"} /></button> : null}
        <button className="capture-action" aria-label={active ? "녹음 끝내고 저장" : "녹음 시작"} title={active ? "녹음 끝내고 저장" : "녹음 시작"} disabled={busy} onClick={() => active ? void stop() : void start()}><Icon name={active ? "stop" : "mic"} /></button>
      </div>
    </div>
    {notice ? <p role="status" className="notice-box">{notice}</p> : null}
    {view === "recording" ? <UnfiledRecordings recordings={recordings} weeks={weeks} lectures={lectures} status={status} onAssign={assign} /> : null}
    <MediaLibrary key={courseId} courseId={courseId} view={view} selectedAssetId={selectedAssetId ?? undefined} place={placeOf} />
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
