import { useCallback, useEffect, useState } from "react";
import type { IpcResponse, MediaAsset } from "@learningxxx/contracts";
import { invoke } from "./host-api.ts";
import { TranscriptPanel } from "./TranscriptPanel.tsx";

export function MediaLibrary({ courseId }: { courseId: string }) {
  const [data, setData] = useState<IpcResponse<"media.list">>();
  const [videos, setVideos] = useState<IpcResponse<"media.videos">["videos"]>([]);
  const [notice, setNotice] = useState<string>();
  const [selected, setSelected] = useState("");
  const refresh = useCallback(async () => {
    const result = await invoke("media.list", { courseId });
    if (result.ok) setData(result.data); else setNotice(result.error.message);
  }, [courseId]);
  useEffect(() => {
    let alive = true, inFlight = false;
    setData(undefined); setVideos([]); setSelected(""); setNotice(undefined);
    const reload = async () => {
      if (inFlight) return; inFlight = true;
      try { const result = await invoke("media.list", { courseId }); if (alive) { if (result.ok) setData(result.data); else setNotice(result.error.message); } }
      finally { inFlight = false; }
    };
    void reload(); const timer = setInterval(() => void reload(), 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [courseId]);
  const loadOriginal = useCallback(async (asset: MediaAsset) => {
    const result = await invoke("media.original", { courseId, assetId: asset.id });
    if (!result.ok) { setNotice(result.error.message); return undefined; }
    return new Blob([Uint8Array.from(result.data.bytes)], { type: result.data.mediaType });
  }, [courseId]);
  return <section aria-label="실제 원본과 자동 전사">
    <p>녹음·다운로드가 끝나면 이 Mac에서 자동 전사합니다. 요약은 자동 실행하지 않습니다.</p>
    <button onClick={() => void invoke("media.videos", { courseId }).then((r) => { if (r.ok) { setVideos(r.data.videos); setNotice(r.data.videos.length ? undefined : "현재 접근 가능한 온라인 영상이 없습니다."); } else setNotice(r.error.message); })}>온라인 강의 확인</button>
    {videos.length ? <><select aria-label="다운로드할 온라인 강의" value={selected} onChange={(e) => setSelected(e.target.value)}><option value="">강의 선택</option>{videos.map((v) => <option key={v.sourceId} value={v.sourceId}>{v.title}</option>)}</select><button disabled={!selected} onClick={() => void invoke("media.download", { courseId, sourceId: selected }).then((r) => { if (!r.ok) setNotice(r.error.message); void refresh(); })}>원본 다운로드</button></> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {data ? <>
      <TranscriptPanel courseId={courseId} assets={data.assets} recordings={data.recordings} jobs={data.jobs} transcripts={data.transcripts} downloads={data.downloads.map((d) => ({ id: d.id, courseId: d.courseId, title: d.title, status: d.status, ...(d.receivedBytes !== undefined ? { receivedBytes: d.receivedBytes } : {}), ...(d.totalBytes !== undefined ? { totalBytes: d.totalBytes } : {}) }))} loadOriginal={loadOriginal} onRetry={async (jobId) => { const result = await invoke("media.retry", { courseId, jobId }); if (!result.ok) setNotice(result.error.message); await refresh(); }} />
      <ul>{data.assets.map((asset) => <li key={asset.id}><button onClick={() => void invoke("media.open", { courseId, assetId: asset.id }).then((r) => { if (!r.ok) setNotice(r.error.message); })}>{asset.title} · 시스템 플레이어로 열기</button></li>)}</ul>
      <ul>{data.downloads.map((d) => <li key={d.id}>{d.title}{d.errorCode ? ` · ${d.errorCode}` : ""}{d.status === "running" || d.status === "queued" ? <button onClick={() => void invoke("media.cancelDownload", { courseId, downloadId: d.id }).then(() => refresh())}>다운로드 취소</button> : d.status === "failed" || d.status === "cancelled" ? <button onClick={() => void invoke("media.videos", { courseId }).then((r) => { if (r.ok) { setVideos(r.data.videos); setNotice("강의를 다시 선택해 다운로드를 재시도하세요."); } else setNotice(r.error.message); })}>강의 목록 다시 확인</button> : null}</li>)}</ul>
      {data.transcripts.map((t) => <button key={`${t.id}:${t.sourceAssetId}`} onClick={() => void navigator.clipboard.writeText(t.segments.map((s) => `[${Math.floor(s.startMs / 1000)}초] ${s.text}`).join("\n")).then(() => setNotice("선택한 버전의 전사를 복사했습니다. 원하는 채팅에 직접 붙여넣으세요.")).catch(() => setNotice("클립보드 접근을 확인하세요."))}>{data.assets.find((a) => a.id === t.sourceAssetId)?.title} · {t.engine.version} · 이 전사 복사</button>)}
    </> : <p>원본·전사 목록을 불러오는 중입니다.</p>}
  </section>;
}
