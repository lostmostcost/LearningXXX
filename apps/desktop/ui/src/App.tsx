import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Course, IpcResponse, LectureMention, MediaAsset, PreferredLanguage } from "@learningxxx/contracts";
import { FIXTURE_MANIFEST, loadFixtureAsset } from "./fixtures.ts";
import { invoke, onHostPush } from "./host-api.ts";
import { onAssistNavigation, type AssistNavigation } from './assist-navigation.ts';
import { EDGE_OPEN_DELAY_MS, edgeClosesAt, isNarrow, nextPanel, readToolsWidth, toggleWorkspaceTool, TOOLS_WIDTH_KEY, workspacePanels } from "./layout.ts";
import type { Panel, WorkspaceSection, WorkspaceTools } from "./layout.ts";
import { screenContextLabel, screenViewing, type ScreenContext } from './screen-context.ts';
import { Dashboard, Icon, entriesOf } from "./StudyUI.tsx";
import brandLogo from "../../../../assets/branding/yolo-univ-logo.png";
import { RichChatPanel } from "./RichChatPanel.tsx";
import { AssignmentPanel, useAssignment } from "./AssignmentPanel.tsx";
import { ArtifactPanel } from './ArtifactPanel.tsx';
import { CourseKnowledge } from "./CourseKnowledge.tsx";
import { SyllabusInfo } from "./SyllabusInfo.tsx";
import { MemoPanel } from "./MemoPanel.tsx";
import { AddMaterials, ManualControls } from "./AddMaterials.tsx";
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
import { ToolsResizer } from "./ToolsResizer.tsx";
import { recordingSession, recordingState, useRecordingSession } from "./recording-session.ts";
import { RecordingFile } from "./RecordingPlace.tsx";
import { MentionList } from "./Mentions.tsx";
import { TaskSidebar, WeekTasks } from "./TaskSidebar.tsx";
import { JobQueue } from "./JobQueue.tsx";
import { currentWeekIndex, unfiledRecordings, weekRecordings, type RecordingRow } from "./recording-weeks.ts";
import { VideoFile, VideoViewer, useVideoLectures } from "./VideoLectures.tsx";
import { rowsForWeek } from "./video-lectures.ts";
import { openPdfInBrowser } from "./pdf-browser.ts";
import { SignInSettings } from "./SignInSettings.tsx";
import { ThemeToggle } from "./ThemeControls.tsx";
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
  const course = courseId ? courses.find((c) => c.id === courseId) : courses[0];
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
  const windowWidth = useWindowWidth();
  const narrow = isNarrow(windowWidth);
  const [home,setHome]=useState(true);
  const [pinned,setPinned]=useState(false);
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
  const [section,setSection]=useState<WorkspaceSection>("book");
  const [tools, setTools] = useState<WorkspaceTools>({ chat: false, memo: false });
  const toolsOpen = tools.chat || tools.memo;
  const openTool = (tool: keyof WorkspaceTools) => setTools(value => ({ ...value, [tool]: true }));
  const toggleTool = (tool: keyof WorkspaceTools) => {
    setTools(value => toggleWorkspaceTool(value, tool));
    document.getElementById(`toggle-${tool}`)?.focus();
  };
  const [weekIndex,setWeekIndex]=useState(0);
  // WBS-082: the course summary (course.md) open in the viewer instead of a material.
  const [knowledgeOpen,setKnowledgeOpen]=useState(false);
  const [explanationOpen, setExplanationOpen] = useState(false);
  const [tray,setTray]=useState(false);
  const [trayDismissed, setTrayDismissed] = useState(false);
  const courseEpoch=useRef(0);
  const [status, setStatus] = useState(FIXTURE_MODE ? "합성 데이터(fixture) 모드" : "확인 중");
  const [collecting, setCollecting] = useState(false);
  const [library, setLibrary] = useState<Library | undefined>(FIXTURE_MODE ? buildLibrary(FIXTURE_MANIFEST) : undefined);
  const libraryRef = useRef(library); libraryRef.current = library;
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
  const lectures=useVideoLectures(IN_APP||FIXTURE_MODE?library?.course.id:undefined,tray||(!home&&section==='media'));
  /** The recording or lecture selected in the independent media screen. */
  const [mediaAssetId, setMediaAssetId] = useState<string>();
  const openRecording=(row:RecordingRow)=>{if(!row.asset)return;setMediaAssetId(row.asset.id);setSection('media');setHome(false);setTray(false);setTrayDismissed(true);};
  const { refresh: refreshMedia } = lectures;
  const recordingsChanged = useCallback(() => void refreshMedia(), [refreshMedia]);
  const selectEntry=(entry:Entry, sourceLibrary=library)=>{setExplanationOpen(false);setPlaying(undefined);setKnowledgeOpen(false);setHome(false);setSection(s=>s==='tasks'&&entry.resource.kind==='assignment'||s==='notice'&&entry.resource.kind==='notice'?s:'book');setSelected(entry);const index=sourceLibrary?.weeks.findIndex(w=>w.week.id===entry.resource.weekId)??-1;setWeekIndex(index);};
  const now = new Date();
  const refs = useRef<Partial<Record<Panel, HTMLElement | null>>>({});
  // LMS completion/attendance/submission badges; read again after each collection (WBS-055).
  const learning = useLearningStatus(library?.course.id, status);
  // WBS-105: a course opens on this week (the LMS's week openings, else the academic calendar), not on week 1.
  // When the LMS status arrives later the guess is refined, unless the user picked a week or an item meanwhile.
  const autoWeek = useRef<{ courseId: string; index: number; withStatus: boolean } | undefined>(undefined);
  useEffect(() => {
    if (!library) return;
    const id = library.course.id, withStatus = learning.status?.courseId === id;
    const prev = autoWeek.current;
    if (prev?.courseId === id && (prev.withStatus || !withStatus)) return;
    if (prev?.courseId === id && weekIndex !== prev.index) { autoWeek.current = { ...prev, withStatus: true }; return; }
    const chosen = selected?.resource.weekId ? library.weeks.findIndex((w) => w.week.id === selected.resource.weekId) : -1;
    const index = chosen >= 0 ? chosen : currentWeekIndex(library.weeks.map((w) => w.week), withStatus ? learning.status : undefined, new Date());
    autoWeek.current = { courseId: id, index: index >= 0 ? index : weekIndex, withStatus: withStatus || chosen >= 0 };
    if (index >= 0 && index !== weekIndex) setWeekIndex(index);
  }, [library, learning.status, weekIndex, selected]);
  // WBS-064: red light on the recording tab, the mic rail button and the top bar while recording.
  // WBS-103: the tools column's width, dragged by the user and kept on this Mac.
  const [toolsWidth, setToolsWidth] = useState<number | undefined>(() => readToolsWidth(typeof localStorage === "undefined" ? undefined : localStorage));
  const resizeTools = useCallback((width: number, done: boolean) => {
    setToolsWidth(width);
    if (done) { try { localStorage.setItem(TOOLS_WIDTH_KEY, String(width)); } catch { /* kept for this window only */ } }
  }, []);
  const resetTools = useCallback(() => { setToolsWidth(undefined); try { localStorage.removeItem(TOOLS_WIDTH_KEY); } catch { /* nothing saved */ } }, []);
  // WBS-102: the recording belongs to the window, not to the course on screen.
  const recording = useRecordingSession();
  const recState: RecordingState = recordingState(recording);
  const recLight = recState === "idle" ? null : <span className={`rec-light ${recState}`} aria-hidden="true" />;
  // WBS-061: which code this development run is, also in the window title.
  const [build, setBuild] = useState<IpcResponse<"app.build">>();
  useEffect(() => { void invoke("app.build", {}).then((r) => { if (r.ok) setBuild(r.data); }); }, []);
  const devLabel = buildLabel(build);
  useEffect(() => { document.title = devLabel ? `YOLO UNIV — ${devLabel}` : "YOLO UNIV"; }, [devLabel]);
  const selectedItem = selected ? itemForResource(learning.status, selected.resource) : undefined;
  // Keep the hidden viewer mounted on Home, while exposing only the actual
  // screen's resource to chat, memo and LMS view tracking.
  const sectionEntry = section === 'book' || section === 'tasks' && selected?.resource.kind === 'assignment' || section === 'notice' && selected?.resource.kind === 'notice' ? selected : undefined;
  const visibleEntry = home ? undefined : sectionEntry;
  const showingResource = section !== 'book' || !explanationOpen && !knowledgeOpen && !playing;
  const assignmentScope = IN_APP && !FIXTURE_MODE && !!visibleEntry && showingResource && library && visibleEntry.resource.kind === 'assignment' && selectedItem?.kind !== 'quiz' ? { courseId: library.course.id, assignmentId: visibleEntry.resource.id } : undefined;
  const assignment = useAssignment(assignmentScope);
  useEffect(() => { if (!library?.weeks[weekIndex]) setExplanationOpen(false); }, [library?.course.id, weekIndex]);
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
  const target = visibleEntry ? viewTarget(visibleEntry) : undefined;
  const shownPdf = showingResource && target?.kind === "pdf" && shownPage?.assetId === target.asset.id;
  useEffect(() => {
    if (shownPdf && canRecordView(selectedItem, new Date())) void recordView(selectedItem.moduleItemId);
  }, [shownPdf, selectedItem, recordView]);
  // WBS-082: what is open, sent with each chat message so "이번 주"·"이 자료" mean this.
  const screenContext = useMemo<ScreenContext>(() => {
    const resource = section === 'book' && explanationOpen ? { title: '주차 설명 영상' } : section === 'book' && knowledgeOpen ? { title: '과목 요약' }
      : section === 'book' && playing ? { title: playing.title } : visibleEntry ? { title: visibleEntry.resource.title,
        ...(shownPdf && shownPage ? { page: shownPage.page } : {}) } : undefined;
    const week = (visibleEntry?.resource.weekId ? library?.weeks.find(w => w.week.id === visibleEntry.resource.weekId) : library?.weeks[weekIndex])?.week.label;
    return { section: home ? 'home' : section, courseId: library?.course.id, courseTitle: library?.course.title, week, resource };
  }, [home, section, library, visibleEntry, weekIndex, knowledgeOpen, explanationOpen, playing, shownPdf, shownPage]);
  const viewing = useMemo(() => screenViewing(screenContext), [screenContext]);
  // WBS-088: after the library is read again (e.g. a file moved week), keep showing the same material.
  useEffect(() => {
    setSelected((current) => current && library ? [...library.notices, ...library.weeks.flatMap((w) => w.entries), ...library.other].find((e) => e.resource.id === current.resource.id) : undefined);
  }, [library]);
  const panels = workspacePanels(windowWidth, home, section, tools);
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
  /** WBS-102: the top bar's 녹음 중 and the panel's note open the recording course's recording tab. */
  const openRecordingCourse = () => {
    const courseId = recordingSession.snapshot.active?.courseId;
    setHome(false); setSection("media");
    if (courseId) void chooseCourse(courseId);
  };
  const chooseCourse = useCallback(async (courseId: string) => {
    if(courseRef.current===courseId)return libraryRef.current;
    setLibrary(undefined);
    const epoch=++courseEpoch.current;
    courseRef.current = courseId;
    setSelectionRequest(undefined);setShownPage(undefined);setLocation(undefined);snapshot.current=undefined;setWeekIndex(0);setMediaAssetId(undefined);
    setSelected(undefined);
    setPlaying(undefined);
    setKnowledgeOpen(false);
    setExplanationOpen(false);
    setActiveSessionId(undefined);
    const next=FIXTURE_MODE?buildLibrary(FIXTURE_MANIFEST):(await loadLocalLibrary(courseId)).library;
    if(epoch===courseEpoch.current){setLibrary(next);return next;}
    return undefined;
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
    openTool('chat');
  };
  const selectionUsed = useCallback((id: string) => setSelectionRequest((r) => r?.id === id ? undefined : r), []);
  const openSelection = (selection: SelectedText): boolean => {
    if (!library) return false;
    const entries = [...library.notices, ...library.other, ...library.weeks.flatMap((w) => w.entries)];
    const entry = entries.find((e) => e.assets.some((a) => a.id === selection.assetId));
    if (!entry) return false;
    setExplanationOpen(false);
    setSelected(entry);
    setLocation({ id: crypto.randomUUID(), assetId: selection.assetId, page: selection.page ?? 1 });
    setHome(false); setSection('book');
    if (narrow) setTools({ chat: false, memo: false });
    return true;
  };

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "F6") return;
      event.preventDefault();
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
  const openExplanation = () => { if (!library?.weeks[weekIndex]) return; setHome(false); setSection('book'); setExplanationOpen(true); setKnowledgeOpen(false); setPlaying(undefined); setTray(false); setTrayDismissed(true); };
  const navigateSection = (id: string) => {
    setHome(id === 'home'); setExplanationOpen(false);
    if (id !== 'home') setSection(id === 'mic' ? 'media' : id as WorkspaceSection);
  };
  const assistHandler = useRef<(request: AssistNavigation) => Promise<unknown>>(undefined);
  assistHandler.current = async request => {
    if (request.op === 'catalog') return {
      courses: courses.map(c => ({ id: c.id, title: c.title })), currentCourseId: library?.course.id,
      resources: library ? entriesOf(library).map(e => ({ id: e.resource.id, title: e.resource.title, kind: e.resource.kind, weekId: e.resource.weekId })) : [],
    };
    // Global tool intents preserve the current screen and also work before a
    // course is selected, just like the top-bar buttons.
    if (!request.courseId && !request.resourceId) {
      if (request.section) navigateSection(request.section);
      if (request.tab === 'chat' || request.tab === 'memo') openTool(request.tab);
      if (request.tab === 'recording' || request.tab === 'transcripts') navigateSection('media');
      return { destination: request.section ?? (request.tab === 'recording' || request.tab === 'transcripts' ? 'media' : home ? 'home' : section), ...(request.tab ? { tab: request.tab } : {}) };
    }
    if (request.courseId && !courses.some(c => c.id === request.courseId)) throw new Error('UNKNOWN_COURSE');
    const next = request.courseId ? await chooseCourse(request.courseId) : libraryRef.current;
    if (!next || request.courseId && (courseRef.current !== request.courseId || next.course.id !== request.courseId)) throw new Error('COURSE_UNAVAILABLE');
    const entry = request.resourceId ? entriesOf(next).find(e => e.resource.id === request.resourceId) : undefined;
    if (request.resourceId && !entry) throw new Error('RESOURCE_UNAVAILABLE');
    navigateSection(request.section ?? 'book'); setEdge(false); setTray(false); setTrayDismissed(true);
    if (entry) selectEntry(entry, next);
    if (request.tab === 'chat' || request.tab === 'memo') openTool(request.tab);
    if (request.tab === 'recording' || request.tab === 'transcripts') setSection('media');
    return { courseId: next.course.id, ...(entry ? { resourceId: entry.resource.id } : {}), ...(request.tab ? { tab: request.tab } : {}) };
  };
  useEffect(() => onAssistNavigation(request => assistHandler.current!(request)), []);
  const materialViewer = <Viewer entry={sectionEntry} lms={sectionEntry?.resource.source==='manual'&&library ? <ManualControls key={sectionEntry.resource.id} courseId={library.course.id} resourceId={sectionEntry.resource.id} weeks={weekList} weekId={sectionEntry.resource.weekId} onDone={(removed)=>{if(removed)setSelected(undefined);void refresh();}}/> : sectionEntry && selectedItem ? <><Badges item={selectedItem}/>{selectedItem.moduleItemId ? <ViewRecordNote view={learning.views[selectedItem.moduleItemId]} onRetry={()=>void recordView(selectedItem.moduleItemId!, true)}/> : null}</> : undefined} {...(library ? { loadAsset } : {})} translator={translator} open={openPdfInBrowser} now={now} onSelectionAction={selectAction} location={location} onPage={onPage} onSnapshot={onSnapshot}
    empty={library ? <WeekTasks library={library} status={learning.status} weekId={weekIndex >= 0 ? library.weeks[weekIndex]?.week.id : undefined} onSelect={selectEntry} onOpenQuiz={(item) => void openQuiz(item)} /> : undefined} />;

  return (
    <div className={`${narrow ? "app narrow" : "app"} study-app ${home?'at-home':''} ${pinned?'sidebar-pinned':''} ${edge&&!pinned?'sidebar-edge':''}`}>
      {/* WBS-104: the course list opens from a half-round tab in the middle of the left edge (the rail no longer has a course button). */}
      {pinned||edge?null:<button className="edge-tab" title="과목 선택" aria-label="과목 선택 열기" aria-expanded={false} onClick={()=>{clearTimeout(edgeTimer.current);setEdge(true);setTimeout(()=>document.querySelector<HTMLButtonElement>('.course-drawer .entry')?.focus({preventScroll:true}),200);}}><Icon name="chevron"/></button>}
      {pinned?null:<div className="edge-zone" aria-hidden="true" onMouseEnter={()=>{clearTimeout(edgeTimer.current);edgeTimer.current=setTimeout(()=>setEdge(true),EDGE_OPEN_DELAY_MS);}} onMouseLeave={()=>{if(!edge)clearTimeout(edgeTimer.current);}}/>}
      <nav className="icon-rail" aria-label="목적별 탐색">{[['home','대시보드'],['book','강의 자료'],['info','강의 정보'],['tasks','과제'],['notice','공지'],['media','녹음·전사']].map(([id,label])=><button key={id} title={id==='media'&&recState!=='idle'?`${label} · ${recState==='paused'?'일시정지 중':'녹음 중'}`:label} aria-label={id==='media'&&recState!=='idle'?`${label} · ${recState==='paused'?'일시정지 중':'녹음 중'}`:label} aria-pressed={id==='home'?home:id==='media'?!home&&section==='media':!home&&section===id} onClick={()=>navigateSection(id!)}><Icon name={id==='media'?'mic':id!}/>{id==='media'?recLight:null}</button>)}</nav>
      <aside className="course-drawer" aria-label="과목 선택"><div className="drawer-heading"><strong>내 과목</strong><button title="과목 목록 고정" aria-label="과목 목록 고정" aria-pressed={pinned} onClick={()=>{setPinned(x=>!x);setEdge(false);}}><Icon name="pin"/></button></div>{courses.map(c=><button className="entry" aria-pressed={library?.course.id===c.id} key={c.id} onClick={()=>{void chooseCourse(c.id);setHome(false);setEdge(false);}}><Icon name="book"/>{c.title}</button>)}</aside>
      <header className="topbar">
        <strong className="wordmark"><button type="button" className="brand-home" title="홈으로" aria-label="YOLO UNIV 홈으로" onClick={()=>{setHome(true);setEdge(false);}}><img className="brand-logo" src={brandLogo} alt=""/></button>{/* Owner 2026-11-09: until the next release, the full development label stays beside the logo (WBS-098 had cut it to "개발"). */}
          {devLabel ? <small className="build-tag" title={buildDetail(build)}>{devLabel}</small> : null}</strong>
        {recState !== "idle" ? <button type="button" className={`rec-pill ${recState}`} onClick={() => openRecordingCourse()} title="녹음 중인 과목의 녹음 화면으로">{recLight}{recState === "paused" ? "녹음 일시정지" : "녹음 중"}</button> : null}
        <span role="status">수집: {status}</span>
        {library ? collectButton : null}
        {IN_APP || FIXTURE_MODE ? <JobQueue /> : null}
        {IN_APP && !FIXTURE_MODE ? <ThemeToggle /> : null}
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
        <div className="global-tool-toggles" role="group" aria-label="우측 패널">
          <button id="toggle-chat" type="button" aria-label={tools.chat ? '채팅 닫기' : '채팅 열기'} aria-pressed={tools.chat} aria-controls="global-chat" title="채팅" onClick={() => toggleTool('chat')}><Icon name="chat"/><span>채팅</span></button>
          <button id="toggle-memo" type="button" aria-label={tools.memo ? '메모 닫기' : '메모 열기'} aria-pressed={tools.memo} aria-controls="global-memo" title="메모" onClick={() => toggleTool('memo')}><Icon name="edit"/><span>메모</span></button>
        </div>
      </header>
      {IN_APP && !FIXTURE_MODE ? <div hidden={!modifying}><ModifyPanel /></div> : null}
      <div className={`workspace section-${home ? 'home' : section}${toolsOpen ? ' has-tools' : ''}`} data-tools-layout style={toolsWidth !== undefined && !narrow ? { '--tools-width': `${toolsWidth}px` } as React.CSSProperties : undefined}>
      <div className="workspace-main" hidden={narrow && toolsOpen}>
      <section className="home-view" aria-label="대시보드" tabIndex={-1} ref={el => { refs.current.home = el; }} hidden={!home}>
      {home?<Dashboard fixture={FIXTURE_MODE} courses={courses} onOpen={(id,entry)=>{setExplanationOpen(false);setPlaying(undefined);setKnowledgeOpen(false);setHome(false);setSection('book');void chooseCourse(id).then(()=>{if(courseRef.current===id&&entry)setSelected(entry);});}}/>:null}
      </section>
      <main className={`panels mode-${section}`} hidden={home || section === 'media'}>
        <div className={`week-tray ${tray?'is-open':''} ${trayDismissed?'is-dismissed':''}`} onMouseLeave={() => setTray(false)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTray(false); }}>
          <button className="week-handle" onMouseEnter={() => { setTrayDismissed(false); setTray(true); }} onFocus={() => { setTrayDismissed(false); setTray(true); }} aria-expanded={tray} onClick={()=>{setTrayDismissed(false);setTray(true);}} onKeyDown={(event)=>{if(event.key==="Escape"){setTray(false);setTrayDismissed(true);event.currentTarget.blur();}}}>{library?.weeks[weekIndex]?.week.label??'학습 자료'} <span>⌄</span></button>
          <div className="week-drop"><div className="week-tabs">{library?.weeks.map((w,i)=><button key={w.week.id} aria-pressed={i===weekIndex} onClick={()=>setWeekIndex(i)}>{w.week.label}</button>)}</div><button aria-pressed={weekIndex===-1} onClick={()=>setWeekIndex(-1)}>기타 자료</button>{IN_APP&&!FIXTURE_MODE&&library?.weeks[weekIndex]?<button onClick={openExplanation}>이 주차 설명 영상 만들기</button>:null}<div className="week-files">{(weekIndex===-1?library?.other:library?.weeks[weekIndex]?.entries)?.map(e=><button key={e.resource.id} aria-pressed={selected?.resource.id===e.resource.id} onClick={(event)=>{selectEntry(e);setTray(false);setTrayDismissed(true);event.currentTarget.blur();}}><Icon name={e.resource.kind==='assignment'?'tasks':'book'}/>{e.resource.title}<Badges item={itemForResource(learning.status,e.resource)}/></button>)}
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
                {videos.map(row=>{const lmsItem=learning.status?.items.find(i=>i.sourceRef===`commons:${row.sourceId}`);return <div className="lecture-group" key={row.sourceId}><VideoFile row={row} lms={<Badges item={lmsItem}/>} playing={playing?.id!==undefined&&playing.id===row.asset?.id} onDownload={(id)=>void lectures.download(id)} onPlay={(asset)=>{setExplanationOpen(false);setSelected(undefined);setHome(false);setSection('book');setKnowledgeOpen(false);setPlaying(asset);setMediaAssetId(asset.id);setTray(false);setTrayDismissed(true);}} />
                  {canWatch(lmsItem)?<button className="watch-lms" title="LMS 공식 플레이어로 시청(출석 반영)" onClick={()=>void watch(lmsItem.moduleItemId)}><Icon name="play"/>LMS에서 시청</button>:null}
                  {recs.filter(r=>r.recording.lectureSourceId===row.sourceId).map(r=>rec(r,true))}</div>;})}
                {recs.filter(r=>!videos.some(v=>v.sourceId===r.recording.lectureSourceId)).map(r=>rec(r))}
                {unfiled.length?<button className="recording-file unfiled" onClick={()=>{setSection('media');setTray(false);setTrayDismissed(true);}}><Icon name="mic"/><span><span className="video-title">주차를 확인할 녹음 {unfiled.length}개</span><small>녹음 탭에서 추정 주차를 확인하고 옮기세요</small></span></button>:null}
              </>;
            })()}</div>
          {upNext?<p className="up-next">다음 미시청 강의: {upNext.weekLabel?`${upNext.weekLabel} · `:''}{upNext.title}{upNext.dueAt?` · 출석 마감 ${new Date(upNext.dueAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'})}`:''} <button className="link-button" onClick={()=>void watch(upNext.moduleItemId)}>LMS에서 시청</button></p>:null}
          {watchNotice?<p className="meta" role="status">{watchNotice}</p>:null}
          {lectures.loading?<p className="meta">동영상 강의 목록을 학교 서버에서 확인하는 중…</p>:null}
          {lectures.notice?<p className="meta" role="status">동영상 강의: {lectures.notice} <button className="link-button" onClick={()=>void lectures.reload()}>다시 확인</button></p>:null}</div>
        </div>
        {panel("library", "과목과 자료", library ? (
          <>
            {section==='book'?<><button className="entry knowledge-entry" aria-pressed={knowledgeOpen} onClick={()=>{setExplanationOpen(false);setPlaying(undefined);setKnowledgeOpen(true);}}><Icon name="file"/>과목 요약</button>{IN_APP&&!FIXTURE_MODE&&library.weeks[weekIndex]?<button className="entry" aria-pressed={explanationOpen} onClick={openExplanation}><Icon name="play"/>이번 주 설명 영상</button>:null}{IN_APP&&!FIXTURE_MODE?<details className="add-materials-box"><summary>+ 내 자료 추가</summary><AddMaterials key={library.course.id} courseId={library.course.id} weeks={weekList} weekId={weekIndex>=0?library.weeks[weekIndex]?.week.id:undefined} onDone={()=>void refresh()}/></details>:null}<LibraryPanel library={library} selectedId={selected?.resource.id} onSelect={selectEntry} now={now} status={learning.status} /></>:section==='info'?<><h2>강의 정보</h2>
              {/* WBS-107: jumps within the syllabus shown in the middle. */}
              <nav className="syllabus-jumps" aria-label="강의 정보 바로가기">{[['syllabus-facts','교수·수업 정보'],['syllabus-grading','평가 비율'],['syllabus-weeks','주차별 계획'],['syllabus-books','교재'],['syllabus-all','전체 내용']].map(([id,label])=><button key={id} className="entry" onClick={()=>{const el=document.getElementById(id!);if(el instanceof HTMLDetailsElement)el.open=true;el?.scrollIntoView({behavior:'smooth',block:'start'});}}>{label}</button>)}</nav>
              <p className="meta">학교 강의계획서를 앱이 직접 받아 정리했습니다. 내용이 바뀌었으면 다시 받기를 누르세요.</p></>:section!=='media'?<><h2>{section==='tasks'?'과제':'공지'}</h2>{section==='tasks'
                // WBS-075: by week, closed by default; to-do and submitted apart.
                ?<TaskSidebar library={library} status={learning.status} currentWeekId={weekIndex >= 0 ? library.weeks[weekIndex]?.week.id : undefined} selectedId={selected?.resource.id} onSelect={selectEntry} onOpenQuiz={(item)=>void openQuiz(item)}/>
                :entriesOf(library).filter(e=>e.resource.kind==='notice').map(e=><button className="entry" key={e.resource.id} onClick={()=>selectEntry(e)}>{e.resource.title}</button>)}
              {section==='tasks'?<MentionList mentions={mentions.filter(m=>m.courseId===library.course.id)} sourceTitle={(id)=>lectures.media?.assets.find(a=>a.id===id)?.title??'녹음'}
                onOpen={(m)=>{setMediaAssetId(m.assetId);setSection('media');}}
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
          section === 'info' && library ? <SyllabusInfo key={library.course.id} courseId={library.course.id} courseTitle={library.course.title} weekLabel={weekIndex >= 0 ? library.weeks[weekIndex]?.week.label : undefined}
            onOpenFile={(resourceId) => { const entry = entriesOf(library).find((e) => e.resource.id === resourceId); if (entry) selectEntry(entry); }} />
          : section === 'book' && explanationOpen && library && library.weeks[weekIndex] ? <><div className="artifact-page-head"><button onClick={() => setExplanationOpen(false)}>자료로 돌아가기</button></div><ArtifactPanel key={`${library.course.id}/${library.weeks[weekIndex]!.week.id}`} scope={{ courseId: library.course.id, kind: 'video', weekId: library.weeks[weekIndex]!.week.id }} title={`${library.weeks[weekIndex]!.week.label} 설명 영상`} /></> : section === 'book' && knowledgeOpen && library && !playing ? <CourseKnowledge key={library.course.id} courseId={library.course.id} courseTitle={library.course.title} weeks={weekList} weekId={weekIndex >= 0 ? library.weeks[weekIndex]?.week.id : undefined} /> : section === 'book' && playing && library && playing.courseId === library.course.id ? <VideoViewer courseId={library.course.id} asset={playing} /> : assignmentScope ? <AssignmentPanel key={`${assignmentScope.courseId}/${assignmentScope.assignmentId}`} workspace={assignment} instructions={materialViewer} presentation={<ArtifactPanel key={`${assignmentScope.courseId}/${assignmentScope.assignmentId}`} scope={{ courseId: assignmentScope.courseId, kind: 'slides', assignmentId: assignmentScope.assignmentId }} title="과제 발표 초안 만들기" />} /> : materialViewer
        ))}
      </main>
        {panel('media', '녹음·전사', <>
          <header className="media-page-heading"><div><h1>녹음·전사</h1><p>{library?.course.title ?? '과목을 선택하세요'} · 녹음과 전사 내용을 한곳에서 확인합니다.</p></div></header>
          {(IN_APP || FIXTURE_MODE) && library ? <RecordingPanel key={library.course.id} courseId={library.course.id} view="combined" onOpenCourse={() => openRecordingCourse()}
            weeks={weekList} lectures={lectures.rows} status={learning.status} selectedAssetId={mediaAssetId} onSelectAsset={setMediaAssetId} onChanged={recordingsChanged} /> : <p className="empty-tool">과목을 선택한 뒤 녹음·전사를 확인하세요.</p>}
        </>)}
      </div>
      <aside className={`global-tools${tools.chat && tools.memo ? ' both-open' : ''}`} aria-label="우측 도구" hidden={!toolsOpen}>
        {!narrow && toolsOpen ? <ToolsResizer width={toolsWidth} onChange={resizeTools} onReset={resetTools} /> : null}
        {panel('chat', '채팅 패널', <>
          <header className="global-tool-heading"><h2 id="global-chat-title">채팅</h2><button type="button" aria-label="채팅 패널 닫기" onClick={() => toggleTool('chat')}>×</button></header>
          <div className="global-tool-body" id="global-chat" aria-labelledby="global-chat-title">
            {window.host ? <RichChatPanel screenLabel={screenContextLabel(screenContext)} viewing={viewing} selectedAssets={visibleEntry && showingResource ? visibleEntry.assets.map(a => ({ id: a.id, name: a.originalName })) : []} courseId={library?.course.id} courseTitle={library?.course.title}
              activeId={assignmentScope ? assignment.state?.sessionId : activeSessionId} onActiveId={id => { if (!assignmentScope) setActiveSessionId(id); }} fixed={!!assignmentScope} blocked={assignment.state?.phase === 'generating' && !!assignmentScope}
              selectionRequest={assignmentScope ? undefined : selectionRequest} onSelectionUsed={selectionUsed} /> : <p className="empty-tool">앱 안에서 실행하면 채팅할 수 있습니다.</p>}
          </div>
        </>)}
        {panel('memo', '메모 패널', <>
          <header className="global-tool-heading"><h2 id="global-memo-title">메모</h2><button type="button" aria-label="메모 패널 닫기" onClick={() => toggleTool('memo')}>×</button></header>
          <div className="global-tool-body" id="global-memo" aria-labelledby="global-memo-title">
            {(IN_APP || FIXTURE_MODE) && library ? <MemoPanel key={library.course.id} courseId={library.course.id} weeks={weekList}
              weekId={visibleEntry?.resource.weekId ?? (weekIndex >= 0 ? library.weeks[weekIndex]?.week.id : undefined)}
              page={shownPdf && shownPage && visibleEntry ? (() => { const a = visibleEntry.assets.find(x => x.id === shownPage.assetId); return a ? { assetId: a.id, title: a.originalName, page: shownPage.page } : undefined; })() : undefined} /> : <p className="empty-tool">과목을 선택하면 메모할 수 있습니다.</p>}
          </div>
        </>)}
      </aside>
      </div>
    </div>
  );
}
