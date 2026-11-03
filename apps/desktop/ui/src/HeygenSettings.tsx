import { useCallback, useEffect, useRef, useState } from "react";
import type { CredentialStatus, IpcResponse } from "@learningxxx/contracts";
import { invoke } from "./host-api.ts";

type Voice = IpcResponse<"credentials.heygenVoices">["voices"][number];

/**
 * WBS-092: the HeyGen API key and voice for the weekly explanation video
 * (optional). The key is checked against HeyGen and kept in the Keychain like
 * the other sign-in details; only the explanation-video script is ever sent
 * to HeyGen. Making a video uses the student's HeyGen credits.
 */
export function HeygenSettings({ status, onStatus }: { status: CredentialStatus | undefined; onStatus: (next: CredentialStatus) => void }) {
  const [key, setKey] = useState("");
  const [voices, setVoices] = useState<Voice[]>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const player = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const audioEpoch = useRef(0);
  const alive = useRef(false), lock = useRef(false), sequence = useRef(0);
  const stopAudio = useCallback(() => {
    audioEpoch.current++;
    const old = player.current; player.current = null;
    if (old) { old.audio.pause(); old.audio.removeAttribute('src'); old.audio.load(); URL.revokeObjectURL(old.url); }
  }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; stopAudio(); }; }, [stopAudio]);
  const action = async (work: (current: () => boolean) => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); const ticket = ++sequence.current;
    const current = () => alive.current && sequence.current === ticket;
    try { await work(current); }
    catch { if (current()) setMessage('HeyGen 요청을 완료하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const loadVoices = () => action(async current => {
    const r = await invoke('credentials.heygenVoices', {});
    if (!current()) return;
    if (r.ok) { setVoices(r.data.voices); setMessage(`음성 ${r.data.voices.length}개를 읽었습니다(목록 최대 500개).`); } else setMessage(r.error.message);
  });

  useEffect(() => { if (status?.heygen && !voices) void loadVoices(); }, [status?.heygen]);

  const save = () => action(async current => {
    setMessage("HeyGen에 확인 중…"); stopAudio();
    const r = await invoke("credentials.saveHeygenKey", { key });
    if (!current()) return;
    setKey("");
    if (!r.ok) return setMessage(r.error.message);
    onStatus(r.data.status); setVoices(r.data.voices);
    setMessage(`확인했습니다. 쓸 수 있는 음성 ${r.data.voices.length}개 — 아래에서 고르세요(목록 최대 500개).`);
  });
  const choose = (voiceId: string) => action(async current => {
    stopAudio(); const r = await invoke("credentials.setHeygenVoice", { voiceId });
    if (!current()) return;
    if (r.ok) { onStatus(r.data); setMessage("음성을 저장했습니다."); } else setMessage(r.error.message);
  });
  const clear = () => action(async current => {
    stopAudio(); const r = await invoke("credentials.clear", { which: "heygen" });
    if (!current()) return;
    if (r.ok) { onStatus(r.data); setVoices(undefined); setMessage("HeyGen 키와 음성을 지웠습니다."); } else setMessage(r.error.message);
  });
  const listen = (voiceId: string) => action(async current => {
    stopAudio(); const epoch = audioEpoch.current;
    const r = await invoke("credentials.heygenPreview", { voiceId });
    if (!current() || epoch !== audioEpoch.current) return;
    if (!r.ok) return setMessage(r.error.message);
    const url = URL.createObjectURL(new Blob([Uint8Array.from(r.data.bytes)], { type: r.data.mediaType }));
    const audio = new Audio(url); player.current = { audio, url };
    const release = () => { if (player.current?.audio === audio) stopAudio(); };
    audio.onended = release; audio.onerror = release;
    try { await audio.play(); } catch { release(); if (current()) setMessage('미리 듣기를 재생하지 못했습니다. 다시 눌러 주세요.'); }
  });
  const chosen = voices?.find((v) => v.voiceId === status?.heygenVoiceId);

  return <section className="heygen-setting">
    <h3>HeyGen 음성 (주차 설명 영상용, 선택)</h3>
    <p className="meta">{status?.heygen ? `저장됨${chosen ? ` · 음성 ${chosen.name}` : " · 음성을 고르세요"}` : "저장 안 됨"} · HeyGen 웹 → 설정(Settings) → API에서 키를 복사해 붙여 넣습니다. 영상 대본만 HeyGen에 보내며, 만들 때 별도 HeyGen API 크레딧이 쓰입니다.</p>
    <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label>API 키 <input type="password" disabled={busy} autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} required minLength={8} /></label>
      <button type="submit" disabled={busy || !key.trim()}>확인 후 저장</button>
      {status?.heygen ? <button type="button" disabled={busy} onClick={() => void clear()}>지우기</button> : null}
    </form>
    {voices ? <div className="heygen-voices">
      <select disabled={busy} aria-label="설명 영상 음성" value={status?.heygenVoiceId ?? ""} onChange={(e) => void choose(e.target.value)}>
        <option value="" disabled>음성 고르기</option>
        {voices.map((v) => <option key={v.voiceId} value={v.voiceId}>{v.name} · {v.language || "언어 미상"}{v.gender ? ` · ${v.gender === "female" ? "여성" : v.gender === "male" ? "남성" : v.gender}` : ""}</option>)}
      </select>
      {chosen?.preview ? <button type="button" disabled={busy} onClick={() => void listen(chosen.voiceId)}>미리 듣기</button> : null}
    </div> : null}
    {status?.heygen ? <button type="button" disabled={busy} onClick={() => void loadVoices()}>음성 목록 다시 읽기</button> : null}
    <button type="button" onClick={stopAudio}>미리 듣기 중지</button>
    {message ? <p className="meta" role="status">{message}</p> : null}
  </section>;
}
