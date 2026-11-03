import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { PdfTranslationService, SYSTEM_FONTS, buildTranslatedPdf, colorAt, pdfLines, stripTextObjects, systemFonts, textStarts } from "../src/pdf-translate.ts";

const COURSE = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const SHA = "a".repeat(64);
const helvetica = async () => [StandardFonts.Helvetica];

/** A synthetic two-page slide deck: a coloured box and a few lines of English per page. */
async function deck(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n++) {
    const page = doc.addPage([400, 300]);
    page.drawRectangle({ x: 10, y: 10, width: 380, height: 60, color: rgb(0.2, 0.4, 0.8) });
    page.drawText(`Chapter ${n}: Boolean Algebra`, { x: 20, y: 250, size: 18, font });
    page.drawText("An AND gate outputs 1", { x: 20, y: 200, size: 12, font });
    page.drawText("only when all inputs are 1.", { x: 160, y: 200, size: 12, font });
    page.drawText("42", { x: 360, y: 20, size: 10, font });
  }
  return doc.save();
}

const texts = async (bytes: Uint8Array) => (await pdfLines(bytes)).map((p) => p.map((l) => l.text));

describe("stripTextObjects", () => {
  it("removes text drawing with its operands and keeps state, shapes and look-alike strings", () => {
    const content = "q 1 0 0 rg 0 0 10 10 re f Q BT /F1 12 Tf 1 0 0 rg 10 20 Td (A Tj ET (x)) Tj [(He) -20 (llo)] TJ (next) ' 1 2 (q) \" ET 0 g 5 5 m 6 6 l S";
    const out = stripTextObjects(content);
    assert.equal(out.removed, 4);
    assert.equal(out.inlineImage, false);
    assert.doesNotMatch(out.content, /Tj|TJ|llo|next|\(q\)/);
    for (const kept of ["0 0 10 10 re f", "/F1 12 Tf", "1 0 0 rg 10 20 Td", "BT", "ET", "5 5 m 6 6 l S"]) assert.ok(out.content.includes(kept), kept);
  });

  it("does not scan inline images and reports invisible OCR text", () => {
    assert.equal(stripTextObjects("q BI /W 1 /H 1 ID \x00\xffET Tj EI Q").inlineImage, true);
    assert.equal(stripTextObjects("BT 3 Tr (hidden) Tj ET").invisibleText, true);
    assert.equal(stripTextObjects("BT 0 Tr (shown) Tj ET").invisibleText, false);
  });

  it("skips comments and hex strings", () => {
    const out = stripTextObjects("% (not) Tj\nBT <48656c6c6f> Tj ET");
    assert.equal(out.removed, 1);
    assert.match(out.content, /% \(not\) Tj/);
  });
});

describe("pdfLines", () => {
  it("joins pieces on one baseline into a line and keeps pages apart", async () => {
    const lines = await pdfLines(await deck());
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0]!.map((l) => l.text), ["Chapter 1: Boolean Algebra", "An AND gate outputs 1 only when all inputs are 1.", "42"]);
    assert.ok(lines[0]![1]!.width > 200);
  });
});

describe("buildTranslatedPdf", () => {
  it("replaces only the chosen page's text and keeps the rest of the page", async () => {
    const original = await deck();
    const lines = await pdfLines(original);
    const built = await buildTranslatedPdf({ original, lines, translations: new Map([[1, ["CH-1", "AND-1", "42"]]]), fonts: [StandardFonts.Helvetica] });
    assert.deepEqual(built.skipped, []);
    const after = await texts(built.bytes);
    assert.deepEqual(after[0], ["CH-1", "AND-1", "42"]);
    assert.deepEqual(after[1], ["Chapter 2: Boolean Algebra", "An AND gate outputs 1 only when all inputs are 1.", "42"]);
    const doc = await PDFDocument.load(built.bytes);
    assert.equal(doc.getPageCount(), 2);
  });

  it("drops characters the font cannot draw instead of failing", async () => {
    const original = await deck(1);
    const lines = await pdfLines(original);
    const built = await buildTranslatedPdf({ original, lines, translations: new Map([[1, ["1장 Ch", "게이트 gate", "42"]]]), fonts: [StandardFonts.Helvetica] });
    assert.deepEqual((await texts(built.bytes))[0], ["1 Ch", "gate", "42"]);
  });

  it("leaves a page whose lines no longer match as the original", async () => {
    const original = await deck(1);
    const lines = await pdfLines(original);
    const built = await buildTranslatedPdf({ original, lines, translations: new Map([[1, ["only one"]]]), fonts: [StandardFonts.Helvetica] });
    assert.deepEqual(built.skipped, [{ page: 1, reason: "changed" }]);
    assert.deepEqual((await texts(built.bytes))[0]![0], "Chapter 1: Boolean Algebra");
  });

  it("draws Korean with the macOS font", { skip: !existsSync(SYSTEM_FONTS.korean) }, async () => {
    const original = await deck(1);
    const built = await buildTranslatedPdf({ original, lines: await pdfLines(original), translations: new Map([[1, ["1장: 불 대수", "AND 게이트는 모든 입력이 1일 때만 1을 출력한다.", "42"]]]), fonts: await systemFonts("ko") });
    assert.deepEqual((await texts(built.bytes))[0], ["1장: 불 대수", "AND 게이트는 모든 입력이 1일 때만 1을 출력한다.", "42"]);
  });
});

