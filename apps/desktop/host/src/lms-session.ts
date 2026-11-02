import { CanvasClient, KHU_CANVAS_BASE_URL, LearningXClient } from "@learningxxx/collector";
import { BrowserWindow, session } from "electron";
import { KHU_LOGIN_URL, type SchoolLoginDeps } from "./school-login.ts";
import { isAllowedLoginUrl, LOGIN_WEB_PREFERENCES } from "./window-options.ts";

/**
 * School sign-in lives in this Electron session, kept apart from the app UI.
 * The school's cookies end when the app quits; saved sign-in details or a
 * Canvas token (credential-store.ts) re-create or replace them (WBS-040).
 */
const LMS_PARTITION = "persist:lms";

/**
 * Canvas through the sign-in session, or with the user's own Canvas access
 * token when one is saved (WBS-040): the token does not expire when the app quits.
 */
export function createLmsClient(canvasToken: () => string | undefined = () => undefined): CanvasClient {
  const lms = session.fromPartition(LMS_PARTITION);
  return new CanvasClient({
    getAuthHeaders: async () => {
      const token = canvasToken();
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
    fetch: ((input, init) => lms.fetch(String(input), init)) as typeof globalThis.fetch,
  });
}

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

export async function learningxToken(): Promise<string | undefined> {
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

/** What the saved-details sign-in needs: this session's fetch, one cookie read, and the LearningX check. */
export function schoolLoginDeps(): SchoolLoginDeps {
  const lms = session.fromPartition(LMS_PARTITION);
  return {
    fetch: ((input, init) => lms.fetch(String(input), init)) as typeof globalThis.fetch,
    cookie: async (url, name) => (await lms.cookies.get({ url, name }))[0]?.value,
    signedIn: async () => (await learningxToken()) !== undefined,
  };
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
