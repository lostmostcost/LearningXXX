import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaAsset, Recording } from "@learningxxx/contracts";
import { invoke, onHostPush } from "./host-api.ts";
import { ChunkBuffer, RECORDING_STATUS, SAMPLE_RATE, clock, toPcm16 } from "./recorder.ts";
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
}

/**
 * Lecture recording for the course on screen (WBS-023). The renderer only
 * captures and forwards PCM; the host checks permission and disk, flushes
 * every chunk and confirms the original when recording stops.
 */
export function RecordingPanel({ courseId }: { courseId: string }) {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [active, setActive] = useState<string>();
  const [savedMs, setSavedMs] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<{ assetId: string; url: string }>();
  const capture = useRef<Capture | undefined>(undefined);

  const reload = useCallback(async () => {
    const result = await invoke("recording.list", { courseId });
    if (result.ok) {
      setRecordings(result.data.recordings);
      setAssets(result.data.assets);
    }
  }, [courseId]);

  const release = () => {
    const c = capture.current;
    capture.current = undefined;
    c?.stream.getTracks().forEach((t) => t.stop());
    void c?.context.close();
    setActive(undefined);
  };

  const stop = useCallback(async (reason: "user" | "device_lost" = "user") => {
    const c = capture.current;
    if (!c) return;
    setBusy(true);
    c.stream.getTracks().forEach((t) => t.stop());
    const last = c.buffer.take();
    if (last) c.sending = c.sending.then(() => send(c, last));
    await c.sending;
    const result = await invoke("recording.stop", { recordingId: c.recordingId, reason });
    release();
    setBusy(false);
    if (!result.ok) setNotice(result.error.message);
    else if (reason === "device_lost") setNotice("마이크 연결이 끊겨 녹음을 멈추고 지금까지의 녹음을 저장했습니다.");
    else setNotice(result.data.recording.status === "failed" ? "녹음된 내용이 없어 저장하지 않았습니다." : "녹음을 저장했습니다.");
    await reload();
  }, [reload]);

  const send = async (c: Capture, pcm: Uint8Array<ArrayBuffer>) => {
    if (capture.current !== c) return;
    const result = await invoke("recording.chunk", { recordingId: c.recordingId, seq: c.seq, pcm });
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
    setNotice(undefined);
    setBusy(true);
    const started = await invoke("recording.start", { courseId });
    if (!started.ok) {
      setBusy(false);
      return setNotice(started.error.message);
    }
    const recordingId = started.data.recording.id;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
      const context = new AudioContext({ sampleRate: SAMPLE_RATE });
      await context.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(context, "pcm-forward");
      const c: Capture = { recordingId, stream, context, buffer: new ChunkBuffer(), seq: 0, sending: Promise.resolve(), startedAt: Date.now() };
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        const full = c.buffer.push(toPcm16(event.data));
        if (full) c.sending = c.sending.then(() => send(c, full));
      };
      context.createMediaStreamSource(stream).connect(node);
      stream.getAudioTracks()[0]?.addEventListener("ended", () => void stop("device_lost"));
      capture.current = c;
      setSavedMs(0);
      setElapsedMs(0);
      setActive(recordingId);
    } catch {
      // Nothing was captured: the host marks this recording as failed.
      await invoke("recording.stop", { recordingId });
      setNotice("마이크를 열지 못했습니다. 시스템 설정 > 개인정보 보호 및 보안 > 마이크에서 이 앱을 켜고 다시 시도하세요.");
      await reload();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void reload();
    return onHostPush((push) => {
      if (push.kind !== "recording.stopped") return;
      if (capture.current?.recordingId === push.recording.id) release();
      setNotice(push.recording.errorCode === "DISK_FULL" ? "저장 공간이 부족해 녹음을 멈추고 저장했습니다." : "Mac이 잠자기에 들어가 녹음을 멈추고 지금까지의 녹음을 저장했습니다.");
      void reload();
    });
  }, [reload]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setElapsedMs(Date.now() - (capture.current?.startedAt ?? Date.now())), 500);
    return () => clearInterval(timer);
  }, [active]);

  // Leaving the course or closing the window stops capture; the host confirms what was saved.
  useEffect(() => () => void stop(), [courseId, stop]);

  const play = async (assetId: string) => {
    const result = await invoke("media.asset", { assetId });
    if (!result.ok) return setNotice(result.error.message);
    if (playing) URL.revokeObjectURL(playing.url);
    setPlaying({ assetId, url: URL.createObjectURL(new Blob([result.data.bytes], { type: result.data.mediaType })) });
  };

  return (
    <section className="recordings" aria-label="강의 녹음">
      <h3>강의 녹음</h3>
      {active ? (
        <p role="status">
          ● 녹음 중 {clock(elapsedMs)} · 저장됨 {clock(savedMs)}{" "}
          <button disabled={busy} onClick={() => void stop()}>녹음 멈추기</button>
        </p>
      ) : (
        <button disabled={busy} onClick={() => void start()}>녹음 시작</button>
      )}
      {notice ? <p role="status" className="notice-box">{notice}</p> : null}
      {recordings.length ? (
        <ul className="entries">
          {recordings.map((r) => {
            const asset = assets.find((a) => a.id === r.originalAssetId);
            return (
              <li key={r.id}>
                <span>{r.title}</span>{" "}
                <span className="meta">
                  {RECORDING_STATUS[r.status]}
                  {r.durationMs ? ` · ${clock(r.durationMs)}` : ""}
                </span>{" "}
                {asset ? <button onClick={() => void play(asset.id)}>재생</button> : null}
                {playing?.assetId === asset?.id && playing ? <audio controls autoPlay src={playing.url} /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
