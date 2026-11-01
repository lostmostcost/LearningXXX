import { CanvasClient, KHU_CANVAS_BASE_URL, LearningXClient } from "@learningxxx/collector";
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

/**
 * School SSO entry that returns through LearningX, so one sign-in sets both the
 * Canvas session and the LearningX token (`xn_api_token`, about 2 hours).
 */
export const KHU_LOGIN_URL =
  "https://e-campus.khu.ac.kr/xn-sso/login.php?auto_login=&sso_only=&cvs_lgn=true&return_url=" +
  encodeURIComponent(`https://e-campus.khu.ac.kr/xn-sso/gw-cb.php?from=web_redirect&login_type=standalone&return_url=${encodeURIComponent(`${KHU_CANVAS_BASE_URL}/learningx/login`)}`);

const LEARNINGX_TOKEN = "xn_api_token";

/** The token's own expiry; a token about to run out counts as missing. */
function tokenUsable(token: string, now = Date.now()): boolean {
  try {
    const { exp } = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    return typeof exp !== "number" || exp * 1000 > now + 60_000;
  } catch {
    return true; // not a JWT we can read; let the server decide
  }
}

async function learningxToken(): Promise<string | undefined> {
  const [cookie] = await session.fromPartition(LMS_PARTITION).cookies.get({ url: KHU_CANVAS_BASE_URL, name: LEARNINGX_TOKEN });
  return cookie && tokenUsable(cookie.value) ? cookie.value : undefined;
}

/** Lecture materials through the same sign-in; the token is read per call, never kept. */
export function createLearningXClient(): LearningXClient {
  const lms = session.fromPartition(LMS_PARTITION);
  return new LearningXClient({
    getToken: learningxToken,
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
  // The SSO callback page loads LearningX in a frame; once its token lands, show Canvas.
  const lms = session.fromPartition(LMS_PARTITION);
  const onCookie = (_event: unknown, cookie: Electron.Cookie, _cause: string, removed: boolean) => {
    if (removed || cookie.name !== LEARNINGX_TOKEN || window.isDestroyed()) return;
    lms.cookies.off("changed", onCookie);
    void window.loadURL(KHU_CANVAS_BASE_URL);
  };
  lms.cookies.on("changed", onCookie);
  window.on("closed", () => lms.cookies.off("changed", onCookie));
  void window.loadURL(KHU_LOGIN_URL);
  return window;
}
