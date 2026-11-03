import { randomUUID } from "node:crypto";
import { AUDIO_IMPORT_TYPES, AUDIO_MEDIA_TYPES } from "@learningxxx/contracts";
import { writeFileSync } from "node:fs";
import { ConversationService } from "./conversation-service.ts";
import { CourseWorkspaceService } from "./course-workspace.ts";
import { weekNotes } from "./week-notes.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CanvasClient, CollectionError, createCommonsVideoResolver, createDirectoryStore, listActiveCourses } from "@learningxxx/collector";
import { QwenEngine } from "@learningxxx/transcriber";
import { MediaService } from "./media-service.ts";
import { statfsSync } from "node:fs";
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, powerMonitor, safeStorage, session, shell, systemPreferences } from "electron";
import { AppModifier, createDockerVerifier, launchWatchdog, locateDocker } from "@learningxxx/app-modifier";
import { AttachmentService } from "./attachment-service.ts";
import { runGuiCliProbe } from "./gui-cli-probe.ts";
import { createCliRunner } from "./cli-runner.ts";
import { FileService } from "./file-service.ts";
import { SttRuntimeService } from "./stt-runtime.ts";
import { createHandlers } from "./handlers.ts";
import { LibraryService } from "./library-service.ts";
import { runLmsProbe } from "./lms-probe.ts";
import { lmsSessionReport, runLmsStatusProbe, runLmsWatch } from "./lms-status-probe.ts";
import { CredentialService } from "./credential-service.ts";
import { CredentialStore } from "./credential-store.ts";
import { createCanvasHttp, createLearningXClient, createLmsClient, learningxToken, openLoginWindow, schoolLoginDeps, allowedRedirectFetch, createLearningSources, openLmsItemPage, openLmsWatchWindow, windowSignInPage } from "./lms-session.ts";
import { pageSchoolLogin, schoolLogin } from "./school-login.ts";
import { readBuildInfo } from "./build-info.ts";
import { captureRegion } from "./native-capture.ts";
import { createRouter } from "./router.ts";
import { RunHistory } from "./run-history.ts";
import { SessionService } from "./session-service.ts";
import { SessionStore } from "./session-store.ts";
import { TranscriptStore } from "./transcript-store.ts";
import { courseBrief } from "./course-context.ts";
import { LearningStatusService, lectureVideos, summarizeLearning } from "./learning-status.ts";
import { RecordingService } from "./recording-service.ts";
import { AudioImporter } from "./audio-import.ts";
import { ChatOutputs } from "./chat-outputs.ts";
import { MemoService } from "./memos.ts";
import { EXTERNAL_TYPES, ExternalMaterials } from "./external-materials.ts";
import { CourseKnowledgeService, SYLLABUS_TITLE } from "./course-knowledge.ts";
import { pdfPageTexts } from "./pdf-text.ts";
import { PdfTranslationService, pdfTranslatePrompt } from "./pdf-translate.ts";
import { correctionPrompt, createClaudeTextRunner, createReadableRunner, mentionsPrompt, parseMentions, parseTranslation, translatePrompt } from "./readable-note.ts";
import { AutomationService } from "./automation.ts";
import { StudyNotes } from "./study-notes.ts";
import { Timetable } from "./timetable.ts";
import { Submissions } from "./submissions.ts";
import { Preferences } from "./preferences.ts";
import { runFilesSmoke, runUiSmoke } from "./ui-smoke.ts";
import { WEB_PREFERENCES, WINDOW_SIZE } from "./window-options.ts";

const INVOKE_CHANNEL = "host:invoke";
const PUSH_CHANNEL = "host:push";
const PRIVACY_PANES = {
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
} as const;
const uiEntry = join(__dirname, "../../ui/dist/index.html");

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...WINDOW_SIZE,
    show: false,
    title: "LearningXXX",
    webPreferences: { ...WEB_PREFERENCES, preload: join(__dirname, "../src/preload.cjs") },
  });
  // The window only ever shows the bundled UI.
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.once("ready-to-show", () => window.show());
  void window.loadFile(uiEntry);
  return window;
}

