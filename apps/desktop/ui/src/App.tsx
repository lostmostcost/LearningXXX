import { useCallback, useEffect, useRef, useState } from "react";
import type { Course } from "@learningxxx/contracts";
import { FIXTURE_MANIFEST, loadFixtureAsset } from "./fixtures.ts";
import { invoke, onHostPush } from "./host-api.ts";
import { isNarrow, nextPanel, visiblePanels } from "./layout.ts";
import type { NarrowView, Panel } from "./layout.ts";
import { Dashboard, Icon, entriesOf } from "./StudyUI.tsx";
import { ChatPanel } from "./ChatPanel.tsx";
import { viewingOf } from "./composer.ts";
import { buildLibrary, type Entry, type Library } from "./library.ts";
import { LibraryPanel } from "./LibraryPanel.tsx";
import { ModifyPanel } from "./ModifyPanel.tsx";
import { RecordingPanel } from "./RecordingPanel.tsx";
import { openPdfInBrowser } from "./pdf-browser.ts";
import { SignInSettings } from "./SignInSettings.tsx";
import { syncStatusText } from "./sync-status.ts";
import { Viewer } from "./Viewer.tsx";
import type { PageSnapshot } from "./PdfView.tsx";
import type { PageLocation, SelectedText, SelectionIntent, SelectionRequest } from "./selection.ts";

/** `?fixture` shows the synthetic course (WBS-013); otherwise material comes from the host's local library (WBS-012). */
const FIXTURE_MODE = new URLSearchParams(window.location.search).has("fixture");
const IN_APP = window.host !== undefined;

