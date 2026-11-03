import { useCallback, useEffect, useState } from "react";
import { LANGUAGE_NAMES, type IpcResponse, type IpcResult, type PdfTranslationSkip, type PreferredLanguage } from "@learningxxx/contracts";
import { PdfView, type AssetLoader, type PageSnapshot, type PdfOpener } from "./PdfView.tsx";
import type { PageLocation, SelectedText, SelectionIntent } from "./selection.ts";
import { pageList } from "./pdf-navigation.ts";

/** WBS-072: what the viewer needs from the host to show and make a translated copy of a PDF. */
export interface PdfTranslator {
  language: PreferredLanguage;
  get: (assetId: string) => Promise<IpcResult<IpcResponse<"library.pdfTranslation">>>;
  make: (assetId: string, from: number, to: number) => Promise<IpcResult<IpcResponse<"library.translatePdf">>>;
  cancel: () => void;
}

/** Pages per request (the host allows 40). */
const DEFAULT_SPAN = 10;
const MAX_SPAN = 40;

const REASON: Record<PdfTranslationSkip["reason"], string> = {
  scanned: "글자층이 없는 스캔 쪽",
  unsupported: "글자가 그림·양식 안에 있어 바꿀 수 없는 쪽",
  changed: "다시 만들어야 하는 쪽",
};

type Copy = IpcResponse<"library.pdfTranslation">;

export function TranslatablePdf(props: {
  assetId: string; translator?: PdfTranslator | undefined; loadAsset?: AssetLoader | undefined; open?: PdfOpener | undefined;
  onPage?: ((assetId: string, page: number) => void) | undefined;
  onSnapshot?: ((snapshot: PageSnapshot | undefined) => void) | undefined;
  onSelectionAction?: ((selection: SelectedText, intent: SelectionIntent) => void) | undefined;
  location?: PageLocation | undefined;
}) {
  const { assetId, translator, loadAsset, onPage } = props;
  const language = translator?.language;
  const [copy, setCopy] = useState<Copy>();
  const [showCopy, setShowCopy] = useState(false);
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  // Where to stay when switching between the original and the copy.
  const [stay, setStay] = useState<PageLocation>();

  useEffect(() => {
    setCopy(undefined); setShowCopy(false); setNote(undefined); setStay(undefined);
    if (!translator) return;
    let alive = true;
    void translator.get(assetId).then((r) => { if (alive && r.ok) setCopy(r.data); });
    return () => { alive = false; };
  }, [assetId, translator]);

  const shownBytes = showCopy ? copy?.bytes : undefined;
  // A fresh copy each time: pdf.js may take over the buffer it is given.
  const load = useCallback<AssetLoader>(async (id) => (shownBytes ? shownBytes.slice() : loadAsset?.(id)), [shownBytes, loadAsset]);
  // A place the rest of the app asks for (a chat citation) wins over where the toggle left off.
  useEffect(() => setStay(undefined), [props.location]);
  const trackPage = useCallback((id: string, p: number) => { setPage(p); onPage?.(id, p); }, [onPage]);

  const toggle = (next: boolean) => {
    if (next === showCopy) return;
    setStay({ id: crypto.randomUUID(), assetId, page });
    setShowCopy(next);
  };

  const make = async () => {
    if (!translator) return;
    const a = Number(from || page), b = Number(to || page + DEFAULT_SPAN - 1);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a) return setNote("쪽 범위를 확인하세요(예: 3–12).");
    if (b - a + 1 > MAX_SPAN) return setNote(`한 번에 ${MAX_SPAN}쪽까지 만들 수 있습니다.`);
    setBusy(true); setNote(`${a}–${b}쪽을 ${LANGUAGE_NAMES[translator.language]}로 번역하는 중… 쪽 수에 따라 몇 분 걸릴 수 있습니다.`);
    const result = await translator.make(assetId, a, b);
    setBusy(false);
    if (!result.ok) {
      setNote(result.error.message);
      // Pages finished before a failure are kept by the host.
      void translator.get(assetId).then((r) => { if (r.ok) setCopy(r.data); });
      return;
    }
    const { bytes, pages, skipped, untranslated, stopped } = result.data;
    setCopy({ bytes, pages, skipped });
    setStay({ id: crypto.randomUUID(), assetId, page: a });
    setShowCopy(true);
    setNote([
      stopped ? "멈췄습니다. 끝난 쪽까지 저장했습니다." : "번역본을 만들었습니다.",
      untranslated ? `${untranslated}줄은 번역을 받지 못해 원문 그대로입니다(다시 만들면 그 쪽은 건너뜀).` : "",
    ].filter(Boolean).join(" "));
  };

  const skippedNote = (Object.keys(REASON) as PdfTranslationSkip["reason"][])
    .map((reason) => [reason, copy?.skipped.filter((s) => s.reason === reason).map((s) => s.page) ?? []] as const)
    .filter(([, pages]) => pages.length).map(([reason, pages]) => `${pageList(pages)}쪽: ${REASON[reason]}`).join(" · ");
  return <>
    {translator && language ? <div className="pdf-translate" role="group" aria-label="PDF 번역본">
      <span className="segmented">
        <button aria-pressed={!showCopy} onClick={() => toggle(false)}>원본</button>
        <button aria-pressed={showCopy} disabled={!copy?.bytes} title={copy?.bytes ? undefined : "아직 번역본이 없습니다"} onClick={() => toggle(true)}>번역본({LANGUAGE_NAMES[language]})</button>
      </span>
      <label>쪽 <input inputMode="numeric" aria-label="번역 시작 쪽" placeholder={String(page)} value={from} disabled={busy} onChange={(e) => setFrom(e.target.value.replace(/\D/g, ""))} /></label>
      <label>– <input inputMode="numeric" aria-label="번역 끝 쪽" placeholder={String(Number(from || page) + DEFAULT_SPAN - 1)} value={to} disabled={busy} onChange={(e) => setTo(e.target.value.replace(/\D/g, ""))} /></label>
      {busy ? <button onClick={() => translator.cancel()}>멈추기</button> : <button onClick={() => void make()}>번역본 만들기</button>}
      {copy?.pages.length ? <span className="meta">번역된 쪽: {pageList(copy.pages)}</span> : null}
      {note ? <span className="meta" role="status">{note}</span> : null}
      {skippedNote ? <span className="meta">원본 유지 — {skippedNote}</span> : null}
    </div> : null}
    <PdfView key={`${assetId}:${showCopy ? "copy" : "original"}:${showCopy ? copy?.pages.join(",") : ""}`} assetId={assetId} loadAsset={load}
      onSelectionAction={props.onSelectionAction} location={stay ?? props.location} onPage={trackPage} onSnapshot={props.onSnapshot}
      {...(props.open ? { open: props.open } : {})} />
  </>;
}
