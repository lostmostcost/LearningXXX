import { useCallback, useEffect, useRef, useState } from "react";
import type { IpcResponse, MediaAsset } from "@learningxxx/contracts";
import { invoke } from "./host-api.ts";
import { Icon } from "./StudyUI.tsx";
import { videoRows, type VideoRow } from "./video-lectures.ts";

type Videos = IpcResponse<"media.videos">["videos"];

/**
 * Online lectures as part of the course's materials (WBS-028 self-test:
 * "동영상 강의는 녹음 탭이 아니라 학습 자료 안에"). Grouped by the LMS week;
 * each one can be downloaded once, then played in the viewer. Their
 * transcripts stay in the 전사 tab. The list asks the LMS only when the
 * section is opened, because that may need a school sign-in.
 */
export function VideoLectures({ courseId, playing, onPlay }: { courseId: string; playing?: string | undefined; onPlay: (asset: MediaAsset) => void }) {
  const [open, setOpen] = useState(false);
  const [videos, setVideos] = useState<Videos>();
  const [media, setMedia] = useState<IpcResponse<"media.list">>();
  const [notice, setNotice] = useState<string>();
  const [loading, setLoading] = useState(false);
  /** Asked once per opening; a failure waits for the refresh button instead of retrying in a loop. */
  const asked = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    asked.current = false;
    setVideos(undefined); setMedia(undefined); setNotice(undefined);
  }, [courseId]);

  const loadVideos = useCallback(async () => {
    const current = generation.current;
    setLoading(true); setNotice(undefined);
    const result = await invoke("media.videos", { courseId });
    if (current !== generation.current) return;
    setLoading(false);
    if (result.ok) setVideos(result.data.videos);
    else setNotice(result.error.message);
  }, [courseId]);

  // While open, follow downloads and transcription without asking the LMS again.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const current = generation.current;
    const refresh = async () => {
      const result = await invoke("media.list", { courseId });
      if (alive && current === generation.current && result.ok) setMedia(result.data);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [open, courseId]);

  useEffect(() => {
    if (!open || asked.current) return;
    asked.current = true;
    void loadVideos();
  }, [open, loadVideos]);

  const act = async (work: () => Promise<{ ok: boolean; error?: { message: string } }>) => {
    const result = await work();
    if (!result.ok) setNotice(result.error?.message ?? "요청을 완료하지 못했습니다.");
    const listed = await invoke("media.list", { courseId });
    if (listed.ok) setMedia(listed.data);
  };

  const rows = videos ? videoRows(videos, media) : [];
  const weeks = [...new Set(rows.map((r) => r.week))];
  const action = (row: VideoRow) => {
    switch (row.state) {
      case "downloaded":
        return <>
          <button className="icon-button" title="재생" aria-label={`${row.title} 재생`} aria-pressed={playing === row.asset!.id} onClick={() => onPlay(row.asset!)}><Icon name="play" /></button>
          <button className="icon-button" title="시스템 플레이어로 열기" aria-label={`${row.title} 시스템 플레이어로 열기`} onClick={() => void act(() => invoke("media.open", { courseId, assetId: row.asset!.id }))}><Icon name="external" /></button>
        </>;
      case "downloading":
        return <button className="icon-button" title="다운로드 취소" aria-label={`${row.title} 다운로드 취소`} onClick={() => void act(() => invoke("media.cancelDownload", { courseId, downloadId: row.downloadId! }))}><Icon name="stop" /></button>;
      default:
        return <button className="icon-button" title={row.state === "failed" ? "다시 받기" : "받기"} aria-label={`${row.title} ${row.state === "failed" ? "다시 받기" : "받기"}`} onClick={() => void act(() => invoke("media.download", { courseId, sourceId: row.sourceId }))}><Icon name="download" /></button>;
    }
  };

  return (
    <details className="video-lectures" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>동영상 강의</summary>
      <div className="video-tools">
        <button className="icon-button" title="강의 목록 새로 고침" aria-label="강의 목록 새로 고침" disabled={loading} onClick={() => void loadVideos()}><Icon name="refresh" /></button>
        {loading ? <span className="meta">학교 서버에서 강의 목록을 확인하는 중…</span> : null}
      </div>
      {notice ? <p role="status" className="notice-box">{notice}</p> : null}
      {videos && videos.length === 0 ? <p className="empty">이 과목에서 받을 수 있는 동영상 강의가 없습니다.</p> : null}
      {weeks.map((week) => (
        <div key={week} className="video-week">
          <p className="meta">{week}</p>
          <ul className="entries">
            {rows.filter((r) => r.week === week).map((row) => (
              <li key={row.sourceId} className={`video-row ${row.state}`}>
                <span className="title">{row.title}</span>
                <span className="meta">{row.status}</span>
                {action(row)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </details>
  );
}

/** The downloaded lecture, played in the viewer from the verified original. */
export function VideoViewer({ courseId, asset }: { courseId: string; asset: MediaAsset }) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true, made: string | undefined;
    setUrl(undefined); setError(undefined);
    void invoke("media.original", { courseId, assetId: asset.id }).then((result) => {
      if (!alive) return;
      if (!result.ok) return setError(result.error.message);
      made = URL.createObjectURL(new Blob([Uint8Array.from(result.data.bytes)], { type: result.data.mediaType }));
      setUrl(made);
    });
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [courseId, asset.id]);
  return (
    <section className="video-viewer" aria-label="동영상 강의">
      <h2>{asset.title}</h2>
      {error ? <p role="alert" className="notice-box">{error}</p> : url ? <video controls src={url} /> : <p role="status">영상을 여는 중…</p>}
      <p className="meta">전사문은 오른쪽 전사 탭에서 볼 수 있습니다.</p>
    </section>
  );
}
