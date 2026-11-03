import { extensionOf, viewTarget } from "./document.ts";
import { deadline, externalUrl, formatSeoul, type Entry } from "./library.ts";
import { PdfView, type AssetLoader, type PageSnapshot, type PdfOpener } from "./PdfView.tsx";
import type { PageLocation, SelectedText, SelectionIntent } from "./selection.ts";

/** https links only; the host hands them to the default browser and never navigates the app window. */
const OpenSource = ({ url, label = "원문 열기" }: { url: string | undefined; label?: string }) =>
  url ? (
    <a className="source-link" href={url} target="_blank" rel="noreferrer">
      {label} ↗
    </a>
  ) : null;

export function Viewer(props: { entry: Entry | undefined; loadAsset?: AssetLoader; open?: PdfOpener; now: Date; lms?: React.ReactNode;
  onSelectionAction?: ((selection: SelectedText, intent: SelectionIntent) => void) | undefined; location?: PageLocation | undefined;
  onPage?: ((assetId: string, page: number) => void) | undefined;
  onSnapshot?: ((snapshot: PageSnapshot | undefined) => void) | undefined }) {
  const { entry } = props;
  if (!entry) {
    return (
      <>
        <h2>자료</h2>
        <p>왼쪽에서 자료를 선택하면 여기에서 열립니다.</p>
      </>
    );
  }
  const { resource } = entry;
  const url = externalUrl(resource);
  const target = viewTarget(entry);
  return (
    <>
      <div className="viewer-head">
        <h2>{resource.title}</h2>
        {props.lms ? <span className="viewer-lms">{props.lms}</span> : null}
        <OpenSource url={url} />
      </div>
      <p className="meta">
        {resource.source === "manual" ? "직접 추가한 자료" : "LMS 자료"} · 갱신 {formatSeoul(resource.updatedAt)}
        {resource.revision > 1 ? ` · 변경 ${resource.revision - 1}회` : ""}
      </p>
      {target.kind === "pdf" ? <PdfView key={target.asset.id} assetId={target.asset.id} onSelectionAction={props.onSelectionAction} location={props.location} onPage={props.onPage} onSnapshot={props.onSnapshot} {...(props.loadAsset ? { loadAsset: props.loadAsset } : {})} {...(props.open ? { open: props.open } : {})} /> : null}
      {target.kind === "unsupported" ? (
        <p role="note" className="notice-box">
          {extensionOf(target.asset.originalName)} 형식은 아직 앱에서 열 수 없습니다. 지금은 PDF만 지원합니다.
          {url ? " 원문 열기로 확인하세요." : ""}
        </p>
      ) : null}
      {target.kind === "no_original" ? (
        <p role="note" className="notice-box">이 자료의 원본 파일이 아직 이 Mac에 없습니다. 수집을 다시 실행하거나 원문 열기로 확인하세요.</p>
      ) : null}
      {target.kind === "notice" ? <p>공지 본문은 LMS에서 확인합니다. 원문 열기를 누르면 브라우저에서 열립니다.</p> : null}
      {target.kind === "assignment" && entry.assignment ? <AssignmentDetail entry={entry} now={props.now} /> : null}
    </>
  );
}

function AssignmentDetail({ entry, now }: { entry: Entry; now: Date }) {
  const due = deadline(entry.assignment!, now);
  const submit = entry.assignment!.submissionUrl;
  return (
    <div className="assignment">
      <p className={`due ${due.status}`}>{due.text}</p>
      {due.note ? <p className="meta">{due.note}</p> : null}
      <p>제출은 LMS에서 합니다. 이 앱은 과제를 제출하지 않습니다.</p>
      <OpenSource url={submit?.startsWith("https://") ? submit : undefined} label="제출 페이지 열기" />
    </div>
  );
}
