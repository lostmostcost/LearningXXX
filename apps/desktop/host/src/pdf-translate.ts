import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream, degrees, rgb, type PDFFont, type StandardFonts, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { z } from "zod";
import { AccountKey, AppError, Id, LANGUAGE_NAMES, type PdfTranslationSkip, type PreferredLanguage } from "@learningxxx/contracts";

/**
 * WBS-072: a copy of a PDF with the text of chosen pages in the preferred
 * language. Each page's own text objects (BT…ET) are removed from its content
 * stream — shapes, pictures and backgrounds stay — and the translation is
 * drawn where each line was (spikes/pdf-translation, variant B). Pages this
 * cannot do safely are left as they are and reported. The original is never
 * changed; translations are kept per original and language, so another page
 * range adds to what was made before.
 */

/** One line as pdf.js places it, in the page's PDF coordinates; `color` (0–1 RGB) where it was read (WBS-096). */
export interface PdfLine { text: string; x: number; y: number; size: number; width: number; angle: number; color?: [number, number, number] | undefined }

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
/** m1 applied after m2, the PDF way (row vector × m1 × m2). */
const times = (m1: Matrix, m2: Matrix): Matrix => [
  m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
  m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
  m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
];
const matrix = (v: unknown): Matrix | undefined => {
  const m = v && typeof v === "object" ? [0, 1, 2, 3, 4, 5].map((i) => Number((v as Record<number, unknown>)[i])) : [];
  return m.length === 6 && m.every(Number.isFinite) ? (m as Matrix) : undefined;
};
const hexColor = (v: unknown): [number, number, number] | undefined => {
  const m = typeof v === "string" ? /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v) : null;
  return m ? [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255] : undefined;
};

/**
 * WBS-096: where each run of text starts on the page and the fill colour in
 * effect then, from pdf.js's operator list (colours there are already RGB
 * hex). Text matrices, page transforms, saved states and forms are followed;
 * advances inside a run are not, so only run starts are known.
 */
export function textStarts(OPS: Record<string, number>, fnArray: readonly number[], argsArray: readonly unknown[]): { x: number; y: number; color: [number, number, number] }[] {
  const out: { x: number; y: number; color: [number, number, number] }[] = [];
  let ctm: Matrix = IDENTITY, fill: [number, number, number] = [0, 0, 0], tlm: Matrix = IDENTITY, leading = 0;
  const stack: { ctm: Matrix; fill: [number, number, number] }[] = [];
  const move = (tx: number, ty: number) => { tlm = times([1, 0, 0, 1, tx, ty], tlm); };
  const show = () => { const m = times(tlm, ctm); out.push({ x: m[4], y: m[5], color: fill }); };
  fnArray.forEach((fn, i) => {
    const args = (argsArray[i] ?? []) as unknown[];
    switch (fn) {
      case OPS.save: stack.push({ ctm, fill }); break;
      case OPS.restore: { const top = stack.pop(); if (top) ({ ctm, fill } = top); break; }
      case OPS.transform: { const m = matrix(args); if (m) ctm = times(m, ctm); break; }
      case OPS.paintFormXObjectBegin: { stack.push({ ctm, fill }); const m = matrix(args[0]); if (m) ctm = times(m, ctm); break; }
      case OPS.paintFormXObjectEnd: { const top = stack.pop(); if (top) ({ ctm, fill } = top); break; }
      case OPS.setFillRGBColor: fill = hexColor(args[0]) ?? fill; break;
      case OPS.beginText: tlm = IDENTITY; break;
      case OPS.setTextMatrix: tlm = matrix(args[0] ?? args) ?? tlm; break;
      case OPS.setLeading: leading = Number(args[0]) || 0; break;
      case OPS.moveText: move(Number(args[0]) || 0, Number(args[1]) || 0); break;
      case OPS.setLeadingMoveText: leading = -(Number(args[1]) || 0); move(Number(args[0]) || 0, Number(args[1]) || 0); break;
      case OPS.nextLine: move(0, -leading); break;
      case OPS.nextLineShowText: case OPS.nextLineSetSpacingShowText: move(0, -leading); show(); break;
      case OPS.showText: case OPS.showSpacedText: show(); break;
    }
  });
  return out;
}

