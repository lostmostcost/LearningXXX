import { useEffect, useRef, useState, type ReactNode } from "react";
import { IMPORTED_ENGINE, MANUAL_ENGINE, type ImportedDocKind, type MediaAsset, type Recording, type Transcript, type TranscriptionJob } from "@learningxxx/contracts";
import { Icon } from "./StudyUI.tsx";
import { excerptFor, jobView, mediaTime, playbackRange, versionsFor, type DownloadViewInput, type TranscriptExcerpt } from "./transcript-model.ts";

export interface TranscriptPanelProps {
  courseId: string;
  view?: "recording" | "transcripts";
  engineReady?: boolean;
  onOpenOriginal?: (assetId: string) => Promise<void>;
  assets: readonly MediaAsset[];
  recordings: readonly Recording[];
  jobs: readonly TranscriptionJob[];
  transcripts: readonly Transcript[];
  downloads?: readonly DownloadViewInput[] | undefined;
  /** Host integration supplies verified bytes in WBS-027; renderer never opens storageKey paths. */
  loadOriginal: (asset: MediaAsset) => Promise<Blob | undefined>;
  targetSession?: { id: string; title: string } | undefined;
  onAttach?: ((excerpt: TranscriptExcerpt, targetSessionId: string) => Promise<void>) | undefined;
  onRetry?: ((jobId: string) => Promise<void>) | undefined;
  /** Transcription is paused on this Mac (all jobs wait until resumed). */
  paused?: boolean | undefined;
  onPause?: (() => Promise<void>) | undefined;
  onResume?: (() => Promise<void>) | undefined;
  onCancel?: ((jobId: string) => Promise<void>) | undefined;
  /**
   * WBS-065: the original chosen under a week of the materials menu (or the
   * recording just saved). There is no course-wide list to pick from here.
   */
  selectedAssetId?: string | undefined;
  /** Where the chosen original sits ("3주차 · 1차시") and, for recordings, a way to move it. */
  place?: ((asset: MediaAsset) => ReactNode) | undefined;
  /** WBS-066: notes copied with an imported original, and how to read one. */
  importedDocs?: Record<string, ImportedDocKind[]> | undefined;
  loadDoc?: ((assetId: string, doc: ImportedDocKind) => Promise<string>) | undefined;
  /** WBS-069: save the user's edits of a version as a new version; resolves with its id. */
  onSaveCorrection?: ((assetId: string, basedOnTranscriptId: string, texts: string[]) => Promise<string>) | undefined;
  /** WBS-069: ask Claude Code for a readable note of a version (kept as the "앱 정리본" document). */
  onMakeReadable?: ((assetId: string, transcriptId: string) => Promise<void>) | undefined;
}

const DOC_LABEL: Record<ImportedDocKind, string> = { readable: "정리본", corrections: "교정 기록", transcript_md: "전사(md)", live: "실시간 메모", srt: "자막(srt)", readable_app: "앱 정리본(Claude)" };

/** WBS-069: how a version is named in the version picker. */
export const versionLabel = (v: Transcript): string =>
  v.engine.name === IMPORTED_ENGINE ? "가져온 전사" : v.engine.name === MANUAL_ENGINE ? "직접 고친 판" : v.kind === "engine" ? "자동 전사 원본" : "요청한 보정본";

/** Read-only notes that came with an imported recording (정리본·교정 기록 …). */
function ImportedDocs({ assetId, docs, load }: { assetId: string; docs: ImportedDocKind[]; load: (assetId: string, doc: ImportedDocKind) => Promise<string> }) {
  const [open, setOpen] = useState<{ doc: ImportedDocKind; text?: string; error?: string }>();
  const show = async (doc: ImportedDocKind) => {
    if (open?.doc === doc) return setOpen(undefined);
    setOpen({ doc });
    try { const text = await load(assetId, doc); setOpen((o) => (o?.doc === doc ? { doc, text } : o)); }
    catch (error) { setOpen((o) => (o?.doc === doc ? { doc, error: error instanceof Error ? error.message : "열지 못했습니다." } : o)); }
  };
  return <div className="imported-docs">
    <span className="meta">문서</span>
    {docs.map((doc) => <button key={doc} aria-pressed={open?.doc === doc} onClick={() => void show(doc)}>{DOC_LABEL[doc]}</button>)}
    {open ? <pre className="imported-doc" aria-label={DOC_LABEL[open.doc]}>{open.error ?? open.text ?? "여는 중…"}</pre> : null}
  </div>;
}

