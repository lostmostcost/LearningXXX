import { useState } from "react";
import type { CourseLearningStatus, IpcResponse, Week } from "@learningxxx/contracts";
import { invoke } from "./host-api.ts";
import { formatSeoul } from "./library.ts";
import { WeekPicker, type Lecture, type Place } from "./RecordingPlace.tsx";
import { estimateWeek } from "./recording-weeks.ts";
import { clock } from "./recorder.ts";

type Files = IpcResponse<"media.chooseAudio">;
interface Choice { include: boolean; title: string; place: Place }

/** "강의 3주차.m4a" → "강의 3주차". */
const titleOf = (name: string) => name.replace(/\.[^.]+$/, "").trim().slice(0, 200) || "가져온 녹음";

/**
 * WBS-077: recordings made with another app (phone voice memo, recorder)
 * brought into this course. The student picks audio files; each gets a title
 * and the week its date suggests (changeable), then is copied as a recording
 * and transcribed. The files themselves are only read.
 */
export function ImportPanel({ courseId, weeks, lectures, status, onDone }: { courseId: string; weeks: readonly Week[]; lectures: readonly Lecture[]; status: CourseLearningStatus | undefined; onDone?: () => void }) {
  const [plan, setPlan] = useState<Files>();
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  const choose = async () => {
    setBusy(true); setNotice(undefined);
    try {
      const result = await invoke("media.chooseAudio", {});
      if (!result.ok) return setNotice(result.error.message);
      if (!result.data.planId) return;
      setPlan(result.data);
      setChoices(Object.fromEntries(result.data.files.filter((f) => !f.problem).map((f) => {
        const week = estimateWeek(weeks, status, new Date(f.startedAt));
        return [f.id, { include: true, title: titleOf(f.name), place: week ? { weekId: week.id } : {} }];
      })));
    } finally { setBusy(false); }
  };

  const chosen = plan?.files.filter((f) => choices[f.id]?.include) ?? [];
  const missingWeek = weeks.length > 0 && chosen.some((f) => !choices[f.id]!.place.weekId);
  const run = async () => {
    if (!plan?.planId || !chosen.length || missingWeek) return;
    setBusy(true); setNotice(undefined);
    try {
      const result = await invoke("media.importAudio", { planId: plan.planId, courseId, files: chosen.map((f) => {
        const c = choices[f.id]!;
        return { id: f.id, title: c.title.trim() || titleOf(f.name), ...(c.place.weekId ? { weekId: c.place.weekId } : {}), ...(c.place.lectureSourceId ? { lectureSourceId: c.place.lectureSourceId } : {}) };
      }) });
      if (!result.ok) return setNotice(result.error.message);
      const { imported, failed } = result.data;
      setNotice(`${imported}개를 가져왔습니다. 자동으로 전사합니다.${failed.length ? ` ${failed.length}개는 가져오지 못했습니다: ${failed.slice(0, 3).map((x) => x.message).join(" / ")}` : ""}`);
      setPlan(undefined); setChoices({});
      onDone?.();
    } finally { setBusy(false); }
  };
  const set = (id: string, change: Partial<Choice>) => setChoices((old) => ({ ...old, [id]: { ...old[id]!, ...change } }));

  return (
    <section className="import-panel" aria-label="녹음 파일 가져오기">
      <div className="import-head">
        <strong>녹음 파일 가져오기</strong>
        <button disabled={busy} onClick={() => void choose()}>{plan ? "다른 파일 고르기" : "파일 고르기…"}</button>
      </div>
      <p className="subtle">휴대폰 음성 메모나 다른 녹음 앱으로 녹음한 파일(mp3·m4a·wav·aac·flac·ogg·opus 등)을 이 과목 녹음으로 가져와 전사합니다. 원래 파일은 바꾸지 않습니다.</p>
      {notice ? <p role="status" className="notice-box">{notice}</p> : null}
      {plan ? <>
        <ul className="import-items">
          {plan.files.map((f) => {
            const c = choices[f.id];
            return <li key={f.id} className={f.problem ? "no_course" : ""}>
              <label className="import-file">
                <input type="checkbox" disabled={!!f.problem || busy} checked={!!c?.include} onChange={(e) => set(f.id, { include: e.target.checked })} />
                <span><strong>{f.name}</strong><small>{f.problem ?? `${f.durationMs ? clock(f.durationMs) : "길이 미확인"} · ${formatSeoul(f.startedAt)}`}</small></span>
              </label>
              {c && !f.problem ? <div className="import-fields">
                <input aria-label={`${f.name} 제목`} value={c.title} maxLength={200} disabled={busy || !c.include} onChange={(e) => set(f.id, { title: e.target.value })} />
                {weeks.length ? <WeekPicker weeks={weeks} lectures={lectures} value={c.place} disabled={busy || !c.include} label={f.name} onChange={(place) => set(f.id, { place })} /> : null}
              </div> : null}
            </li>;
          })}
        </ul>
        {missingWeek ? <p className="meta">주차를 고르지 않은 파일이 있습니다.</p> : null}
        <button className="primary" disabled={busy || !chosen.length || missingWeek} onClick={() => void run()}>{busy ? "가져오는 중…" : `${chosen.length}개 가져오기`}</button>
      </> : null}
    </section>
  );
}
