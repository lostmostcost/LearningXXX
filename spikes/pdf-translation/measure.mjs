// Counts only (no text is printed): how much of each PDF's text sits where variant B can reach it.
import { readFileSync } from "node:fs";
import { PDFDocument, PDFArray, PDFName, PDFRawStream, PDFDict, decodePDFRawStream } from "pdf-lib";
const files = process.argv.slice(2);
for (const f of files) {
  try {
    const doc = await PDFDocument.load(readFileSync(f), { ignoreEncryption: true });
    let pageBT = 0, inline = 0, formsWithText = 0, pages = doc.getPageCount();
    const decode = (s) => new TextDecoder("latin1").decode(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents());
    for (const page of doc.getPages().slice(0, 30)) {
      const c = page.node.Contents(); const refs = c instanceof PDFArray ? c.asArray() : [page.node.get(PDFName.of("Contents"))];
      for (const r of refs) { const t = decode(doc.context.lookup(r)); pageBT += (t.match(/\bBT\b/g) || []).length; inline += (t.match(/\bBI\b/g) || []).length; }
      const xo = page.node.Resources()?.lookup(PDFName.of("XObject"));
      if (xo instanceof PDFDict) for (const [, ref] of xo.entries()) { const s = doc.context.lookup(ref); if (s?.dict?.get(PDFName.of("Subtype"))?.toString() === "/Form" && /\bBT\b/.test(decode(s))) formsWithText++; }
    }
    console.log(JSON.stringify({ pages, sampledPages: Math.min(pages, 30), pageTextObjects: pageBT, inlineImages: inline, formXObjectsWithText: formsWithText }));
  } catch (e) { console.log(JSON.stringify({ error: String(e).slice(0, 80) })); }
}
