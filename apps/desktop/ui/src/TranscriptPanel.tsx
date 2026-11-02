import { useEffect, useRef, useState } from "react";
import type { MediaAsset, Recording, Transcript, TranscriptionJob } from "@learningxxx/contracts";
import { downloadView, excerptFor, jobView, mediaTime, playbackRange, versionsFor, type DownloadViewInput, type TranscriptExcerpt } from "./transcript-model.ts";

export interface TranscriptPanelProps {
  courseId: string;
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
}

export function TranscriptPanel(props: TranscriptPanelProps) {
  const [selectedId, setSelectedId] = useState<string>();
  const assets = props.assets.filter((a) => a.courseId === props.courseId && a.role === "original");
  const asset = assets.find((a) => a.id === selectedId) ?? assets[0];
  const recordingLabel = { recording: "녹음 중 · 종료 후 원본 확정", finalized: "원본 보존됨", recovered_partial: "중단 후 일부 복구됨", failed: "녹음 실패 · 남은 원본 확인 필요" };
  return <section className="media-library" aria-label="녹음과 전사">
    <h2>강의 원본과 전사</h2>
    <ul>{props.recordings.filter((r) => r.courseId === props.courseId).map((r) => <li key={r.id}>{r.title} · {recordingLabel[r.status]}{r.durationMs !== undefined ? ` · ${mediaTime(r.durationMs)}` : ""}{r.errorCode ? ` · ${r.errorCode}` : ""}</li>)}</ul>
    <ul aria-label="영상 다운로드">{props.downloads?.filter((d) => d.courseId === props.courseId).map((d) => {
      const view = downloadView(d);
      return <li key={d.id}>{d.title} · {view.label}{view.progress !== undefined ? ` · ${Math.round(view.progress * 100)}%` : ""}{d.status === "running" ? <progress max={1} value={view.progress} aria-label="영상 다운로드 진행" /> : null}</li>;
    })}</ul>
    <div className="media-columns">
      <nav aria-label="강의 원본"><ul className="entries">{assets.map((a) => <li key={a.id}><button className="entry" aria-pressed={a.id === asset?.id} onClick={() => setSelectedId(a.id)}>{a.mediaType.startsWith("video/") ? "영상" : "녹음"} · {a.title}</button></li>)}</ul></nav>
      {asset ? <MediaDetail key={`${props.courseId}:${asset.id}`} {...props} asset={asset} /> : <p>아직 확정된 강의 원본이 없습니다. 녹음 또는 다운로드가 끝나면 여기에 표시됩니다.</p>}
    </div>
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
    }).catch(() => { if (alive) setNotice("원본을 불러오지 못했습니다. 다시 열어 보세요."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [asset, props.loadOriginal, loadAttempt]);

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
  return <div className="media-detail">
    <h3>{asset.title}</h3>
    <p className="meta">{asset.durationMs !== undefined ? mediaTime(asset.durationMs) : "길이 미확인"} · 원본 메타데이터 · 자동 요약 안 함</p>
    {loading ? <p role="status">원본 여는 중…</p> : null}
    {url ? <>
      {asset.mediaType.startsWith("video/") ? <video ref={(el) => { player.current = el; }} src={url} controls {...events} /> : <audio ref={(el) => { player.current = el; }} src={url} controls {...events} />}
      <a href={url} target="_blank" rel="noreferrer">원본 열기</a>
    </> : null}
    {!loading ? <button onClick={() => setLoadAttempt((n) => n + 1)}>원본 다시 열기</button> : null}
    {notice ? <p role="status" className="notice-box">{notice}</p> : null}
    <ul aria-label="전사 작업">{props.jobs.filter((j) => j.sourceAssetId === asset.id).map((job) => {
      const view = jobView(job);
      return <li key={job.id}>{view.label}{view.progress !== undefined ? ` · ${Math.round(view.progress * 100)}%` : ""}
        {job.status === "running" ? <progress aria-label="전사 진행" max={1} value={view.progress} /> : null}
        {job.errorCode ? ` · ${job.errorCode}` : ""}
        {view.retry ? <button disabled={!props.onRetry || retrying !== undefined} onClick={async () => {
          if (!props.onRetry || retrying !== undefined) return;
          setRetrying(job.id);
          try { await props.onRetry(job.id); } catch { setNotice("전사 재시도를 시작하지 못했습니다. 원본은 보존됩니다."); }
          finally { setRetrying(undefined); }
        }}>전사 재시도</button> : null}</li>;
    })}</ul>
    {version ? <>
      <label>전사 버전 <select aria-label="전사 버전" value={version.id} disabled={busy} onChange={(e) => changeVersion(e.target.value)}>{versions.map((v) => <option key={v.id} value={v.id}>{v.kind === "engine" ? "자동 전사 원본" : "요청한 보정본"} · {v.engine.version} · {v.createdAt}</option>)}</select></label>
      <p className="meta">타임스탬프로 해당 구간을 재생합니다. 채팅에는 직접 선택한 구간만 넣습니다.</p>
      <ol className="segment-list">{version.segments.map((segment, index) => <li key={`${version.id}:${index}`}>
        <input type="checkbox" aria-label={`${index + 1}번 전사 선택`} checked={selected.includes(index)} disabled={busy} onChange={(e) => setSelected(e.target.checked ? [...selected, index] : selected.filter((n) => n !== index))} />
        <button disabled={!mediaReady} aria-label={`${mediaTime(segment.startMs)} 구간 재생`} onClick={() => void play(index)}>{mediaTime(segment.startMs)}–{mediaTime(segment.endMs)}</button><span>{segment.text || "(발화 없음)"}</span>
      </li>)}</ol>
      <button disabled={!selected.length || busy} onClick={prepare}>선택 전사 미리보기</button>
      {preview ? <div className="notice-box">
        <p>대상: {preview.session?.title ?? "세션을 고른 뒤 다시 미리보기 하세요"}</p><pre>{preview.excerpt.text}</pre>
        <button disabled={!preview.session || !props.onAttach || busy} onClick={() => void attach()}>{busy ? "초안에 넣는 중…" : "이 내용을 채팅 초안에 넣기"}</button>
        <button disabled={busy} onClick={() => setPreview(undefined)}>미리보기 취소</button>
      </div> : null}
    </> : <p>아직 전사가 없습니다. 전사가 실패해도 원본은 남습니다.</p>}
  </div>;
}
