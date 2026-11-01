/**
 * Builds small synthetic PDFs for fixture mode and tests, so no real course
 * file is ever bundled (AGENTS.md). Text uses the built-in Helvetica font and
 * must be ASCII.
 */
export interface SyntheticPdfOptions {
  /** One string per page; `null` draws a filled box instead of text (a "scan"). */
  pages: (string | null)[];
  /** Adds a standard security handler whose empty user password does not match. */
  encrypted?: boolean;
}

const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

export function makeSyntheticPdf({ pages, encrypted = false }: SyntheticPdfOptions): Uint8Array {
  const pageIds = pages.map((_, i) => 4 + i * 2);
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [i, text] of pages.entries()) {
    const content =
      text === null
        ? "0.6 0.6 0.6 rg 40 40 515 760 re f"
        : `BT /F1 20 Tf 50 760 Td (${escape(text)}) Tj ET BT /F1 12 Tf 50 730 Td (Synthetic page ${i + 1}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${pageIds[i]! + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  let encryptRef = "";
  if (encrypted) {
    const hex32 = "A5".repeat(32);
    objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${hex32}> /U <${hex32}> /P -4 >>`);
    encryptRef = ` /Encrypt ${objects.length} 0 R /ID [<${"01".repeat(16)}> <${"01".repeat(16)}>]`;
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptRef} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
