import { useCallback, useState } from "react";
import { TranscriptPanel } from "./TranscriptPanel.tsx";
import { MEDIA_COURSE_ID, SAMPLE_MEDIA, SAMPLE_RECOVERED_MEDIA, SAMPLE_VIDEO, SAMPLE_RECORDINGS, SAMPLE_JOBS, SAMPLE_TRANSCRIPT, SAMPLE_CORRECTED } from "./transcript-fixtures.ts";
import type { DownloadViewInput } from "./transcript-model.ts";

/** A generated ten-second tone, never a real lecture. No audio/video is stored in Git. */
export function syntheticAudio(): Blob {
  const buffer = new ArrayBuffer(160044), view = new DataView(buffer);
  const word = (at: number, text: string) => { for (const [i, c] of [...text].entries()) view.setUint8(at + i, c.charCodeAt(0)); };
  word(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); word(8, "WAVE"); word(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); word(36, "data"); view.setUint32(40, 160000, true);
  for (let i = 0; i < 80000; i++) view.setInt16(44 + i * 2, Math.sin(i / 8000 * Math.PI * 660) * 500, true);
  return new Blob([buffer], { type: "audio/wav" });
}

export function TranscriptDemo() {
  const [jobIndex, setJobIndex] = useState(1);
  const [session, setSession] = useState("sample-a");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const loadOriginal = useCallback(async (asset: { id: string }) => asset.id === SAMPLE_MEDIA.id ? syntheticAudio() : undefined, []);
  return <main className="media-demo">
    <header><h1>강의 원본 · 타임스탬프 전사</h1><p>합성 UI 예시 · 실제 녹음/전사/AI 호출이 아닙니다.</p></header>
    <div className="media-demo-options">
      <label>예시 전사 상태 <select aria-label="예시 전사 상태" value={jobIndex} onChange={(e) => setJobIndex(Number(e.target.value))}>{SAMPLE_JOBS.map((j, i) => <option key={j.id} value={i}>{j.status}</option>)}</select></label>
      <label>대상 채팅 <select aria-label="대상 채팅" value={session} onChange={(e) => setSession(e.target.value)}><option value="sample-a">샘플 세션 A</option><option value="sample-b">샘플 세션 B</option><option value="">세션 없음</option></select></label>
    </div>
    <TranscriptPanel courseId={MEDIA_COURSE_ID} assets={[SAMPLE_MEDIA, SAMPLE_RECOVERED_MEDIA, SAMPLE_VIDEO]} recordings={SAMPLE_RECORDINGS}
      jobs={[SAMPLE_JOBS[jobIndex]!]} transcripts={[SAMPLE_TRANSCRIPT, SAMPLE_CORRECTED]} loadOriginal={loadOriginal}
      downloads={[{ id: "sample-download", courseId: MEDIA_COURSE_ID, title: "다음 온라인 강의 예시", status: SAMPLE_JOBS[jobIndex]!.status as DownloadViewInput["status"] }]}
      targetSession={session ? { id: session, title: session === "sample-a" ? "샘플 세션 A" : "샘플 세션 B" } : undefined}
      onRetry={async () => setJobIndex(1)}
      onAttach={async (excerpt, target) => setDrafts((d) => ({ ...d, [target]: [d[target], excerpt.text].filter(Boolean).join("\n\n") }))} />
    <section aria-label="샘플 채팅 초안"><h2>샘플 채팅 초안 · 자동 전송 안 함</h2>{Object.entries(drafts).map(([target, text]) => <div key={target}><h3>{target === "sample-a" ? "샘플 세션 A" : "샘플 세션 B"}</h3><pre>{text}</pre></div>)}</section>
  </main>;
}
