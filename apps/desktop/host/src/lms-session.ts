import { CanvasClient, KHU_CANVAS_BASE_URL } from "@learningxxx/collector";
import { BrowserWindow, session } from "electron";
import { isAllowedLoginUrl, LOGIN_WEB_PREFERENCES } from "./window-options.ts";

/**
 * School sign-in lives in this Electron session, kept apart from the app UI.
 * Requests go through it, so this code never handles a credential and
 * the session survives restarts in Electron's own encrypted store.
 */
const LMS_PARTITION = "persist:lms";

export function createLmsClient(): CanvasClient {
  const lms = session.fromPartition(LMS_PARTITION);
  return new CanvasClient({
    getAuthHeaders: async () => ({}),
    fetch: ((input, init) => lms.fetch(String(input), init)) as typeof globalThis.fetch,
  });
}

export function openLoginWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 520,
    height: 720,
    title: "학교 로그인",
    webPreferences: { ...LOGIN_WEB_PREFERENCES, partition: LMS_PARTITION },
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedLoginUrl(url)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void window.loadURL(KHU_CANVAS_BASE_URL);
  return window;
}
