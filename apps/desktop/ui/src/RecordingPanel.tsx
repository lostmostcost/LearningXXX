import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, onHostPush } from "./host-api.ts";
import { MediaLibrary } from "./MediaLibrary.tsx";
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

/**
 * Lecture recording for the course on screen (WBS-023). The renderer only
 * captures and forwards PCM; the host checks permission and disk, flushes
 * every chunk and confirms the original when recording stops.
 */
export function RecordingPanel({ courseId, view = "recording", onState }: { courseId: string; view?: "recording" | "transcripts"; onState?: (state: RecordingState) => void }) {
  const [active, setActive] = useState<string>();
  const [paused, setPaused] = useState(false);
  const [savedMs, setSavedMs] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const starting = useRef(false);
  const capture = useRef<Capture | undefined>(undefined);

  const reload = useCallback(async () => {
    const result = await invoke("recording.list", { courseId });
    if (!result.ok) setNotice(result.error.message);
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
      const started = await invoke("recording.start", { courseId });
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
      <p className="subtle">{active ? (paused ? `일시정지 중 · 멈춘 동안은 녹음되지 않습니다 · 저장됨 ${clock(savedMs)}` : `저장됨 ${clock(savedMs)}`) : "녹음이 끝나면 자동으로 전사합니다"}</p>
      <div className="capture-actions">
        {active ? <button className="capture-action secondary" aria-label={paused ? "녹음 이어서 하기" : "녹음 일시정지"} title={paused ? "녹음 이어서 하기" : "녹음 일시정지"} disabled={busy} onClick={togglePause}><Icon name={paused ? "play" : "pause"} /></button> : null}
        <button className="capture-action" aria-label={active ? "녹음 끝내고 저장" : "녹음 시작"} title={active ? "녹음 끝내고 저장" : "녹음 시작"} disabled={busy} onClick={() => active ? void stop() : void start()}><Icon name={active ? "stop" : "mic"} /></button>
      </div>
    </div>
    {notice ? <p role="status" className="notice-box">{notice}</p> : null}
    <MediaLibrary key={courseId} courseId={courseId} view={view} />
  </section>;
}
