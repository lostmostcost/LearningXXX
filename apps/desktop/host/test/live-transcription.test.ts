import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SAMPLE_RATE, wavSamples, type EngineOutput } from "@learningxxx/transcriber";
import { LiveTranscription } from "../src/live-transcription.ts";

const WINDOW = { seconds: 10, searchSeconds: 1, minTailSeconds: 3 };
const dirs: string[] = [];
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A recording's PCM file that grows like the real one: a tone with a silent gap every 10 s (at 9.8 s, 19.8 s, …). */
function recording() {
  const root = mkdtempSync(join(tmpdir(), "live-")); dirs.push(root);
  const pcmPath = join(root, "audio.pcm");
  writeFileSync(pcmPath, Buffer.alloc(0));
  let written = 0;
  const grow = (seconds: number) => {
    const s = new Int16Array(Math.round(seconds * SAMPLE_RATE));
    for (let i = 0; i < s.length; i += 1) {
      const t = (written + i) / SAMPLE_RATE;
      s[i] = t % 10 >= 9.8 ? 0 : Math.round(7000 * Math.sin(i / 5));
    }
    appendFileSync(pcmPath, Buffer.from(s.buffer));
    written += s.length;
    return statSync(pcmPath).size;
  };
  return { root, pcmPath, grow };
}

