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

/**
 * WBS-114: a run of words is taken for the engine reading back its context
 * (course material titles) only when it spells at least this many letters of
 * it in order and runs across two of its lines; reading out one title stays.
 */
const MIN_ECHO_LETTERS = 20;

const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);
const letters = (s: string) => [...s].filter(isWordChar).join("").toLowerCase();

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
 * WBS-114: on quiet stretches the engine may write out the context it was
 * given (one material title after another) as if it were speech, and the
 * aligner then piles those words onto one moment. Such runs are removed from
 * the words and from the text.
 */
export function removeContextEcho(text: string, words: readonly AlignedWord[], context: string): { text: string; words: AlignedWord[] } {
  const lines = context.split("\n").map(letters).filter(Boolean);
  if (lines.length < 2 || words.length === 0) return { text, words: [...words] };
  const ctx = lines.join("");
  const boundaries: number[] = [];
  for (let at = 0, i = 0; i < lines.length - 1; i += 1) { at += lines[i]!.length; boundaries.push(at); }
  const crossesLine = (run: string) => {
    for (let from = ctx.indexOf(run); from !== -1; from = ctx.indexOf(run, from + 1)) {
      if (boundaries.some((b) => b > from && b < from + run.length)) return true;
    }
    return false;
  };
  const own = words.map((w) => letters(w.text));
  const runs: { first: number; last: number }[] = [];
  for (let i = 0; i < words.length; ) {
    if (!own[i] || !ctx.includes(own[i]!)) { i += 1; continue; }
    let run = own[i]!;
    let last = i;
    while (last + 1 < words.length && ctx.includes(run + own[last + 1]!)) { last += 1; run += own[last]!; }
    if (run.length >= MIN_ECHO_LETTERS && crossesLine(run)) { runs.push({ first: i, last }); i = last + 1; } else i += 1;
  }
  if (runs.length === 0) return { text, words: [...words] };
  const spans = locate(text, words);
  let cleaned = text;
  if (spans) {
    for (const { first, last } of runs.toReversed()) {
      const to = last + 1 < words.length ? spans[last + 1]!.from : text.length;
      cleaned = cleaned.slice(0, spans[first]!.from) + cleaned.slice(to);
    }
  }
  const dropped = new Set(runs.flatMap(({ first, last }) => Array.from({ length: last - first + 1 }, (_, k) => first + k)));
  return { text: cleaned, words: words.filter((_, i) => !dropped.has(i)) };
}

/**
 * Readable, time-stamped segments from the engine's full text and its aligned
 * words. A segment ends at a sentence end, a long pause or a length limit, and
 * keeps the text's own spacing and punctuation. Then the rule clean-up:
 * hallucination-only segments go, the engine's read-back context goes
 * (WBS-114) and an immediate exact repeat is dropped.
 */
export function buildSegments(fullText: string, allWords: readonly AlignedWord[], context = ""): TranscriptSegment[] {
  const { text, words } = removeContextEcho(fullText, allWords, context);
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
    // WBS-114: the aligner can place a word before the one spoken ahead of it; a transcript is always in time order.
    const startMs = Math.max(segments.at(-1)?.startMs ?? 0, Math.round(Math.max(0, s.start) * 1000));
    segments.push({ startMs, endMs: Math.max(startMs, Math.round(s.end * 1000)), text: s.text });
  }
  return segments;
}
