import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell, systemPreferences } from "electron";
import { AppModifier, createDockerVerifier, launchWatchdog, locateDocker } from "@learningxxx/app-modifier";
import { AttachmentService } from "./attachment-service.ts";
import { runGuiCliProbe } from "./gui-cli-probe.ts";
import { createCliRunner } from "./cli-runner.ts";
import { FileService } from "./file-service.ts";
import { createHandlers } from "./handlers.ts";
import { LibraryService } from "./library-service.ts";
import { runLmsProbe } from "./lms-probe.ts";
import { createLmsClient, openLoginWindow } from "./lms-session.ts";
import { captureRegion } from "./native-capture.ts";
import { createRouter } from "./router.ts";
import { RunHistory } from "./run-history.ts";
import { SessionService } from "./session-service.ts";
import { SessionStore } from "./session-store.ts";
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
  const library = new LibraryService({
    root: join(dataRoot, "library"),
    client: createLmsClient,
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
  const router = createRouter(createHandlers(sessions, library, files, attachments, modifier));
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
