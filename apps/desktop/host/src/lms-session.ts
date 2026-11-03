import { CanvasClient, KHU_CANVAS_BASE_URL, LearningXClient } from "@learningxxx/collector";
import { BrowserWindow, net, session } from "electron";
import { KHU_LOGIN_URL, type SchoolLoginDeps, type SignInPage } from "./school-login.ts";
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
/** WBS-058: Canvas's own CSRF cookie, sent back as a header on a submission (only to Canvas). */
const CANVAS_CSRF = "_csrf_token";

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
export function schoolLoginDeps(trace?: (step: string) => void): SchoolLoginDeps {
  const lms = session.fromPartition(LMS_PARTITION);
  return {
    fetch: ((input, init) => lms.fetch(String(input), init)) as typeof globalThis.fetch,
    cookie: async (url, name) => (await lms.cookies.get({ url, name }))[0]?.value,
    signedIn: async () => (await learningxToken()) !== undefined,
    ...(trace ? { trace } : {}),
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

/**
 * WBS-056: an LMS page's own window as the place for the school sign-in
 * (school-login.ts pageSchoolLogin), so the result page runs as in a browser.
 * It loads pages, reads the CSRF cookie by name as the request-only sign-in
 * does, and asks Canvas whether its web pages see a signed-in user; it never
 * runs scripts in the page or fills its input boxes.
 */
export function windowSignInPage(contents: Electron.WebContents): SignInPage {
  const lms = session.fromPartition(LMS_PARTITION);
  return {
    load: async (url, post) => {
      await contents.loadURL(url, post ? {
        postData: [{ type: "rawData", bytes: Buffer.from(post.body) }],
        extraHeaders: "Content-Type: application/x-www-form-urlencoded\n",
        httpReferrer: post.referrer,
      } : {}).catch(() => undefined); // judged by the cookies that follow
    },
    cookie: async (url, name) => (await lms.cookies.get({ url, name }))[0]?.value,
    webSignedIn: async (timeoutMs) => {
      for (const until = Date.now() + timeoutMs; Date.now() < until; await new Promise((r) => setTimeout(r, 1000))) {
        const self = await lms.fetch(`${KHU_CANVAS_BASE_URL}/api/v1/users/self`, { redirect: "manual", headers: { Accept: "application/json" } }).catch(() => undefined);
        if (self?.status === 200) return true;
      }
      return false;
    },
  };
}

const VIEW_RECORD_TIMEOUT_MS = 60_000;
export type ItemPageResult = "recorded" | "sign_in" | "failed";
const isSchoolSignIn = (url: string) => url.startsWith(`${SSO_SIGN_IN_ORIGIN}/xn-sso/login.php`);
const SSO_SIGN_IN_ORIGIN = "https://e-campus.khu.ac.kr";
const KHU_HOST = /(^|\.)khu\.ac\.kr$/;

/**
 * CR-054 / WBS-056: the LMS item page in a window the user does not see, in
 * the sign-in session, so the LMS's own document viewer reports the view
 * (`…/progress/forceSubmit`) exactly as when the page is opened by hand. The
 * app sends no LMS request itself. Resolves "recorded" when that report
 * succeeded. When the page asks for the school sign-in (the web session ends
 * when the app quits, the LearningX token does not), the saved details sign in
 * once in this same window (pageSchoolLogin) and the page is opened again; "sign_in" when there is nothing to sign
 * in with.
 * "failed" on time out, a failed page load or a page outside the school.
 * Muted and limited to school pages; pop-ups are refused.
 */
export function openLmsItemPage(
  { sourceCourseId, moduleItemId }: { sourceCourseId: string; moduleItemId: string },
  signInAgain: (contents: Electron.WebContents) => Promise<boolean>,
  timeoutMs = VIEW_RECORD_TIMEOUT_MS,
): Promise<ItemPageResult> {
  const lms = session.fromPartition(LMS_PARTITION);
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { partition: LMS_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const contents = window.webContents;
  contents.setAudioMuted(true);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  const report = new RegExp(`^/learningx/api/v1/courses/${sourceCourseId.replace(/\W/g, "")}/sections/\\d+/components/[^/]+/progress/forceSubmit$`);
  const page = `${KHU_CANVAS_BASE_URL}/courses/${encodeURIComponent(sourceCourseId)}/modules/items/${encodeURIComponent(moduleItemId)}`;
  return new Promise<ItemPageResult>((resolve) => {
    let settled = false;
    let signedInAgain = false;
    const finish = (ok: ItemPageResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lms.webRequest.onCompleted(null);
      if (!window.isDestroyed()) window.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish("failed"), timeoutMs);
    lms.webRequest.onCompleted({ urls: [`${KHU_CANVAS_BASE_URL}/learningx/api/v1/courses/*`] }, (details) => {
      if (details.webContentsId !== contents.id || details.method !== "POST") return;
      if (report.test(new URL(details.url).pathname)) finish(details.statusCode >= 200 && details.statusCode < 300 ? "recorded" : "failed");
    });
    const schoolOnly = (event: { preventDefault: () => void }, url: string) => {
      const target = new URL(url);
      if (target.protocol !== "https:" || !KHU_HOST.test(target.hostname)) { event.preventDefault(); finish("failed"); }
    };
    // The sign-in page is never filled in here: the saved details sign in through the
    // same session (school-login.ts), once, and the item page is opened again.
    // After that the sign-in page normally continues by itself to the LMS (as in
    // the login window), so it is given until the time limit.
    contents.on("did-navigate", (_event, url) => {
      if (!isSchoolSignIn(url) || settled || signedInAgain) return;
      signedInAgain = true;
      void signInAgain(contents).then((ok) => {
        if (settled) return;
        if (!ok) return finish("sign_in");
        void contents.loadURL(page).catch(() => undefined);
      }, () => finish("sign_in"));
    });
    contents.on("will-navigate", (event, url) => schoolOnly(event, url));
    contents.on("will-redirect", (event, url) => schoolOnly(event, url));
    contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => { if (isMainFrame && code !== -3) finish("failed"); });
    window.on("closed", () => finish("failed"));
    void window.loadURL(page).catch(() => undefined); // aborted loads are judged by did-fail-load
  });
}

let watching: { window: BrowserWindow; closed: Promise<void> } | undefined;

/**
 * CR-054 / WBS-057: the lecture's LMS page in a window the user sees, in the
 * sign-in session, so the user really watches it in the official player and
 * the LMS counts it the way it always does. Sound is on; the app does not
 * play, skip or report anything itself. One such window at a time: opening
 * another lecture loads it in the same window. School pages only; pop-ups are
 * refused. Resolves when the user closes the window.
 */
export function openLmsWatchWindow(
  target: { sourceCourseId: string; title: string } & ({ moduleItemId: string } | { quizId: string }),
  signInAgain: (contents: Electron.WebContents) => Promise<boolean>,
): Promise<void> {
  const { sourceCourseId, title } = target;
  // WBS-059: a quiz the weekly page does not list opens at its Canvas quiz page.
  const path = "moduleItemId" in target ? `modules/items/${encodeURIComponent(target.moduleItemId)}` : `quizzes/${encodeURIComponent(target.quizId)}`;
  const page = `${KHU_CANVAS_BASE_URL}/courses/${encodeURIComponent(sourceCourseId)}/${path}`;
  if (watching && !watching.window.isDestroyed()) {
    watching.window.setTitle(`LMS에서 시청 · ${title}`);
    void watching.window.loadURL(page).catch(() => undefined);
    watching.window.show();
    watching.window.focus();
    return watching.closed;
  }
  const window = new BrowserWindow({
    show: true,
    width: 1280,
    height: 860,
    title: `LMS에서 시청 · ${title}`,
    webPreferences: { partition: LMS_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Keep our title, not the page's.
  window.on("page-title-updated", (event) => event.preventDefault());
  const schoolOnly = (event: { preventDefault: () => void }, url: string) => {
    const target = new URL(url);
    if (target.protocol !== "https:" || !KHU_HOST.test(target.hostname)) event.preventDefault();
  };
  let signedInAgain = false;
  contents.on("did-navigate", (_event, url) => {
    if (!isSchoolSignIn(url) || signedInAgain) return;
    signedInAgain = true;
    void signInAgain(contents).then((ok) => { if (ok && !window.isDestroyed()) void contents.loadURL(page).catch(() => undefined); }, () => undefined);
  });
  contents.on("will-navigate", (event, url) => schoolOnly(event, url));
  contents.on("will-redirect", (event, url) => schoolOnly(event, url));
  const closed = new Promise<void>((resolve) => window.on("closed", () => { watching = undefined; resolve(); }));
  watching = { window, closed };
  void window.loadURL(page).catch(() => undefined);
  return closed;
}

/**
 * WBS-058: requests that change something at the LMS (assignment upload and
 * submission), through the school sign-in. With cookies Canvas wants its CSRF
 * token as a header; with a saved Canvas token the token alone is enough.
 */
export function createCanvasHttp(canvasToken: () => string | undefined): import("./assignment-submit.ts").CanvasHttp {
  const lms = session.fromPartition(LMS_PARTITION);
  return {
    request: async (url, { method, body }) => {
      const target = new URL(url, KHU_CANVAS_BASE_URL);
      // Cookies and the token go to the LMS only; the upload host gets just the file and the fields Canvas gave.
      if (target.origin !== new URL(KHU_CANVAS_BASE_URL).origin) {
        if (target.protocol !== "https:") throw Object.assign(new Error("upload url"), { appError: { code: "SOURCE_CHANGED", message: "업로드 주소가 안전하지 않습니다.", retryable: false } });
        return globalThis.fetch(target.href, { method, ...(body ? { body } : {}), redirect: "manual" });
      }
      const token = canvasToken();
      const [csrf] = token ? [] : await lms.cookies.get({ url: KHU_CANVAS_BASE_URL, name: CANVAS_CSRF });
      const headers: Record<string, string> = { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(csrf && method !== "GET" ? { "X-CSRF-Token": decodeURIComponent(csrf.value) } : {}) };
      return lms.fetch(target.href, { method, headers, ...(body ? { body } : {}), redirect: "manual" });
    },
  };
}
