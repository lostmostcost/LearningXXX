import { useEffect, useRef, useState } from 'react';
import { TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import { pageScale, type FitMode } from './pdf-navigation.ts';

/** Keep page geometry while only rasterizing pages near the scrolling viewport. */
export function PdfSheet({ doc, number, root, bounds, fit, zoom, initialSize }: {
  doc: PDFDocumentProxy; number: number; root: HTMLDivElement | null;
  bounds: { width: number; height: number }; fit: FitMode; zoom: number;
  initialSize: { width: number; height: number };
}) {
  const [size, setSize] = useState(initialSize);
  const [near, setNear] = useState(number === 1);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const wrapper = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const scale = pageScale(size, bounds, fit, zoom);
  useEffect(() => {
    let alive = true;
    void doc.getPage(number).then(p => { if (alive) { const v = p.getViewport({ scale: 1 }); setSize({ width: v.width, height: v.height }); } }).catch(() => { if (alive) setStatus('error'); });
    return () => { alive = false; };
  }, [doc, number]);
  useEffect(() => {
    const element = wrapper.current;
    if (!element || !root) return;
    const observer = new IntersectionObserver(([entry]) => setNear(!!entry?.isIntersecting), { root, rootMargin: '600px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    const target = canvas.current, text = layer.current, sheet = wrapper.current;
    if (!target || !text || !sheet) return;
    let cancelled = false, render: RenderTask | undefined, textTask: TextLayer | undefined;
    text.replaceChildren();
    setStatus('loading');
    if (!near) { target.width = 0; target.height = 0; return; }
    void (async () => {
      const page = await doc.getPage(number);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
      const pixels = page.getViewport({ scale: scale * ratio });
      target.width = Math.max(1, Math.floor(pixels.width));
      target.height = Math.max(1, Math.floor(pixels.height));
      sheet.style.setProperty('--total-scale-factor', String(scale * page.userUnit));
      render = page.render({ canvas: target, viewport: pixels });
      const renderText = page.getTextContent().then(async content => {
        if (cancelled) return;
        textTask = new TextLayer({ textContentSource: content, container: text, viewport });
        await textTask.render();
      });
      await Promise.all([render.promise, renderText]);
      if (!cancelled) setStatus('ready');
    })().catch(() => { if (!cancelled) { text.replaceChildren(); setStatus('error'); } });
    return () => { cancelled = true; render?.cancel(); textTask?.cancel(); };
  }, [doc, number, near, scale]);
  return <div ref={wrapper} className="pdf-sheet" data-page={number} data-scale={scale} data-ready={status === 'ready'} style={{ width: size.width * scale, height: size.height * scale }}>
    <canvas ref={canvas} aria-label={`${number}쪽`} style={{ width: '100%', height: '100%' }} />
    <div ref={layer} className="textLayer" aria-label={`${number}쪽 텍스트`} />
    {near && status === 'error' ? <p role="alert" className="page-message">{number}쪽을 표시하지 못했습니다. 확대·축소하거나 다시 열어주세요.</p> : null}
    {near && status === 'loading' ? <span className="page-message" role="status">{number}쪽을 표시하는 중…</span> : null}
  </div>;
}
