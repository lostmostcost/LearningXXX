import { useCallback, useEffect, useRef, useState } from "react";
import { FIXTURE_MANIFEST, loadFixtureAsset } from "./fixtures.ts";
import { invoke, onHostPush } from "./host-api.ts";
import { isNarrow, nextPanel, visiblePanels } from "./layout.ts";
import type { NarrowView, Panel } from "./layout.ts";
import { ChatPanel } from "./ChatPanel.tsx";
import { buildLibrary, type Entry, type Library } from "./library.ts";
import { LibraryPanel } from "./LibraryPanel.tsx";
import { ModifyPanel } from "./ModifyPanel.tsx";
import { openPdfInBrowser } from "./pdf-browser.ts";
import { syncStatusText } from "./sync-status.ts";
import { Viewer } from "./Viewer.tsx";
import type { PageLocation, SelectedText, SelectionIntent, SelectionRequest } from "./selection.ts";

/** `?fixture` shows the synthetic course (WBS-013); otherwise material comes from the host's local library (WBS-012). */
const FIXTURE_MODE = new URLSearchParams(window.location.search).has("fixture");
const IN_APP = window.host !== undefined;

/** The first course with collected material, read from disk by the host; works offline. */
async function loadLocalLibrary(): Promise<Library | undefined> {
  const courses = await invoke("library.courses", {});
  const course = courses.ok ? courses.data.courses[0] : undefined;
  if (!course) return undefined;
  const result = await invoke("library.manifest", { courseId: course.id });
  return result.ok && result.data.manifest ? buildLibrary(result.data.manifest) : undefined;
}

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
  const [collecting, setCollecting] = useState(false);
  const [library, setLibrary] = useState<Library | undefined>(FIXTURE_MODE ? buildLibrary(FIXTURE_MANIFEST) : undefined);
  const [selected, setSelected] = useState<Entry>();
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [selectionRequest, setSelectionRequest] = useState<SelectionRequest>();
  const [location, setLocation] = useState<PageLocation>();
  const [modifying, setModifying] = useState(false);
  const now = new Date();
  const refs = useRef<Partial<Record<Panel, HTMLElement | null>>>({});
  const panels = visiblePanels(narrow, view);

  const refresh = useCallback(async () => {
    const result = await invoke("collection.status", {});
    setStatus(result.ok ? syncStatusText(result.data) : result.error.message);
    setLibrary(await loadLocalLibrary());
  }, []);

  useEffect(() => {
    if (FIXTURE_MODE) return;
    void refresh();
    return onHostPush((push) => {
      if (push.kind !== "collection.progress") return;
      setCollecting(push.syncRun.status === "running");
      if (push.syncRun.status === "running") setStatus(syncStatusText({ current: push.syncRun }));
      else void refresh();
    });
  }, [refresh]);

  const collect = useCallback(async () => {
    setCollecting(true);
    const result = await invoke("collection.run", { scope: "all_courses" });
    if (!result.ok) {
      setCollecting(false);
      setStatus(result.error.message);
    }
  }, []);

  const loadAsset = useCallback(
    async (assetId: string) => {
      if (FIXTURE_MODE) return loadFixtureAsset(assetId);
      if (!library) return undefined;
      const result = await invoke("library.asset", { courseId: library.course.id, assetId });
      return result.ok ? result.data.bytes : undefined;
    },
    [library],
  );
  const collectButton = IN_APP && !FIXTURE_MODE ? (
    <button onClick={() => void collect()} disabled={collecting}>{collecting ? "수집 중…" : "수집 실행"}</button>
  ) : null;

  const selectAction = (selection: SelectedText, intent: SelectionIntent) => {
    setSelectionRequest({ id: crypto.randomUUID(), selection: { ...selection }, intent,
      ...(activeSessionId ? { targetSessionId: activeSessionId } : {}) });
    setView("chat");
  };
  const selectionUsed = useCallback((id: string) => setSelectionRequest((r) => r?.id === id ? undefined : r), []);
  const openSelection = (selection: SelectedText): boolean => {
    if (!library) return false;
    const entries = [...library.notices, ...library.other, ...library.weeks.flatMap((w) => w.entries)];
    const entry = entries.find((e) => e.assets.some((a) => a.id === selection.assetId));
    if (!entry) return false;
    setSelected(entry);
    setLocation({ id: crypto.randomUUID(), assetId: selection.assetId, page: selection.page ?? 1 });
    setView("materials");
    return true;
  };

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

  // Keep drafts, streams and the current PDF page when narrow layouts switch panels.
  const panel = (id: Panel, label: string, children: React.ReactNode) => (
      <section hidden={!panels.includes(id)} className={`panel ${id}`} aria-label={label} tabIndex={-1} ref={(element) => { refs.current[id] = element; }}>
        {children}
      </section>
    );

  return (
    <div className={narrow ? "app narrow" : "app"}>
      <header className="topbar">
        <strong>LearningXXX</strong>
        <span role="status">수집: {status}</span>
        {library ? collectButton : null}
        <span>{library ? library.course.title : "과목 없음"} · {activeSessionId ? "세션 선택됨" : "세션 없음"}</span>
        {IN_APP && !FIXTURE_MODE ? <button aria-expanded={modifying} onClick={() => setModifying((open) => !open)}>앱 수정</button> : null}
        {narrow ? (
          <div role="tablist" aria-label="화면 전환">
            <button role="tab" aria-selected={view === "materials"} onClick={() => setView("materials")}>자료</button>
            <button role="tab" aria-selected={view === "chat"} onClick={() => setView("chat")}>채팅</button>
          </div>
        ) : null}
      </header>
      {IN_APP && !FIXTURE_MODE ? <div hidden={!modifying}><ModifyPanel /></div> : null}
      <main className="panels">
        {panel("library", "과목과 자료", library ? (
          <LibraryPanel library={library} selectedId={selected?.resource.id} onSelect={setSelected} now={now} />
        ) : (
          <>
            <h2>과목</h2>
            <p>아직 자료가 없습니다.</p>
            <p>수집을 실행하면 과목과 주차가 여기에 나타납니다. 처음이면 학교 로그인 창이 열립니다.</p>
            {collectButton ?? <p>앱 안에서 실행하면 수집할 수 있습니다.</p>}
          </>
        ))}
        {panel("viewer", "자료 뷰어", (
          <Viewer entry={selected} {...(library ? { loadAsset } : {})} open={openPdfInBrowser} now={now} onSelectionAction={selectAction} location={location} />
        ))}
        {panel("chat", "채팅", window.host ? (
          <ChatPanel courseId={library?.course.id} courseTitle={library?.course.title} activeId={activeSessionId} onActiveId={setActiveSessionId}
            selectedAssets={selected?.assets.map((a) => ({ id: a.id, name: a.originalName })) ?? []} selectionRequest={selectionRequest} onSelectionUsed={selectionUsed} onOpenSelection={openSelection} />
        ) : (
          <>
            <h2>채팅</h2>
            <p>앱 안에서 실행하면 채팅할 수 있습니다.</p>
          </>
        ))}
      </main>
    </div>
  );
}
