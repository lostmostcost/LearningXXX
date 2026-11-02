import { useEffect, useRef, useState, type CSSProperties } from "react";
import { TextLayer, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import { PDF_MESSAGES, type PdfState } from "./document.ts";
import type { OpenedPdf } from "./pdf.ts";
import { selectedText, type PageLocation, type SelectedText, type SelectionIntent } from "./selection.ts";

export type AssetLoader = (assetId: string) => Promise<Uint8Array | undefined>;
export type PdfOpener = (bytes: Uint8Array) => Promise<OpenedPdf>;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

export function PdfView({ assetId, loadAsset, open, onSelectionAction, location, onPage }: {
  assetId: string; loadAsset?: AssetLoader; open?: PdfOpener;
  /** Told the page shown, so a chat message can say where the user is looking. */
  onPage?: ((assetId: string, page: number) => void) | undefined;
  onSelectionAction?: ((selection: SelectedText, intent: SelectionIntent) => void) | undefined;
  location?: PageLocation | undefined;
}) {
  const [state, setState] = useState<PdfState>({ kind: "loading" });
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [zoomIndex, setZoomIndex] = useState(2);
  const [selection, setSelection] = useState<SelectedText>();
  const [rendering, setRendering] = useState(false);
  const [pageError, setPageError] = useState<string>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    let opened: OpenedPdf | undefined;
    setState({ kind: "loading" });
    setPage(1);
    setSelection(undefined);
    void (async () => {
      const bytes = loadAsset ? await loadAsset(assetId) : undefined;
      if (!alive) return;
      if (!bytes || !open) return setState({ kind: "unavailable" });
      opened = await open(bytes);
      if (!alive) return void opened.close();
      setDoc(opened.doc);
      setState(opened.state);
    })().catch(() => alive && setState({ kind: "broken" }));
    return () => { alive = false; setDoc(undefined); void opened?.close(); };
  }, [assetId, loadAsset, open]);

  useEffect(() => {
    if (location?.assetId === assetId && state.kind === "ready") {
      setPage(Math.max(1, Math.min(location.page, state.pageCount)));
    }
  }, [location, assetId, state]);

  useEffect(() => {
    const target = canvas.current, layer = textLayer.current, wrapper = sheet.current;
    if (!doc || !target || !layer || !wrapper) return;
    let task: RenderTask | undefined, textTask: TextLayer | undefined;
    let cancelled = false;
    setSelection(undefined);
    setPageError(undefined);
    setRendering(true);
    layer.replaceChildren();
    void (async () => {
      const pdfPage = await doc.getPage(page);
      if (cancelled) return;
      const zoom = ZOOMS[zoomIndex] ?? 1, ratio = window.devicePixelRatio || 1;
      const viewport = pdfPage.getViewport({ scale: zoom });
      const pixels = pdfPage.getViewport({ scale: zoom * ratio });
      wrapper.style.setProperty("--total-scale-factor", String(zoom * pdfPage.userUnit));
      target.width = Math.floor(pixels.width);
      target.height = Math.floor(pixels.height);
      target.style.width = `${viewport.width}px`;
      target.style.height = `${viewport.height}px`;
      wrapper.style.width = `${viewport.width}px`;
      wrapper.style.height = `${viewport.height}px`;
      task = pdfPage.render({ canvas: target, viewport: pixels });
      const renderText = pdfPage.getTextContent().then(async (content) => {
        if (cancelled) return;
        textTask = new TextLayer({ textContentSource: content, container: layer, viewport });
        await textTask.render();
      });
      await Promise.all([task.promise, renderText]);
      if (!cancelled) setRendering(false);
    })().catch(() => {
      if (!cancelled) { layer.replaceChildren(); setRendering(false); setPageError("이 쪽을 표시하지 못했습니다. 쪽 이동이나 확대/축소 후 다시 확인하세요."); }
    });
    return () => { cancelled = true; task?.cancel(); textTask?.cancel(); };
  }, [doc, page, zoomIndex]);

  useEffect(() => {
    if (state.kind === "ready") onPage?.(assetId, page);
  }, [assetId, page, state.kind, onPage]);

  useEffect(() => {
    const update = () => {
      const layer = textLayer.current;
      setSelection(!rendering && layer ? selectedText(window.getSelection(), layer, assetId, page) : undefined);
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [assetId, page, rendering]);

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
      <div className="selection-actions" role="toolbar" aria-label="선택 텍스트 도구">
        {([ ["translate_en_ko", "영어 → 한국어"], ["translate_ko_en", "한국어 → 영어"], ["explain_simply", "쉽게 설명"] ] as const).map(([intent, label]) => (
          <button key={intent} disabled={!selection || !onSelectionAction || rendering} onMouseDown={(e) => e.preventDefault()}
            onClick={() => selection && onSelectionAction?.({ ...selection }, intent)}>{label}</button>
        ))}
        <span className="meta">문장을 선택한 뒤 누르세요. 채팅에서 확인 후 보냅니다. 최대 20,000자</span>
      </div>
      {rendering ? <p role="status">{page}쪽을 표시하는 중…</p> : null}
      {pageError ? <p role="alert" className="notice-box">{pageError}</p> : null}
      <div className="pdf-page">
        <div ref={sheet} className="pdf-sheet" style={{ "--total-scale-factor": zoom, "--scale-factor": zoom } as CSSProperties}>
          <canvas ref={canvas} aria-label={`${page}쪽`} />
          <div ref={textLayer} className="textLayer" aria-label={`${page}쪽 텍스트`} />
        </div>
      </div>
    </div>
  );
}
