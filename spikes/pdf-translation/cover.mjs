// WBS-072 spike: synthetic English PDF → text items with positions (pdf.js) → new PDF with the
// same pages, text areas covered and redrawn in Korean with a macOS system font (pdf-lib + fontkit).
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
const pdfjs = await import(process.argv[2]);

// 1. Synthetic source: two pages, a title, body lines, and a box drawn under some text.
const src = await PDFDocument.create();
const helv = await src.embedFont(StandardFonts.Helvetica);
for (let p = 0; p < 2; p++) {
  const page = src.addPage([595, 842]);
  page.drawRectangle({ x: 40, y: 600, width: 300, height: 60, color: rgb(0.85, 0.92, 1) });
  page.drawText(`Chapter ${p + 1}: Boolean Algebra`, { x: 50, y: 780, size: 22, font: helv });
  ["An AND gate outputs 1 only when all inputs are 1.", "An OR gate outputs 1 when any input is 1.", "De Morgan's laws relate AND, OR and NOT."].forEach((t, i) => page.drawText(t, { x: 50, y: 700 - i * 40, size: 12, font: helv }));
}
const srcBytes = await src.save();
writeFileSync("source.pdf", srcBytes);

// 2. Text items with positions.
const doc = await pdfjs.getDocument({ data: new Uint8Array(srcBytes) }).promise;
const pages = [];
for (let n = 1; n <= doc.numPages; n++) {
  const content = await (await doc.getPage(n)).getTextContent();
  pages.push(content.items.filter((i) => i.str.trim()).map((i) => ({ text: i.str, x: i.transform[4], y: i.transform[5], size: Math.hypot(i.transform[2], i.transform[3]), width: i.width })));
}
console.log("items per page", pages.map((p) => p.length), pages[0][0]);

// 3. Translated copy (fake translation stands in for Claude Code).
const KO = { "Chapter 1: Boolean Algebra": "1장: 불 대수", "Chapter 2: Boolean Algebra": "2장: 불 대수", "An AND gate outputs 1 only when all inputs are 1.": "AND 게이트는 모든 입력이 1일 때만 1을 출력한다.", "An OR gate outputs 1 when any input is 1.": "OR 게이트는 입력 중 하나라도 1이면 1을 출력한다.", "De Morgan's laws relate AND, OR and NOT.": "드모르간 법칙은 AND, OR, NOT의 관계를 나타낸다." };
const out = await PDFDocument.load(srcBytes);
out.registerFontkit(fontkit);
const t0 = Date.now();
const font = await out.embedFont(readFileSync(process.argv[3]), { subset: true });
const embedMs = Date.now() - t0;
out.getPages().forEach((page, n) => {
  for (const item of pages[n]) {
    const ko = KO[item.text] ?? item.text;
    // Cover the original glyphs with the background colour under them (white here; the spike notes the limit).
    page.drawRectangle({ x: item.x - 1, y: item.y - item.size * 0.25, width: item.width + 2, height: item.size * 1.2, color: rgb(1, 1, 1) });
    // Shrink to the original width so the layout stays.
    let size = item.size;
    while (size > 5 && font.widthOfTextAtSize(ko, size) > item.width * 1.05) size -= 0.5;
    page.drawText(ko, { x: item.x, y: item.y, size, font });
  }
});
const outBytes = await out.save();
writeFileSync("translated.pdf", outBytes);
// 4. Check: the new PDF's text layer is Korean (searchable/selectable) and page count is the same.
const check = await pdfjs.getDocument({ data: new Uint8Array(outBytes) }).promise;
const firstText = (await (await check.getPage(1)).getTextContent()).items.map((i) => i.str).join(" ");
console.log(JSON.stringify({ pages: check.numPages, embedMs, sourceBytes: srcBytes.length, translatedBytes: outBytes.length, firstPageText: firstText.slice(0, 200) }));
