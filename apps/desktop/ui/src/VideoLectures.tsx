import { useCallback, useEffect, useRef, useState } from "react";
import type { IpcResponse, MediaAsset } from "@learningxxx/contracts";
import { invoke } from "./host-api.ts";
import { Icon } from "./StudyUI.tsx";
import { videoRows, type VideoRow } from "./video-lectures.ts";

type Videos = IpcResponse<"media.videos">["videos"];

/**
 * Online lectures for the materials menu (WBS-028 self-test: "동영상 강의는
 * 녹음 탭이 아니라 학습 자료 안에", shown under each week like the PDFs).
 * The LMS is asked once per course, only when `active` first becomes true,
 * because it may need a school sign-in; a failure waits for `reload`. While
 * active, downloads and transcription are followed from this Mac only.
 */
export function useVideoLectures(courseId: string | undefined, active: boolean) {
  const [videos, setVideos] = useState<Videos>();
  const [media, setMedia] = useState<IpcResponse<"media.list">>();
  const [notice, setNotice] = useState<string>();
  const [loading, setLoading] = useState(false);
  const asked = useRef<string | undefined>(undefined);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    asked.current = undefined;
    setVideos(undefined); setMedia(undefined); setNotice(undefined); setLoading(false);
  }, [courseId]);

  const reload = useCallback(async () => {
    if (!courseId) return;
    const current = generation.current;
    setLoading(true); setNotice(undefined);
    const result = await invoke("media.videos", { courseId });
    if (current !== generation.current) return;
    setLoading(false);
    if (result.ok) setVideos(result.data.videos);
    else setNotice(result.error.message);
  }, [courseId]);

  const refresh = useCallback(async () => {
    if (!courseId) return;
    const current = generation.current;
    const result = await invoke("media.list", { courseId });
    if (current === generation.current && result.ok) setMedia(result.data);
  }, [courseId]);

  useEffect(() => {
    if (!active || !courseId || asked.current === courseId) return;
    asked.current = courseId;
    void reload();
  }, [active, courseId, reload]);

  useEffect(() => {
    if (!active || !courseId) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [active, courseId, refresh]);

  const run = async (work: Promise<{ ok: boolean; error?: { message: string } }>) => {
    const result = await work;
    if (!result.ok) setNotice(result.error?.message ?? "요청을 완료하지 못했습니다.");
    await refresh();
  };
  return {
    rows: videos ? videoRows(videos, media) : [],
    loaded: videos !== undefined,
    loading,
    notice,
    reload,
    download: (sourceId: string) => courseId && run(invoke("media.download", { courseId, sourceId })),
    cancel: (downloadId: string) => courseId && run(invoke("media.cancelDownload", { courseId, downloadId })),
  };
}

/** One lecture in the week menu: play it when downloaded, otherwise download it. */
export function VideoFile({ row, playing, onPlay, onDownload, lms }: { row: VideoRow; playing: boolean; onPlay: (asset: MediaAsset) => void; onDownload: (sourceId: string) => void; /** LMS attendance badges (WBS-055). */ lms?: React.ReactNode }) {
  const label = row.state === "downloaded" ? "재생" : row.state === "downloading" ? "받는 중" : row.state === "failed" ? "다시 받기" : "받기";
  return (
    <button className={`video-file ${row.state}`} aria-pressed={playing} disabled={row.state === "downloading"} title={`${row.title} · ${row.status}`} aria-label={`동영상 강의 ${row.title}, ${row.status}, ${label}`}
      onClick={() => (row.asset ? onPlay(row.asset) : onDownload(row.sourceId))}>
      <Icon name={row.state === "downloaded" ? "play" : row.state === "downloading" ? "video" : "download"} />
      <span><span className="video-title">{row.title}</span><small>{row.status}{lms}</small></span>
    </button>
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
