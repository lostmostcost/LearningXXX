import { useEffect, useState } from "react";
import type { ImportItem, IpcResponse } from "@learningxxx/contracts";
import { invoke } from "./host-api.ts";
import { importSummary } from "./imports.ts";

const DOC_LABEL = { readable: "정리본", corrections: "교정 기록", transcript_md: "전사(md)", live: "실시간 메모", srt: "자막(srt)" } as const;

/**
 * WBS-066: copies recordings and lecture audio the user made before (with
 * their transcripts and notes) from their semester folder. The user sees
 * every file and where it will go before anything is copied.
 */
export function ImportPanel({ onDone }: { onDone?: () => void }) {
  const [plan, setPlan] = useState<IpcResponse<"media.importScan">>();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<IpcResponse<"media.importStatus">>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    if (!busy || !plan?.planId) return;
    const timer = setInterval(() => void invoke("media.importStatus", {}).then((r) => { if (r.ok) setProgress(r.data); }), 500);
    return () => clearInterval(timer);
  }, [busy, plan?.planId]);

  const scan = async () => {
    setBusy(true); setNotice(undefined); setProgress(undefined);
    try {
      const result = await invoke("media.importScan", {});
      if (!result.ok) return setNotice(result.error.message);
      if (!result.data.planId) return setNotice(result.data.items.length ? undefined : "폴더를 고르지 않았습니다.");
      setPlan(result.data);
      setChecked(new Set(result.data.items.filter((i) => i.status === "new").map((i) => i.id)));
      if (!result.data.items.length) setNotice("이 폴더에서 가져올 녹음을 찾지 못했습니다. 학기 폴더(과목 → NN주차 → 녹음·강의영상)를 골라 주세요.");
    } finally { setBusy(false); }
  };

  const run = async () => {
    if (!plan?.planId || !checked.size) return;
    setBusy(true); setNotice(undefined);
    try {
      const result = await invoke("media.importRun", { planId: plan.planId, itemIds: [...checked] });
      if (!result.ok) return setNotice(result.error.message);
      const { imported, skipped, failed } = result.data;
      setNotice(`${imported}개를 가져왔습니다.${skipped ? ` ${skipped}개는 건너뛰었습니다.` : ""}${failed.length ? ` ${failed.length}개는 가져오지 못했습니다: ${failed.slice(0, 3).map((f) => f.message).join(" / ")}` : ""} 원래 파일은 그대로입니다.`);
      setPlan(undefined); setChecked(new Set());
      onDone?.();
    } finally { setBusy(false); setProgress(undefined); }
  };

  const toggle = (item: ImportItem) => setChecked((old) => { const next = new Set(old); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; });
  const summary = plan ? importSummary(plan.items) : undefined;

  return (
    <section className="import-panel" aria-label="기존 녹음 가져오기">
      <div className="import-head">
        <strong>기존 녹음·전사 가져오기</strong>
        <button disabled={busy} onClick={() => void scan()}>{plan ? "다른 폴더 고르기" : "학기 폴더 고르기…"}</button>
      </div>
      <p className="subtle">예: 문서/KHU/2026년 2학기. 과목 → NN주차 → 녹음·강의영상의 음성과 전사·정리본만 복사합니다. 다른 파일은 열지 않습니다.</p>
      {notice ? <p role="status" className="notice-box">{notice}</p> : null}
      {busy && progress?.running ? <p role="status">가져오는 중 {progress.done}/{progress.total}… <progress max={progress.total} value={progress.done} /></p> : null}
      {plan && summary ? <>
        <p className="meta">{plan.folder} · 새로 {summary.new}개 · 이미 가져옴 {summary.imported}개 · 과목을 못 찾음 {summary.noCourse}개</p>
        {summary.groups.map((group) => (
          <details key={group.key} open={group.items.some((i) => i.status === "new")}>
            <summary>{group.title} <span className="meta">{group.items.length}개</span></summary>
            <ul className="import-items">
              {group.items.map((item) => (
                <li key={item.id} className={item.status}>
                  <label>
                    <input type="checkbox" disabled={item.status !== "new" || busy} checked={checked.has(item.id)} onChange={() => toggle(item)} />
                    <span>
                      <strong>{item.title}</strong>
                      <small>
                        {item.kind === "lecture" ? "강의영상" : "녹음"} · {item.weekLabel ?? "주차 미정(나중에 확인)"}
                        {item.kind === "lecture" ? (item.lectureSourceId ? " · 동영상 강의에 연결" : " · 연결할 강의 없음") : ""}
                        {" · "}{item.hasTranscript ? "전사 있음" : "전사 없음(가져온 뒤 전사)"}
                        {item.docs.length ? ` · ${item.docs.map((d) => DOC_LABEL[d]).join(", ")}` : ""}
                        {item.status === "imported" ? " · 이미 가져옴" : item.status === "no_course" ? " · 앱에 이 과목이 없음" : ""}
                      </small>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </details>
        ))}
        <button className="primary" disabled={busy || !checked.size} onClick={() => void run()}>{busy ? "가져오는 중…" : `${checked.size}개 가져오기`}</button>
      </> : null}
    </section>
  );
}
