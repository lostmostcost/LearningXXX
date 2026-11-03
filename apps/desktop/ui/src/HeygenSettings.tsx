import { useEffect, useRef, useState } from "react";
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
  const player = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!status?.heygen || voices) return;
    void invoke("credentials.heygenVoices", {}).then((r) => { if (r.ok) setVoices(r.data.voices); else setMessage(r.error.message); });
  }, [status?.heygen, voices]);

  const save = async () => {
    setBusy(true); setMessage("HeyGen에 확인 중…");
    const r = await invoke("credentials.saveHeygenKey", { key });
    setBusy(false); setKey("");
    if (!r.ok) return setMessage(r.error.message);
    onStatus(r.data.status); setVoices(r.data.voices);
    setMessage(`확인했습니다. 쓸 수 있는 음성 ${r.data.voices.length}개 — 아래에서 고르세요.`);
  };
  const choose = async (voiceId: string) => {
    const r = await invoke("credentials.setHeygenVoice", { voiceId });
    if (r.ok) { onStatus(r.data); setMessage("음성을 저장했습니다."); } else setMessage(r.error.message);
  };
  const clear = async () => {
    const r = await invoke("credentials.clear", { which: "heygen" });
    if (r.ok) { onStatus(r.data); setVoices(undefined); setMessage("HeyGen 키와 음성을 지웠습니다."); }
  };
  const listen = async (voiceId: string) => {
    const r = await invoke("credentials.heygenPreview", { voiceId });
    if (!r.ok) return setMessage(r.error.message);
    player.current?.pause();
    player.current = new Audio(URL.createObjectURL(new Blob([Uint8Array.from(r.data.bytes)], { type: r.data.mediaType })));
    void player.current.play();
  };
  const chosen = voices?.find((v) => v.voiceId === status?.heygenVoiceId);

  return <section className="heygen-setting">
    <h3>HeyGen 음성 (주차 설명 영상용, 선택)</h3>
    <p className="meta">{status?.heygen ? `저장됨${chosen ? ` · 음성 ${chosen.name}` : " · 음성을 고르세요"}` : "저장 안 됨"} · HeyGen 웹 → 설정(Settings) → API에서 키를 복사해 붙여 넣습니다. 영상 대본만 HeyGen에 보내며, 만들 때 HeyGen 크레딧이 쓰입니다.</p>
    <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label>API 키 <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} required minLength={8} /></label>
      <button type="submit" disabled={busy || !key.trim()}>확인 후 저장</button>
      {status?.heygen ? <button type="button" disabled={busy} onClick={() => void clear()}>지우기</button> : null}
    </form>
    {voices ? <div className="heygen-voices">
      <select aria-label="설명 영상 음성" value={status?.heygenVoiceId ?? ""} onChange={(e) => void choose(e.target.value)}>
        <option value="" disabled>음성 고르기</option>
        {voices.map((v) => <option key={v.voiceId} value={v.voiceId}>{v.name} · {v.language || "언어 미상"}{v.gender ? ` · ${v.gender === "female" ? "여성" : v.gender === "male" ? "남성" : v.gender}` : ""}</option>)}
      </select>
      {chosen?.preview ? <button type="button" onClick={() => void listen(chosen.voiceId)}>미리 듣기</button> : null}
    </div> : null}
    {message ? <p className="meta" role="status">{message}</p> : null}
  </section>;
}
