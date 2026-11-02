import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSegments } from "../src/segments.ts";

const w = (text: string, start: number, end: number) => ({ text, start, end });

test("segments keep the text's spacing and punctuation and end at sentence ends", () => {
  const text = "이번 시간에는 5.3 동기식 순차 논리입니다. 래치를 봅니다.";
  const words = [w("이번", 0, 0.3), w("시간", 0.3, 0.6), w("에는", 0.6, 0.9), w("53", 0.9, 1.5), w("동기", 1.5, 1.8), w("식", 1.8, 1.9), w("순차", 2, 2.3), w("논리입니다", 2.3, 3), w("래치를", 3.2, 3.6), w("봅니다", 3.6, 4)];
  assert.deepEqual(buildSegments(text, words), [
    { startMs: 0, endMs: 3000, text: "이번 시간에는 5.3 동기식 순차 논리입니다." },
    { startMs: 3200, endMs: 4000, text: "래치를 봅니다." },
  ]);
});

test("a long pause starts a new segment even without punctuation", () => {
  const segments = buildSegments("그래서 이렇게 되는 거죠", [w("그래서", 0, 1), w("이렇게", 3, 3.5), w("되는", 3.5, 3.8), w("거죠", 3.8, 4)]);
  assert.deepEqual(segments.map((s) => s.text), ["그래서", "이렇게 되는 거죠"]);
});

test("invented closing phrases and an immediate exact repeat are removed", () => {
  const text = "네 끝났습니다. 시청해주셔서 감사합니다. 시청해주셔서 감사합니다.";
  const words = [w("네", 0, 0.2), w("끝났습니다", 0.2, 1), w("시청", 5, 5.4), w("해주셔서", 5.4, 5.8), w("감사합니다", 5.8, 6.2), w("시청", 9, 9.4), w("해주셔서", 9.4, 9.8), w("감사합니다", 9.8, 10.2)];
  assert.deepEqual(buildSegments(text, words).map((s) => s.text), ["네 끝났습니다."]);
});

test("a lecturer's real thanks stay", () => {
  assert.deepEqual(buildSegments("감사합니다.", [w("감사합니다", 0, 1)]).map((s) => s.text), ["감사합니다."]);
});

test("when the words and text disagree, the words are joined instead of guessing positions", () => {
  assert.deepEqual(buildSegments("완전히 다른 문장", [w("래치", 0, 1)]).map((s) => s.text), ["래치"]);
});