/** A fake engine: each window is answered with one word naming its length; calls are logged. */
function fakeEngine(opts: { fail?: Set<number> } = {}) {
  const calls: number[] = [];
  const transcribe = async (wav: string, signal: AbortSignal): Promise<EngineOutput> => {
    const seconds = wavSamples(readFileSync(wav)).length / SAMPLE_RATE;
    calls.push(seconds);
    await new Promise((r) => setTimeout(r, 2));
    signal.throwIfAborted();
    if (opts.fail?.has(calls.length)) throw new Error("engine failed");
    return { language: "Korean", text: `구간${calls.length}`, words: [{ text: `구간${calls.length}`, start: 0.1, end: seconds - 0.1 }] };
  };
  return { calls, transcribe };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

test("WBS-101: windows are cut at quiet moments and transcribed while recording; stopping adds only the tail", async () => {
  const r = recording();
  const engine = fakeEngine();
  const live = new LiveTranscription({ root: join(r.root, "live"), window: WINDOW, transcribe: engine.transcribe, enabled: () => true });
  for (let i = 0; i < 25; i += 1) { live.chunkSaved("rec1", r.pcmPath, r.grow(1)); await settle(); }
  // 25 s recorded: the first window (to the gap near 10 s) and the second (near 20 s) need 11 s and 21 s of audio.
  assert.equal(engine.calls.length, 2, "two windows done during the recording");
  assert.ok(engine.calls.every((s) => s > 9 && s < 11), `windows end in the gaps: ${engine.calls}`);
  assert.ok(live.transcribedMs("rec1") > 19_000);
  const bytes = r.grow(2);
  live.finish("rec1", r.pcmPath, bytes, "a".repeat(64));
  const progress: number[] = [];
  const out = await live.take("a".repeat(64), new AbortController().signal, (p) => progress.push(p));
  assert.ok(out);
  assert.equal(engine.calls.length, 3, "only the tail was left after stopping");
  assert.equal(out.text, "구간1 구간2 구간3");
  assert.ok(out.words[1]!.start > 9 && out.words[2]!.start > 19, "words are in recording time");
  assert.equal(progress.at(-1), 1);
  assert.equal(existsSync(join(r.root, "live", "rec1")), false, "live work is removed once taken");
  assert.equal(await live.take("a".repeat(64), new AbortController().signal, () => {}), undefined);
});

test("WBS-101: while transcription is paused, windows are only cut; the queue's take does them all", async () => {
  const r = recording();
  const engine = fakeEngine();
  let enabled = false;
  const live = new LiveTranscription({ root: join(r.root, "live"), window: WINDOW, transcribe: engine.transcribe, enabled: () => enabled });
  for (let i = 0; i < 4; i += 1) { live.chunkSaved("rec2", r.pcmPath, r.grow(8)); await settle(); }
  assert.equal(engine.calls.length, 0);
  assert.equal(live.transcribedMs("rec2"), 0);
  live.finish("rec2", r.pcmPath, statSync(r.pcmPath).size, "b".repeat(64));
  const out = await live.take("b".repeat(64), new AbortController().signal, () => {});
  assert.equal(engine.calls.length, 4, "three full windows and the tail");
  assert.equal(out?.words.length, 4);
  enabled = true;
});

test("WBS-101: after a crash, a new start continues from the finished windows and the recovered recording's tail", async () => {
  const r = recording();
  const first = fakeEngine();
  const root = join(r.root, "live");
  const live = new LiveTranscription({ root, window: WINDOW, transcribe: first.transcribe, enabled: () => true });
  for (let i = 0; i < 3; i += 1) { live.chunkSaved("rec3", r.pcmPath, r.grow(8)); await settle(); }
  assert.equal(first.calls.length, 2);
  // The app is gone; the next start recovers the recording (same PCM file) as an original.
  const second = fakeEngine();
  const again = new LiveTranscription({ root, window: WINDOW, transcribe: second.transcribe, enabled: () => true });
  assert.ok(again.transcribedMs("rec3") > 19_000, "finished windows survived");
  again.finish("rec3", r.pcmPath, statSync(r.pcmPath).size, "c".repeat(64));
  again.prune(() => false, (sha) => sha === "c".repeat(64));
  const out = await again.take("c".repeat(64), new AbortController().signal, () => {});
  assert.equal(second.calls.length, 1, "only the tail ran after the restart");
  assert.equal(out?.text, "구간1 구간2 구간1");
});

test("WBS-101: a failed window is retried by take, and the error reaches the queue when it fails again", async () => {
  const r = recording();
  const engine = fakeEngine({ fail: new Set([1, 3]) });
  const live = new LiveTranscription({ root: join(r.root, "live"), window: WINDOW, transcribe: engine.transcribe, enabled: () => true, retryAfterMs: 60_000 });
  live.chunkSaved("rec4", r.pcmPath, r.grow(12)); await settle();
  assert.equal(engine.calls.length, 1, "first try failed");
  live.chunkSaved("rec4", r.pcmPath, r.grow(1)); await settle();
  assert.equal(engine.calls.length, 1, "not retried on its own before retryAfterMs");
  live.finish("rec4", r.pcmPath, statSync(r.pcmPath).size, "d".repeat(64));
  await assert.rejects(live.take("d".repeat(64), new AbortController().signal, () => {}), /engine failed/);
  const out = await live.take("d".repeat(64), new AbortController().signal, () => {});
  assert.equal(out?.words.length, 2);
});

test("WBS-101: live work of a recording that is gone, or whose original is gone, is removed; short recordings are left to the queue", async () => {
  const r = recording();
  const engine = fakeEngine();
  const root = join(r.root, "live");
  const live = new LiveTranscription({ root, window: WINDOW, transcribe: engine.transcribe, enabled: () => false });
  live.chunkSaved("orphan", r.pcmPath, r.grow(12));
  live.chunkSaved("removed", r.pcmPath, statSync(r.pcmPath).size);
  live.finish("removed", r.pcmPath, statSync(r.pcmPath).size, "e".repeat(64));
  live.prune(() => false, () => false);
  assert.equal(existsSync(join(root, "orphan")), false);
  assert.equal(existsSync(join(root, "removed")), false);
  // Finished but never taken for more than two weeks (transcription cancelled and not retried).
  const old = recording();
  const later = new LiveTranscription({ root, window: WINDOW, transcribe: engine.transcribe, enabled: () => false, now: () => Date.now() + 15 * 24 * 3600_000 });
  later.chunkSaved("cancelled", old.pcmPath, old.grow(12));
  later.finish("cancelled", old.pcmPath, statSync(old.pcmPath).size, "9".repeat(64));
  later.prune(() => false, () => true);
  assert.equal(existsSync(join(root, "cancelled")), false);
  const short = recording();
  live.chunkSaved("short", short.pcmPath, short.grow(5));
  live.finish("short", short.pcmPath, statSync(short.pcmPath).size, "f".repeat(64));
  assert.equal(await live.take("f".repeat(64), new AbortController().signal, () => {}), undefined, "under one window: the queue transcribes the original");
});
