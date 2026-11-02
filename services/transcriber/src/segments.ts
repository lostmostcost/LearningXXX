import type { TranscriptSegment } from "@learningxxx/contracts";

/** One aligned word from the engine, in seconds; no spacing or punctuation. */
export interface AlignedWord {
  text: string;
  start: number;
  end: number;
}

/** A pause this long starts a new segment even mid-sentence. */
const PAUSE_SECONDS = 1.2;
/** Segments are split before they grow past this many characters. */
const MAX_CHARS = 120;

/**
 * Phrases speech models are known to invent on silence or music (ADR-003 rule
 * step). Removed only when a whole segment is nothing but one of them.
 */
const HALLUCINATIONS = [/^(시청|구독)(해|하여)? ?주셔서 감사합니다\.?$/, /^구독(과)? ?좋아요.*$/, /^MBC 뉴스.*$/];

const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);

/**
 * Where each word sits in the full text, matching letters and digits only.
 * Returns undefined when the two disagree, so the caller can fall back.
 */
function locate(text: string, words: readonly AlignedWord[]): { from: number; to: number }[] | undefined {
  const spans: { from: number; to: number }[] = [];
  let i = 0;
  for (const word of words) {
    const letters = [...word.text].filter(isWordChar);
    if (letters.length === 0) {
      spans.push({ from: i, to: i });
      continue;
    }
    let from = -1;
    for (const letter of letters) {
      while (i < text.length && !isWordChar(text[i]!)) i += 1;
      if (i >= text.length || text[i]!.toLowerCase() !== letter.toLowerCase()) return undefined;
      if (from === -1) from = i;
      i += 1;
    }
    spans.push({ from, to: i });
  }
  return spans;
}

/**
 * Readable, time-stamped segments from the engine's full text and its aligned
 * words. A segment ends at a sentence end, a long pause or a length limit, and
 * keeps the text's own spacing and punctuation. Then the rule clean-up:
 * hallucination-only segments go and an immediate exact repeat is dropped.
 */
export function buildSegments(text: string, words: readonly AlignedWord[]): TranscriptSegment[] {
  if (words.length === 0) return [];
  const spans = locate(text, words);
  const raw: { start: number; end: number; text: string }[] = [];
  let first = 0;
  const close = (last: number) => {
    const from = spans ? spans[first]!.from : 0;
    const to = spans ? (last + 1 < words.length ? spans[last + 1]!.from : text.length) : 0;
    const piece = spans ? text.slice(from, to).trim() : words.slice(first, last + 1).map((w) => w.text).join(" ");
    raw.push({ start: words[first]!.start, end: words[last]!.end, text: piece });
    first = last + 1;
  };
  for (let n = 0; n < words.length; n += 1) {
    if (n === words.length - 1) {
      close(n);
      break;
    }
    const after = spans ? text.slice(spans[n]!.to, spans[n + 1]!.from) : "";
    // "5.3" is one number, not a sentence end: the mark must be followed by a space.
    const sentenceEnd = /[.?!。]\s/.test(after);
    const pause = words[n + 1]!.start - words[n]!.end >= PAUSE_SECONDS;
    const length = spans
      ? spans[n]!.to - spans[first]!.from
      : words.slice(first, n + 1).reduce((sum, w) => sum + w.text.length + 1, 0);
    if (sentenceEnd || pause || length >= MAX_CHARS) close(n);
  }
  const segments: TranscriptSegment[] = [];
  for (const s of raw) {
    if (!s.text || HALLUCINATIONS.some((h) => h.test(s.text))) continue;
    if (segments.at(-1)?.text === s.text) continue;
    const startMs = Math.round(s.start * 1000);
    segments.push({ startMs, endMs: Math.max(startMs, Math.round(s.end * 1000)), text: s.text });
  }
  return segments;
}
