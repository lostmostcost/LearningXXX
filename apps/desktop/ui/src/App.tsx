import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Course, IpcResponse, LectureMention, MediaAsset, PreferredLanguage } from "@learningxxx/contracts";
import { FIXTURE_MANIFEST, loadFixtureAsset } from "./fixtures.ts";
import { invoke, onHostPush } from "./host-api.ts";
import { EDGE_OPEN_DELAY_MS, edgeClosesAt, isNarrow, nextPanel, visiblePanels } from "./layout.ts";
import type { NarrowView, Panel } from "./layout.ts";
import { Dashboard, Icon, entriesOf } from "./StudyUI.tsx";
import { RichChatPanel } from "./RichChatPanel.tsx";
import { CourseKnowledge } from "./CourseKnowledge.tsx";
import { buildLibrary, type Entry, type Library } from "./library.ts";
import { LibraryPanel } from "./LibraryPanel.tsx";
import { Badges, ViewRecordNote, useLearningStatus } from "./LearningBadges.tsx";
import { canRecordView, canWatch, itemForResource, nextUnwatched } from "./learning.ts";
import { viewTarget } from "./document.ts";
import { buildDetail, buildLabel } from "./build-label.ts";
import { claimLaunchSync } from "./launch-sync.ts";
import type { RecordingState } from "./recorder.ts";
import { ModifyPanel } from "./ModifyPanel.tsx";
import { RecordingPanel } from "./RecordingPanel.tsx";
import { RecordingFile } from "./RecordingPlace.tsx";
import { MentionList } from "./Mentions.tsx";
import { TaskSidebar } from "./TaskSidebar.tsx";
import { JobQueue } from "./JobQueue.tsx";
import { unfiledRecordings, weekRecordings, type RecordingRow } from "./recording-weeks.ts";
import { VideoFile, VideoViewer, useVideoLectures } from "./VideoLectures.tsx";
import { rowsForWeek } from "./video-lectures.ts";
import { openPdfInBrowser } from "./pdf-browser.ts";
import { SignInSettings } from "./SignInSettings.tsx";
import { syncStatusText } from "./sync-status.ts";
import { Viewer } from "./Viewer.tsx";
import type { PageSnapshot } from "./PdfView.tsx";
import type { PdfTranslator } from "./PdfTranslation.tsx";
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
  // WBS-068: the course list also slides in when the pointer rests on the screen's left edge.
  const [edge,setEdge]=useState(false);
  const edgeTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  useEffect(()=>{
    if(!edge)return;
    const move=(event:MouseEvent)=>{if(edgeClosesAt(event.clientX))setEdge(false);};
    const out=(event:MouseEvent)=>{if(!event.relatedTarget)setEdge(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')setEdge(false);};
    document.addEventListener('mousemove',move);document.addEventListener('mouseout',out);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('mousemove',move);document.removeEventListener('mouseout',out);document.removeEventListener('keydown',escape);};
  },[edge]);
  useEffect(()=>()=>clearTimeout(edgeTimer.current),[]);
  const [section,setSection]=useState("book");
  const [rightTab, setRightTab] = useState<"chat" | "recording" | "transcripts">("chat");
  const [weekIndex,setWeekIndex]=useState(0);
  // WBS-082: the course summary (course.md) open in the viewer instead of a material.
  const [knowledgeOpen,setKnowledgeOpen]=useState(false);
  const [tray,setTray]=useState(false);
  const [trayDismissed, setTrayDismissed] = useState(false);
  const courseEpoch=useRef(0);
  const [view, setView] = useState<NarrowView>("materials");
  const [status, setStatus] = useState(FIXTURE_MODE ? "합성 데이터(fixture) 모드" : "확인 중");
  const [collecting, setCollecting] = useState(false);
  const [library, setLibrary] = useState<Library | undefined>(FIXTURE_MODE ? buildLibrary(FIXTURE_MANIFEST) : undefined);
  const [selected, setSelected] = useState<Entry>();
  /** A downloaded online lecture playing in the viewer instead of a document. */
  const [playing, setPlaying] = useState<MediaAsset>();
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
  // Asked from the LMS the first time the week menu opens for a course (IN_APP only: the fixture has no LMS).
  // Also when the recording tools are open: the recording picker lists the week's lectures (WBS-065).
  const lectures=useVideoLectures(IN_APP||FIXTURE_MODE?library?.course.id:undefined,tray||(!home&&rightTab!=='chat'));
  /** WBS-065: the recording or lecture whose original and transcript the right panel shows. */
  const [mediaAssetId, setMediaAssetId] = useState<string>();
  const openRecording=(row:RecordingRow)=>{if(!row.asset)return;setMediaAssetId(row.asset.id);setRightTab('transcripts');setView('chat');setTray(false);setTrayDismissed(true);};
  const { refresh: refreshMedia } = lectures;
  const recordingsChanged = useCallback(() => void refreshMedia(), [refreshMedia]);
  // The course list closes when the user clicks anywhere else or presses Escape (not on hover-out).
  useEffect(()=>{
    if(!drawer)return;
    const outside=(event:MouseEvent)=>{const target=event.target as Element|null;if(!target?.closest('.course-drawer, .drawer-toggle'))setDrawer(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')setDrawer(false);};
    document.addEventListener('mousedown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('mousedown',outside);document.removeEventListener('keydown',escape);};
  },[drawer]);
  const selectEntry=(entry:Entry)=>{setPlaying(undefined);setKnowledgeOpen(false);setSelected(entry);const index=library?.weeks.findIndex(w=>w.week.id===entry.resource.weekId)??-1;setWeekIndex(index);};
  const now = new Date();
  const refs = useRef<Partial<Record<Panel, HTMLElement | null>>>({});
  // LMS completion/attendance/submission badges; read again after each collection (WBS-055).
  const learning = useLearningStatus(library?.course.id, status);
  // WBS-064: red light on the recording tab, the mic rail button and the top bar while recording.
  const [recState, setRecState] = useState<RecordingState>("idle");
  const recLight = recState === "idle" ? null : <span className={`rec-light ${recState}`} aria-hidden="true" />;
  // WBS-061: which code this development run is, also in the window title.
  const [build, setBuild] = useState<IpcResponse<"app.build">>();
  useEffect(() => { void invoke("app.build", {}).then((r) => { if (r.ok) setBuild(r.data); }); }, []);
  const devLabel = buildLabel(build);
  useEffect(() => { document.title = devLabel ? `LearningXXX — ${devLabel}` : "LearningXXX"; }, [devLabel]);
  const selectedItem = selected ? itemForResource(learning.status, selected.resource) : undefined;
  // WBS-056: an LMS PDF whose page is actually drawn in the viewer is a view the LMS records
  // (once per item; retry on failure). A PDF that cannot be opened is not.
  const { recordView } = learning;
  // WBS-057: watch in the official LMS player (a visible app window); the status is read again when it closes.
  const [watchNotice, setWatchNotice] = useState<string>();
  const watch = useCallback(async (moduleItemId: string) => {
    const courseId = library?.course.id;
    if (!courseId) return;
    setWatchNotice(undefined);
    const result = await invoke("learning.watch", { courseId, moduleItemId });
    setWatchNotice(result.ok ? "LMS 시청 창을 열었습니다. 다 보고 창을 닫으면 출석 상태를 다시 읽습니다." : result.error.message);
  }, [library?.course.id]);
  const { reload: reloadLearning } = learning;
  useEffect(() => onHostPush((push) => {
    if (push.kind !== "learning.watchClosed" || push.courseId !== courseRef.current) return;
    setWatchNotice("시청 창을 닫았습니다. LMS의 출석 상태를 다시 읽었습니다.");
    void reloadLearning(false);
  }), [reloadLearning]);
  const upNext = nextUnwatched(learning.status, now);
  // WBS-070: confirmed lecture announcements, read whenever the 과제 section is shown.
  const [mentions, setMentions] = useState<LectureMention[]>([]);
  const mentionCourse = library?.course.id;
  useEffect(() => {
    if (!mentionCourse || section !== 'tasks' || home || !(IN_APP || FIXTURE_MODE)) return;
    let alive = true;
    void invoke("media.mentions", { courseId: mentionCourse }).then((r) => { if (alive) setMentions(r.ok ? r.data.mentions : []); });
    return () => { alive = false; };
  }, [mentionCourse, section, home]);
  // WBS-059: the quiz's own LMS page in a visible window; the user takes it there.
  const openQuiz = useCallback(async (item: { moduleItemId?: string | undefined; quiz?: { quizId?: string | undefined } | undefined }) => {
    const courseId = library?.course.id;
    if (!courseId) return;
    const result = await invoke("learning.openQuiz", { courseId, ...(item.moduleItemId ? { moduleItemId: item.moduleItemId } : {}), ...(item.quiz?.quizId ? { quizId: item.quiz.quizId } : {}) });
    setWatchNotice(result.ok ? "LMS 퀴즈 창을 열었습니다. 응시는 그 창에서 직접 합니다. 창을 닫으면 상태를 다시 읽습니다." : result.error.message);
  }, [library?.course.id]);
  const target = selected ? viewTarget(selected) : undefined;
  const shownPdf = !playing && target?.kind === "pdf" && shownPage?.assetId === target.asset.id;
  useEffect(() => {
    if (shownPdf && canRecordView(selectedItem, new Date())) void recordView(selectedItem.moduleItemId);
  }, [shownPdf, selectedItem, recordView]);
  // WBS-082: what is open, sent with each chat message so "이번 주"·"이 자료" mean this.
  const viewing = useMemo(() => {
    if (!library) return undefined;
    const week = (selected?.resource.weekId ? library.weeks.find((w) => w.week.id === selected.resource.weekId) : weekIndex >= 0 ? library.weeks[weekIndex] : undefined)?.week.label;
    const title = knowledgeOpen ? "과목 정리 (course.md)" : selected?.resource.title;
    const page = !knowledgeOpen && shownPage && selected?.assets.some((a) => a.id === shownPage.assetId) ? shownPage.page : undefined;
    return week || title ? { ...(week ? { week } : {}), ...(title ? { title } : {}), ...(page ? { page } : {}) } : undefined;
  }, [library, selected, weekIndex, knowledgeOpen, shownPage]);
  const panels = visiblePanels(narrow, view);
  const weekList = useMemo(() => library?.weeks.map((w) => w.week) ?? [], [library]);

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
    setSelectionRequest(undefined);setShownPage(undefined);setLocation(undefined);snapshot.current=undefined;setWeekIndex(0);setMediaAssetId(undefined);
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
  // WBS-062: collect once when the app starts; sign-in and errors show as for the button.
  useEffect(() => {
    if (IN_APP && !FIXTURE_MODE && claimLaunchSync(window.sessionStorage)) void collect();
  }, [collect]);

  const loadAsset = useCallback(
    async (assetId: string) => {
      if (FIXTURE_MODE) return loadFixtureAsset(assetId);
      if (!library) return undefined;
      const result = await invoke("library.asset", { courseId: library.course.id, assetId });
      return result.ok ? result.data.bytes : undefined;
    },
    [library],
  );
  // WBS-072: translated copies of PDFs in the preferred language (read again when settings change).
  const [language, setLanguage] = useState<PreferredLanguage>();
  useEffect(() => {
    if (!IN_APP || FIXTURE_MODE) return;
    const read = () => void invoke("app.preferences", {}).then((r) => { if (r.ok) setLanguage(r.data.language); });
    read(); window.addEventListener("learningxxx:preferences", read);
    return () => window.removeEventListener("learningxxx:preferences", read);
  }, []);
  const courseId = library?.course.id;
  const translator = useMemo<PdfTranslator | undefined>(() => courseId && language ? {
    language,
    get: (assetId) => invoke("library.pdfTranslation", { courseId, assetId, language }),
    make: (assetId, from, to) => invoke("library.translatePdf", { courseId, assetId, language, from, to }),
    cancel: () => void invoke("library.cancelPdfTranslation", {}),
  } : undefined, [courseId, language]);
  const collectButton = IN_APP && !FIXTURE_MODE ? (
    <button aria-label={collecting ? "수집 중…" : "자료 수집"} title={collecting ? "수집 중…" : "자료 수집"} onClick={() => void collect()} disabled={collecting}><Icon name="refresh" /></button>
  ) : null;

  const selectAction = (selection: SelectedText, intent: SelectionIntent) => {
    setSelectionRequest({ id: crypto.randomUUID(), selection: { ...selection }, intent,
      ...(activeSessionId ? { targetSessionId: activeSessionId } : {}) });
    setView("chat");
    setRightTab("chat");
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
    <div className={`${narrow ? "app narrow" : "app"} study-app ${home?'at-home':''} ${pinned?'sidebar-pinned':''} ${drawer?'sidebar-open':''} ${edge&&!pinned&&!drawer?'sidebar-edge':''}`}>
      {pinned||drawer?null:<div className="edge-zone" aria-hidden="true" onMouseEnter={()=>{clearTimeout(edgeTimer.current);edgeTimer.current=setTimeout(()=>setEdge(true),EDGE_OPEN_DELAY_MS);}} onMouseLeave={()=>{if(!edge)clearTimeout(edgeTimer.current);}}/>}
      <nav className="icon-rail" aria-label="목적별 탐색">{[['home','대시보드'],['book','강의 자료'],['tasks','과제'],['notice','공지'],['mic','녹음']].map(([id,label])=><button key={id} title={id==='mic'&&recState!=='idle'?`${label} · ${recState==='paused'?'일시정지 중':'녹음 중'}`:label} aria-label={id==='mic'&&recState!=='idle'?`${label} · ${recState==='paused'?'일시정지 중':'녹음 중'}`:label} aria-pressed={id==='home'?home:id==='mic'?!home&&rightTab==='recording':!home&&section===id} onClick={()=>{setHome(id==='home');setDrawer(false);if(id!=='home'){setSection(id==='mic'?'book':id!);if(id==='mic'){setRightTab('recording');setView('chat');}}}}><Icon name={id!}/>{id==='mic'?recLight:null}</button>)}<button className="drawer-toggle" title="과목 목록" aria-label="과목 목록" aria-expanded={drawer||pinned} onClick={()=>setDrawer(x=>!x)}><Icon name="menu"/></button></nav>
      <aside className="course-drawer" aria-label="과목 선택"><div className="drawer-heading"><strong>내 과목</strong><button title="과목 목록 고정" aria-label="과목 목록 고정" aria-pressed={pinned} onClick={()=>{setPinned(x=>!x);setDrawer(false);setEdge(false);}}><Icon name="pin"/></button></div>{courses.map(c=><button className="entry" aria-pressed={library?.course.id===c.id} key={c.id} onClick={()=>{void chooseCourse(c.id);setHome(false);setDrawer(false);setEdge(false);}}><Icon name="book"/>{c.title}</button>)}</aside>
      <header className="topbar">
        <strong className="wordmark">Learning<span>XXX</span>{devLabel ? <small className="build-tag" title={buildDetail(build)}>{devLabel}</small> : null}</strong>
        {recState !== "idle" ? <button type="button" className={`rec-pill ${recState}`} onClick={() => { setRightTab("recording"); setView("chat"); }} title="녹음 화면으로">{recLight}{recState === "paused" ? "녹음 일시정지" : "녹음 중"}</button> : null}
        <span role="status">수집: {status}</span>
        {library ? collectButton : null}
        {IN_APP || FIXTURE_MODE ? <JobQueue /> : null}
        {IN_APP && !FIXTURE_MODE ? <SignInSettings /> : null}
        {courses.length > 1 && library ? (
          <label className="course-picker">과목{" "}
            <select value={library.course.id} onChange={(e) => void chooseCourse(e.target.value)}>
              {courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </label>
        ) : null}
        <span>{library ? library.course.title : "과목 없음"} · {activeSessionId ? "세션 선택됨" : "세션 없음"}</span>
        {IN_APP && !FIXTURE_MODE ? <button aria-label="앱 수정" title="앱 수정" aria-expanded={modifying} onClick={() => setModifying((open) => !open)}><Icon name="code" /></button> : null}
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
        <div className={`week-tray ${tray?'is-open':''} ${trayDismissed?'is-dismissed':''}`} onMouseLeave={() => setTray(false)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTray(false); }}>
          <button className="week-handle" onMouseEnter={() => { setTrayDismissed(false); setTray(true); }} onFocus={() => { setTrayDismissed(false); setTray(true); }} aria-expanded={tray} onClick={()=>{setTrayDismissed(false);setTray(true);}} onKeyDown={(event)=>{if(event.key==="Escape"){setTray(false);setTrayDismissed(true);event.currentTarget.blur();}}}>{library?.weeks[weekIndex]?.week.label??'학습 자료'} <span>⌄</span></button>
          <div className="week-drop"><div className="week-tabs">{library?.weeks.map((w,i)=><button key={w.week.id} aria-pressed={i===weekIndex} onClick={()=>setWeekIndex(i)}>{w.week.label}</button>)}</div><button aria-pressed={weekIndex===-1} onClick={()=>setWeekIndex(-1)}>기타 자료</button><div className="week-files">{(weekIndex===-1?library?.other:library?.weeks[weekIndex]?.entries)?.map(e=><button key={e.resource.id} aria-pressed={selected?.resource.id===e.resource.id} onClick={(event)=>{selectEntry(e);setTray(false);setTrayDismissed(true);event.currentTarget.blur();}}><Icon name={e.resource.kind==='assignment'?'tasks':'book'}/>{e.resource.title}<Badges item={itemForResource(learning.status,e.resource)}/></button>)}
            {(()=>{
              // WBS-065: a week's recordings sit under the lecture they were filed with, the rest under the week.
              const week=weekIndex===-1?undefined:library?.weeks[weekIndex]?.week;
              const videos=rowsForWeek(lectures.rows, week?.label, library?.weeks.map(w=>w.week.label)??[]);
              const recs=week?weekRecordings(lectures.media, week.id):[];
              const rec=(r:RecordingRow,nested?:boolean)=><RecordingFile key={r.recording.id} row={r} nested={nested} selected={r.asset!==undefined&&r.asset.id===mediaAssetId} onOpen={openRecording}/>;
              const unfiled=week||!library?[]:unfiledRecordings(lectures.media?.recordings??[], library.weeks.map(w=>w.week), learning.status);
              // WBS-074: every week shows, also one with nothing in it yet.
              const empty=week&&!library?.weeks[weekIndex]?.entries.length&&!videos.length&&!recs.length;
              return <>
                {empty?<p className="meta week-empty">이 주차에는 아직 자료가 없습니다.</p>:null}
                {videos.map(row=>{const lmsItem=learning.status?.items.find(i=>i.sourceRef===`commons:${row.sourceId}`);return <div className="lecture-group" key={row.sourceId}><VideoFile row={row} lms={<Badges item={lmsItem}/>} playing={playing?.id!==undefined&&playing.id===row.asset?.id} onDownload={(id)=>void lectures.download(id)} onPlay={(asset)=>{setSelected(undefined);setPlaying(asset);setMediaAssetId(asset.id);setTray(false);setTrayDismissed(true);}} />
                  {canWatch(lmsItem)?<button className="watch-lms" title="LMS 공식 플레이어로 시청(출석 반영)" onClick={()=>void watch(lmsItem.moduleItemId)}><Icon name="play"/>LMS에서 시청</button>:null}
                  {recs.filter(r=>r.recording.lectureSourceId===row.sourceId).map(r=>rec(r,true))}</div>;})}
                {recs.filter(r=>!videos.some(v=>v.sourceId===r.recording.lectureSourceId)).map(r=>rec(r))}
                {unfiled.length?<button className="recording-file unfiled" onClick={()=>{setRightTab('recording');setView('chat');setTray(false);setTrayDismissed(true);}}><Icon name="mic"/><span><span className="video-title">주차를 확인할 녹음 {unfiled.length}개</span><small>녹음 탭에서 추정 주차를 확인하고 옮기세요</small></span></button>:null}
              </>;
            })()}</div>
          {upNext?<p className="up-next">다음 미시청 강의: {upNext.weekLabel?`${upNext.weekLabel} · `:''}{upNext.title}{upNext.dueAt?` · 출석 마감 ${new Date(upNext.dueAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'})}`:''} <button className="link-button" onClick={()=>void watch(upNext.moduleItemId)}>LMS에서 시청</button></p>:null}
          {watchNotice?<p className="meta" role="status">{watchNotice}</p>:null}
          {lectures.loading?<p className="meta">동영상 강의 목록을 학교 서버에서 확인하는 중…</p>:null}
          {lectures.notice?<p className="meta" role="status">동영상 강의: {lectures.notice} <button className="link-button" onClick={()=>void lectures.reload()}>다시 확인</button></p>:null}</div>
        </div>
        {panel("library", "과목과 자료", library ? (
          <>
            {section==='book'?<><button className="entry knowledge-entry" aria-pressed={knowledgeOpen} onClick={()=>{setPlaying(undefined);setKnowledgeOpen(true);setView('materials');}}><Icon name="file"/>과목 정리 (course.md)</button><LibraryPanel library={library} selectedId={selected?.resource.id} onSelect={selectEntry} now={now} status={learning.status} /></>:section!=='mic'?<><h2>{section==='tasks'?'과제':'공지'}</h2>{section==='tasks'
                // WBS-075: by week, closed by default; to-do and submitted apart.
                ?<TaskSidebar library={library} status={learning.status} selectedId={selected?.resource.id} onSelect={selectEntry} onOpenQuiz={(item)=>void openQuiz(item)}/>
                :entriesOf(library).filter(e=>e.resource.kind==='notice').map(e=><button className="entry" key={e.resource.id} onClick={()=>selectEntry(e)}>{e.resource.title}</button>)}
              {section==='tasks'?<MentionList mentions={mentions.filter(m=>m.courseId===library.course.id)} sourceTitle={(id)=>lectures.media?.assets.find(a=>a.id===id)?.title??'녹음'}
                onOpen={(m)=>{setMediaAssetId(m.assetId);setRightTab('transcripts');setView('chat');}}
                onRemove={(m)=>void invoke("media.removeMention",{courseId:m.courseId,mentionId:m.id}).then((r)=>{if(r.ok)setMentions(x=>x.filter(y=>y.id!==m.id));})}/>:null}
              {section==='tasks'&&watchNotice?<p className="meta" role="status">{watchNotice}</p>:null}</>:null}
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
          knowledgeOpen && library && !playing ? <CourseKnowledge key={library.course.id} courseId={library.course.id} courseTitle={library.course.title} /> : playing && library && playing.courseId === library.course.id ? <VideoViewer courseId={library.course.id} asset={playing} /> : <Viewer entry={selected} lms={selectedItem ? <><Badges item={selectedItem}/>{selectedItem.moduleItemId ? <ViewRecordNote view={learning.views[selectedItem.moduleItemId]} onRetry={()=>void recordView(selectedItem.moduleItemId!, true)}/> : null}</> : undefined} {...(library ? { loadAsset } : {})} translator={translator} open={openPdfInBrowser} now={now} onSelectionAction={selectAction} location={location} onPage={onPage} onSnapshot={onSnapshot} />
        ))}
        {panel("chat", "학습 도구", <>
          <div className="right-tabs" role="tablist" aria-label="학습 도구" onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const tabs = ['chat', 'recording', 'transcripts'] as const;
            const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[2] : tabs[(tabs.indexOf(rightTab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3]!;
            setRightTab(next);
            document.getElementById(`tool-${next}`)?.focus();
          }}>
            {([['chat', '채팅'], ['recording', '녹음'], ['transcripts', '전사']] as const).map(([id, label]) => <button key={id} id={`tool-${id}`} role="tab" tabIndex={rightTab === id ? 0 : -1} aria-selected={rightTab === id} aria-controls={id === "chat" ? "tool-panel-chat" : "tool-panel-media"} onClick={() => setRightTab(id)}><Icon name={id === 'chat' ? 'chat' : id === 'recording' ? 'mic' : 'file'} />{label}{id === 'recording' ? recLight : null}</button>)}
          </div>
          <div className="tool-pane" id="tool-panel-chat" role="tabpanel" aria-labelledby="tool-chat" hidden={rightTab !== 'chat'}>
            {window.host ? <RichChatPanel viewing={viewing} selectedAssets={selected?.assets.map(a => ({ id: a.id, name: a.originalName })) ?? []} courseId={library?.course.id} courseTitle={library?.course.title} activeId={activeSessionId} onActiveId={setActiveSessionId} selectionRequest={selectionRequest} onSelectionUsed={selectionUsed} /> : <p className="empty-tool">앱 안에서 실행하면 채팅할 수 있습니다.</p>}
          </div>
          <div className="tool-pane recording-pane" id="tool-panel-media" role="tabpanel" aria-labelledby={rightTab === "transcripts" ? "tool-transcripts" : "tool-recording"} hidden={rightTab === "chat"}>
            {(IN_APP || FIXTURE_MODE) && library ? <RecordingPanel key={library.course.id} courseId={library.course.id} view={rightTab === "transcripts" ? "transcripts" : "recording"} onState={setRecState}
              weeks={weekList} lectures={lectures.rows} status={learning.status} selectedAssetId={mediaAssetId} onSelectAsset={setMediaAssetId} onChanged={recordingsChanged} /> : <p className="empty-tool">과목을 선택한 뒤 Mac 앱에서 녹음할 수 있습니다.</p>}
          </div>
        </>)}
      </main>
    </div>
  );
}
