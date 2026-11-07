import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeWindows, planWindows, quietestPoint, SAMPLE_RATE, wavFile, wavSamples } from "../src/windows.ts";

/** Synthetic speech-like audio: a loud tone everywhere except silent gaps at the given seconds. */
function audio(seconds: number, gaps: number[], gapSeconds = 0.4): Int16Array {
  const pcm = new Int16Array(seconds * SAMPLE_RATE);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE));
  for (const g of gaps) pcm.fill(0, Math.round(g * SAMPLE_RATE), Math.round((g + gapSeconds) * SAMPLE_RATE));
  return pcm;
}

test("WBS-101: the cut lands in the silent gap nearest the target, not at the exact second", () => {
  const pcm = audio(30, [12.3]);
  const cut = quietestPoint(pcm, 7 * SAMPLE_RATE, 15 * SAMPLE_RATE);
  assert.ok(cut >= 12.3 * SAMPLE_RATE && cut <= 12.7 * SAMPLE_RATE, `cut at ${cut / SAMPLE_RATE}s`);
});

test("WBS-101: windows cover the audio exactly once, end at quiet moments, and a short tail joins the last window", () => {
  const pcm = audio(65, [9.6, 20.5, 29.8, 41.0, 50.2, 60.1]);
  const windows = planWindows(pcm, { seconds: 10, searchSeconds: 2, minTailSeconds: 4 });
  assert.equal(windows[0]!.start, 0);
  assert.equal(windows.at(-1)!.end, pcm.length);
  for (let i = 1; i < windows.length; i += 1) assert.equal(windows[i]!.start, windows[i - 1]!.end, "no gap or overlap");
  const cuts = windows.slice(0, -1).map((w) => w.end / SAMPLE_RATE);
  for (const c of cuts) assert.ok([9.6, 20.5, 29.8, 41.0, 50.2, 60.1].some((g) => c >= g && c <= g + 0.4), `cut ${c}s is in a gap`);
  // 65 s with 10 s windows: the remainder after the 6th cut is under 10 + 4 s, so it stays one last window.
  assert.ok(windows.at(-1)!.end - windows.at(-1)!.start >= 4 * SAMPLE_RATE);
});

test("WBS-101: audio no longer than one window is a single window", () => {
  const pcm = audio(12, []);
  assert.deepEqual(planWindows(pcm, { seconds: 10, searchSeconds: 2, minTailSeconds: 4 }), [{ start: 0, end: pcm.length }]);
});

test("WBS-101: WAV data is found after extra chunks, and a written window reads back the same", () => {
  const samples = audio(2, [0.5]);
  const plain = wavFile(samples);
  assert.deepEqual([...wavSamples(plain)].slice(0, 50), [...samples].slice(0, 50));
  // afconvert can put a FLLR (padding) chunk before data.
  const fllr = Buffer.alloc(8 + 6); fllr.write("FLLR", 0); fllr.writeUInt32LE(6, 4);
  const padded = Buffer.concat([plain.subarray(0, 36), fllr, plain.subarray(36)]);
  padded.writeUInt32LE(padded.length - 8, 4);
  assert.equal(wavSamples(padded).length, samples.length);
  // An odd byte offset (a slice of a bigger buffer) is copied, not misread.
  const odd = Buffer.concat([Buffer.alloc(1), plain]).subarray(1);
  assert.deepEqual([...wavSamples(odd)].slice(0, 50), [...samples].slice(0, 50));
  assert.throws(() => wavSamples(Buffer.from("not audio at all")), /not a WAV/);
});

test("WBS-101: merged results keep every word once, shifted to whole-audio time and in order", () => {
  const merged = mergeWindows([
    { offsetSeconds: 300, output: { language: "Korean", text: "두 번째 구간.", words: [{ text: "두", start: 0.2, end: 0.4 }, { text: "번째", start: 0.5, end: 0.9 }, { text: "구간", start: 1, end: 1.4 }] } },
    { offsetSeconds: 0, output: { language: "Korean", text: " 첫 구간입니다. ", words: [{ text: "첫", start: 1, end: 1.2 }, { text: "구간입니다", start: 1.3, end: 2 }] } },
    { offsetSeconds: 600, output: { language: "", text: "", words: [] } },
  ]);
  assert.equal(merged.text, "첫 구간입니다. 두 번째 구간.");
  assert.deepEqual(merged.words.map((w) => [w.text, w.start]), [["첫", 1], ["구간입니다", 1.3], ["두", 300.2], ["번째", 300.5], ["구간", 301]]);
  assert.equal(merged.language, "Korean");
});
