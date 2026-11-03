/**
 * School SSO entry that returns through LearningX, so one sign-in sets both the
 * Canvas session and the LearningX token (`xn_api_token`, about 2 hours).
 */
export const KHU_LOGIN_URL =
  "https://e-campus.khu.ac.kr/xn-sso/login.php?auto_login=&sso_only=&cvs_lgn=true&return_url=" +
  encodeURIComponent(
    `https://e-campus.khu.ac.kr/xn-sso/gw-cb.php?from=web_redirect&login_type=standalone&return_url=${encodeURIComponent("https://khcanvas.khu.ac.kr/learningx/login")}`,
  );
const SSO_ORIGIN = "https://e-campus.khu.ac.kr";
const SUBMIT_URL = `${SSO_ORIGIN}/xn-sso/gw-cb.php`;
const SCHOOL_REJECTED = /로그인 오류|인증에 실패/;
const CSRF_COOKIE = "xn_sso_csrf_token_for_this_login";

export type SchoolLoginResult = "signed_in" | "rejected" | "failed";

export interface SchoolLoginDeps {
  /** Fetch bound to the LMS sign-in session: cookies set here are what the collector uses afterwards. */
  fetch: typeof globalThis.fetch;
  /** Reads one cookie of that session. */
  cookie: (url: string, name: string) => Promise<string | undefined>;
  /** True once the LearningX token is in the session. */
  signedIn: () => Promise<boolean>;
  /** Diagnostics: the step reached and HTTP statuses, never an ID, password or cookie value. */
  trace?: (step: string) => void;
}

/**
 * Replays the school sign-in form (WBS-040), as the user's own browser would:
 * open the login page for its CSRF cookie, post the saved ID and password to
 * the school, then open the LearningX callback the result page would load in a
 * frame. Exactly one attempt: a rejection is reported, never retried, so a
 * wrong saved password cannot lock the account.
 */
export async function schoolLogin(deps: SchoolLoginDeps, schoolId: string, password: string): Promise<SchoolLoginResult> {
  const trace = deps.trace ?? (() => undefined);
  try {
    const entry = await deps.fetch(KHU_LOGIN_URL);
    await entry.text();
    trace(`login page ${entry.status}`);
    const csrf = await deps.cookie(SSO_ORIGIN, CSRF_COOKIE);
    if (!csrf) return (trace("no csrf cookie"), "failed");
    const response = await deps.fetch(SUBMIT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: KHU_LOGIN_URL },
      body: new URLSearchParams({ csrf_token: csrf, login_user_id: schoolId, login_user_password: password }).toString(),
    });
    const page = await response.text();
    trace(`submit ${response.status}`);
    if (SCHOOL_REJECTED.test(page)) return (trace("rejected"), "rejected");
    const callback = /https:\/\/khcanvas\.khu\.ac\.kr\/learningx\/login\/from_cc\?result=[^"'\s<>]+/.exec(page)?.[0];
    if (!callback) return (trace("no callback in result page"), "failed");
    const back = await deps.fetch(callback.replaceAll("&amp;", "&"), { headers: { Referer: `${SSO_ORIGIN}/` } });
    await back.text();
    trace(`callback ${back.status}`);
    const ok = await deps.signedIn();
    if (!ok) trace("no LearningX token after callback");
    return ok ? "signed_in" : "failed";
  } catch (error) {
    trace(`error ${(error as Error).name}`);
    return "failed";
  }
}

/** A browser window of the sign-in session (lms-session.ts windowSignInPage). */
export interface SignInPage {
  /** Opens a page; with `post`, sends that form body the way a submitted form does. */
  load: (url: string, post?: { body: string; referrer: string }) => Promise<void>;
  cookie: (url: string, name: string) => Promise<string | undefined>;
  /** True once LMS web pages see a signed-in user; waits up to `timeoutMs`. */
  webSignedIn: (timeoutMs: number) => Promise<boolean>;
}

/**
 * WBS-056: the request-only sign-in gives LearningX a token but the LMS web
 * pages still ask for the school sign-in; they accept it only after the
 * school's result page has run in a browser. So: first schoolLogin, only to
 * tell a refused password apart (and stop there — no second try; right after
 * another sign-in its result page can differ, which is not a refusal), then
 * the same form once more in the LMS page's own window.
 */
export async function pageSchoolLogin(deps: SchoolLoginDeps, page: SignInPage, schoolId: string, password: string, timeoutMs = 20_000): Promise<SchoolLoginResult> {
  if ((await schoolLogin(deps, schoolId, password)) === "rejected") return "rejected";
  const trace = deps.trace ?? (() => undefined);
  try {
    await page.load(KHU_LOGIN_URL);
    const csrf = await page.cookie(SSO_ORIGIN, CSRF_COOKIE);
    if (!csrf) return (trace("page: no csrf cookie"), "failed");
    await page.load(SUBMIT_URL, {
      body: new URLSearchParams({ csrf_token: csrf, login_user_id: schoolId, login_user_password: password }).toString(),
      referrer: KHU_LOGIN_URL,
    });
    const ok = await page.webSignedIn(timeoutMs);
    trace(ok ? "page: LMS web signed in" : "page: LMS web still signed out");
    return ok ? "signed_in" : "failed";
  } catch (error) {
    trace(`page: error ${(error as Error).name}`);
    return "failed";
  }
}
