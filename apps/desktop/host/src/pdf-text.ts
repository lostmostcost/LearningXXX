/**
 * Text of each page of a PDF, with pdf.js (the same library the viewer uses).
 * Runs in the host so the AI can read a large or slide-only PDF page by page
 * without extra tools on the Mac (WBS-045: the CLI cannot open files over
 * 20MB at once, and its page reader needs poppler, which is not installed).
 * Images and charts are not text and are not included.
 */
export async function pdfPageTexts(bytes: Uint8Array): Promise<string[]> {
  // Kept outside the bundle: loaded from node_modules when first needed.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: bytes, useSystemFonts: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const content = await (await doc.getPage(n)).getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str + (item.hasEOL ? "\n" : "");
      }
      pages.push(text.replace(/[ \t]+\n/g, "\n").trim());
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** One file per PDF: every page under its own heading, empty pages marked as such. */
export function pageTextFile(name: string, pages: readonly string[]): string {
  const head = `# ${name} — 쪽별 텍스트 (${pages.length}쪽, 그림·도표는 포함되지 않음)\n`;
  return head + pages.map((text, i) => `\n=== ${i + 1}쪽 ===\n${text || "(글자 없음: 그림이나 도표만 있는 쪽일 수 있음)"}\n`).join("");
}
