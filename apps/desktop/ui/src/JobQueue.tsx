import { useEffect, useRef, useState } from "react";
import type { IpcResponse } from "@learningxxx/contracts";
import { invoke } from "./host-api.ts";
import { Icon } from "./StudyUI.tsx";
import { queueStatus } from "./job-queue.ts";

type Queue = IpcResponse<"media.queue">;
const KIND = { transcription: "전사", download: "받기", claude: "Claude Code", import: "가져오기" } as const;

/**
 * WBS-073: everything running or waiting on this Mac — transcriptions in the
 * order they run, downloads, the Claude Code request and an import — with
 * the existing stop and pause actions. The count is checked every few seconds.
 */
export function JobQueue() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [queue, setQueue] = useState<Queue>();
  const [notice, setNotice] = useState<string>();
  const load = async () => { const r = await invoke("media.queue", {}); if (r.ok) setQueue(r.data); };
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), open ? 2000 : 8000);
    return () => clearInterval(timer);
  }, [open]);
  const act = async (work: () => Promise<{ ok: boolean; error?: { message: string } }>) => { const r = await work(); setNotice(r.ok ? undefined : r.error?.message); await load(); };
  const count = queue?.items.length ?? 0;
  return <>
    <button className="queue-button" title="진행 중·대기 중인 작업" aria-label={`작업 ${count}개`} onClick={() => { setOpen(true); dialog.current?.showModal(); }}><Icon name="refresh" />작업{count ? <span className="badge">{count}</span> : null}</button>
    <dialog ref={dialog} className="job-queue" aria-label="작업 목록" onClose={() => setOpen(false)}>
      <div className="job-queue-head"><h2>작업</h2>
        {queue ? <button onClick={() => void act(() => queue.transcriptionPaused ? invoke("media.resumeTranscription", {}) : invoke("media.pauseTranscription", {}))}>{queue.transcriptionPaused ? "전사 재개" : "전사 일시 정지"}</button> : null}
        <button aria-label="닫기" onClick={() => dialog.current?.close()}>×</button></div>
      <p className="meta">전사는 이 Mac에서 한 번에 하나씩, 들어온 순서대로 진행합니다.</p>
      {notice ? <p role="status" className="notice-box">{notice}</p> : null}
      {!queue ? <p>확인하는 중…</p> : !count ? <p className="meta">진행 중이거나 기다리는 작업이 없습니다.</p> : <ol className="job-list">
        {queue.items.map((item) => <li key={`${item.kind}:${item.id}`} className={item.status}>
          <span className="job-kind">{KIND[item.kind]}</span>
          <span className="job-title"><strong>{item.title}</strong>{item.courseTitle ? <small>{item.courseTitle}</small> : null}</span>
          <span className="job-status">{queueStatus(item, queue.transcriptionPaused)}{item.status === "running" && item.progress !== undefined ? <progress max={1} value={item.progress} /> : null}</span>
          {item.kind === "transcription" && item.courseId ? <button title="이 전사 중지" aria-label="이 전사 중지" onClick={() => void act(() => invoke("media.cancelTranscription", { courseId: item.courseId!, jobId: item.id }))}><Icon name="stop" /></button>
            : item.kind === "download" && item.courseId ? <button title="받기 취소" aria-label="받기 취소" onClick={() => void act(() => invoke("media.cancelDownload", { courseId: item.courseId!, downloadId: item.id }))}><Icon name="stop" /></button> : <span />}
        </li>)}
      </ol>}
    </dialog>
  </>;
}