/** The colour of the run that starts closest to where the line starts, on its baseline; black when none is near. */
export function colorAt(starts: readonly { x: number; y: number; color: [number, number, number] }[], line: Pick<PdfLine, "x" | "y" | "size">): [number, number, number] | undefined {
  let best: { d: number; color: [number, number, number] } | undefined;
  for (const s of starts) {
    if (Math.abs(s.y - line.y) > line.size * 0.5) continue;
    const d = Math.abs(s.x - line.x);
    if (d <= line.size * 1.5 && (!best || d < best.d)) best = { d, color: s.color };
  }
  return best?.color;
}

/** Pages per request, so one request stays within a few minutes. */
export const MAX_PAGES = 40;
/** Lines per Claude Code request, like the transcript translation. */
export const LINE_BATCH = 120;

function fail(code: "NOT_FOUND" | "INVALID_REQUEST" | "RUN_ALREADY_ACTIVE" | "MEDIA_UNREADABLE" | "AUTH_REQUIRED" | "SCOPE_VIOLATION", message: string, retryable = false): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable }) });
}

/** pdf.js text items joined into lines: same baseline and angle, small gap. */
export async function pdfLines(bytes: Uint8Array, colorPages?: ReadonlySet<number>): Promise<PdfLine[][]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: PdfLine[][] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const items = (await page.getTextContent()).items;
      const lines: PdfLine[] = [];
      for (const item of items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const [a, b, , , x, y] = item.transform as number[];
        const size = Math.hypot(item.transform[2]!, item.transform[3]!) || Math.hypot(a!, b!) || 10;
        const angle = Math.round((Math.atan2(b!, a!) * 180) / Math.PI);
        const last = lines.at(-1);
        // Along the line's own direction: how far this item starts after the last one ends.
        const gap = last ? (x! - last.x) * Math.cos((angle * Math.PI) / 180) + (y! - last.y) * Math.sin((angle * Math.PI) / 180) - last.width : 0;
        const across = last ? -(x! - last.x) * Math.sin((angle * Math.PI) / 180) + (y! - last.y) * Math.cos((angle * Math.PI) / 180) : 0;
        if (last && last.angle === angle && Math.abs(across) < last.size * 0.4 && gap > -last.size && gap < last.size * 1.5) {
          last.text += (gap > last.size * 0.15 && !/\s$/.test(last.text) && !/^\s/.test(item.str) ? " " : "") + item.str;
          last.width = Math.max(last.width, gap + last.width + item.width);
        } else {
          lines.push({ text: item.str, x: x!, y: y!, size, width: item.width, angle });
        }
      }
      // WBS-096: colours only for the pages being drawn; reading the operator list costs more than the text.
      const starts = colorPages?.has(n) && lines.length ? await page.getOperatorList().then((ops) => textStarts(pdfjs.OPS as unknown as Record<string, number>, ops.fnArray, ops.argsArray)).catch(() => []) : [];
      pages.push(lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim(), ...(starts.length ? { color: colorAt(starts, l) } : {}) })).filter((l) => l.text));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

const DELIM = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);
const isSpace = (c: string) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";
const OPERAND = /^([+-]?(\d+\.?\d*|\.\d+)|true|false|null)$/;
const SHOW_TEXT = new Set(["Tj", "TJ", "'", '"']);

/**
 * A content stream with its text-drawing operators (Tj, TJ, ', ") and their
 * operands removed. Everything else — fonts, colours and positions set inside
 * text objects, shapes, pictures — is kept, so the rest of the page draws as
 * before. Strings, hex strings and comments are skipped while scanning, so
 * text that reads like an operator is not mistaken for one. An inline image
 * (BI) holds raw bytes this cannot scan, and invisible text (render mode 3)
 * is a scan's OCR layer; both are reported and the stream is left alone.
 */
