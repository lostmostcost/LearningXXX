import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PdfSheet } from "./PdfSheet.tsx";
import { clampZoom, pageScale, wheelZoom, type FitMode } from "./pdf-navigation.ts";
import "pdfjs-dist/web/pdf_viewer.css";
import { PDF_MESSAGES, type PdfState } from "./document.ts";
import type { OpenedPdf } from "./pdf.ts";
import { selectedText, type PageLocation, type SelectedText, type SelectionIntent } from "./selection.ts";

export type AssetLoader = (assetId: string) => Promise<Uint8Array | undefined>;
export type PdfOpener = (bytes: Uint8Array) => Promise<OpenedPdf>;


/** Longest side of the page image sent to the AI; enough to read slide text. */
const SNAPSHOT_MAX = 1600;

export type PageSnapshot = () => Promise<Uint8Array<ArrayBuffer> | undefined>;

export function PdfView({ assetId, loadAsset, open, onSelectionAction, location, onPage, onSnapshot }: {
  assetId: string; loadAsset?: AssetLoader; open?: PdfOpener;
  /** Told the page shown, so a chat message can say where the user is looking. */
  onPage?: ((assetId: string, page: number) => void) | undefined;
  /** Given a way to draw the current page as a PNG (and undefined when it goes away). */
  onSnapshot?: ((snapshot: PageSnapshot | undefined) => void) | undefined;
  onSelectionAction?: ((selection: SelectedText, intent: SelectionIntent) => void) | undefined;
  location?: PageLocation | undefined;
}) {
  const [state, setState] = useState<PdfState>({ kind: "loading" });
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [manualZoom, setManualZoom] = useState(1);
  const [fit, setFit] = useState<FitMode>('page');
  const [size, setSize] = useState({ width: 595, height: 842 });
  const [bounds, setBounds] = useState({ width: 600, height: 700 });
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const viewportBox = useRef<HTMLDivElement | null>(null);
  const bindViewport = useCallback((el: HTMLDivElement | null) => { viewportBox.current = el; setViewport(el); }, []);
  const [selection, setSelection] = useState<SelectedText>();
  const anchor = useRef<{ number: string; x: number; y: number; clientX: number; clientY: number } | undefined>(undefined);
  const effectiveZoom = useRef(1);
  effectiveZoom.current = pageScale(size, bounds, fit, manualZoom);
  const goTo = (number: number) => {
    const element = viewportBox.current?.querySelector<HTMLElement>(`[data-page="${number}"]`);
    if (element) { viewportBox.current!.scrollTop += element.getBoundingClientRect().top - viewportBox.current!.getBoundingClientRect().top - 16; setPage(number); }
  };
  useEffect(() => {
    if (!viewport) return;
    const observer = new ResizeObserver(([entry]) => { if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) setBounds({ width: entry.contentRect.width, height: entry.contentRect.height }); });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewport]);
  useEffect(() => {
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const sheets = [...viewport.querySelectorAll<HTMLElement>('[data-page]')];
      const target = sheets.find(el => { const r = el.getBoundingClientRect(); return event.clientY >= r.top && event.clientY <= r.bottom; }) ?? sheets.find(el => el.dataset.page === String(page));
      if (target) { const rect = target.getBoundingClientRect(); anchor.current = { number: target.dataset.page!, x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height, clientX: event.clientX, clientY: event.clientY }; }
      const current = fit === 'manual' ? effectiveZoom.current : Number(target?.dataset.scale ?? effectiveZoom.current);
      const next = wheelZoom(current, event.deltaY, event.deltaMode);
      effectiveZoom.current = next;
      setFit('manual'); setManualZoom(next);
    };
    viewport.addEventListener('wheel', wheel, { passive: false });
    return () => viewport.removeEventListener('wheel', wheel);
  }, [viewport, page, fit]);
  useLayoutEffect(() => {
    const at = anchor.current, box = viewportBox.current;
    if (!at || !box) return;
    const sheet = box.querySelector<HTMLElement>(`[data-page="${at.number}"]`);
    if (sheet) { const rect = sheet.getBoundingClientRect(); box.scrollLeft += rect.left + rect.width * at.x - at.clientX; box.scrollTop += rect.top + rect.height * at.y - at.clientY; }
    anchor.current = undefined;
  }, [manualZoom, fit]);

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
      const first = await opened.doc?.getPage(1);
      if (!alive) return;
      if (first) { const v = first.getViewport({ scale: 1 }); setSize({ width: v.width, height: v.height }); }
      setFit("page"); setManualZoom(1);
      setDoc(opened.doc);
      setState(opened.state);
    })().catch(() => alive && setState({ kind: "broken" }));
    return () => { alive = false; setDoc(undefined); void opened?.close(); };
  }, [assetId, loadAsset, open]);

  useEffect(() => {
    if (location?.assetId === assetId && state.kind === "ready") {
      goTo(Math.max(1, Math.min(location.page, state.pageCount)));
    }
  }, [location, assetId, state]);

  useEffect(() => {
    if (state.kind === "ready") onPage?.(assetId, page);
  }, [assetId, page, state.kind, onPage]);

  useEffect(() => {
    if (!doc || !onSnapshot) return;
    // Drawn fresh at a fixed size, independent of the zoom on screen.
    onSnapshot(async () => {
      const pdfPage = await doc.getPage(page);
      const base = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: SNAPSHOT_MAX / Math.max(base.width, base.height) });
      const target = document.createElement("canvas");
      target.width = Math.floor(viewport.width);
      target.height = Math.floor(viewport.height);
      await pdfPage.render({ canvas: target, viewport }).promise;
      const blob = await new Promise<Blob | null>((resolve) => target.toBlob(resolve, "image/png"));
      return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
    });
    return () => onSnapshot(undefined);
  }, [doc, page, onSnapshot]);

  useEffect(() => {
    const update = () => {
      const current = window.getSelection();
      const layer = current?.anchorNode?.parentElement?.closest<HTMLElement>('.textLayer');
      const sheet = layer?.closest<HTMLElement>('[data-page]');
      setSelection(layer && sheet?.dataset.ready === 'true' && viewportBox.current?.contains(layer) ? selectedText(current, layer, assetId, Number(sheet.dataset.page)) : undefined);
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [assetId, manualZoom, fit]);

  if (state.kind === "loading") return <p role="status">PDF를 여는 중입니다…</p>;
  if (state.kind !== "ready") return <p role="alert" className="notice-box">{PDF_MESSAGES[state.kind]}</p>;
  const zoom = manualZoom;
  return (
    <div className="pdf">
      {state.hasText ? null : <p role="note" className="notice-box">{PDF_MESSAGES.noText}</p>}
      <div className="pdf-toolbar" role="toolbar" aria-label="PDF 보기">
        <button onClick={() => goTo(page - 1)} disabled={page <= 1} aria-label="이전 쪽">‹</button>
        <span aria-live="polite">{page} / {state.pageCount} 쪽</span>
        <button onClick={() => goTo(page + 1)} disabled={page >= state.pageCount} aria-label="다음 쪽">›</button>
        <button onClick={() => {setFit("manual");setManualZoom(clampZoom(effectiveZoom.current/1.2));}} disabled={fit==='manual'&&manualZoom<=.1} aria-label="축소">−</button>
        <button onClick={() => {setFit("manual");setManualZoom(1);}} aria-label="원래 크기">{fit==='manual'?`${Math.round(zoom*100)}%`:'자동'}</button>
        <button onClick={() => {setFit("manual");setManualZoom(clampZoom(effectiveZoom.current*1.2));}} disabled={fit==='manual'&&manualZoom>=4} aria-label="확대">+</button>
      </div>
      <div className="fit-tools"><button aria-pressed={fit==='page'} onClick={()=>setFit("page")}>페이지 맞춤</button><button aria-pressed={fit==='width'} onClick={()=>setFit("width")}>폭 맞춤</button></div>
      <div className="selection-actions" role="toolbar" aria-label="선택 텍스트 도구">
        {([ ["translate_en_ko", "영어 → 한국어"], ["translate_ko_en", "한국어 → 영어"], ["explain_simply", "쉽게 설명"] ] as const).map(([intent, label]) => (
          <button key={intent} disabled={!selection || !onSelectionAction} onMouseDown={(e) => e.preventDefault()}
            onClick={() => selection && onSelectionAction?.({ ...selection }, intent)}>{label}</button>
        ))}
        <span className="meta">문장을 선택한 뒤 누르세요. 채팅에서 확인 후 보냅니다. 최대 20,000자</span>
      </div>
      <div className="pdf-page pdf-continuous" ref={bindViewport} tabIndex={0} aria-label="PDF 연속 스크롤" onScroll={() => {
        const box = viewportBox.current;
        if (!box) return;
        const top = box.getBoundingClientRect().top + box.clientHeight * .35;
        const sheets = [...box.querySelectorAll<HTMLElement>('[data-page]')];
        const current = sheets.find(el => el.getBoundingClientRect().bottom > top) ?? sheets.at(-1);
        if (current) setPage(Number(current.dataset.page));
      }}>
        {doc ? Array.from({ length: state.pageCount }, (_, index) => <PdfSheet key={`${assetId}:${index}`} doc={doc} number={index + 1} root={viewport} bounds={bounds} fit={fit} zoom={manualZoom} initialSize={size} />) : null}
      </div>
    </div>
  );
}
