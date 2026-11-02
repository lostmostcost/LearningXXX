import { useCallback, useEffect, useRef, useState } from "react";
import type { RunChanges, Session } from "@learningxxx/contracts";
import { CHANGE_LABEL, canGrantFolders, canTrash, displayKey, goneNote, hasRestorable, recordsFor, recoveryNote, restoreSummary } from "./files.ts";
import { invoke, onHostPush } from "./host-api.ts";

/**
 * Folder grants and per-run change history for one session (WBS-035). History
 * comes from the host, so runs cut off by a quit are shown after a restart.
 * Every path is chosen or confirmed in the host; this panel only sends keys.
 */
export function FilesSection({ session, running, onChanged }: { session: Session; running: boolean; onChanged: () => void }) {
  const [loaded, setLoaded] = useState<RunChanges[]>([]);
  const latestLoad = useRef(0);
  const [notice, setNotice] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const { appSessionId } = session;
  const folders = session.externalFolders ?? [];
  const records = recordsFor(loaded, appSessionId);

  const load = useCallback(async () => {
    const generation = (latestLoad.current += 1);
    const result = await invoke("files.sessionChanges", { appSessionId });
    if (generation !== latestLoad.current) return; // A newer request owns the list.
    if (result.ok) setLoaded(result.data.records);
    else setNotice(result.error.message);
  }, [appSessionId]);

  useEffect(() => {
    setNotice(undefined);
    setConfirming(undefined);
    void load();
    return onHostPush((push) => {
      if (push.kind !== "run.event") return;
      const { type } = push.event;
      if (type === "run.completed" || type === "run.failed" || type === "run.cancelled") void load();
    });
  }, [load]);

  const act = async (work: () => ReturnType<typeof invoke>, done?: (data: never) => string) => {
    setNotice(undefined);
    const result = await work();
    if (!result.ok) return setNotice(result.error.message);
    if (done) setNotice(done(result.data as never));
    onChanged();
    await load();
  };

  const busy = running ? "응답이 끝난 뒤 할 수 있습니다" : undefined;
  return (
    <section className="files" aria-label="파일 작업">
      {canGrantFolders(session) ? (
        <div>
          <p className="meta">작업 폴더: 이 세션 전용 폴더{folders.length ? ` 외 ${folders.length}개` : ""}</p>
          {folders.length ? (
            <ul className="entries">
              {folders.map((folder) => (
                <li key={folder}>
                  <span title={folder}>{folder}</span>{" "}
                  <button disabled={running} title={busy} onClick={() => void act(() => invoke("files.removeFolder", { appSessionId, folder }))}>해제</button>
                </li>
              ))}
            </ul>
          ) : null}
          <button disabled={running} title={busy ?? "선택한 폴더는 이 세션에서만 쓰기가 허용됩니다"} onClick={() => void act(() => invoke("files.chooseFolder", { appSessionId }))}>외부 폴더 추가</button>
        </div>
      ) : null}
      {notice ? <p role="status" className="notice-box">{notice}</p> : null}
      {records.length ? (
        <details open={records.length === 1}>
          <summary>변경된 파일 ({records.length}회 실행)</summary>
          {records.map((record, index) => (
            <div key={record.runId} className="run-changes">
              <p className="meta">{new Date(record.recordedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</p>
              <ul className="entries">
                {record.changes.map((change) => (
                  <li key={change.key}>
                    <span className="badge">{CHANGE_LABEL[change.change]}</span> {displayKey(change.key, record.externalFolders)}{" "}
                    {goneNote(change) ? <span className="meta">{goneNote(change)}</span> : null}
                    {canTrash(change) ? (
                      <button disabled={running} title={busy ?? "확인 후 휴지통으로 옮깁니다"} onClick={() => void act(() => invoke("files.trash", { appSessionId, runId: record.runId, key: change.key }), (d: { trashed: boolean }) => (d.trashed ? "휴지통으로 옮겼습니다." : "취소했습니다."))}>휴지통으로</button>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="meta">{index === 0 ? recoveryNote(record) : "가장 최근 실행만 되돌릴 수 있습니다."}</p>
              {index === 0 && hasRestorable(record) ? (
                confirming === record.runId ? (
                  <>
                    <button disabled={running} onClick={() => { setConfirming(undefined); void act(() => invoke("files.restore", { runId: record.runId }), restoreSummary); }}>되돌리기 확인</button>
                    <button onClick={() => setConfirming(undefined)}>취소</button>
                  </>
                ) : (
                  <button disabled={running} title={busy} onClick={() => setConfirming(record.runId)}>이 실행 전으로 되돌리기</button>
                )
              ) : null}
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}