export function stripTextObjects(content: string): { content: string; removed: number; inlineImage: boolean; invisibleText: boolean } {
  const cuts: [number, number][] = [];
  const operands: string[] = [];
  let i = 0, operandsFrom = 0;
  const n = content.length;
  while (i < n) {
    const c = content[i]!;
    if (isSpace(c)) { i++; continue; }
    if (c === "%") { while (i < n && content[i] !== "\n" && content[i] !== "\r") i++; continue; }
    if (c === "(") {
      let depth = 1; i++;
      while (i < n && depth) { const d = content[i]!; if (d === "\\") i++; else if (d === "(") depth++; else if (d === ")") depth--; i++; }
      operands.push("(string)");
      continue;
    }
    if (c === "<" && content[i + 1] !== "<") { while (i < n && content[i] !== ">") i++; i++; operands.push("<hex>"); continue; }
    if (DELIM.has(c)) {
      i++;
      if ((c === "<" || c === ">") && content[i] === c) i++;
      else if (c === "/") { while (i < n && !isSpace(content[i]!) && !DELIM.has(content[i]!)) i++; operands.push("/name"); }
      continue;
    }
    const from = i;
    while (i < n && !isSpace(content[i]!) && !DELIM.has(content[i]!)) i++;
    const token = content.slice(from, i);
    if (OPERAND.test(token)) { operands.push(token); continue; }
    if (token === "BI") return { content, removed: 0, inlineImage: true, invisibleText: false };
    if (token === "Tr" && operands.at(-1) === "3") return { content, removed: 0, inlineImage: false, invisibleText: true };
    if (SHOW_TEXT.has(token)) cuts.push([operandsFrom, i]);
    operands.length = 0;
    operandsFrom = i;
  }
  let kept = "", at = 0;
  for (const [a, b] of cuts) { kept += content.slice(at, a) + " "; at = b; }
  return { content: kept + content.slice(at), removed: cuts.length, inlineImage: false, invisibleText: false };
}

/** Numbered lines in, a JSON object of the same numbers out (like the transcript translation). */
export function pdfTranslatePrompt(language: PreferredLanguage, lines: readonly string[]): string {
  return [
    `다음은 강의 자료(PDF)의 줄들입니다. 각 줄을 ${LANGUAGE_NAMES[language]}(${language})로 번역해 주세요. 한 문장이 여러 줄로 나뉘어 있을 수 있으니 앞뒤 줄을 보고 뜻이 이어지게 번역하되, 줄 수와 순서는 그대로 둡니다.`,
    "수식·코드·기호·고유 이름·숫자는 그대로 두고, 전문 용어는 그 언어에서 흔히 쓰는 말로, 뜻을 더하거나 빼지 않습니다. 이미 그 언어인 줄은 그대로 씁니다.",
    "",
    'JSON 객체 하나만 출력합니다(앞뒤 설명·코드 블록 없이): {"1": "번역", "2": "번역", ...}. 번호는 아래와 같게, 모든 번호를 넣습니다.',
    "",
    ...lines.map((line, i) => `${i + 1}\t${line}`),
  ].join("\n");
}

/** macOS fonts drawn into the copy (subset); nothing is bundled with the app. */
export const SYSTEM_FONTS = {
  korean: "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
  wide: "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
} as const;

/** Lines worth sending: some letter in them, not only numbers or symbols. */
const hasWords = (text: string) => /\p{L}{2,}/u.test(text);

interface Face { font: PDFFont; chars: Set<number> }

/** The characters a face cannot draw are dropped rather than shown as boxes. */
function drawable(text: string, faces: readonly Face[]): { face: Face; text: string } {
  const points = [...text].map((ch) => ch.codePointAt(0)!);
  for (const face of faces) if (points.every((p) => p <= 32 || face.chars.has(p))) return { face, text };
  const face = faces[0]!;
  return { face, text: [...text].filter((ch) => ch.codePointAt(0)! <= 32 || face.chars.has(ch.codePointAt(0)!)).join("") };
}

function contentRefs(page: PDFPage): PDFRef[] {
  const raw = page.node.get(PDFName.of("Contents"));
  if (raw instanceof PDFRef) {
    const target = page.doc.context.lookup(raw);
    return target instanceof PDFArray ? target.asArray().filter((r): r is PDFRef => r instanceof PDFRef) : [raw];
  }
  return raw instanceof PDFArray ? raw.asArray().filter((r): r is PDFRef => r instanceof PDFRef) : [];
}

const streamText = (stream: unknown): string => {
  if (stream instanceof PDFRawStream) return new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode());
  if (stream instanceof PDFStream) return new TextDecoder("latin1").decode(stream.getContents());
  throw new Error("not a stream");
};
const latin1 = (text: string) => Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);