describe("PdfTranslationService", () => {
  const setup = async (options: { pages?: number; translate?: (lines: string[], signal: AbortSignal) => Promise<(string | undefined)[]> } = {}) => {
    const root = await mkdtemp(join(tmpdir(), "pdf-translate-"));
    const bytes = await deck(options.pages ?? 3);
    let account: string | undefined = "acct_abcdefgh";
    const calls: string[][] = [];
    const service = new PdfTranslationService({
      root, accountKey: () => account, fonts: helvetica, batch: 3,
      original: async () => ({ bytes, sha256: SHA, mediaType: "application/pdf" }),
      translate: async ({ lines, signal }) => { calls.push(lines); return options.translate ? options.translate(lines, signal) : lines.map((l) => `T:${l}`); },
    });
    return { root, service, calls, setAccount: (a: string | undefined) => { account = a; }, done: () => rm(root, { recursive: true, force: true }) };
  };

  it("translates a range, keeps it, and adds a later range without asking again", async () => {
    const t = await setup();
    try {
      assert.deepEqual(await t.service.get(COURSE, ASSET, "ko"), { pages: [], skipped: [] });
      const first = await t.service.make(COURSE, ASSET, "ko", 1, 1);
      assert.deepEqual(first.pages, [1]);
      assert.equal(first.stopped, false);
      // Numbers alone are not sent.
      assert.deepEqual(t.calls, [["Chapter 1: Boolean Algebra", "An AND gate outputs 1 only when all inputs are 1."]]);
      assert.deepEqual((await texts(first.bytes))[0], ["T:Chapter 1: Boolean Algebra", "T:An AND gate outputs 1 only when all inputs are 1.", "42"]);
      const second = await t.service.make(COURSE, ASSET, "ko", 1, 3);
      assert.deepEqual(second.pages, [1, 2, 3]);
      // Only pages 2 and 3 are asked for (4 lines, 3 per request here).
      assert.equal(t.calls.slice(1).flat().length, 4);
      const saved = await t.service.get(COURSE, ASSET, "ko");
      assert.deepEqual(saved.pages, [1, 2, 3]);
      assert.deepEqual((await texts(saved.bytes!))[2]![0], "T:Chapter 3: Boolean Algebra");
      // Another language is its own copy.
      assert.deepEqual((await t.service.get(COURSE, ASSET, "en")).pages, []);
      assert.deepEqual(await readdir(join(t.root, "acct_abcdefgh", COURSE)), [`${SHA}.ko.json`, `${SHA}.ko.pdf`]);
    } finally { await t.done(); }
  });

  it("keeps the finished pages when a later request fails", async () => {
    let n = 0;
    const t = await setup({ pages: 4, translate: async (lines) => { if (++n > 1) throw Object.assign(new Error("x"), { appError: { code: "RUN_INTERRUPTED", message: "끊김", retryable: true } }); return lines.map((l) => `T:${l}`); } });
    try {
      await assert.rejects(t.service.make(COURSE, ASSET, "ko", 1, 4), /x/);
      const saved = await t.service.get(COURSE, ASSET, "ko");
      // The first request (3 lines) finished page 1 and half of page 2.
      assert.deepEqual(saved.pages, [1]);
      assert.ok(saved.bytes);
    } finally { await t.done(); }
  });

  it("stops on request and saves what is done", async () => {
    let service!: PdfTranslationService;
    let n = 0;
    const t = await setup({ pages: 4, translate: async (lines, signal) => {
      if (++n === 2) { service.cancel(); assert.equal(signal.aborted, true); throw new Error("cancelled"); }
      return lines.map((l) => `T:${l}`);
    } });
    service = t.service;
    try {
      const out = await t.service.make(COURSE, ASSET, "ko", 1, 4);
      assert.equal(out.stopped, true);
      assert.deepEqual(out.pages, [1]);
      // The next request carries on from page 2.
      n = 10;
      const rest = await t.service.make(COURSE, ASSET, "ko", 1, 4);
      assert.deepEqual(rest.pages, [1, 2, 3, 4]);
    } finally { await t.done(); }
  });

  it("refuses bad ranges, a second run and a changed account", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let t!: Awaited<ReturnType<typeof setup>>;
    t = await setup({ translate: async (lines) => { await gate; return lines; } });
    try {
      await assert.rejects(t.service.make(COURSE, ASSET, "ko", 4, 5), /쪽 범위/);
      await assert.rejects(t.service.make(COURSE, ASSET, "ko", 0, 1), /쪽 범위/);
      const running = t.service.make(COURSE, ASSET, "ko", 1, 3);
      await assert.rejects(t.service.make(COURSE, ASSET, "ko", 1, 1), /다른 번역본/);
      t.setAccount("acct_zzzzzzzz");
      release();
      await assert.rejects(running, /계정이 바뀌었습니다/);
      assert.deepEqual(await readdir(t.root), []);
      t.setAccount(undefined);
      await assert.rejects(t.service.get(COURSE, ASSET, "ko"), /계정/);
    } finally { await t.done(); }
  });
});