export function TranscriptPanel(props: TranscriptPanelProps) {
  const assets = props.assets.filter((a) => a.courseId === props.courseId && a.role === "original");
  const asset = assets.find((a) => a.id === props.selectedAssetId);
  return <section className="media-library" aria-label="녹음과 전사">
    <div className="media-heading"><h3>{props.view === "transcripts" ? "전사 노트" : "저장한 원본"}</h3>{asset ? <span className="media-title" title={asset.title}>{asset.title}</span> : null}</div>
    {asset && props.place ? <div className="media-place">{props.place(asset)}</div> : null}
    {asset && props.loadDoc && props.importedDocs?.[asset.id]?.length ? <ImportedDocs key={asset.id} assetId={asset.id} docs={props.importedDocs[asset.id]!} load={props.loadDoc} /> : null}
    {asset ? <MediaDetail key={`${props.courseId}:${asset.id}`} {...props} asset={asset} /> : <div className="media-empty"><Icon name={props.view === "transcripts" ? "file" : "mic"} /><p>{assets.length ? "주차 학습에서 녹음이나 강의를 고르세요" : props.view === "transcripts" ? "전사할 원본이 없습니다" : "아직 저장한 녹음이 없습니다"}</p><small>{assets.length ? "녹음과 받은 동영상 강의는 위쪽 주차 메뉴의 각 주차·강의 아래에 있습니다." : "녹음하거나 온라인 강의를 가져오면 주차 학습의 해당 주차 아래에 표시됩니다."}</small></div>}
    {props.recordings.filter(r => r.courseId === props.courseId && !r.originalAssetId && r.status !== "recording").map(r => <p className="notice-box" key={r.id}>{r.title} · {r.status === "failed" ? "녹음을 저장하지 못했습니다" : "원본을 복구하고 있습니다"}</p>)}
  </section>;

}

