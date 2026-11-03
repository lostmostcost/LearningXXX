import { writeFileSync } from "node:fs";
import { ConversationService } from "./conversation-service.ts";
import { CourseWorkspaceService } from "./course-workspace.ts";
import { NativeTerminalService } from "./native-terminal.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CanvasClient, CollectionError, createCommonsVideoResolver, listActiveCourses } from "@learningxxx/collector";
import { QwenEngine } from "@learningxxx/transcriber";
import { MediaService } from "./media-service.ts";
import { statfsSync } from "node:fs";
import { app, BrowserWindow, dialog, ipcMain, powerMonitor, safeStorage, session, shell, systemPreferences } from "electron";
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
import { createLearningXClient, createLmsClient, learningxToken, openLoginWindow, schoolLoginDeps, allowedRedirectFetch, createLearningSources, openLmsItemPage, openLmsWatchWindow, windowSignInPage } from "./lms-session.ts";
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
import { LegacyImporter, importStore } from "./legacy-import.ts";
import { createClaudeTextRunner, createReadableRunner, mentionsPrompt, parseMentions } from "./readable-note.ts";
import { runFilesSmoke, runUiSmoke } from "./ui-smoke.ts";
import { WEB_PREFERENCES, WINDOW_SIZE } from "./window-options.ts";

const INVOKE_CHANNEL = "host:invoke";
const PUSH_CHANNEL = "host:push";
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
  const library = new LibraryService({
    root: join(dataRoot, "library"),
    client: () => createLmsClient(() => credentials.canvasToken()),
    ensureSignedIn: () => credentials.ensureSignedIn(),
    discoverCourses: listActiveCourses,
    learningx: createLearningXClient,
    onProgress: (syncRun) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(PUSH_CHANNEL, { kind: "collection.progress", syncRun });
    },
    // One login window at a time; the user signs in there and runs collection again.
    openLogin: () => {
      if (loginWindow && !loginWindow.isDestroyed()) return void loginWindow.focus();
      loginWindow = openLoginWindow();
    },
  });
  await library.init();
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
    capture: () => captureRegion({ permission: () => systemPreferences.getMediaAccessStatus("screen") }),
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
    mentions: async ({ title, text, transcript, signal }) => parseMentions(await claudeText({ prompt: mentionsPrompt(title, text), what: "과제·시험 안내 찾기", signal }), transcript),
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
  // WBS-066: the user's own earlier recordings and transcripts, copied on request.
  const importer = new LegacyImporter({
    chooseFolder: async () => {
      const picked = await dialog.showOpenDialog({ title: "가져올 학기 폴더 선택 (예: 2026년 2학기)", properties: ["openDirectory"] });
      return picked.canceled ? undefined : picked.filePaths[0];
    },
    courses: async () => { const key = library.accountKey(); return (await library.courses()).filter((c) => c.accountKey === key); },
    weeks: async (courseId) => (await library.manifest(courseId))?.weeks ?? [],
    recordings: (courseId) => recordings.list({ courseId }).recordings,
    store: importStore({ adoptImport: (courseId, input) => media.adoptImport(courseId, input), importOriginal: (input) => recordings.importOriginal(input), register: (asset) => media.register(asset) }),
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
  const courseWorkspaces = new CourseWorkspaceService({ root: join(dataRoot, 'course-workspaces'), sessionsRoot: join(dataRoot, 'native-sessions'), source: library, getSession: id => sessions.get(id) });
  const prepareCourse = (id: string, cwd: string) => courseWorkspaces.prepare(id, cwd);
  const terminals = new NativeTerminalService({ prepareCourse, courseHookPath: join(app.getAppPath(), 'src/native-course-hook.cjs'), canOpen: id => !conversations?.active(id), root: join(dataRoot, 'native-sessions'), hookPath: join(app.getAppPath(), 'src/native-session-hook.cjs'), getSession: id => sessions.get(id) });
  conversations = new ConversationService({ prepareCourse, root: join(dataRoot, 'native-sessions'), getSession: id => sessions.get(id), rename: (id, title) => sessions.rename({ appSessionId: id, title }), nativeActive: id => terminals.isActive(id) });
  let closing = false;
  app.on("before-quit", (event) => {
    if (closing) return;
    event.preventDefault(); closing = true;
    void (async () => { try { await conversations.stopAll(); await terminals.stopAll(); await recordings.stopActive("RECORDING_INTERRUPTED"); } finally {
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
  const router = createRouter({ ...createHandlers(sessions, library, files, attachments, credentials, modifier, recordings, media, terminals, conversations, stt, learning, importer), "app.build": async () => build });
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
