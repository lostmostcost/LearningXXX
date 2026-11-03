// Variant B: remove the page's own text objects (BT…ET) from its content stream, then draw the translation.
import { readFileSync, writeFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFArray, PDFRawStream, PDFStream, decodePDFRawStream, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
const pdfjs = await import(process.argv[2]);
const srcBytes = readFileSync("source.pdf");
const doc = await pdfjs.getDocument({ data: new Uint8Array(srcBytes) }).promise;
const pages = [];
for (let n = 1; n <= doc.numPages; n++) {
  const content = await (await doc.getPage(n)).getTextContent();
  pages.push(content.items.filter((i) => i.str.trim()).map((i) => ({ text: i.str, x: i.transform[4], y: i.transform[5], size: Math.hypot(i.transform[2], i.transform[3]), width: i.width })));
}
const out = await PDFDocument.load(srcBytes);
out.registerFontkit(fontkit);
const font = await out.embedFont(readFileSync(process.argv[3]), { subset: true });
let stripped = 0;
for (const page of out.getPages()) {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => out.context.lookup(r)) : [contents];
  for (const ref of (contents instanceof PDFArray ? contents.asArray() : [page.node.get(PDFName.of("Contents"))])) {
    const stream = out.context.lookup(ref);
    const text = new TextDecoder("latin1").decode(stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents());
    // Text objects never nest, and graphics (paths, images) live outside them.
    const kept = text.replace(/(^|[\s\]>)])BT[\s\S]*?\sET(?=[\s\[<(]|$)/g, (m, lead) => { stripped++; return lead; });
    out.context.assign(ref, out.context.flateStream(new TextEncoder().encode(kept)));
  }
}
const KO = { "Chapter 1: Boolean Algebra": "1장: 불 대수", "Chapter 2: Boolean Algebra": "2장: 불 대수", "An AND gate outputs 1 only when all inputs are 1.": "AND 게이트는 모든 입력이 1일 때만 1을 출력한다.", "An OR gate outputs 1 when any input is 1.": "OR 게이트는 입력 중 하나라도 1이면 1을 출력한다.", "De Morgan's laws relate AND, OR and NOT.": "드모르간 법칙은 AND, OR, NOT의 관계를 나타낸다." };
out.getPages().forEach((page, n) => {
  for (const item of pages[n]) {
    const ko = KO[item.text] ?? item.text;
    let size = item.size;
    // Allow 30% wider before shrinking: Korean lines are often shorter, and slightly wider reads better than tiny.
    while (size > item.size * 0.7 && font.widthOfTextAtSize(ko, size) > item.width * 1.3) size -= 0.5;
    page.drawText(ko, { x: item.x, y: item.y, size, font, color: rgb(0, 0, 0) });
  }
});
const outBytes = await out.save();
writeFileSync("translated-b.pdf", outBytes);
const check = await pdfjs.getDocument({ data: new Uint8Array(outBytes) }).promise;
const firstText = (await (await check.getPage(1)).getTextContent()).items.map((i) => i.str).join(" ");
console.log(JSON.stringify({ stripped, pages: check.numPages, bytes: outBytes.length, firstPageText: firstText }));