/** Collected courses and the chosen one's material (the first by default), read from disk by the host; works offline. */
async function loadLocalLibrary(courseId?: string): Promise<{ courses: Course[]; library?: Library }> {
  const listed = await invoke("library.courses", {});
  const courses = listed.ok ? listed.data.courses : [];
  const course = courses.find((c) => c.id === courseId) ?? courses[0];
  if (!course) return { courses };
  const result = await invoke("library.manifest", { courseId: course.id });
  return result.ok && result.data.manifest ? { courses, library: buildLibrary(result.data.manifest) } : { courses };
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
  const [home,setHome]=useState(true);
  const [pinned,setPinned]=useState(false);
  const [drawer,setDrawer]=useState(false);
  const [section,setSection]=useState("book");
  const [weekIndex,setWeekIndex]=useState(0);
  const [tray,setTray]=useState(false);
  const courseEpoch=useRef(0);
  const [view, setView] = useState<NarrowView>("materials");
  const [status, setStatus] = useState(FIXTURE_MODE ? "합성 데이터(fixture) 모드" : "확인 중");
  const [collecting, setCollecting] = useState(false);
  const [library, setLibrary] = useState<Library | undefined>(FIXTURE_MODE ? buildLibrary(FIXTURE_MANIFEST) : undefined);
  const [selected, setSelected] = useState<Entry>();
  const [courses, setCourses] = useState<Course[]>(FIXTURE_MODE ? [FIXTURE_MANIFEST.course] : []);
  const courseRef = useRef<string | undefined>(FIXTURE_MODE ? FIXTURE_MANIFEST.course.id : undefined);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [selectionRequest, setSelectionRequest] = useState<SelectionRequest>();
  const [location, setLocation] = useState<PageLocation>();
  const [shownPage, setShownPage] = useState<{ assetId: string; page: number }>();
  const onPage = useCallback((assetId: string, page: number) => setShownPage({ assetId, page }), []);
  const snapshot = useRef<PageSnapshot | undefined>(undefined);
  const onSnapshot = useCallback((s: PageSnapshot | undefined) => { snapshot.current = s; }, []);
  const snapshotPage = useCallback(() => snapshot.current?.() ?? Promise.resolve(undefined), []);
  const [modifying, setModifying] = useState(false);
  const selectEntry=(entry:Entry)=>{setSelected(entry);const index=library?.weeks.findIndex(w=>w.week.id===entry.resource.weekId)??-1;setWeekIndex(index);};
  const now = new Date();
  const refs = useRef<Partial<Record<Panel, HTMLElement | null>>>({});
  const panels = visiblePanels(narrow, view);

  const refresh = useCallback(async () => {
    const epoch=courseEpoch.current;
    const result = await invoke("collection.status", {});
    setStatus(result.ok ? syncStatusText(result.data) : result.error.message);
    const loaded = await loadLocalLibrary(courseRef.current);
    if(epoch!==courseEpoch.current)return;
    setCourses(loaded.courses);
    setLibrary(loaded.library);
    courseRef.current=loaded.library?.course.id;
  }, []);

  /** Switching courses closes the open material; sessions stay per course in the chat panel. */
  const chooseCourse = useCallback(async (courseId: string) => {
    if(courseRef.current===courseId)return;
    setLibrary(undefined);
    const epoch=++courseEpoch.current;
    courseRef.current = courseId;
    setSelectionRequest(undefined);setShownPage(undefined);setLocation(undefined);snapshot.current=undefined;setWeekIndex(0);
    setSelected(undefined);
    setActiveSessionId(undefined);
    const next=FIXTURE_MODE?buildLibrary(FIXTURE_MANIFEST):(await loadLocalLibrary(courseId)).library;
    if(epoch===courseEpoch.current)setLibrary(next);
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
      if(home)return;
      const active = panels.find((p) => refs.current[p]?.contains(document.activeElement));
      refs.current[nextPanel(active, panels, event.shiftKey)]?.focus();
    },
    [panels,home],
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
    <div className={`${narrow ? "app narrow" : "app"} study-app ${home?'at-home':''} ${pinned?'sidebar-pinned':''} ${drawer?'sidebar-open':''}`}>
      <nav className="icon-rail" aria-label="목적별 탐색">{[['home','대시보드'],['book','강의 자료'],['tasks','과제'],['notice','공지'],['mic','녹음']].map(([id,label])=><button key={id} title={label} aria-label={label} aria-pressed={id==='home'?home:!home&&section===id} onClick={()=>{setHome(id==='home');if(id!=='home'){setSection(id!);setDrawer(true);}}}><Icon name={id!}/></button>)}<button title="과목 목록" aria-label="과목 목록" aria-expanded={drawer||pinned} onClick={()=>setDrawer(x=>!x)}><Icon name="menu"/></button></nav>
      <aside className="course-drawer" aria-label="과목 선택"><div className="drawer-heading"><strong>내 과목</strong><button title="과목 목록 고정" aria-label="과목 목록 고정" aria-pressed={pinned} onClick={()=>{setPinned(x=>!x);setDrawer(false);}}><Icon name="pin"/></button></div>{courses.map(c=><button className="entry" aria-pressed={library?.course.id===c.id} key={c.id} onClick={()=>{void chooseCourse(c.id);setHome(false);setDrawer(false);}}><Icon name="book"/>{c.title}</button>)}</aside>
      <header className="topbar">
        <strong className="wordmark">Learning<span>XXX</span></strong>
        <span role="status">수집: {status}</span>
        {library ? collectButton : null}
        {IN_APP && !FIXTURE_MODE ? <SignInSettings /> : null}
        {courses.length > 1 && library ? (
          <label className="course-picker">과목{" "}
            <select value={library.course.id} onChange={(e) => void chooseCourse(e.target.value)}>
              {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </label>
        ) : null}
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
      {home?<Dashboard fixture={FIXTURE_MODE} courses={courses} onOpen={(id,entry)=>{setHome(false);setSection('book');void chooseCourse(id).then(()=>{if(courseRef.current===id&&entry)setSelected(entry);});}}/>:null}
      <main className={`panels mode-${section}`} hidden={home}>
        <div className={`week-tray ${tray?'is-open':''}`}>
          <button className="week-handle" aria-expanded={tray} onClick={()=>setTray(x=>!x)}>{library?.weeks[weekIndex]?.week.label??'학습 자료'} <span>⌄</span></button>
          <div className="week-drop"><div className="week-tabs">{library?.weeks.map((w,i)=><button key={w.week.id} aria-pressed={i===weekIndex} onClick={()=>setWeekIndex(i)}>{w.week.label}</button>)}</div><button aria-pressed={weekIndex===-1} onClick={()=>setWeekIndex(-1)}>기타 자료</button><div className="week-files">{(weekIndex===-1?library?.other:library?.weeks[weekIndex]?.entries)?.map(e=><button key={e.resource.id} aria-pressed={selected?.resource.id===e.resource.id} onClick={()=>{selectEntry(e);setTray(false);}}><Icon name={e.resource.kind==='assignment'?'tasks':'book'}/>{e.resource.title}</button>)}</div></div>
        </div>
        {panel("library", "과목과 자료", library ? (
          <>
            {section==='book'?<LibraryPanel library={library} selectedId={selected?.resource.id} onSelect={selectEntry} now={now} />:section!=='mic'?<><h2>{section==='tasks'?'과제':'공지'}</h2>{entriesOf(library).filter(e=>e.resource.kind===(section==='tasks'?'assignment':'notice')).map(e=><button className="entry" key={e.resource.id} onClick={()=>selectEntry(e)}>{e.resource.title}</button>)}</>:null}
            {section==='mic' && IN_APP && !FIXTURE_MODE ? <RecordingPanel courseId={library.course.id} /> : null}
          </>
        ) : (
          <>
            <h2>과목</h2>
            <p>아직 자료가 없습니다.</p>
            <p>수집을 실행하면 과목과 주차가 여기에 나타납니다. 처음이면 학교 로그인 창이 열립니다.</p>
            {collectButton ?? <p>앱 안에서 실행하면 수집할 수 있습니다.</p>}
          </>
        ))}
        {panel("viewer", "자료 뷰어", (
          <Viewer entry={selected} {...(library ? { loadAsset } : {})} open={openPdfInBrowser} now={now} onSelectionAction={selectAction} location={location} onPage={onPage} onSnapshot={onSnapshot} />
        ))}
        {panel("chat", "채팅", window.host ? (
          <ChatPanel courseId={library?.course.id} courseTitle={library?.course.title} activeId={activeSessionId} onActiveId={setActiveSessionId}
            selectedAssets={selected?.assets.map((a) => ({ id: a.id, name: a.originalName })) ?? []}
            viewing={viewingOf(selected?.assets.map((a) => a.id) ?? [], shownPage)} snapshotPage={snapshotPage} selectionRequest={selectionRequest} onSelectionUsed={selectionUsed} onOpenSelection={openSelection} />
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