describe("WBS-096 colours", () => {
  it("reads each line's colour and draws the translation in it", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawRectangle({ x: 0, y: 0, width: 400, height: 300, color: rgb(0.1, 0.1, 0.2) });
    page.drawText("Red title", { x: 20, y: 250, size: 18, font, color: rgb(1, 0, 0) });
    page.drawText("White body on dark", { x: 20, y: 200, size: 12, font, color: rgb(1, 1, 1) });
    const original = await doc.save();
    const lines = await pdfLines(original, new Set([1]));
    assert.deepEqual(lines[0]!.map((l) => [l.text, l.color]), [["Red title", [1, 0, 0]], ["White body on dark", [1, 1, 1]]]);
    assert.equal((await pdfLines(original))[0]![0]!.color, undefined, "no colours unless asked");
    const built = await buildTranslatedPdf({ original, lines, translations: new Map([[1, ["RT", "WB"]]]), fonts: [StandardFonts.Helvetica] });
    const after = await pdfLines(built.bytes, new Set([1]));
    assert.deepEqual(after[0]!.map((l) => [l.text, l.color]), [["RT", [1, 0, 0]], ["WB", [1, 1, 1]]]);
  });

  it("follows text matrices, moves, leading and saved states", () => {
    const OPS = { save: 1, restore: 2, transform: 3, setFillRGBColor: 4, beginText: 5, setTextMatrix: 6, moveText: 7, showText: 8, setLeading: 9, nextLine: 10 } as Record<string, number>;
    const starts = textStarts(OPS, [1, 3, 4, 5, 6, 8, 7, 8, 9, 10, 8, 2, 5, 6, 8], [
      null, [1, 0, 0, 1, 100, 0], ["#ff0000"], null, [{ 0: 10, 1: 0, 2: 0, 3: 10, 4: 5, 5: 200 }], null, [0, -2], null, [3], null, null, null, null, [[1, 0, 0, 1, 7, 7]], null,
    ]);
    assert.deepEqual(starts.map((s) => [s.x, s.y, s.color]), [[105, 200, [1, 0, 0]], [105, 180, [1, 0, 0]], [105, 150, [1, 0, 0]], [7, 7, [0, 0, 0]]]);
    assert.deepEqual(colorAt(starts, { x: 106, y: 181, size: 10 }), [1, 0, 0]);
    assert.equal(colorAt(starts, { x: 300, y: 181, size: 10 }), undefined);
  });
});
