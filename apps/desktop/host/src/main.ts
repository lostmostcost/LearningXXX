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
import { createHandlers } from "./handlers.ts";
import { LibraryService } from "./library-service.ts";
import { runLmsProbe } from "./lms-probe.ts";
import { CredentialService } from "./credential-service.ts";
import { CredentialStore } from "./credential-store.ts";
import { createLearningXClient, createLmsClient, learningxToken, openLoginWindow, schoolLoginDeps } from "./lms-session.ts";
import { schoolLogin } from "./school-login.ts";
import { captureRegion } from "./native-capture.ts";
import { createRouter } from "./router.ts";
import { RunHistory } from "./run-history.ts";
import { SessionService } from "./session-service.ts";
import { SessionStore } from "./session-store.ts";
import { TranscriptStore } from "./transcript-store.ts";
import { courseBrief } from "./course-context.ts";
import { RecordingService } from "./recording-service.ts";
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

app.whenReady().then(async () => {
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
  const credentials = new CredentialService({
    store: new CredentialStore(join(app.getPath("userData"), "credentials.bin"), {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (data) => safeStorage.decryptString(data),
    }),
    login: (schoolId, password) => schoolLogin(schoolLoginDeps(), schoolId, password),
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
  media = new MediaService({
    dataRoot, accountKey: () => library.accountKey(), courses: () => library.courses(),
    originals: () => recordings.originals(), recordings: (courseId) => recordings.list({ courseId }).recordings,
    engine: new QwenEngine({ python: join(sttRoot, ".venv/bin/python"), script: resolve(app.getAppPath(), "../../../services/transcriber/python/transcribe.py"), modelHome: join(sttRoot, "hf") }),
    contextFor: async (asset) => (await library.manifest(asset.courseId))?.items.map((i) => i.resource.title).join("\n").slice(0, 4000) ?? "",
    openOriginal: async (path) => { const error = await shell.openPath(path); if (error) throw new Error("원본을 여는 시스템 플레이어를 확인하세요."); },
    videos: async (course) => {
      await credentials.ensureSignedIn();
      const modules = await createLearningXClient().modules(course.sourceCourseId);
      const videos: { sourceId: string; title: string }[] = [];
      for (const module of modules) for (const item of (module as { module_items?: unknown[] }).module_items ?? []) {
        const value = item as { title?: unknown; content_data?: { opened?: unknown; item_content_data?: { content_id?: unknown; content_type?: unknown } } };
        const content = value.content_data?.item_content_data;
        if (value.content_data?.opened === true && typeof content?.content_id === "string" && /^[\w-]{1,64}$/.test(content.content_id) && ["movie", "video", "mp4"].includes(String(content.content_type).toLowerCase())) videos.push({ sourceId: content.content_id, title: String(value.title ?? "온라인 강의").slice(0, 200) || "온라인 강의" });
      }
      return videos;
    },
    video: (_course, contentId) => {
      const fetch = schoolLoginDeps().fetch;
      return { fetch, resolveSource: createCommonsVideoResolver({ contentId, fetch }), allowedOrigins: ["https://commons.khu.ac.kr"] };
    },
  });
  // Recordings cut off by a quit or crash are confirmed from what reached the disk.
  await recordings.recover().catch(() => undefined);
  // A corrupt media catalog must not prevent the UI from opening to show its error.
  if (library.accountKey()) await media.recover().catch(() => undefined);
  let conversations: ConversationService;
  const courseWorkspaces = new CourseWorkspaceService({ root: join(dataRoot, 'course-workspaces'), sessionsRoot: join(dataRoot, 'native-sessions'), source: library, getSession: id => sessions.get(id) });
  const prepareCourse = (id: string, cwd: string) => courseWorkspaces.prepare(id, cwd);
  const terminals = new NativeTerminalService({ prepareCourse, courseHookPath: join(app.getAppPath(), 'src/native-course-hook.cjs'), canOpen: id => !conversations?.active(id), root: join(dataRoot, 'native-sessions'), hookPath: join(app.getAppPath(), 'src/native-session-hook.cjs'), getSession: id => sessions.get(id) });
  conversations = new ConversationService({ prepareCourse, root: join(dataRoot, 'native-sessions'), getSession: id => sessions.get(id), rename: (id, title) => sessions.rename({ appSessionId: id, title }), nativeActive: id => terminals.isActive(id) });
  let closing = false;
  app.on("before-quit", (event) => {
    if (closing) return;
    event.preventDefault(); closing = true;
    void (async () => { try { await conversations.stopAll(); await terminals.stopAll(); await recordings.stopActive("RECORDING_INTERRUPTED"); } finally { await media.stop(); } })().catch(() => undefined).finally(() => app.quit());
  });
  // A sleeping Mac stops capturing; keep what was recorded as a finished original.
  powerMonitor.on("suspend", () => void recordings.stopActive("RECORDING_INTERRUPTED").catch(() => undefined));
  // The renderer may use the microphone (audio only) for recording; no camera, no screen.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== "media") return callback(true);
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    callback(webContents.getURL().startsWith("file://") && types.length > 0 && types.every((t) => t === "audio"));
  });
  const router = createRouter(createHandlers(sessions, library, files, attachments, credentials, modifier, recordings, media, terminals, conversations));
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
