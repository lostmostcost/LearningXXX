import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { PDF_MESSAGES, type PdfState } from "./document.ts";
import type { OpenedPdf } from "./pdf.ts";

export type AssetLoader = (assetId: string) => Promise<Uint8Array | undefined>;
export type PdfOpener = (bytes: Uint8Array) => Promise<OpenedPdf>;

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

export function PdfView({ assetId, loadAsset, open }: { assetId: string; loadAsset?: AssetLoader; open?: PdfOpener }) {
  const [state, setState] = useState<PdfState>({ kind: "loading" });
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [zoomIndex, setZoomIndex] = useState(2);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let alive = true;
    let opened: OpenedPdf | undefined;
    setState({ kind: "loading" });
    setPage(1);
    void (async () => {
      const bytes = loadAsset ? await loadAsset(assetId) : undefined;
      if (!alive) return;
      if (!bytes || !open) return setState({ kind: "unavailable" });
      opened = await open(bytes);
      if (!alive) return void opened.close();
      setDoc(opened.doc);
      setState(opened.state);
    })().catch(() => alive && setState({ kind: "broken" }));
    return () => {
      alive = false;
      setDoc(undefined);
      void opened?.close();
    };
  }, [assetId, loadAsset, open]);

  useEffect(() => {
    const target = canvas.current;
    if (!doc || !target) return;
    let task: RenderTask | undefined;
    let cancelled = false;
    void doc
      .getPage(page)
      .then((p) => {
        if (cancelled) return;
        const ratio = window.devicePixelRatio || 1;
        const viewport = p.getViewport({ scale: (ZOOMS[zoomIndex] ?? 1) * ratio });
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        target.style.width = `${Math.floor(viewport.width / ratio)}px`;
        task = p.render({ canvas: target, viewport });
        return task.promise;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, zoomIndex]);

  if (state.kind === "loading") return <p role="status">PDF를 여는 중입니다…</p>;
  if (state.kind !== "ready") return <p role="alert" className="notice-box">{PDF_MESSAGES[state.kind]}</p>;

  const zoom = ZOOMS[zoomIndex] ?? 1;
  return (
    <div className="pdf">
      {state.hasText ? null : <p role="note" className="notice-box">{PDF_MESSAGES.noText}</p>}
      <div className="pdf-toolbar" role="toolbar" aria-label="PDF 보기">
        <button onClick={() => setPage((p) => p - 1)} disabled={page <= 1} aria-label="이전 쪽">‹</button>
        <span aria-live="polite">{page} / {state.pageCount} 쪽</span>
        <button onClick={() => setPage((p) => p + 1)} disabled={page >= state.pageCount} aria-label="다음 쪽">›</button>
        <button onClick={() => setZoomIndex((z) => z - 1)} disabled={zoomIndex <= 0} aria-label="축소">−</button>
        <button onClick={() => setZoomIndex(2)} aria-label="원래 크기">{Math.round(zoom * 100)}%</button>
        <button onClick={() => setZoomIndex((z) => z + 1)} disabled={zoomIndex >= ZOOMS.length - 1} aria-label="확대">+</button>
      </div>
      <div className="pdf-page">
        <canvas ref={canvas} aria-label={`${page}쪽`} />
      </div>
    </div>
  );
}
