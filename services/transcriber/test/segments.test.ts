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

// WBS-114: material titles given as context, as the app builds it (one per line).
const CONTEXT = ["[동계 현장실습 참가자 모집]", "가나호텔_홍길동 과장님_강의자료", "다라항공 김철수 부사무장님 강의자료", "중간과제"].join("\n");

test("WBS-114: the engine reading back its context is removed, and the transcript stays in time order", () => {
  const text = "오늘 특강 감사드립니다. 동계 현장실습 참가자 모집 가나호텔홍길동 과장님강의자료 다라항공 김철수 부사무장님강의자료 기억은 안 나는데 메일이 왔어요.";
  const words = [
    w("오늘", 100, 100.3), w("특강", 100.3, 100.7), w("감사드립니다", 100.7, 101.5),
    // The aligner spreads the read-back words over the real speech, then piles the rest onto one moment.
    w("동계", 102, 102.2), w("현장실습", 102.2, 102.6), w("참가자", 102.6, 103), w("모집", 103, 103.4),
    w("가나호텔홍길동", 110, 110), w("과장님강의자료", 110, 110), w("다라항공", 110, 110), w("김철수", 110, 110), w("부사무장님강의자료", 110, 110),
    w("기억은", 104, 104.4), w("안", 104.4, 104.5), w("나는데", 104.5, 105), w("메일이", 105.2, 105.6), w("왔어요", 105.6, 106),
  ];
  const segments = buildSegments(text, words, CONTEXT);
  assert.deepEqual(segments.map((s) => s.text), ["오늘 특강 감사드립니다.", "기억은 안 나는데 메일이 왔어요."]);
  assert.deepEqual(segments.map((s) => s.startMs), [100000, 104000]);
});

test("WBS-114: a lecturer reading out one title, or using a word from the titles, keeps it", () => {
  const text = "이번에 동계 현장실습 참가자 모집 공지가 올라왔어요. 중간과제 잊지 마세요.";
  const words = [w("이번에", 0, 0.4), w("동계", 0.4, 0.7), w("현장실습", 0.7, 1.2), w("참가자", 1.2, 1.6), w("모집", 1.6, 1.9), w("공지가", 1.9, 2.3), w("올라왔어요", 2.3, 3), w("중간과제", 3.5, 4), w("잊지", 4, 4.3), w("마세요", 4.3, 4.8)];
  assert.deepEqual(buildSegments(text, words, CONTEXT).map((s) => s.text), ["이번에 동계 현장실습 참가자 모집 공지가 올라왔어요.", "중간과제 잊지 마세요."]);
});

test("WBS-114: a word the aligner placed too early never makes a segment start before the one ahead of it", () => {
  const text = "첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다.";
  const words = [w("첫", 10, 10.2), w("문장입니다", 10.2, 11), w("둘째", 20, 20.3), w("문장입니다", 20.3, 21), w("셋째", 15, 15.3), w("문장입니다", 15.3, 16)];
  const segments = buildSegments(text, words);
  assert.deepEqual(segments.map((s) => s.text), ["첫 문장입니다.", "둘째 문장입니다.", "셋째 문장입니다."]);
  for (let i = 1; i < segments.length; i += 1) assert.ok(segments[i]!.startMs >= segments[i - 1]!.startMs);
  for (const s of segments) assert.ok(s.endMs >= s.startMs);
});
