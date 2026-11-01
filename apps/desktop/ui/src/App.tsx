import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "./host-api.ts";
import { isNarrow, nextPanel, visiblePanels } from "./layout.ts";
import type { NarrowView, Panel } from "./layout.ts";

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
  const [status, setStatus] = useState("확인 중");
  const refs = useRef<Partial<Record<Panel, HTMLElement | null>>>({});
  const panels = visiblePanels(narrow, view);

  useEffect(() => {
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
        <span>과목 없음 · 세션 없음</span>
        {narrow ? (
          <div role="tablist" aria-label="화면 전환">
            <button role="tab" aria-selected={view === "materials"} onClick={() => setView("materials")}>자료</button>
            <button role="tab" aria-selected={view === "chat"} onClick={() => setView("chat")}>채팅</button>
          </div>
        ) : null}
      </header>
      <main className="panels">
        {panel("library", "과목과 자료", (
          <>
            <h2>과목</h2>
            <p>아직 자료가 없습니다.</p>
            <p>수집을 실행하면 과목과 주차가 여기에 나타납니다.</p>
            <button disabled title="수집 연결은 후속 작업에서 제공됩니다">수집 실행</button>
          </>
        ))}
        {panel("viewer", "자료 뷰어", (
          <>
            <h2>자료</h2>
            <p>왼쪽에서 자료를 선택하면 여기에서 열립니다.</p>
          </>
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