/** Does a form drawn on the page carry text of its own (which stripping the page would miss)? */
function formsHaveText(page: PDFPage): boolean {
  const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  for (const [, ref] of xobjects?.entries() ?? []) {
    const stream = page.doc.context.lookup(ref);
    if (!(stream instanceof PDFStream) || stream.dict.get(PDFName.of("Subtype")) !== PDFName.of("Form")) continue;
    try { if (stripTextObjects(streamText(stream)).removed) return true; } catch { return true; }
  }
  return false;
}

export type PageReason = PdfTranslationSkip["reason"];

/**
 * Builds the copy: pages with a translation get their text replaced, every
 * other page is the original. Returns the pages that could not be changed.
 */
export async function buildTranslatedPdf(input: { original: Uint8Array; lines: readonly PdfLine[][]; translations: ReadonlyMap<number, readonly string[]>; fonts: readonly (Uint8Array | StandardFonts)[] }): Promise<{ bytes: Uint8Array<ArrayBuffer>; skipped: { page: number; reason: PageReason }[] }> {
  const doc = await PDFDocument.load(input.original, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const faces: Face[] = [];
  for (const bytes of input.fonts) {
    const font = await doc.embedFont(bytes, { subset: true });
    faces.push({ font, chars: new Set(font.getCharacterSet()) });
  }
  const skipped: { page: number; reason: PageReason }[] = [];
  const pages = doc.getPages();
  for (const [number, texts] of [...input.translations].sort(([a], [b]) => a - b)) {
    const page = pages[number - 1];
    const lines = input.lines[number - 1];
    if (!page || !lines || lines.length !== texts.length) { skipped.push({ page: number, reason: "changed" }); continue; }
    let stripped: { ref: PDFRef; content: string }[];
    try {
      if (formsHaveText(page)) { skipped.push({ page: number, reason: "unsupported" }); continue; }
      const results = contentRefs(page).map((ref) => ({ ref, ...stripTextObjects(streamText(doc.context.lookup(ref))) }));
      if (results.some((r) => r.invisibleText)) { skipped.push({ page: number, reason: "scanned" }); continue; }
      if (results.some((r) => r.inlineImage)) { skipped.push({ page: number, reason: "unsupported" }); continue; }
      stripped = results;
    } catch { skipped.push({ page: number, reason: "unsupported" }); continue; }
    // New streams, so a stream shared with another page is not changed there.
    const fresh = stripped.map(({ content }) => doc.context.register(doc.context.flateStream(latin1(content))));
    page.node.set(PDFName.of("Contents"), doc.context.obj(fresh));
    lines.forEach((line, i) => {
      const { face, text } = drawable(texts[i] ?? line.text, faces);
      if (!text.trim()) return;
      // Up to 30% wider, but not into the next column on the same baseline; then smaller, down to 60%.
      const next = line.angle ? undefined : lines.filter((o) => !o.angle && o.x > line.x + line.width * 0.5 && Math.abs(o.y - line.y) < line.size * 0.4).sort((a, b) => a.x - b.x)[0];
      // A line kept as it was (code, names) is redrawn in a different font: it gets exactly its old width.
      const room = text === line.text ? line.width : Math.max(line.width, Math.min(Math.max(line.width, line.size) * 1.3, next ? next.x - line.x - line.size * 0.3 : Infinity));
      let size = line.size;
      while (size > line.size * 0.6 && face.font.widthOfTextAtSize(text, size) > room) size -= 0.25;
      page.drawText(text, { x: line.x, y: line.y, size, font: face.font, color: rgb(...(line.color ?? [0, 0, 0])), ...(line.angle ? { rotate: degrees(line.angle) } : {}) });
    });
  }
  return { bytes: new Uint8Array(await doc.save()), skipped };
}

const Saved = z.object({
  pages: z.record(z.string().regex(/^\d{1,5}$/), z.array(z.string())),
  skipped: z.record(z.string().regex(/^\d{1,5}$/), z.enum(["scanned", "unsupported", "changed"])).default({}),
});
type Saved = z.infer<typeof Saved>;

export interface PdfTranslationOptions {
  root: string;
  accountKey: () => string | undefined;
  /** The verified original and its hash; throws an app error when missing. */
  original: (courseId: string, assetId: string) => Promise<{ bytes: Uint8Array; sha256: string; mediaType: string }>;
  translate: (input: { language: PreferredLanguage; lines: string[]; signal: AbortSignal }) => Promise<(string | undefined)[]>;
  /** Font files to draw with, first choice first (tests pass a standard PDF font). */
  fonts?: (language: PreferredLanguage) => Promise<(Uint8Array | StandardFonts)[]>;
  lines?: (bytes: Uint8Array, colorPages?: ReadonlySet<number>) => Promise<PdfLine[][]>;
  batch?: number;
}

export async function systemFonts(language: PreferredLanguage): Promise<Uint8Array[]> {
  // Korean reads best in AppleGothic; Arial Unicode covers the other languages and symbols.
  const files = language === "ko" ? [SYSTEM_FONTS.korean, SYSTEM_FONTS.wide] : [SYSTEM_FONTS.wide];
  const out: Uint8Array[] = [];
  for (const file of files) out.push(new Uint8Array(await readFile(file).catch(() => fail("MEDIA_UNREADABLE", "번역본에 쓸 macOS 기본 글꼴을 찾지 못했습니다."))));
  return out;
}

export interface TranslatedPdf { bytes?: Uint8Array<ArrayBuffer>; pages: number[]; skipped: PdfTranslationSkip[] }

export class PdfTranslationService {
  readonly #o: PdfTranslationOptions;
  #running = false;
  #abort: AbortController | undefined;

  constructor(options: PdfTranslationOptions) { this.#o = options; }

  /** Kept per account and course, like the rest of the app's data. */
  #dir(courseId: string): { key: string; dir: string } {
    const key = this.#o.accountKey();
    if (!key) fail("AUTH_REQUIRED", "학교 자료를 먼저 수집해 계정을 확인하세요.");
    return { key, dir: join(this.#o.root, AccountKey.parse(key), Id.parse(courseId)) };
  }

  async #original(courseId: string, assetId: string) {
    const original = await this.#o.original(courseId, assetId);
    if (!/^[0-9a-f]{64}$/.test(original.sha256)) fail("MEDIA_UNREADABLE", "자료 정보를 읽지 못했습니다.");
    return original;
  }

  async #saved(file: string): Promise<Saved> {
    try { return Saved.parse(JSON.parse(await readFile(file, "utf8"))); } catch { return { pages: {}, skipped: {} }; }
  }

  #view(saved: Saved): Omit<TranslatedPdf, "bytes"> {
    const skipped = Object.entries(saved.skipped).map(([page, reason]) => ({ page: Number(page), reason }));
    const off = new Set(skipped.map((s) => s.page));
    return { pages: Object.keys(saved.pages).map(Number).filter((p) => !off.has(p)).sort((a, b) => a - b), skipped: skipped.sort((a, b) => a.page - b.page) };
  }

  /** The copy made before for this original and language, if any. */
  async get(courseId: string, assetId: string, language: PreferredLanguage): Promise<TranslatedPdf> {
    const { dir } = this.#dir(courseId);
    const { sha256 } = await this.#original(courseId, assetId);
    const base = join(dir, `${sha256}.${language}`);
    const saved = await this.#saved(`${base}.json`);
    const view = this.#view(saved);
    if (!view.pages.length) return view;
    const bytes = await readFile(`${base}.pdf`).catch(() => undefined);
    return bytes ? { ...view, bytes: new Uint8Array(bytes) } : view;
  }

  cancel(): void { this.#abort?.abort(); }

  /**
   * Translates pages `from`–`to` (1-based, inclusive) and adds them to the
   * copy. Stopping, or a failed request part-way, keeps the pages finished so
   * far: the copy is built and saved with them before returning or failing.
   */
  async make(courseId: string, assetId: string, language: PreferredLanguage, from: number, to: number): Promise<TranslatedPdf & { bytes: Uint8Array<ArrayBuffer>; untranslated: number; stopped: boolean }> {
    if (this.#running) fail("RUN_ALREADY_ACTIVE", "다른 번역본을 만드는 중입니다. 끝난 뒤 다시 시도하세요.");
    this.#running = true;
    const abort = (this.#abort = new AbortController());
    try {
      const { key, dir } = this.#dir(courseId);
      const original = await this.#original(courseId, assetId);
      if (original.mediaType !== "application/pdf") fail("INVALID_REQUEST", "PDF만 번역본을 만들 수 있습니다.");
      // Colours are read for the pages this copy will draw: the ones asked for and those made before.
      const before = await this.#saved(join(dir, `${original.sha256}.${language}.json`));
      const drawn = new Set([...Object.keys(before.pages).map(Number), ...Array.from({ length: Math.max(0, Math.min(to, from + MAX_PAGES) - from + 1) }, (_, i) => from + i)]);
      const lines = await (this.#o.lines ?? pdfLines)(original.bytes, drawn).catch(() => fail("MEDIA_UNREADABLE", "PDF를 읽지 못했습니다(암호가 걸렸거나 손상된 파일일 수 있음)."));
      const last = Math.min(to, lines.length);
      if (!Number.isInteger(from) || from < 1 || from > last) fail("INVALID_REQUEST", `쪽 범위가 올바르지 않습니다(1–${lines.length}쪽).`);
      if (last - from + 1 > MAX_PAGES) fail("INVALID_REQUEST", `한 번에 ${MAX_PAGES}쪽까지 만들 수 있습니다.`);
      // Checked before any translating: a PDF that cannot be rewritten (e.g. encrypted) would waste the requests.
      await PDFDocument.load(original.bytes, { updateMetadata: false }).catch(() => fail("MEDIA_UNREADABLE", "이 PDF는 고쳐 쓸 수 없습니다(암호가 걸렸거나 구조가 손상됨). 원본만 볼 수 있습니다."));
      const fonts = await (this.#o.fonts ?? systemFonts)(language);
      const base = join(dir, `${original.sha256}.${language}`);
      const saved = await this.#saved(`${base}.json`);
      const wanted: number[] = [];
      for (let p = from; p <= last; p++) {
        if (!lines[p - 1]!.length) saved.skipped[String(p)] = "scanned";
        else if (!saved.pages[String(p)] || saved.skipped[String(p)] === "changed") { delete saved.skipped[String(p)]; delete saved.pages[String(p)]; wanted.push(p); }
      }
      // Every line of the wanted pages in reading order; those without words are kept as they are.
      const queue = wanted.flatMap((p) => lines[p - 1]!.map((l, i) => ({ p, i, text: l.text })));
      const sendable = queue.filter((q) => hasWords(q.text));
      const result = new Map<string, string>();
      let untranslated = 0, failure: unknown;
      try {
        for (let at = 0, size = this.#o.batch ?? LINE_BATCH; at < sendable.length && !abort.signal.aborted; at += size) {
          const batch = sendable.slice(at, at + size);
          const out = await this.#o.translate({ language, lines: batch.map((b) => b.text), signal: abort.signal });
          if (abort.signal.aborted) break;
          batch.forEach((b, k) => { const t = out[k]; if (t === undefined) untranslated++; result.set(`${b.p}:${b.i}`, t ?? b.text); });
          // A page is kept once every one of its lines is back.
          for (const p of new Set(batch.map((b) => b.p))) {
            const own = queue.filter((q) => q.p === p);
            if (own.every((q) => !hasWords(q.text) || result.has(`${q.p}:${q.i}`))) saved.pages[String(p)] = own.map((q) => result.get(`${q.p}:${q.i}`) ?? q.text);
          }
        }
      } catch (error) { failure = error; }
      // Nothing new to keep: fail without rewriting the copy.
      if (failure && !abort.signal.aborted && !wanted.some((p) => saved.pages[String(p)])) throw failure;
      const translations = new Map(Object.entries(saved.pages).map(([p, t]) => [Number(p), t] as const));
      const built = await buildTranslatedPdf({ original: original.bytes, lines, translations, fonts });
      for (const s of built.skipped) saved.skipped[String(s.page)] = s.reason;
      // Never written into another account's folder if the sign-in changed meanwhile.
      if (this.#o.accountKey() !== key) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다. 번역본을 저장하지 않았습니다.");
      await mkdir(dir, { recursive: true });
      await writeAtomic(`${base}.pdf`, built.bytes);
      await writeAtomic(`${base}.json`, JSON.stringify(saved));
      if (failure && !abort.signal.aborted) throw failure;
      return { ...this.#view(saved), bytes: built.bytes, untranslated, stopped: abort.signal.aborted };
    } finally {
      this.#running = false;
      this.#abort = undefined;
    }
  }
}

async function writeAtomic(file: string, data: Uint8Array | string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, data);
  await rename(temp, file);
}