function MediaDetail(props: TranscriptPanelProps & { asset: MediaAsset }) {
  const { asset } = props;
  const versions = versionsFor(asset, props.transcripts);
  const [versionId, setVersionId] = useState<string | undefined>(versions[0]?.id);
  const version = versions.find((v) => v.id === versionId) ?? versions[0];
  const [url, setUrl] = useState<string>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [mediaReady, setMediaReady] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [selection, setSelection] = useState<{ transcriptId: string; rows: number[] }>();
  const selected = selection?.transcriptId === version?.id ? selection?.rows ?? [] : [];
  const setSelected = (rows: number[]) => setSelection(version ? { transcriptId: version.id, rows } : undefined);
  const [storedPreview, setPreview] = useState<{ excerpt: TranscriptExcerpt; session?: { id: string; title: string } }>();
  const preview = storedPreview?.excerpt.transcriptId === version?.id ? storedPreview : undefined;
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState<string>();
  /** WBS-069: edited texts while correcting this version (undefined when not editing). */
  const [editing, setEditing] = useState<string[]>();
  const [making, setMaking] = useState(false);
  const player = useRef<HTMLMediaElement | null>(null);
  const endAt = useRef<number | undefined>(undefined);

  useEffect(() => {
    // A newly arriving version must not inherit another version's row indices or preview.
    player.current?.pause(); endAt.current = undefined; setSelection(undefined); setPreview(undefined);
    if (versionId === undefined && version) setVersionId(version.id);
  }, [version?.id, versionId]);

  useEffect(() => {
    let alive = true, objectUrl: string | undefined;
    setUrl(undefined); setMediaReady(false); setLoading(true); setNotice(undefined); endAt.current = undefined;
    void props.loadOriginal(asset).then((blob) => {
      if (!alive) return;
      if (!blob) { setNotice("원본을 열 수 없습니다. 원본 저장 상태를 확인한 뒤 다시 열어 보세요."); return; }
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch((error: unknown) => { if (alive) setNotice(error instanceof Error && error.message ? error.message : "원본을 불러오지 못했습니다. 다시 열어 보세요."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [asset.id, asset.sha256, props.loadOriginal, loadAttempt]);

  const saveEdits = async () => {
    if (!version || !editing || !props.onSaveCorrection || busy) return;
    setBusy(true);
    try { const id = await props.onSaveCorrection(asset.id, version.id, editing); setEditing(undefined); setVersionId(id); setNotice("고친 내용을 새 판으로 저장했습니다. 고치기 전 판도 그대로 있습니다."); }
    catch (error) { setNotice(error instanceof Error && error.message ? error.message : "저장하지 못했습니다. 고친 내용은 화면에 남아 있습니다."); }
    finally { setBusy(false); }
  };
  const makeReadable = async () => {
    if (!version || !props.onMakeReadable || making) return;
    setMaking(true); setNotice("Claude Code로 정리본을 만드는 중입니다. 몇 분 걸릴 수 있습니다…");
    try { await props.onMakeReadable(asset.id, version.id); setNotice("정리본을 만들었습니다. 위 \"문서\"의 \"앱 정리본(Claude)\"에서 볼 수 있습니다."); }
    catch (error) { setNotice(error instanceof Error && error.message ? error.message : "정리본을 만들지 못했습니다."); }
    finally { setMaking(false); }
  };
  const changeVersion = (id: string) => { player.current?.pause(); endAt.current = undefined; setVersionId(id); setSelected([]); setPreview(undefined); setNotice(undefined); };
  const play = async (index: number) => {
    const media = player.current, segment = version?.segments[index];
    if (!media || !segment || !mediaReady) return;
    const duration = Number.isFinite(media.duration) ? media.duration * 1000 : asset.durationMs;
    const range = playbackRange(segment, duration);
    if (!range) { setNotice("이 구간은 원본 재생 범위 밖입니다."); return; }
    try { endAt.current = range.endSeconds; media.currentTime = range.startSeconds; await media.play(); setNotice(undefined); }
    catch { endAt.current = undefined; setNotice("재생을 시작하지 못했습니다. 원본 형식과 재생 권한을 확인하세요."); }
  };
  const events = { onLoadedMetadata: () => setMediaReady(true), onTimeUpdate: () => {
    if (player.current && endAt.current !== undefined && player.current.currentTime >= endAt.current) { player.current.pause(); endAt.current = undefined; }
  }, onEnded: () => { endAt.current = undefined; }, onError: () => { setMediaReady(false); setNotice("이 원본을 재생할 수 없습니다. 파일 형식을 확인하거나 다시 열어 보세요."); } };
  const prepare = () => {
    if (!version) return;
    const result = excerptFor(asset, version, selected, props.courseId);
    if (!result.ok) { setNotice(result.reason === "too_large" ? "선택한 전사가 너무 깁니다. 구간을 줄여 주세요." : "원본과 전사 버전, 선택한 구간을 다시 확인하세요."); return; }
    setPreview({ excerpt: result.excerpt, ...(props.targetSession ? { session: { ...props.targetSession } } : {}) });
  };
  const attach = async () => {
    if (!preview?.session || !props.onAttach || busy) return;
    setBusy(true);
    try { await props.onAttach(preview.excerpt, preview.session.id); setPreview(undefined); setSelected([]); setNotice("확인한 전사를 대상 채팅 초안에 넣었습니다. 아직 AI에 보내지 않았습니다."); }
    catch { setNotice("초안에 넣지 못했습니다. 대상 세션 상태를 확인한 뒤 다시 시도하세요."); }
    finally { setBusy(false); }
  };
  const latest = props.jobs.filter(j => j.sourceAssetId === asset.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  return <div className="media-detail">
    <div className="original-toolbar"><span className="meta">{asset.mediaType.startsWith("video/") ? "영상" : "녹음"} · {asset.durationMs !== undefined ? mediaTime(asset.durationMs) : "길이 미확인"}</span><span>{props.onOpenOriginal ? <button className="icon-button" title="시스템 플레이어로 열기" aria-label="시스템 플레이어로 열기" onClick={() => void props.onOpenOriginal?.(asset.id)}><Icon name="folder" /></button> : null}<button className="icon-button" title="원본 다시 열기" aria-label="원본 다시 열기" disabled={loading} onClick={() => setLoadAttempt(n => n + 1)}><Icon name="refresh" /></button></span></div>
    {loading ? <p role="status">원본 여는 중…</p> : null}
    {url ? <>
      {asset.mediaType.startsWith("video/") ? <video ref={(el) => { player.current = el; }} src={url} controls {...events} /> : <audio ref={(el) => { player.current = el; }} src={url} controls {...events} />}

    </> : null}
    {notice ? <p role="status" className="notice-box">{notice}</p> : null}
    <ul className="transcription-jobs" aria-label="전사 작업">{(latest ? [latest] : []).map((job) => {
      const view = jobView(job);
      const act = (work: (() => Promise<void>) | undefined, failed: string) => async () => { try { await work?.(); } catch { setNotice(failed); } };
      return <li key={job.id}>{props.paused && job.status === "queued" ? "일시 정지됨 · 재개하면 처음부터 다시 전사" : view.label}{view.progress !== undefined ? ` · ${Math.round(view.progress * 100)}%` : ""}
        {job.status === "running" && props.onPause ? <button className="icon-button" title="전사 일시 정지" aria-label="전사 일시 정지" onClick={act(props.onPause, "전사를 일시 정지하지 못했습니다.")}><Icon name="pause" /></button> : null}
        {props.paused && job.status === "queued" && props.onResume ? <button className="icon-button" title="전사 재개" aria-label="전사 재개" onClick={act(props.onResume, "전사를 재개하지 못했습니다.")}><Icon name="play" /></button> : null}
        {(job.status === "running" || job.status === "queued") && props.onCancel ? <button className="icon-button" title="이 전사 중지" aria-label="이 전사 중지" onClick={act(() => props.onCancel!(job.id), "전사를 중지하지 못했습니다.")}><Icon name="stop" /></button> : null}
        {job.status === "running" ? <progress aria-label="전사 진행" max={1} value={view.progress} /> : null}
        {job.errorCode ? <small>{job.errorCode === "RUN_INTERRUPTED" ? "앱이 꺼져 중단됐습니다. 재시도를 누르면 처음부터 다시 전사합니다." : job.errorCode === "ENGINE_UNAVAILABLE" ? "위에서 엔진 준비·복구 후 다시 시도하세요." : job.errorCode === "CHECKSUM_MISMATCH" ? "원본이 변경됐거나 없어 확인이 필요합니다." : job.errorCode === "MEDIA_UNREADABLE" ? "원본 오디오를 읽을 수 없습니다." : "처리하지 못했습니다. 원본을 확인한 뒤 다시 시도하세요."}</small> : null}
        {view.retry ? <button className="icon-button" title="전사 재시도" aria-label="전사 재시도" disabled={!props.onRetry || props.engineReady === false || retrying !== undefined} onClick={async () => {
          if (!props.onRetry || retrying !== undefined) return;
          setRetrying(job.id);
          try { await props.onRetry(job.id); } catch { setNotice("전사 재시도를 시작하지 못했습니다. 원본은 보존됩니다."); }
          finally { setRetrying(undefined); }
        }}><Icon name="refresh" /></button> : null}</li>;
    })}</ul>
    {version && props.view !== "recording" ? <>
      <div className="transcript-actions"><strong>전사 내용</strong>
        {props.onSaveCorrection ? (editing
          ? <><button disabled={busy} onClick={() => void saveEdits()}>새 판으로 저장</button><button disabled={busy} onClick={() => setEditing(undefined)}>고치기 취소</button></>
          : <button disabled={busy} onClick={() => { setEditing(version.segments.map((s) => s.text)); setSelected([]); setPreview(undefined); }}>고치기</button>) : null}
        {props.onMakeReadable && !editing ? <button disabled={making} title="Claude Code(구독)로 읽기 쉬운 정리본 만들기" onClick={() => void makeReadable()}>{making ? "정리본 만드는 중…" : "정리본 만들기"}</button> : null}<button className="icon-button" title="이 전사 복사" aria-label="이 전사 복사" onClick={() => void navigator.clipboard.writeText(version.segments.map(s => `[${mediaTime(s.startMs)}] ${s.text}`).join("\n")).then(() => setNotice("전사를 복사했습니다.")).catch(() => setNotice("클립보드 접근을 확인해 주세요."))}><Icon name="copy" /></button></div>
      <label>전사 버전 <select aria-label="전사 버전" value={version.id} disabled={busy || editing !== undefined} onChange={(e) => changeVersion(e.target.value)}>{versions.map((v) => <option key={v.id} value={v.id}>{versionLabel(v)} · {v.engine.version} · {v.createdAt}</option>)}</select></label>

      {editing ? <ol className="segment-list editing">{version.segments.map((segment, index) => <li key={`edit:${version.id}:${index}`}>
        <button disabled={!mediaReady} aria-label={`${mediaTime(segment.startMs)} 구간 재생`} onClick={() => void play(index)}>{mediaTime(segment.startMs)}–{mediaTime(segment.endMs)}</button>
        <textarea aria-label={`${index + 1}번 문장 고치기`} value={editing[index] ?? ""} maxLength={5000} rows={Math.min(6, Math.max(1, Math.ceil((editing[index] ?? "").length / 40)))} onChange={(e) => setEditing((old) => old?.map((t, i) => (i === index ? e.target.value : t)))} />
      </li>)}</ol> :
      <ol className="segment-list">{version.segments.map((segment, index) => <li key={`${version.id}:${index}`}>
        {props.onAttach ? <input type="checkbox" aria-label={`${index + 1}번 전사 선택`} checked={selected.includes(index)} disabled={busy} onChange={(e) => setSelected(e.target.checked ? [...selected, index] : selected.filter((n) => n !== index))} /> : null}
        <button disabled={!mediaReady} aria-label={`${mediaTime(segment.startMs)} 구간 재생`} onClick={() => void play(index)}>{mediaTime(segment.startMs)}–{mediaTime(segment.endMs)}</button><span>{segment.text || "(발화 없음)"}</span>
      </li>)}</ol>}
      {props.onAttach ? <button disabled={!selected.length || busy} onClick={prepare}>선택 전사 미리보기</button> : null}
      {preview ? <div className="notice-box">
        <p>대상: {preview.session?.title ?? "세션을 고른 뒤 다시 미리보기 하세요"}</p><pre>{preview.excerpt.text}</pre>
        <button disabled={!preview.session || !props.onAttach || busy} onClick={() => void attach()}>{busy ? "초안에 넣는 중…" : "이 내용을 채팅 초안에 넣기"}</button>
        <button disabled={busy} onClick={() => setPreview(undefined)}>미리보기 취소</button>
      </div> : null}
    </> : <p className="subtle">{version ? "전사 탭에서 내용을 확인하세요." : latest?.status === "failed" || latest?.status === "cancelled" ? "전사를 완료하지 못했습니다. 원본은 보관됩니다." : "전사 대기 중 · 원본은 안전하게 보관됩니다."}</p>}
  </div>;
}
