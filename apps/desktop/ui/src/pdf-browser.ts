import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { OpenedPdf } from "./pdf.ts";
import { openPdf } from "./pdf.ts";

GlobalWorkerOptions.workerSrc = workerUrl;

/** Data files copied into dist/pdfjs by vite.config.ts: CMaps for Korean text, fonts, image decoders. */
const asset = (dir: string) => new URL(`./pdfjs/${dir}/`, document.baseURI).href;

export const openPdfInBrowser = (bytes: Uint8Array): Promise<OpenedPdf> =>
  openPdf({ getDocument }, bytes, {
    cMapUrl: asset("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: asset("standard_fonts"),
    wasmUrl: asset("wasm"),
  });
