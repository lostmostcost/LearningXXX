import { Details } from './Details.tsx';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { IpcResponse, MediaAsset, PreferredLanguage, Week } from "@learningxxx/contracts";
import { invoke } from "./host-api.ts";
import { TranscriptPanel } from "./TranscriptPanel.tsx";
import { Icon } from "./StudyUI.tsx";
import { mediaWeekGroups } from './recording-weeks.ts';
import { formatSeoul } from './library.ts';

const NO_WEEKS: readonly Week[] = [];
const NO_LECTURES: readonly { sourceId: string; week: string }[] = [];

export function MediaLibrary({ courseId, view = "recording", selectedAssetId, place, onSelectAsset, weeks = NO_WEEKS, lectures = NO_LECTURES }: { courseId: string; view?: "recording" | "transcripts"; selectedAssetId?: string | undefined; place?: (asset: MediaAsset) => ReactNode; onSelectAsset?: ((id: string | undefined) => void) | undefined; weeks?: readonly Week[]; lectures?: readonly { sourceId: string; week: string }[] }) {
  const [data, setData] = useState<IpcResponse<"media.list">>();
  const [engine, setEngine] = useState<IpcResponse<"stt.status">>();
  const [preparing, setPreparing] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [weekFilter, setWeekFilter] = useState('all');
  const groups = useMemo(() => data ? mediaWeekGroups(courseId, weeks, data, lectures) : [], [courseId, weeks, data, lectures]);
  const selectedGroup = groups.find(group => group.assets.some(asset => asset.id === selectedAssetId));
  // Follow a selected original when it is saved or reassigned, without briefly
  // unmounting its player/transcript. User filter changes clear the selection.
  const filter = weekFilter === 'all' ? 'all' : selectedGroup?.id ?? (groups.some(g => g.id === weekFilter) ? weekFilter : 'all');
  useEffect(() => { if (selectedGroup && weekFilter !== 'all') setWeekFilter(selectedGroup.id); }, [selectedAssetId, selectedGroup?.id, weekFilter]);
  const shownGroups = filter === 'all' ? groups : groups.filter(group => group.id === filter);
  const shownAssets = onSelectAsset ? shownGroups.flatMap(group => group.assets) : data?.assets ?? [];
  const shownRecordings = onSelectAsset ? shownGroups.flatMap(group => group.recordings) : data?.recordings ?? [];
  const shownAssetId = shownAssets.some(asset => asset.id === selectedAssetId) ? selectedAssetId : undefined;
  // WBS-071: the preferred language, read again when it is changed in settings.
  const [language, setLanguage] = useState<PreferredLanguage>();
  useEffect(() => {
    const read = () => void invoke("app.preferences", {}).then((r) => { if (r.ok) setLanguage(r.data.language); });
    read(); window.addEventListener("learningxxx:preferences", read);
    return () => window.removeEventListener("learningxxx:preferences", read);
  }, []);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = generation.current, result = await invoke("media.list", { courseId });
    if (current !== generation.current) return;
    if (result.ok) setData(result.data); else setNotice(result.error.message);
  }, [courseId]);
  useEffect(() => {
    let alive = true, inFlight = false; generation.current++;
    setData(undefined); setNotice(undefined);
    const reload = async () => {
      if (inFlight) return; inFlight = true;
      try {
        const [media, runtime] = await Promise.all([invoke("media.list", { courseId }), invoke("stt.status", {})]);
        if (!alive) return;
        if (media.ok) setData(media.data); else setNotice(media.error.message);
        if (runtime.ok) setEngine(runtime.data); else setNotice(runtime.error.message);
      } catch { if (alive) setNotice("목록을 불러오지 못했습니다. 잠시 후 다시 확인합니다."); }
      finally { inFlight = false; }
    };
    void reload(); const timer = setInterval(() => void reload(), 2000);
    return () => { alive = false; generation.current++; clearInterval(timer); };
  }, [courseId]);
  const action = async (work: () => Promise<void>) => {
    const current = generation.current;
    try { await work(); } catch (error) { if (current === generation.current) setNotice(error instanceof Error ? error.message : "요청을 완료하지 못했습니다."); }
  };
  const loadOriginal = useCallback(async (asset: MediaAsset) => {
    const result = await invoke("media.original", { courseId, assetId: asset.id });
    if (!result.ok) throw new Error(result.error.message);
    return new Blob([Uint8Array.from(result.data.bytes)], { type: result.data.mediaType });
  }, [courseId]);
  const setup = async (cancel = false) => {
    if (preparing) return;
    setPreparing(true); const current = generation.current;
    try { const result = cancel ? await invoke("stt.cancel", {}) : await invoke("stt.prepare", {}); if (current === generation.current) { if (result.ok) setEngine(result.data); else setNotice(result.error.message); } }
    finally { setPreparing(false); }
  };
  const runtimeControl = engine && engine.state !== "unsupported" ? <button className="icon-button" aria-label={engine.state === "installing" ? "엔진 준비 취소" : engine.state === "ready" ? "전사 엔진 복구" : "전사 엔진 준비"} title={engine.state === "installing" ? "엔진 준비 취소" : engine.state === "ready" ? "전사 엔진 복구" : "전사 엔진 준비"} disabled={preparing} onClick={() => void action(() => setup(engine.state === "installing"))}><Icon name={engine.state === "installing" ? "stop" : engine.state === "ready" ? "refresh" : "download"} /></button> : null;
  return <section className="media-workspace" aria-label="원본과 전사">
    {onSelectAsset ? <div className="media-week-browser">
      <label className="media-source-select">주차<select aria-label="녹음·전사 주차" value={filter} onChange={event => { setWeekFilter(event.target.value); onSelectAsset(undefined); }}>
        <option value="all">전체 주차 ({groups.reduce((sum, group) => sum + group.assets.length, 0)})</option>
        {groups.map(group => <option key={group.id} value={group.id}>{group.label} ({group.assets.length})</option>)}
      </select></label>
      <label className="media-source-select">녹음·전사 원본<select aria-label="녹음·전사 원본 선택" value={shownAssetId ?? ''} onChange={event => onSelectAsset(event.target.value || undefined)}>
      <option value="">확인할 원본을 선택하세요</option>
      {shownGroups.filter(group => group.assets.length).map(group => <optgroup key={group.id} label={group.label}>{group.assets.map(asset => {
        const source = asset.source;
        const at = source.type === 'recording' ? group.recordings.find(r => r.id === source.recordingId)?.startedAt ?? asset.createdAt : asset.createdAt;
        return <option key={asset.id} value={asset.id}>{group.label} · {asset.title} · {formatSeoul(at)}{data?.removed?.includes(asset.id) ? ' · 원본 지움' : ''}</option>;
      })}</optgroup>)}
      </select></label>
      {data ? <p className="meta media-week-count" role="status">{filter === 'all' ? '전체 주차' : shownGroups[0]?.label} · {shownAssets.length ? `원본 ${shownAssets.length}개` : '저장한 원본이 없습니다'}</p> : null}
    </div> : null}
    <div className={`engine-card ${engine?.state ?? "checking"}`} role="status">
      <span className="engine-light" /><div><strong>{engine?.state === "ready" ? "로컬 전사 준비 완료" : engine?.state === "installing" ? "전사 엔진 준비 중" : engine?.state === "unsupported" ? "지원하지 않는 Mac" : "전사 엔진 준비 필요"}</strong>{engine?.state !== "ready" ? <small>{engine?.message ?? "이 Mac의 엔진을 확인하고 있습니다…"}</small> : <small>로컬 처리</small>}</div>
      {engine?.state === "ready" ? <Details title="전사 설정">{runtimeControl}</Details> : runtimeControl}
    </div>
    {data?.transcriptionPaused ? <p role="status" className="notice-box">전사가 일시 정지되어 있습니다. <button className="link-button" onClick={() => void action(async () => { const r = await invoke("media.resumeTranscription", {}); if (!r.ok) throw new Error(r.error.message); await refresh(); })}>재개</button></p> : null}
    {notice ? <p role="status" className="notice-box">{notice}</p> : null}
    {data ? <TranscriptPanel courseId={courseId} assets={shownAssets} recordings={shownRecordings} jobs={data.jobs} transcripts={data.transcripts} loadOriginal={loadOriginal} importedDocs={data.importedDocs} removed={data.removed}
      onSaveCorrection={async (assetId, basedOnTranscriptId, texts) => { const r = await invoke("media.saveCorrection", { courseId, assetId, basedOnTranscriptId, texts }); if (!r.ok) throw new Error(r.error.message); await refresh(); return r.data.transcriptId; }}
      language={language}
      waiting={data.waiting}
      loadTranslation={async (assetId, transcriptId, lang) => { const r = await invoke("media.translation", { courseId, assetId, transcriptId, language: lang }); if (!r.ok) throw new Error(r.error.message); return r.data.texts; }}
      onTranslate={async (assetId, transcriptId, lang) => { const r = await invoke("media.translate", { courseId, assetId, transcriptId, language: lang }); if (!r.ok) throw new Error(r.error.message); return r.data; }}
      onFindMentions={async (assetId, transcriptId) => { const r = await invoke("media.findMentions", { courseId, assetId, transcriptId }); if (!r.ok) throw new Error(r.error.message); return r.data.candidates; }}
      onAddMentions={async (assetId, candidates) => { const r = await invoke("media.addMentions", { courseId, assetId, candidates }); if (!r.ok) throw new Error(r.error.message); return r.data.mentions.length; }}
      onMakeReadable={async (assetId, transcriptId) => { const r = await invoke("media.makeReadable", { courseId, assetId, transcriptId }); if (!r.ok) throw new Error(r.error.message); await refresh(); }} loadDoc={async (assetId, doc) => { const r = await invoke("media.importedDoc", { courseId, assetId, doc }); if (!r.ok) throw new Error(r.error.message); return r.data.text; }} view={view} selectedAssetId={shownAssetId} place={place} engineReady={engine?.state === "ready"} onOpenOriginal={assetId => action(async () => { const r = await invoke("media.open", { courseId, assetId }); if (!r.ok) throw new Error(r.error.message); })} onRetry={async jobId => { const result = await invoke("media.retry", { courseId, jobId }); if (!result.ok) throw new Error(result.error.message); await refresh(); }}
      paused={data.transcriptionPaused}
      onPause={async () => { const r = await invoke("media.pauseTranscription", {}); if (!r.ok) throw new Error(r.error.message); await refresh(); }}
      onResume={async () => { const r = await invoke("media.resumeTranscription", {}); if (!r.ok) throw new Error(r.error.message); await refresh(); }}
      onCancel={async jobId => { const r = await invoke("media.cancelTranscription", { courseId, jobId }); if (!r.ok) throw new Error(r.error.message); await refresh(); }} /> : <p className="empty-tool">원본 목록을 불러오는 중…</p>}
  </section>;
}
