import { useEffect, useRef, useState } from "react";
import { LANGUAGE_NAMES, PreferredLanguage, type CredentialStatus } from "@learningxxx/contracts";
import { AutomationSettings } from "./AutomationSettings.tsx";
import { HeygenSettings } from "./HeygenSettings.tsx";
import { invoke } from "./host-api.ts";
import { Icon } from "./StudyUI.tsx";
import { signInSummary } from "./signin.ts";

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

  const apply = (next: CredentialStatus) => {
    setStatus(next);
    onChange?.(next);
  };
  useEffect(() => {
    void invoke("credentials.status", {}).then((r) => { if (r.ok) apply(r.data); });
  }, []);

  const run = async (work: () => ReturnType<typeof invoke<"credentials.status">>, done: string) => {
    setBusy(true);
    setMessage("확인 중…");
    const result = await work();
    setBusy(false);
    setPassword("");
    setToken("");
    if (result.ok) {
      apply(result.data);
      setMessage(done);
    } else {
      setMessage(result.error.message);
    }
  };

  return (
    <>
      <button type="button" aria-label="설정" title={`설정 · ${signInSummary(status)}`} onClick={() => { setMessage(""); dialog.current?.showModal(); }}><Icon name="account" /></button>
      <dialog ref={dialog} className="signin" aria-label="설정">
        <h2>설정</h2>
        <h3 className="settings-group">로그인</h3>
        <p>이 Mac에만 저장되며 키체인으로 암호화됩니다. 앱은 학교 로그인과 Canvas에만 보냅니다.</p>
        {status && !status.available ? <p role="alert">이 Mac에서는 안전한 저장소를 쓸 수 없어 저장할 수 없습니다.</p> : null}

        <form onSubmit={(e) => { e.preventDefault(); void run(() => invoke("credentials.saveSchool", { schoolId, password }), "학교 로그인을 확인하고 저장했습니다. 다음 수집부터 자동으로 로그인합니다."); }}>
          <h3>학교 통합 로그인 (강의 자료에 필요)</h3>
          <p className="meta">
            {status?.school ? (status.schoolRejected ? "저장됨 — 학교가 비밀번호를 거부해 자동 로그인을 멈췄습니다. 다시 저장하세요." : "저장됨") : "저장 안 됨"}
          </p>
          <label>아이디(학번) <input autoComplete="username" value={schoolId} onChange={(e) => setSchoolId(e.target.value)} required /></label>
          <label>비밀번호 <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <p className="meta">저장할 때 한 번 로그인해 확인합니다. 틀리면 저장하지 않고, 다시 시도하지도 않습니다.</p>
          <button type="submit" disabled={busy}>확인 후 저장</button>
          {status?.school ? <button type="button" disabled={busy} onClick={() => void run(async () => invoke("credentials.clear", { which: "school" }), "학교 로그인 정보를 지웠습니다.")}>지우기</button> : null}
        </form>

        <form onSubmit={(e) => { e.preventDefault(); void run(() => invoke("credentials.saveCanvasToken", { token }), "Canvas 토큰을 확인하고 저장했습니다."); }}>
          <h3>Canvas 액세스 토큰 (선택)</h3>
          <p className="meta">{status?.canvasToken ? "저장됨" : "저장 안 됨"} · 이캠퍼스 → 계정 → 설정 → 새 액세스 토큰에서 발급합니다. 공지·과제 수집에 쓰입니다.</p>
          <label>토큰 <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required /></label>
          <button type="submit" disabled={busy}>확인 후 저장</button>
          {status?.canvasToken ? <button type="button" disabled={busy} onClick={() => void run(async () => invoke("credentials.clear", { which: "canvasToken" }), "Canvas 토큰을 지웠습니다.")}>지우기</button> : null}
        </form>

        <p role="status">{message}</p>
        <LanguageSetting />
        <AutomationSettings />
        <HeygenSettings status={status} onStatus={apply} />
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
    <p className="meta">전사문 번역(전사 탭의 번역 보기)에 씁니다. 원문은 그대로 남습니다.</p>
    <select aria-label="선호 언어" value={language ?? ""} disabled={!language} onChange={(e) => {
      const next = PreferredLanguage.parse(e.target.value);
      void invoke("app.setPreferences", { language: next }).then((r) => { if (r.ok) { setLanguage(r.data.language); setNote("저장했습니다."); window.dispatchEvent(new Event("learningxxx:preferences")); } else setNote(r.error.message); });
    }}>{PreferredLanguage.options.map((code) => <option key={code} value={code}>{LANGUAGE_NAMES[code]}</option>)}</select>
    {note ? <span className="meta"> {note}</span> : null}
  </section>;
}
