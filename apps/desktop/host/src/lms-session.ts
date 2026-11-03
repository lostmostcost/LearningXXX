import { CanvasClient, KHU_CANVAS_BASE_URL, LearningXClient } from "@learningxxx/collector";
import { BrowserWindow, net, session } from "electron";
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

const MAX_REDIRECTS = 5;

/** Where one request would be redirected, without reading its body; undefined when it is answered directly. */
function redirectTarget(lms: Electron.Session, url: string, headers: Headers, signal?: AbortSignal | null): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, session: lms, redirect: "manual", useSessionCookies: true });
    headers.forEach((value, name) => request.setHeader(name, value));
    const stop = () => { request.abort(); reject(signal?.reason ?? new Error("aborted")); };
    signal?.addEventListener("abort", stop, { once: true });
    const done = (value: string | undefined) => { signal?.removeEventListener("abort", stop); request.abort(); resolve(value); };
    request.on("redirect", (_status, _method, next) => done(next));
    request.on("response", () => done(undefined));
    request.on("error", (error) => { signal?.removeEventListener("abort", stop); reject(error); });
    request.end();
  });
}

/**
 * The LMS session's fetch for course videos (WBS-028 self-test: every
 * download failed). Commons answers a download link with a 307 to a signed
 * link on the same server, and Electron's fetch cannot hand a manual redirect
 * back, so each hop is resolved first and must stay on an allowed origin;
 * only then is the final address fetched. A hop elsewhere, or too many hops,
 * comes back as a 3xx answer, which the collector refuses as before.
 */
export function allowedRedirectFetch(allowedOrigins: readonly string[]): typeof globalThis.fetch {
  const lms = session.fromPartition(LMS_PARTITION);
  return (async (input, init) => {
    let url = new URL(String(input)).href;
    const headers = new Headers(init?.headers);
    for (let hop = 0; ; hop += 1) {
      const next = await redirectTarget(lms, url, headers, init?.signal);
      if (next === undefined) break;
      const target = new URL(next, url);
      if (hop === MAX_REDIRECTS || target.protocol !== "https:" || !allowedOrigins.includes(target.origin)) return new Response(null, { status: 302 });
      url = target.href;
    }
    return lms.fetch(url, { ...init, redirect: "manual" });
  }) as typeof globalThis.fetch;
}

/** CR-054 / WBS-055 read-only sources: LearningX weekly learning and Canvas assignments/quizzes. */
export function createLearningSources(canvasToken: () => string | undefined): import("./learning-status.ts").LearningSources {
  const lms = session.fromPartition(LMS_PARTITION);
  const lx = async (path: string) => {
    const token = await learningxToken();
    const response = await lms.fetch(`${KHU_CANVAS_BASE_URL}/learningx/api/v1/${path}`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: "application/json" } });
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error("auth"), { appError: { code: "AUTH_REQUIRED" } });
    if (!response.ok) throw new Error(`learningx ${response.status}`);
    return (await response.json()) as unknown;
  };
  const canvas = () => createLmsClient(canvasToken);
  return {
    modules: async (id) => { const v = await lx(`courses/${encodeURIComponent(id)}/modules?include_detail=true`); return Array.isArray(v) ? v : []; },
    attendanceItem: (id, itemId) => lx(`courses/${encodeURIComponent(id)}/attendance_items/${encodeURIComponent(itemId)}`),
    assignments: (id) => canvas().getList(`/api/v1/courses/${encodeURIComponent(id)}/assignments?include[]=submission&per_page=100`),
    quizzes: (id) => canvas().getList(`/api/v1/courses/${encodeURIComponent(id)}/quizzes?per_page=100`),
  };
}
