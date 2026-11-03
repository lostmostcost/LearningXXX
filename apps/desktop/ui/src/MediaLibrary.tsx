import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { IpcResponse, MediaAsset } from "@learningxxx/contracts";
import { invoke } from "./host-api.ts";
import { TranscriptPanel } from "./TranscriptPanel.tsx";
import { Icon } from "./StudyUI.tsx";

export function MediaLibrary({ courseId, view = "recording", selectedAssetId, place }: { courseId: string; view?: "recording" | "transcripts"; selectedAssetId?: string | undefined; place?: (asset: MediaAsset) => ReactNode }) {
  const [data, setData] = useState<IpcResponse<"media.list">>();
  const [engine, setEngine] = useState<IpcResponse<"stt.status">>();
  const [preparing, setPreparing] = useState(false);
  const [notice, setNotice] = useState<string>();
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
  return <section className="media-workspace" aria-label="원본과 전사">
    <div className={`engine-card ${engine?.state ?? "checking"}`} role="status">
      <span className="engine-light" /><div><strong>{engine?.state === "ready" ? "로컬 전사 준비 완료" : engine?.state === "installing" ? "전사 엔진 준비 중" : engine?.state === "unsupported" ? "지원하지 않는 Mac" : "전사 엔진 준비 필요"}</strong>{engine?.state !== "ready" ? <small>{engine?.message ?? "이 Mac의 엔진을 확인하고 있습니다…"}</small> : <small>오디오는 이 Mac에서 처리합니다</small>}</div>
      {engine && engine.state !== "unsupported" ? <button className="icon-button" aria-label={engine.state === "installing" ? "엔진 준비 취소" : engine.state === "ready" ? "전사 엔진 복구" : "전사 엔진 준비"} title={engine.state === "installing" ? "엔진 준비 취소" : engine.state === "ready" ? "전사 엔진 복구" : "전사 엔진 준비"} disabled={preparing} onClick={() => void action(() => setup(engine.state === "installing"))}><Icon name={engine.state === "installing" ? "stop" : engine.state === "ready" ? "refresh" : "download"} /></button> : null}
    </div>
    {data?.transcriptionPaused ? <p role="status" className="notice-box">전사가 일시 정지되어 있습니다. <button className="link-button" onClick={() => void action(async () => { const r = await invoke("media.resumeTranscription", {}); if (!r.ok) throw new Error(r.error.message); await refresh(); })}>재개</button></p> : null}
    {notice ? <p role="status" className="notice-box">{notice}</p> : null}
    {data ? <TranscriptPanel courseId={courseId} assets={data.assets} recordings={data.recordings} jobs={data.jobs} transcripts={data.transcripts} loadOriginal={loadOriginal} importedDocs={data.importedDocs} loadDoc={async (assetId, doc) => { const r = await invoke("media.importedDoc", { courseId, assetId, doc }); if (!r.ok) throw new Error(r.error.message); return r.data.text; }} view={view} selectedAssetId={selectedAssetId} place={place} engineReady={engine?.state === "ready"} onOpenOriginal={assetId => action(async () => { const r = await invoke("media.open", { courseId, assetId }); if (!r.ok) throw new Error(r.error.message); })} onRetry={async jobId => { const result = await invoke("media.retry", { courseId, jobId }); if (!result.ok) throw new Error(result.error.message); await refresh(); }}
      paused={data.transcriptionPaused}
      onPause={async () => { const r = await invoke("media.pauseTranscription", {}); if (!r.ok) throw new Error(r.error.message); await refresh(); }}
      onResume={async () => { const r = await invoke("media.resumeTranscription", {}); if (!r.ok) throw new Error(r.error.message); await refresh(); }}
      onCancel={async jobId => { const r = await invoke("media.cancelTranscription", { courseId, jobId }); if (!r.ok) throw new Error(r.error.message); await refresh(); }} /> : <p className="empty-tool">원본 목록을 불러오는 중…</p>}
  </section>;
}
