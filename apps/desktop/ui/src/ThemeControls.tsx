import { useEffect, useState } from "react";
import { ThemePreference } from "@learningxxx/contracts";
import { invoke } from "./host-api.ts";
import { Icon } from "./StudyUI.tsx";
import { DARK_QUERY, PREFERENCES_EVENT, THEME_LABELS, toggledTheme, toggleLabel } from "./theme.ts";

/** WBS-100: the saved theme choice and what is on screen now. */
function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>();
  const [dark, setDark] = useState(() => window.matchMedia(DARK_QUERY).matches);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const changed = () => setDark(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    const read = () => void invoke("app.preferences", {}).then((r) => { if (r.ok) setPreference(r.data.theme); });
    read();
    window.addEventListener(PREFERENCES_EVENT, read);
    return () => window.removeEventListener(PREFERENCES_EVENT, read);
  }, []);
  const choose = async (theme: ThemePreference) => {
    setBusy(true);
    try {
      const r = await invoke("app.setPreferences", { theme });
      if (!r.ok) { setError(r.error.message); return false; }
      setError(""); setPreference(r.data.theme);
      window.dispatchEvent(new Event(PREFERENCES_EVENT));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "테마를 저장하지 못했습니다.");
      return false;
    } finally { setBusy(false); }
  };
  return { preference, dark, busy, error, choose };
}

/** Top bar: one click between light and dark. */
export function ThemeToggle() {
  const { preference, dark, busy, error, choose } = useTheme();
  const label = toggleLabel(dark);
  return <>
    <button type="button" className="theme-toggle" aria-label={label} title={error ? `${label} · 실패: ${error}` : label} disabled={busy || !preference} onClick={() => void choose(toggledTheme(dark))}>
      <Icon name={dark ? "sun" : "moon"} />
    </button>
    {error ? <span className="meta" role="alert">테마를 바꾸지 못했습니다.</span> : null}
  </>;
}

/** Settings: system, light or dark. */
export function ThemeSetting() {
  const { preference, busy, error, choose } = useTheme();
  const [note, setNote] = useState("");
  return <section className="language-setting">
    <h3>화면 테마</h3>
    <select aria-label="화면 테마" value={preference ?? ""} disabled={!preference || busy} onChange={(e) => {
      const next = ThemePreference.parse(e.target.value);
      void choose(next).then((saved) => setNote(saved ? "저장했습니다." : ""));
    }}>{ThemePreference.options.map((theme) => <option key={theme} value={theme}>{THEME_LABELS[theme]}</option>)}</select>
    {error ? <span className="meta" role="alert"> {error}</span> : note ? <span className="meta"> {note}</span> : null}
  </section>;
}
