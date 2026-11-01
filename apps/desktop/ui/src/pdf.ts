import type { getDocument, PDFDocumentProxy } from "pdfjs-dist";
import { hasSelectableText, pdfErrorState, type PdfState } from "./document.ts";

type DocumentInitParameters = Extract<NonNullable<Parameters<typeof getDocument>[0]>, { data?: unknown }>;

/** The part of pdf.js this module uses; the browser build and the Node legacy build both fit. */
export interface PdfLib {
  getDocument(params: DocumentInitParameters): { promise: Promise<PDFDocumentProxy>; destroy(): Promise<void> };
}

export interface OpenedPdf {
  state: PdfState;
  doc?: PDFDocumentProxy;
  /** Releases the worker-side document; safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Opens PDF bytes and decides the viewer state, including whether any page has
 * selectable text. The bytes are copied because pdf.js transfers its input to
 * the worker. pdf.js 6 uses no eval, which the renderer CSP forbids.
 */
export async function openPdf(lib: PdfLib, bytes: Uint8Array, params: Partial<DocumentInitParameters> = {}): Promise<OpenedPdf> {
  const task = lib.getDocument({ ...params, data: bytes.slice() });
  const close = () => task.destroy();
  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (error) {
    await close();
    return { state: pdfErrorState(error), close };
  }
  const texts: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    for (const item of content.items) if ("str" in item) texts.push(item.str);
    if (hasSelectableText(texts)) break;
  }
  return { state: { kind: "ready", pageCount: doc.numPages, hasText: hasSelectableText(texts) }, doc, close };
}