// One app per Mac account: two copies would share the same recordings and
// transcription queue. Diagnostic runs (smoke, probes) are exempt.
const diagnostic = process.argv.some((arg) => /^--(ui-smoke|files-smoke|probe-out|lms-probe|lms-status-probe|lms-watch|learning-status-dump|school-login-check)=/.test(arg));
if (!diagnostic && !app.requestSingleInstanceLock()) {
  app.exit(0);
} else if (!diagnostic) {
  // Launching again brings the open window forward instead of starting a second copy.
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
}

app.whenReady().then(async () => {
  if (!diagnostic && !app.hasSingleInstanceLock()) return;
  const probeOut = process.argv.find((arg) => arg.startsWith("--probe-out="))?.split("=")[1];
  if (probeOut !== undefined) {
    await runGuiCliProbe(probeOut, "/opt/homebrew/bin/claude", tmpdir());
    app.quit();
    return;
  }
  const lmsProbeOut = process.argv.find((arg) => arg.startsWith("--lms-probe="))?.split("=")[1];
  if (lmsProbeOut !== undefined) {
    await runLmsProbe(lmsProbeOut);
    app.quit();
    return;
  }
  const dataRoot = join(app.getPath("userData"), "data");
  let sessions: SessionService;
  let loginWindow: BrowserWindow | undefined;
  // Sign-in steps and HTTP statuses go to the terminal (never IDs, passwords or cookie values).
  const schoolDeps = () => schoolLoginDeps((step) => console.warn("[school-login]", step));
  const credentials = new CredentialService({
    store: new CredentialStore(join(app.getPath("userData"), "credentials.bin"), {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (data) => safeStorage.decryptString(data),
    }),
    login: (schoolId, password) => schoolLogin(schoolDeps(), schoolId, password),
    signedIn: async () => (await learningxToken()) !== undefined,
    checkCanvasToken: async (token) => {
      try {
        await new CanvasClient({ getAuthHeaders: async () => ({ Authorization: `Bearer ${token}` }) }).getObject("/api/v1/users/self");
        return "ok";
      } catch (error) {
        return error instanceof CollectionError && error.appError.code === "AUTH_REQUIRED" ? "rejected" : "failed";
      }
    },
  });
  // WBS-071/083: preferred language and automation settings.
  const preferences = new Preferences(join(dataRoot, "preferences.json"));
  // WBS-083: the automatic steps; created once everything they use exists.
  let automation: AutomationService | undefined;
  // WBS-088: the student's own files, added to the served course material (declared before the library uses it).
  let externals: ExternalMaterials | undefined;
  const library = new LibraryService({
    root: join(dataRoot, "library"),
    extend: (manifest) => externals ? externals.merge(manifest) : Promise.resolve(manifest),
    client: () => createLmsClient(() => credentials.canvasToken()),
    ensureSignedIn: () => credentials.ensureSignedIn(),
    discoverCourses: listActiveCourses,
    learningx: createLearningXClient,
    onProgress: (syncRun) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(PUSH_CHANNEL, { kind: "collection.progress", syncRun });
      if (syncRun.courseId && (syncRun.status === "succeeded" || syncRun.status === "partial")) automation?.changed(syncRun.courseId);
    },
    // One login window at a time; the user signs in there and runs collection again.
    openLogin: () => {
      if (loginWindow && !loginWindow.isDestroyed()) return void loginWindow.focus();
      loginWindow = openLoginWindow();
    },
  });
  await library.init();
  externals = new ExternalMaterials({
    root: join(dataRoot, "external-materials"), accountKey: () => library.accountKey(), store: createDirectoryStore(join(dataRoot, "library")),
    collected: (courseId) => library.manifest(courseId),
    chooseFiles: async () => {
      const picked = await dialog.showOpenDialog({ title: "추가할 자료 선택", properties: ["openFile", "multiSelections"], filters: [{ name: "학습 자료", extensions: Object.keys(EXTERNAL_TYPES) }] });
      return picked.canceled ? undefined : picked.filePaths;
    },
  });
  // WBS-056 check: the sign-in session before and after one sign-in with the saved details.
  // Writes cookie names and HTTP statuses only.
  const loginCheck = process.argv.find((arg) => arg.startsWith("--school-login-check="))?.split("=")[1];
  if (loginCheck !== undefined) {
    const before = await lmsSessionReport();
    const hidden = new BrowserWindow({ show: false, webPreferences: { partition: "persist:lms", sandbox: true, contextIsolation: true } });
    const ok = await credentials.signInAgain((id, pw) => pageSchoolLogin(schoolDeps(), windowSignInPage(hidden.webContents), id, pw));
    hidden.destroy();
    const after = await lmsSessionReport();
    writeFileSync(loginCheck, `${JSON.stringify({ before, signInAgain: ok, after }, null, 2)}\n`);
    app.quit();
    return;
  }
  // WBS-054 read-only measurement modes; see lms-status-probe.ts.
  const statusProbeOut = process.argv.find((arg) => arg.startsWith("--lms-status-probe="))?.split("=")[1];
  const watchOut = process.argv.find((arg) => arg.startsWith("--lms-watch="))?.split("=")[1];
  if (statusProbeOut !== undefined || watchOut !== undefined) {
    const ensureSignedIn = () => credentials.ensureSignedIn();
    if (statusProbeOut !== undefined) {
      await runLmsStatusProbe(statusProbeOut, { ensureSignedIn, learningxToken, canvas: () => createLmsClient(() => credentials.canvasToken()), courses: () => library.courses() });
    } else {
      await runLmsWatch(watchOut!, { ensureSignedIn });
    }
    app.quit();
    return;
  }
  const attachments = new AttachmentService({
    capture: () => captureRegion({
      permission: () => systemPreferences.getMediaAccessStatus("screen"),
      // WBS-080: a screen source query is what makes macOS ask and list the app under Screen Recording.
      requestAccess: async () => { await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }); },
    }),
    dataRoot, getSession: (id) => sessions.get(id), accountKey: () => library.accountKey(),
    readAsset: (courseId, assetId) => library.attachmentSource(courseId, assetId),
    chooseLocal: async () => {
      const selected = await dialog.showOpenDialog({ title: "첨부할 파일 선택", properties: ["openFile"], filters: [{ name: "학습 자료", extensions: ["pdf", "txt", "md", "csv", "json", "png", "jpg", "jpeg", "webp"] }] });
      return selected.canceled ? undefined : selected.filePaths[0];
    },
  });
  sessions = new SessionService({
    dataRoot,
    attachments,
    store: new SessionStore(join(dataRoot, "app-state.json")),
    transcripts: new TranscriptStore(join(dataRoot, "transcripts")),
    courseContext: async (courseId, materialsDir) => {
      const found = await library.materials(courseId, materialsDir);
      if (!found) return undefined;
      return {
        brief: courseBrief(found.manifest, { dir: materialsDir, entries: found.entries }),
        paths: new Map(found.entries.map((e) => [e.assetId, { path: e.path, textPath: e.textPath }])),
      };
    },
    startCli: createCliRunner(),
    history: (now) => new RunHistory(join(dataRoot, "history"), now),
    onEvent: (event) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(PUSH_CHANNEL, { kind: "run.event", event });
    },
  });

  const files = new FileService({
    dataRoot,
    sessions,
    history: sessions.history!,
    chooseFolder: async () => {
      const picked = await dialog.showOpenDialog({ title: "작업 폴더 선택", properties: ["openDirectory", "createDirectory"] });
      return picked.canceled ? undefined : picked.filePaths[0];
    },
    confirmTrash: async (path) => {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        message: "이 파일을 휴지통으로 옮길까요?",
        detail: path,
        buttons: ["취소", "휴지통으로 이동"],
        defaultId: 0,
        cancelId: 0,
      });
      return response === 1;
    },
    trash: (path) => shell.trashItem(path),
  });
  const startCli = createCliRunner();
  const claudeText = createClaudeTextRunner(startCli, join(dataRoot, "readable-runs"));
  // WBS-072: the original is looked up through the manifest and re-hashed, like any viewer request.
  const pdfTranslations = new PdfTranslationService({
    root: join(dataRoot, "pdf-translations"), accountKey: () => library.accountKey(),
    original: async (courseId, assetId) => {
      const asset = (await library.manifest(courseId))?.items.flatMap((i) => i.assets).find((a) => a.id === assetId);
      const { bytes, mediaType } = await library.asset({ courseId, assetId });
      return { bytes, mediaType, sha256: asset?.sha256 ?? "" };
    },
    translate: async ({ language, lines, signal }) => parseTranslation(await claudeText({ prompt: pdfTranslatePrompt(language, lines), what: "PDF 번역", signal }), lines.length),
  });
  const dockerPath = locateDocker();
  const modifier = new AppModifier({
    root: join(dataRoot, "app-modifier"),
    // apps/desktop/host → repository root. Only this app's own source can be changed.
    expectedSource: resolve(app.getAppPath(), "../../.."),
    startCli,
    verifier: createDockerVerifier(dockerPath),
    chooseFolder: async () => {
      const picked = await dialog.showOpenDialog({ title: "앱 소스 폴더 선택", properties: ["openDirectory"] });
      return picked.canceled ? undefined : picked.filePaths[0];
    },
    confirm: async (message, detail, action) => {
      const { response } = await dialog.showMessageBox({ type: "warning", message, detail, buttons: ["취소", action], defaultId: 0, cancelId: 0 });
      return response === 1;
    },
    // The watchdog starts the new app once this one is gone, then restores the last good app if it never comes up.
    restart: (planPath) => {
      launchWatchdog(process.execPath, planPath);
      app.exit(0);
    },
    launch: { execPath: process.execPath, args: process.argv.slice(1), cwd: process.cwd() },
    onJob: (job) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(PUSH_CHANNEL, { kind: "modify.job", job });
    },
  });
  let media: MediaService;
  const recordings = new RecordingService({
    dataRoot,
    micPermission: async () => {
      const status = systemPreferences.getMediaAccessStatus("microphone");
      if (status === "granted") return "granted";
      if (status === "not-determined") return (await systemPreferences.askForMediaAccess("microphone")) ? "granted" : "denied";
      return "denied";
    },
    freeBytes: (path) => {
      const stats = statfsSync(path);
      return stats.bavail * stats.bsize;
    },
    onOriginalConfirmed: (asset) => { void media.register(asset).catch(() => { /* Durable originals are reconciled on refresh/startup. */ }); },
    onStopped: (recording, asset) => {
      void media.authorize(recording.courseId).then(() => {
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send(PUSH_CHANNEL, { kind: "recording.stopped", recording, ...(asset ? { asset } : {}) });
      }).catch(() => undefined);
    },
  });
  const sttRoot = join(app.getPath("userData"), "stt");
  const engine = new QwenEngine({ python: join(sttRoot, ".venv/bin/python"), script: resolve(app.getAppPath(), "../../../services/transcriber/python/transcribe.py"), modelHome: join(sttRoot, "hf") });
  const stt = new SttRuntimeService({ root: sttRoot, source: resolve(app.getAppPath(), "../../../services/transcriber"), model: String(engine.parameters.model), onReady: async () => { if (library.accountKey()) await media.retryUnavailable(); } });
  media = new MediaService({
    dataRoot, accountKey: () => library.accountKey(), courses: () => library.courses(),
    originals: () => recordings.originals(), recordings: (courseId) => recordings.list({ courseId }).recordings,
    engine: { info: engine.info, parameters: engine.parameters, transcribe: input => stt.run(async () => { input.signal.throwIfAborted(); return engine.transcribe(input); }) },
    contextFor: async (asset) => (await library.manifest(asset.courseId))?.items.map((i) => i.resource.title).join("\n").slice(0, 4000) ?? "",
    // WBS-069: readable notes through the official CLI, in the most restricted (independent) mode.
    readable: createReadableRunner(startCli, join(dataRoot, "readable-runs")),
    // WBS-070: the same restricted runner; the answer is checked against the transcript.
    // WBS-071: one batch of sentences per request.
    translate: async ({ language, lines, signal }) => parseTranslation(await claudeText({ prompt: translatePrompt(language, lines), what: "번역", signal }), lines.length),
    mentions: async ({ title, text, transcript, signal }) => parseMentions(await claudeText({ prompt: mentionsPrompt(title, text), what: "과제·시험 안내 찾기", signal }), transcript),
    // WBS-083: automatic correction, and the hook that starts the automatic steps.
    correct: async ({ title, context, lines, signal }) => parseTranslation(await claudeText({ prompt: correctionPrompt(title, context, lines), what: "자동 교정", signal }), lines.length),
    onTranscribed: (input) => automation?.transcribed(input),
    openOriginal: async (path) => { const error = await shell.openPath(path); if (error) throw new Error("원본을 여는 시스템 플레이어를 확인하세요."); },
    videos: async (course) => {
      await credentials.ensureSignedIn();
      const modules = await createLearningXClient().modules(course.sourceCourseId);
      return lectureVideos(modules);
    },
    video: (_course, contentId) => {
      const allowedOrigins = ["https://commons.khu.ac.kr"];
      const fetch = allowedRedirectFetch(allowedOrigins);
      return { fetch, resolveSource: createCommonsVideoResolver({ contentId, fetch }), allowedOrigins };
    },
  });
  // WBS-077: recordings the student made elsewhere, picked as audio files.
  const importer = new AudioImporter({
    chooseFiles: async () => {
      const picked = await dialog.showOpenDialog({ title: "가져올 녹음 파일 선택", properties: ["openFile", "multiSelections"], filters: [{ name: "녹음 파일", extensions: [...AUDIO_IMPORT_TYPES] }] });
      return picked.canceled ? undefined : picked.filePaths;
    },
    store: async ({ type, ...input }) => {
      const { asset } = recordings.importOriginal({ ...input, mediaType: AUDIO_MEDIA_TYPES[type], ext: type, recordingId: randomUUID(), assetId: randomUUID() });
      await media.register(asset);
      return asset;
    },
  });
  // Recordings cut off by a quit or crash are confirmed from what reached the disk.
  await recordings.recover().catch(() => undefined);
  // A corrupt media catalog must not prevent the UI from opening to show its error.
  if (library.accountKey()) await media.recover().catch(() => undefined);
  // Jobs that failed only because the engine was missing run again once it is
  // ready, also when it was prepared in an earlier run (onReady fires only
  // right after preparing in this one).
  void stt.status(true).then(async (s) => {
    if (s.state === "ready" && library.accountKey()) await media.retryUnavailable();
  }).catch(() => undefined);
  let conversations: ConversationService;
  // WBS-078: what the app keeps per week (transcripts, notes, assignment/notice text) goes into the course folder too.
  const seoul = (utc: string) => new Date(utc).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const notesFor = async (courseId: string) => {
    const manifest = await library.manifest(courseId);
    if (!manifest) return [];
    const listed = await media.list(courseId).catch(() => undefined);
    return weekNotes({
      manifest, media: listed, formatTime: seoul,
      doc: async (assetId, kind) => (await media.importedDoc(courseId, assetId, kind).catch(() => undefined))?.text,
      learning: await learning.status(courseId).catch(() => undefined),
      mentions: (await media.mentions(courseId).catch(() => undefined))?.mentions,
    });
  };
  // WBS-082: course.md, made on request from the syllabus, the material list and the transcripts.
  const knowledge = new CourseKnowledgeService({
    root: join(dataRoot, 'course-knowledge'), accountKey: () => library.accountKey(),
    sources: async (courseId) => {
      const manifest = await library.manifest(courseId);
      if (!manifest) return undefined;
      const syllabusFiles: { title: string; text: string }[] = [];
      for (const item of manifest.items) {
        if (syllabusFiles.length >= 3) break;
        for (const asset of item.assets) {
          if (asset.mediaType !== 'application/pdf' || !(SYLLABUS_TITLE.test(item.resource.title) || SYLLABUS_TITLE.test(asset.originalName))) continue;
          const pages = await library.asset({ courseId, assetId: asset.id }).then((a) => pdfPageTexts(a.bytes)).catch(() => undefined);
          if (pages?.some((p) => p.trim())) syllabusFiles.push({ title: asset.originalName, text: pages.slice(0, 15).join('\n\n') });
        }
      }
      return { manifest, notes: await notesFor(courseId), syllabusFiles };
    },
    write: ({ prompt, signal }) => claudeText({ prompt, what: '과목 정리 파일 만들기', signal }),
  });
  // WBS-086: the student's memos; also given to the course chat by week.
  const memos = new MemoService({
    root: join(dataRoot, 'memos'), accountKey: () => library.accountKey(), manifest: (courseId) => library.manifest(courseId),
    notes: (courseId) => notesFor(courseId), summary: (courseId) => knowledge.markdown(courseId),
    write: ({ prompt, signal }) => claudeText({ prompt, what: '메모 정리', signal }),
  });
  // WBS-083: review/preview notes per week, and the automation runner.
  const study = new StudyNotes({
    root: join(dataRoot, 'study-notes'), accountKey: () => library.accountKey(), manifest: (courseId) => library.manifest(courseId),
    notes: async (courseId) => [...await notesFor(courseId), ...await memos.notes(courseId)], summary: (courseId) => knowledge.markdown(courseId),
    pdfText: async (courseId, weekId) => {
      const out: { title: string; text: string }[] = [];
      for (const item of (await library.manifest(courseId))?.items.filter((i) => i.resource.weekId === weekId) ?? []) {
        for (const asset of item.assets.filter((a) => a.mediaType === 'application/pdf')) {
          if (out.length >= 3) return out;
          const pages = await library.asset({ courseId, assetId: asset.id }).then((a) => pdfPageTexts(a.bytes)).catch(() => undefined);
          if (pages?.some((p) => p.trim())) out.push({ title: asset.originalName, text: pages.slice(0, 15).join('\n').slice(0, 10_000) });
        }
      }
      return out;
    },
    write: ({ prompt, signal }) => claudeText({ prompt, what: '복습·예습 노트', signal }),
  });
  const weekByLabel = async (courseId: string, label: string | undefined) => label ? (await library.manifest(courseId))?.weeks.find((w) => w.label === label)?.id : undefined;
  // WBS-058: assignment submission; rules the student confirmed are checked every minute.
  const submissions = new Submissions({
    root: join(dataRoot, 'submissions'), accountKey: () => library.accountKey(), manifest: (courseId) => library.manifest(courseId),
    http: () => createCanvasHttp(() => credentials.canvasToken()),
    chooseFile: async () => { const picked = await dialog.showOpenDialog({ title: '제출할 파일 선택', properties: ['openFile'] }); return picked.canceled ? undefined : picked.filePaths[0]; },
    onAuto: (r) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(PUSH_CHANNEL, { kind: 'submit.auto', ...r }); },
  });
  const submitTimer = setInterval(() => { void submissions.tick().catch(() => undefined); }, 60_000);
  // WBS-085: class times (the student's own, else from course.md).
  const timetable = new Timetable({ root: join(dataRoot, 'timetable'), accountKey: () => library.accountKey(), courses: () => library.courses(), found: async (courseId) => (await knowledge.get(courseId)).meetings });
  automation = new AutomationService({
    settings: () => preferences.get().automation,
    correct: ({ courseId, assetId, transcriptId, signal }) => media.autoCorrect(courseId, assetId, transcriptId, signal),
    readable: ({ courseId, assetId, transcriptId }) => media.makeReadable(courseId, assetId, transcriptId),
    mentions: async ({ courseId, assetId, transcriptId }) => {
      const { candidates } = await media.findMentions(courseId, assetId, transcriptId);
      return candidates.length ? (await media.addMentions(courseId, assetId, candidates)).mentions.length : 0;
    },
    courseMd: (courseId) => knowledge.make(courseId),
    review: ({ courseId, weekId, signal }) => study.make(courseId, weekId, 'review', signal),
    weekOf: async (courseId, assetId) => {
      const listed = await media.list(courseId);
      const asset = listed.assets.find((a) => a.id === assetId);
      if (asset?.source.type === 'recording') { const id = asset.source.recordingId; return listed.recordings.find((r) => r.id === id)?.weekId; }
      if (asset?.source.type === 'lms_video') { const ref = `commons:${asset.source.sourceId}`; return weekByLabel(courseId, (await learning.status(courseId).catch(() => undefined))?.items.find((i) => i.sourceRef === ref)?.weekLabel); }
      return undefined;
    },
    preview: {
      courses: () => library.courses(),
      meetings: (courseId) => timetable.meetings(courseId),
      // The latest week whose LMS items are open now.
      currentWeek: async (courseId) => {
        const status = await learning.status(courseId).catch(() => undefined), manifest = await library.manifest(courseId);
        const open = new Set((status?.items ?? []).filter((i) => i.period !== 'not_open' && (!i.unlockAt || Date.parse(i.unlockAt) <= Date.now())).map((i) => i.weekLabel));
        return manifest?.weeks.filter((w) => open.has(w.label)).toSorted((a, b) => b.order - a.order)[0]?.id;
      },
      has: (courseId, weekId) => study.has(courseId, weekId, 'preview'),
      make: ({ courseId, weekId, signal }) => study.make(courseId, weekId, 'preview', signal),
    },
  });
  if (!preferences.get().automation.transcribe) await media.pauseTranscription().catch(() => undefined);
  // Only a change of this setting pauses or resumes; a pause the student made by hand otherwise stays.
  let transcribeSetting = preferences.get().automation.transcribe;
  preferences.onChange((value) => {
    if (value.automation.transcribe === transcribeSetting) return;
    transcribeSetting = value.automation.transcribe;
    void (transcribeSetting ? media.resumeTranscription() : media.pauseTranscription()).catch(() => undefined);
  });
  const previewTimer = setInterval(() => { void automation?.tick().catch(() => undefined); }, 10 * 60_000);
  setTimeout(() => { void automation?.tick().catch(() => undefined); }, 60_000).unref();
  const courseWorkspaces = new CourseWorkspaceService({ root: join(dataRoot, 'course-workspaces'), sessionsRoot: join(dataRoot, 'native-sessions'), source: library, getSession: id => sessions.get(id), notes: async (courseId) => [...await notesFor(courseId), ...await memos.notes(courseId), ...await study.weekNotes(courseId)], knowledge: (courseId) => knowledge.markdown(courseId) });
  const prepareCourse = (id: string, cwd: string) => courseWorkspaces.prepare(id, cwd);
  conversations = new ConversationService({ prepareCourse, root: join(dataRoot, 'native-sessions'), getSession: id => sessions.get(id), rename: (id, title) => sessions.rename({ appSessionId: id, title }), nativeActive: () => false });
  const chatOutputs = new ChatOutputs({ workspace: (id) => conversations.workspace(id), openPath: (path) => shell.openPath(path), reveal: (path) => shell.showItemInFolder(path) });
  let closing = false;
  app.on("before-quit", (event) => {
    if (closing) return;
    event.preventDefault(); closing = true;
    clearInterval(previewTimer); clearInterval(submitTimer); automation?.stop();
    void (async () => { try { await conversations.stopAll(); await recordings.stopActive("RECORDING_INTERRUPTED"); } finally {
      // Transcription first, so the running job is handed back to the queue before the engine goes away.
      await media.stop(); await stt.stop();
    } })().catch(() => undefined).finally(() => app.quit());
  });
  // Ctrl-C in a terminal or a plain `kill` quits the same way as Cmd-Q, so recordings and transcription are saved.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());
  // A sleeping Mac stops capturing; keep what was recorded as a finished original.
  powerMonitor.on("suspend", () => void recordings.stopActive("RECORDING_INTERRUPTED").catch(() => undefined));
  // The renderer may use the microphone (audio only) for recording; no camera, no screen.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== "media") return callback(true);
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    callback(webContents.getURL().startsWith("file://") && types.length > 0 && types.every((t) => t === "audio"));
  });
  const learning = new LearningStatusService({
    root: join(dataRoot, "learning-status"),
    sources: createLearningSources(() => credentials.canvasToken()),
    ensureSignedIn: () => credentials.ensureSignedIn(),
    courses: () => library.courses(),
    accountKey: () => library.accountKey(),
    openItemPage: (page) => openLmsItemPage(page, (contents) => credentials.signInAgain((id, pw) => pageSchoolLogin(schoolDeps(), windowSignInPage(contents), id, pw))),
    openWatchWindow: (page) => openLmsWatchWindow(page, (contents) => credentials.signInAgain((id, pw) => pageSchoolLogin(schoolDeps(), windowSignInPage(contents), id, pw))),
    onWatchClosed: (courseId, moduleItemId) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send(PUSH_CHANNEL, { kind: "learning.watchClosed", courseId, moduleItemId }); },
  });
  // WBS-055 check: reads every course's learning status once and writes counts (no titles) to a file.
  const learningDump = process.argv.find((arg) => arg.startsWith("--learning-status-dump="))?.split("=")[1];
  if (learningDump !== undefined) {
    const summary: Record<string, unknown>[] = [];
    for (const course of await library.courses()) {
      const status = await learning.status(course.id, true).catch(() => undefined);
      summary.push({ course: course.sourceCourseId, ...(status ? summarizeLearning(status) : { status: "unreadable" }) });
    }
    writeFileSync(learningDump, `${JSON.stringify(summary, null, 2)}\n`);
    app.quit();
    return;
  }
  // WBS-061: read once; a development run shows which code it is in the top bar.
  const build = await readBuildInfo(app.getAppPath(), app.isPackaged);
  const router = createRouter({ ...createHandlers(sessions, library, files, attachments, credentials, modifier, recordings, media, conversations, stt, learning, importer), "app.build": async () => build,
    // WBS-080: opens the macOS Settings pane for a permission the app needs; fixed addresses only.
    "app.openSettings": async ({ pane }) => { await shell.openExternal(PRIVACY_PANES[pane]); return {}; },
    // WBS-081: files a conversation made, listed and opened by id only.
    "chat.outputs": ({ appSessionId }) => chatOutputs.list(appSessionId),
    "chat.readOutput": ({ appSessionId, id }) => chatOutputs.read(appSessionId, id),
    "chat.showOutput": ({ appSessionId, id, how }) => chatOutputs.show(appSessionId, id, how),
    // WBS-088: the student's own files in a week or 기타 자료.
    "materials.choose": () => externals!.choose(),
    "materials.add": (request) => externals!.add(request),
    "materials.change": (request) => externals!.change(request),
    // WBS-058: assignment submission after the student's confirmation (now, or by a confirmed rule).
    "submit.choose": ({ courseId, resourceId }) => submissions.choose(courseId, resourceId),
    "submit.confirm": ({ planId }) => submissions.confirm(planId),
    "submit.schedule": ({ planId, minutesBefore }) => submissions.schedule(planId, minutesBefore),
    "submit.rules": () => submissions.rules(),
    "submit.cancelRule": ({ ruleId }) => submissions.cancel(ruleId),
    // WBS-085: class times.
    "timetable.get": () => timetable.get(),
    "timetable.set": ({ courseId, meetings }) => timetable.set(courseId, meetings),
    // WBS-083: automatic steps and study notes.
    "automation.status": async () => automation!.status(),
    "study.list": async ({ courseId }) => ({ notes: await study.list(courseId) }),
    "study.make": ({ courseId, weekId, kind }) => study.make(courseId, weekId, kind),
    // WBS-086: memos per course week.
    "memo.get": ({ courseId, weekId }) => memos.get(courseId, weekId),
    "memo.save": ({ courseId, weekId, text, base }) => memos.save(courseId, weekId, text, base),
    "memo.cleanup": ({ courseId, weekId }) => memos.cleanup(courseId, weekId),
    "memo.apply": ({ courseId, weekId, action }) => memos.apply(courseId, weekId, action),
    "memo.pageText": async ({ courseId, assetId, page }) => {
      const pages = await pdfPageTexts((await library.asset({ courseId, assetId })).bytes);
      return { text: (pages[page - 1] ?? "").slice(0, 3000) };
    },
    // WBS-082: the course summary file.
    "course.knowledge": ({ courseId }) => knowledge.get(courseId),
    "course.makeKnowledge": ({ courseId }) => knowledge.make(courseId),
    "course.cancelKnowledge": async ({ courseId }) => { knowledge.cancel(courseId); return {}; },
    // WBS-072: translated copies of collected PDFs.
    "library.pdfTranslation": ({ courseId, assetId, language }) => pdfTranslations.get(courseId, assetId, language),
    "library.translatePdf": ({ courseId, assetId, language, from, to }) => pdfTranslations.make(courseId, assetId, language, from, to),
    "library.cancelPdfTranslation": async () => { pdfTranslations.cancel(); return {}; },
    // WBS-071: the preferred language, kept on this Mac.
    "app.preferences": async () => preferences.get(), "app.setPreferences": async (request) => preferences.set(request) });
  ipcMain.handle(INVOKE_CHANNEL, (event, envelope: unknown) => {
    if (!event.senderFrame?.url.startsWith("file://")) {
      return { ok: false, error: { code: "SCOPE_VIOLATION", message: "허용되지 않은 요청입니다.", retryable: false } };
    }
    return router(envelope);
  });
  const filesSmokeDir = process.argv.find((arg) => arg.startsWith("--files-smoke="))?.split("=")[1];
  if (filesSmokeDir !== undefined) {
    await runFilesSmoke(uiEntry, filesSmokeDir);
    app.quit();
    return;
  }
  const window = createWindow();
  const smokeDir = process.argv.find((arg) => arg.startsWith("--ui-smoke="))?.split("=")[1];
  if (smokeDir !== undefined) {
    await runUiSmoke(window, smokeDir);
    app.quit();
    return;
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
