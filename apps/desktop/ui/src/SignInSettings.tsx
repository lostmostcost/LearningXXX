import { useEffect, useRef, useState } from "react";
import { LANGUAGE_NAMES, PreferredLanguage, type CredentialStatus } from "@learningxxx/contracts";
import { AutomationSettings } from "./AutomationSettings.tsx";
import { invoke } from "./host-api.ts";
import { Icon } from "./StudyUI.tsx";
import { signInSummary } from "./signin.ts";
import { Details } from './Details.tsx';

/**
 * Saves the school ID/password and the Canvas access token on this Mac
 * (encrypted with the Keychain). Fields are cleared after each attempt, and
 * the host only ever answers whether something is saved.
 */
export function SignInSettings({ onChange }: { onChange?: (status: CredentialStatus) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<CredentialStatus>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [schoolId, setSchoolId] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const requestBusy = useRef(false);
  const [reload, setReload] = useState(0);

  const apply = (next: CredentialStatus) => {
    setStatus(next);
    onChange?.(next);
  };
  useEffect(() => {
    let alive = true;
    void invoke("credentials.status", {}).then(r => { if (alive) { if (r.ok) apply(r.data); else setMessage(r.error.message); } }).catch(() => { if (alive) setMessage('로그인 설정을 불러오지 못했습니다.'); });
    return () => { alive = false; };
  }, [reload]);

  const run = async (work: () => ReturnType<typeof invoke<"credentials.status">>, done: string) => {
    if (requestBusy.current) return;
    requestBusy.current = true;
    setBusy(true);
    setMessage("확인 중…");
    try {
      const result = await work();
      if (result.ok) { apply(result.data); setMessage(done); }
      else setMessage(result.error.message);
    } catch { setMessage('설정을 저장하지 못했습니다. 연결을 확인하고 다시 시도하세요.'); }
    finally { requestBusy.current = false; setBusy(false); setPassword(''); setToken(''); }
  };

  return (
    <>
      <button type="button" aria-label="설정" title={`설정 · ${signInSummary(status)}`} onClick={() => { setMessage(""); setReload(v => v + 1); dialog.current?.showModal(); }}><Icon name="account" /></button>
      <dialog ref={dialog} className="signin" aria-label="설정">
        <h2>설정</h2>
        <p className="settings-status">{status ? signInSummary(status) : '연결 상태 확인 중…'}</p>
        {status && !status.available ? <p role="alert">이 Mac에서는 안전한 저장소를 쓸 수 없어 저장할 수 없습니다.</p> : null}
        <Details title={<>학교 로그인 <small>{!status ? '확인 중' : status.school && !status.schoolRejected ? '연결됨 · 변경' : '연결 필요'}</small></>} open={!!status && (!status.school || status.schoolRejected)}>
        <form onSubmit={(e) => { e.preventDefault(); void run(() => invoke("credentials.saveSchool", { schoolId, password }), "학교 로그인을 확인하고 저장했습니다. 다음 수집부터 자동으로 로그인합니다."); }}>
          <p className="meta">
            {status?.school ? (status.schoolRejected ? "저장됨 — 학교가 비밀번호를 거부해 자동 로그인을 멈췄습니다. 다시 저장하세요." : "저장됨") : "저장 안 됨"}
          </p>
          <label>아이디(학번) <input autoComplete="username" value={schoolId} onChange={(e) => setSchoolId(e.target.value)} required /></label>
          <label>비밀번호 <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <p className="meta">이 Mac의 키체인에 저장합니다. 학교에 한 번 확인하며 실패 시 자동 재시도하지 않습니다.</p>
          <button type="submit" disabled={busy || !status?.available}>확인 후 저장</button>
          {status?.school ? <button type="button" disabled={busy} onClick={() => void run(async () => invoke("credentials.clear", { which: "school" }), "학교 로그인 정보를 지웠습니다.")}>지우기</button> : null}
        </form>
        </Details>
        <Details title={<>공지·과제 연결 <small>{status?.canvasToken ? '연결됨 · 변경' : '선택'}</small></>}>
        <form onSubmit={(e) => { e.preventDefault(); void run(() => invoke("credentials.saveCanvasToken", { token }), "Canvas 토큰을 확인하고 저장했습니다."); }}>
          <p className="meta">{status?.canvasToken ? "저장됨" : "저장 안 됨"} · 이캠퍼스 → 계정 → 설정 → 새 액세스 토큰에서 발급합니다. 공지·과제 수집에 쓰입니다.</p>
          <label>토큰 <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required /></label>
          <button type="submit" disabled={busy || !status?.available}>확인 후 저장</button>
          {status?.canvasToken ? <button type="button" disabled={busy} onClick={() => void run(async () => invoke("credentials.clear", { which: "canvasToken" }), "Canvas 토큰을 지웠습니다.")}>지우기</button> : null}
        </form>
        </Details>
        <p role="status">{message}</p>
        {!status && message ? <button onClick={() => setReload(v => v + 1)}>연결 다시 확인</button> : null}
        <LanguageSetting />
        <Details title="자동화 설정"><AutomationSettings /></Details>
        <button type="button" onClick={() => dialog.current?.close()}>닫기</button>
      </dialog>
    </>
  );
}

/** WBS-071: the language transcripts (and later PDFs) are translated into, kept on this Mac. */
function LanguageSetting() {
  const [language, setLanguage] = useState<PreferredLanguage>();
  const [note, setNote] = useState("");
  useEffect(() => { void invoke("app.preferences", {}).then((r) => { if (r.ok) setLanguage(r.data.language); }); }, []);
  return <section className="language-setting">
    <h3>선호 언어</h3>
    <select aria-label="선호 언어" value={language ?? ""} disabled={!language} onChange={(e) => {
      const next = PreferredLanguage.parse(e.target.value);
      void invoke("app.setPreferences", { language: next }).then((r) => { if (r.ok) { setLanguage(r.data.language); setNote("저장했습니다."); window.dispatchEvent(new Event("learningxxx:preferences")); } else setNote(r.error.message); });
    }}>{PreferredLanguage.options.map((code) => <option key={code} value={code}>{LANGUAGE_NAMES[code]}</option>)}</select>
    {note ? <span className="meta"> {note}</span> : null}
  </section>;
}
