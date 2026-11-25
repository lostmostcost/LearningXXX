import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EngineError, errorDetail, QwenEngine } from "../src/engine.ts";
import { planWindows, SAMPLE_RATE, wavSamples } from "../src/windows.ts";

const SETTINGS = { seconds: 10, searchSeconds: 1, minTailSeconds: 3 };
import { readFileSync } from "node:fs";

const tone = (seconds: number) => Int16Array.from({ length: seconds * SAMPLE_RATE }, (_, i) => Math.round(6000 * Math.sin(i / 7)));
const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "stt-win-")); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A fake engine: names each window by its length in seconds, and can be told to fail. */
function engine(partsRoot: string | undefined, opts: { failAt?: number; log?: string[] } = {}) {
  let calls = 0;
  return new QwenEngine({
    python: "unused", script: "unused", modelHome: "unused", model: "Qwen/Qwen3-ASR-1.7B", partsRoot,
    window: SETTINGS,
    runWindow: async (wav, _signal, onProgress) => {
      calls += 1;
      opts.log?.push(`start ${calls}`);
      await new Promise((r) => setTimeout(r, 5));
      const seconds = wavSamples(readFileSync(wav)).length / SAMPLE_RATE;
      if (opts.failAt === calls) { opts.log?.push(`fail ${calls}`); throw new EngineError("TRANSCRIBE_FAILED", "실패", true, "boom"); }
      onProgress(1);
      opts.log?.push(`end ${calls}`);
      return { language: "Korean", text: `창${calls}`, words: [{ text: `창${calls}`, start: 0.5, end: seconds - 0.5 }] };
    },
  });
}

test("WBS-101: a long file is transcribed window by window and merged in whole-file time", async () => {
  const progress: number[] = [];
  const pcm = tone(33), windows = planWindows(pcm, SETTINGS);
  assert.ok(windows.length >= 3);
  const out = await engine(undefined).transcribeSamples(pcm, { context: "", signal: new AbortController().signal, onProgress: (p) => progress.push(p), work: temp() });
  assert.equal(out.text, windows.map((_, i) => `창${i + 1}`).join(" "));
  assert.deepEqual(out.words.map((w) => w.start), windows.map((w) => w.start / SAMPLE_RATE + 0.5), "each window's words are shifted by where it starts");
  assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]!), "progress never goes back");
  assert.equal(progress.at(-1), 1);
});

test("WBS-101: after a failure, the next attempt reuses finished windows and only runs the rest", async () => {
  const parts = temp();
  const log: string[] = [];
  const pcm = tone(33);
  await assert.rejects(engine(parts, { failAt: 2, log }).transcribeSamples(pcm, { context: "", signal: new AbortController().signal, onProgress: () => {}, work: temp() }), (e: EngineError) => e.detail === "boom");
  assert.equal(readdirSync(parts).length, 1, "the first window was kept");
  const again: string[] = [];
  const out = await engine(parts, { log: again }).transcribeSamples(pcm, { context: "", signal: new AbortController().signal, onProgress: () => {}, work: temp() });
  const count = planWindows(pcm, SETTINGS).length;
  assert.equal(again.filter((l) => l.startsWith("start")).length, count - 1, "every window but the finished first one ran again");
  assert.equal(out.words.length, count);
  assert.equal(readdirSync(parts).length, 0, "pieces are removed once the whole transcript exists");
});

test("WBS-101: never two engine processes at once, even for different callers", async () => {
  const log: string[] = [];
  const e = engine(undefined, { log });
  const work = temp();
  await Promise.all([
    e.transcribeSamples(tone(25), { context: "", signal: new AbortController().signal, onProgress: () => {}, work }),
    e.transcribeSamples(tone(12), { context: "", signal: new AbortController().signal, onProgress: () => {}, work: temp() }),
  ]);
  let running = 0;
  for (const line of log) { running += line.startsWith("start") ? 1 : -1; assert.ok(running <= 1, log.join(",")); }
});

test("WBS-101: the failure reason keeps the error line and drops file paths", () => {
  const stderr = "Traceback (most recent call last):\n  File \"/Users/kim/Library/Application Support/x/transcribe.py\", line 3\nWarning: something\nRuntimeError: [METAL] Command buffer execution failed: Insufficient Memory (/Users/kim/a.wav)\n";
  const d = errorDetail(stderr)!;
  assert.match(d, /Insufficient Memory/);
  assert.doesNotMatch(d, /Users|kim/);
  assert.equal(errorDetail(""), undefined);
});
