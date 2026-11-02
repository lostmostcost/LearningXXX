import { useCallback, useEffect, useState } from "react";
import type { ModifyJob } from "@learningxxx/contracts";
import { invoke, onHostPush } from "./host-api.ts";
import { STATUS_LABEL, actionLabel, actionsFor, canRequest, failureLines, type ModifyAction } from "./modify.ts";

/**
 * Requests a change to the app's own code (REQ-011). It sends words and IDs
 * only: the host picks the folder, asks for confirmation and runs everything.
 */
export function ModifyPanel() {
  const [configured, setConfigured] = useState(false);
  const [job, setJob] = useState<ModifyJob>();
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async () => {
    const result = await invoke("modify.status", {});
    if (!result.ok) return setNotice(result.error.message);
    setConfigured(result.data.sourceConfigured);
    setJob(result.data.job);
  }, []);

  useEffect(() => {
    void load();
    return onHostPush((push) => { if (push.kind === "modify.job") setJob(push.job); });
  }, [load]);

  const chooseSource = async () => {
    const result = await invoke("modify.chooseSource", {});
    if (result.ok) setConfigured(result.data.sourceConfigured);
    else setNotice(result.error.message);
  };

  const start = async () => {
    setNotice(undefined);
    const result = await invoke("modify.start", { requestId: crypto.randomUUID(), prompt });
    if (!result.ok) return setNotice(result.error.message);
    setJob(result.data.job);
    setPrompt("");
  };

  const act = async (action: ModifyAction) => {
    if (!job) return;
    setNotice(undefined);
    const channel = `modify.${action}` as const;
    const result = await invoke(channel, { jobId: job.jobId });
    if (result.ok) setJob(result.data.job);
    else setNotice(result.error.message);
  };

  return (
    <section className="modify" aria-label="앱 수정">
      <h2>앱 수정</h2>
      <p className="meta">요청한 내용만 AI가 별도 복사본에서 고칩니다. 확인하고 적용하기 전에는 현재 앱과 소스가 바뀌지 않습니다.</p>
      {notice ? <p role="status" className="notice-box">{notice}</p> : null}
      {!configured ? (
        <button onClick={() => void chooseSource()}>앱 소스 폴더 선택</button>
      ) : canRequest(job) ? (
        <>
          <textarea aria-label="수정 요청" value={prompt} maxLength={4000} onChange={(e) => setPrompt(e.target.value)} />
          <button disabled={prompt.trim() === ""} onClick={() => void start()}>수정 요청</button>
        </>
      ) : null}
      {job && job.status !== "discarded" ? (
        <div>
          <p role="status"><span className="badge">{STATUS_LABEL[job.status]}</span> {job.message}</p>
          {job.status === "verify_failed" && failureLines(job.verifyLog).length ? (
            <ul className="notice-box">{failureLines(job.verifyLog).map((line) => <li key={line}>{line}</li>)}</ul>
          ) : null}
          {actionsFor(job.status).map((action) => <button key={action} onClick={() => void act(action)}>{actionLabel(action, job.status)}</button>)}
          <p className="meta">요청: {job.prompt}</p>
          {job.explanation ? <p>{job.explanation}</p> : null}
          {job.warnings.length ? <ul className="notice-box">{job.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
          {job.files.length ? (
            <details open>
              <summary>변경된 파일 {job.files.length}개{job.diffTruncated ? " (diff 일부만 표시)" : ""}</summary>
              <ul className="entries">{job.files.map((file) => <li key={file.path}>{file.change === "added" ? "추가" : "수정"} {file.path}</li>)}</ul>
              <pre>{job.diff}</pre>
            </details>
          ) : null}
          {job.verifyLog ? <details><summary>검증 기록</summary><pre>{job.verifyLog}</pre></details> : null}
        </div>
      ) : null}
    </section>
  );
}
