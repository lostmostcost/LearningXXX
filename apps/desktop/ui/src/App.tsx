import { useCallback, useEffect, useRef, useState } from "react";
import { FIXTURE_MANIFEST, loadFixtureAsset } from "./fixtures.ts";
import { invoke } from "./host-api.ts";
import { isNarrow, nextPanel, visiblePanels } from "./layout.ts";
import type { NarrowView, Panel } from "./layout.ts";
import { buildLibrary, type Entry } from "./library.ts";
import { LibraryPanel } from "./LibraryPanel.tsx";
import { openPdfInBrowser } from "./pdf-browser.ts";
import { Viewer } from "./Viewer.tsx";

/**
 * `?fixture` shows the synthetic course (WBS-013 acceptance). The host has no
 * course list or local asset channel yet (WBS-012), so the app itself shows
 * the empty state.
 */
const FIXTURE_MODE = new URLSearchParams(window.location.search).has("fixture");
const library = FIXTURE_MODE ? buildLibrary(FIXTURE_MANIFEST) : undefined;
const loadAsset = FIXTURE_MODE ? loadFixtureAsset : undefined;

function useWindowWidth(): number {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

export function App() {
  const narrow = isNarrow(useWindowWidth());
  const [view, setView] = useState<NarrowView>("materials");
  const [status, setStatus] = useState(FIXTURE_MODE ? "합성 데이터(fixture) 모드" : "확인 중");
  const [selected, setSelected] = useState<Entry>();
  const now = new Date();
  const refs = useRef<Partial<Record<Panel, HTMLElement | null>>>({});
  const panels = visiblePanels(narrow, view);

  useEffect(() => {
    if (FIXTURE_MODE) return;
    void invoke("collection.status", {}).then((result) => {
      if (!result.ok) setStatus(result.error.message);
      else setStatus(result.data.lastSucceeded ? "수집 완료" : "아직 수집하지 않음");
    });
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "F6") return;
      event.preventDefault();
      const active = panels.find((p) => refs.current[p]?.contains(document.activeElement));
      refs.current[nextPanel(active, panels, event.shiftKey)]?.focus();
    },
    [panels],
  );
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  const panel = (id: Panel, label: string, children: React.ReactNode) =>
    panels.includes(id) ? (
      <section className={`panel ${id}`} aria-label={label} tabIndex={-1} ref={(element) => { refs.current[id] = element; }}>
        {children}
      </section>
    ) : null;

  return (
    <div className={narrow ? "app narrow" : "app"}>
      <header className="topbar">
        <strong>LearningXXX</strong>
        <span role="status">수집: {status}</span>
        <span>{library ? library.course.title : "과목 없음"} · 세션 없음</span>
        {narrow ? (
          <div role="tablist" aria-label="화면 전환">
            <button role="tab" aria-selected={view === "materials"} onClick={() => setView("materials")}>자료</button>
            <button role="tab" aria-selected={view === "chat"} onClick={() => setView("chat")}>채팅</button>
          </div>
        ) : null}
      </header>
      <main className="panels">
        {panel("library", "과목과 자료", library ? (
          <LibraryPanel library={library} selectedId={selected?.resource.id} onSelect={setSelected} now={now} />
        ) : (
          <>
            <h2>과목</h2>
            <p>아직 자료가 없습니다.</p>
            <p>수집을 실행하면 과목과 주차가 여기에 나타납니다.</p>
            <button disabled title="수집 연결은 후속 작업에서 제공됩니다">수집 실행</button>
          </>
        ))}
        {panel("viewer", "자료 뷰어", (
          <Viewer entry={selected} {...(loadAsset ? { loadAsset } : {})} open={openPdfInBrowser} now={now} />
        ))}
        {panel("chat", "채팅", (
          <>
            <h2>채팅</h2>
            <p>세션이 없습니다. 파일을 직접 첨부해 질문할 수도 있습니다.</p>
            <textarea aria-label="메시지 입력" disabled placeholder="채팅 연결은 후속 작업에서 제공됩니다" />
          </>
        ))}
      </main>
    </div>
  );
}
