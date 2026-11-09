import { useSyncExternalStore } from "react";
import type { MediaAsset, Recording } from "@learningxxx/contracts";
import { invoke, onHostPush } from "./host-api.ts";
import { ChunkBuffer, SAMPLE_RATE, recordedMs, toPcm16, type RecordingState } from "./recorder.ts";
// Its own file under the CSP's script-src 'self' (a small asset would otherwise be inlined as data:).
import workletUrl from "./pcm-worklet.js?url&no-inline";

/**
 * WBS-102: the one lecture recording of this window, kept outside the course
 * screen. Before, the microphone belonged to the course's recording panel, so
 * choosing another course (for example to open its AI chat) closed the panel
 * and silently ended the recording. Now only the stop button, a lost
 * microphone, the Mac sleeping, a full disk, or closing the window/app end it.
 */

interface Capture {
  recordingId: string;
  courseId: string;
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

export interface RecordingSnapshot {
  /** The recording under way, if any, and the course it belongs to. */
  active?: { recordingId: string; courseId: string; paused: boolean; savedMs: number; /** WBS-101: already transcribed while still recording. */ transcribedMs: number; startedAt: number; pausedTotalMs: number; pausedAt?: number | undefined } | undefined;
  busy: boolean;
  /** The last message about a recording, with its course so the right screen shows it. */
  notice?: { courseId: string; text: string } | undefined;
  /** Bumped whenever a recording starts or ends, so screens reload their lists. */
  changes: number;
  /** The original just saved, so its course's screen can show it. */
  saved?: { courseId: string; assetId: string; seq: number } | undefined;
}

type Place = { weekId?: string | undefined; lectureSourceId?: string | undefined };

class RecordingSession {
  #capture: Capture | undefined;
  #starting = false;
  #snapshot: RecordingSnapshot = { busy: false, changes: 0 };
  readonly #listeners = new Set<() => void>();
  #installed = false;

