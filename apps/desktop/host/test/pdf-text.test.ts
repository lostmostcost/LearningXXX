import assert from "node:assert/strict";
import { test } from "node:test";
import { pageTextFile, pdfPageTexts } from "../src/pdf-text.ts";

/** A tiny two-page PDF: text on page 1, only a filled box on page 2. */
function twoPagePdf(): Uint8Array {
  const contents = ["BT /F1 20 Tf 50 760 Td (Week one overview) Tj ET", "0.6 0.6 0.6 rg 40 40 515 760 re f"];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  contents.forEach((content, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test("each page's text is read in the host, and a picture-only page is marked", async () => {
  const pages = await pdfPageTexts(twoPagePdf());
  assert.deepEqual(pages, ["Week one overview", ""]);
  const file = pageTextFile("OT.pdf", pages);
  assert.match(file, /=== 1쪽 ===\nWeek one overview/);
  assert.match(file, /=== 2쪽 ===\n\(글자 없음/);
});

test("a file that is not a PDF is refused, not guessed", async () => {
  await assert.rejects(pdfPageTexts(new TextEncoder().encode("not a pdf")));
});