  get snapshot(): RecordingSnapshot { return this.#snapshot; }

  subscribe = (listener: () => void): (() => void) => {
    this.#install();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(change: Partial<RecordingSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...change };
    for (const listener of this.#listeners) listener();
  }

  #view(c: Capture | undefined, savedMs = this.#snapshot.active?.savedMs ?? 0, transcribedMs = this.#snapshot.active?.transcribedMs ?? 0): RecordingSnapshot["active"] {
    return c ? { recordingId: c.recordingId, courseId: c.courseId, paused: c.pausedAt !== undefined, savedMs, transcribedMs, startedAt: c.startedAt, pausedTotalMs: c.pausedTotalMs, pausedAt: c.pausedAt } : undefined;
  }

  /** Once per window: the host's own stops (sleep, full disk, lost access) and closing the window. */
  #install() {
    if (this.#installed) return;
    this.#installed = true;
    onHostPush((push) => {
      if (push.kind !== "recording.stopped") return;
      const c = this.#capture;
      if (c?.recordingId === push.recording.id) this.#release(c);
      this.#finished(push.recording, push.asset, stoppedText(push.recording));
    });
    // Closing or reloading the window ends capture; the host confirms what reached it.
    window.addEventListener("pagehide", () => { const c = this.#capture; if (c && !c.stopping) void invoke("recording.stop", { recordingId: c.recordingId, reason: "page_closed" }); });
  }

  #finished(recording: Recording, asset: MediaAsset | undefined, text: string) {
    this.#set({
      notice: { courseId: recording.courseId, text },
      changes: this.#snapshot.changes + 1,
      ...(asset ? { saved: { courseId: recording.courseId, assetId: asset.id, seq: (this.#snapshot.saved?.seq ?? 0) + 1 } } : {}),
    });
  }

  #release(expected: Capture) {
    if (this.#capture !== expected) return;
    this.#capture = undefined;
    expected.stream.getTracks().forEach((t) => t.stop());
    void expected.context.close().catch(() => undefined);
    this.#set({ active: undefined });
  }

  async #send(c: Capture, pcm: Uint8Array<ArrayBuffer>) {
    if (this.#capture !== c) return;
    const result = await invoke("recording.chunk", { recordingId: c.recordingId, seq: c.seq, pcm });
    if (this.#capture !== c) return;
    if (result.ok) {
      c.seq += 1;
      this.#set({ active: this.#view(c, result.data.savedMs, result.data.transcribedMs ?? 0) });
    } else {
      // The host already stopped and saved (e.g. low disk); stop capturing too.
      this.#release(c);
      this.#set({ notice: { courseId: c.courseId, text: result.error.message }, changes: this.#snapshot.changes + 1 });
    }
  }

  /** Starts recording for a course; an error message when it could not. */
  async start(courseId: string, place: Place): Promise<string | undefined> {
    if (this.#starting) return undefined;
    if (this.#capture) return this.#capture.courseId === courseId ? undefined : "다른 과목에서 녹음하고 있습니다. 그 녹음을 먼저 끝내세요.";
    this.#starting = true;
    this.#set({ busy: true, notice: undefined });
    try {
      const started = await invoke("recording.start", { courseId, ...(place.weekId ? { weekId: place.weekId } : {}), ...(place.lectureSourceId ? { lectureSourceId: place.lectureSourceId } : {}) });
      if (!started.ok) return started.error.message;
      const recordingId = started.data.recording.id;
      let stream: MediaStream | undefined, context: AudioContext | undefined;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
        context = new AudioContext({ sampleRate: SAMPLE_RATE });
        await context.audioWorklet.addModule(workletUrl);
        const node = new AudioWorkletNode(context, "pcm-forward");
        const c: Capture = { recordingId, courseId, stream, context, buffer: new ChunkBuffer(), seq: 0, sending: Promise.resolve(), startedAt: Date.now(), pausedTotalMs: 0 };
        node.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (this.#capture !== c || c.stopping || c.pausedAt !== undefined) return;
          const full = c.buffer.push(toPcm16(event.data));
          if (full) c.sending = c.sending.then(() => this.#send(c, full));
        };
        context.createMediaStreamSource(stream).connect(node);
        stream.getAudioTracks()[0]?.addEventListener("ended", () => { if (this.#capture === c) void this.stop("device_lost"); });
        this.#capture = c;
        this.#set({ active: this.#view(c, 0, 0), changes: this.#snapshot.changes + 1 });
        return undefined;
      } catch {
        stream?.getTracks().forEach((t) => t.stop());
        await context?.close().catch(() => undefined);
        // Nothing was captured: the host marks this recording as failed.
        await invoke("recording.stop", { recordingId });
        this.#set({ changes: this.#snapshot.changes + 1 });
        return "마이크를 열지 못했습니다. 시스템 설정 > 개인정보 보호 및 보안 > 마이크에서 이 앱을 켜고 다시 시도하세요.";
      }
    } catch {
      return "녹음을 시작하지 못했습니다. 다시 시도해 주세요.";
    } finally {
      this.#starting = false;
      this.#set({ busy: false });
    }
  }

  async stop(reason: "user" | "device_lost" = "user"): Promise<void> {
    const c = this.#capture;
    if (!c || c.stopping) return;
    c.stopping = true;
    this.#set({ busy: true });
    let text = "녹음 저장 상태를 확인해 주세요. 저장된 원본은 유지됩니다.";
    let lost = false;
    try {
      c.stream.getTracks().forEach((t) => t.stop());
      const last = c.buffer.take();
      if (last) c.sending = c.sending.then(() => this.#send(c, last));
      await c.sending.catch(() => { lost = true; });
      const result = await invoke("recording.stop", { recordingId: c.recordingId, reason });
      this.#release(c);
      if (!result.ok) text = result.error.message;
      else {
        text = reason === "device_lost" ? "마이크 연결이 끊겨 녹음을 멈추고 지금까지의 녹음을 저장했습니다." : result.data.recording.status === "failed" ? "녹음된 내용이 없어 저장하지 않았습니다." : "녹음을 저장했습니다.";
        if (lost) text = `일부 녹음 전송을 확인하지 못했습니다. ${text}`;
        this.#finished(result.data.recording, result.data.asset, text);
        return;
      }
    } catch { /* the message below */ }
    finally { this.#release(c); this.#set({ busy: false }); }
    this.#set({ notice: { courseId: c.courseId, text }, changes: this.#snapshot.changes + 1 });
  }

  /** Pause keeps the microphone and the recording open; what was buffered is sent now so a crash keeps it. */
  togglePause() {
    const c = this.#capture;
    if (!c || c.stopping) return;
    if (c.pausedAt === undefined) {
      c.pausedAt = Date.now();
      const part = c.buffer.take();
      if (part) c.sending = c.sending.then(() => this.#send(c, part));
    } else {
      c.pausedTotalMs += Date.now() - c.pausedAt;
      c.pausedAt = undefined;
    }
    this.#set({ active: this.#view(c) });
  }

  clearNotice() { if (this.#snapshot.notice) this.#set({ notice: undefined }); }
}

function stoppedText(recording: Recording): string {
  switch (recording.stopReason ?? (recording.errorCode === "DISK_FULL" ? "disk_full" : "sleep")) {
    case "disk_full": return "저장 공간이 부족해 녹음을 멈추고 지금까지의 녹음을 저장했습니다.";
    case "access_lost": return "이 과목을 더 이상 쓸 수 없어(계정 변경 등) 녹음을 멈추고 지금까지의 녹음을 저장했습니다.";
    case "app_closing": return "앱이 종료되어 녹음을 멈추고 지금까지의 녹음을 저장했습니다.";
    default: return "Mac이 잠자기에 들어가 녹음을 멈추고 지금까지의 녹음을 저장했습니다.";
  }
}

export const recordingSession = new RecordingSession();

export function useRecordingSession(): RecordingSnapshot {
  return useSyncExternalStore(recordingSession.subscribe, () => recordingSession.snapshot);
}

/** idle / recording / paused, for the top bar and the rail. */
export function recordingState(s: RecordingSnapshot): RecordingState {
  return s.active ? (s.active.paused ? "paused" : "recording") : "idle";
}

export function elapsedOf(active: NonNullable<RecordingSnapshot["active"]>, now = Date.now()): number {
  return recordedMs(active.startedAt, now, active.pausedTotalMs, active.pausedAt);
}
