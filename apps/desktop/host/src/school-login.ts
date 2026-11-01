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
const CSRF_COOKIE = "xn_sso_csrf_token_for_this_login";

export type SchoolLoginResult = "signed_in" | "rejected" | "failed";

export interface SchoolLoginDeps {
  /** Fetch bound to the LMS sign-in session: cookies set here are what the collector uses afterwards. */
  fetch: typeof globalThis.fetch;
  /** Reads one cookie of that session. */
  cookie: (url: string, name: string) => Promise<string | undefined>;
  /** True once the LearningX token is in the session. */
  signedIn: () => Promise<boolean>;
}

/**
 * Replays the school sign-in form (WBS-040), as the user's own browser would:
 * open the login page for its CSRF cookie, post the saved ID and password to
 * the school, then open the LearningX callback the result page would load in a
 * frame. Exactly one attempt: a rejection is reported, never retried, so a
 * wrong saved password cannot lock the account.
 */
export async function schoolLogin(deps: SchoolLoginDeps, schoolId: string, password: string): Promise<SchoolLoginResult> {
  try {
    await (await deps.fetch(KHU_LOGIN_URL)).text();
    const csrf = await deps.cookie(SSO_ORIGIN, CSRF_COOKIE);
    if (!csrf) return "failed";
    const response = await deps.fetch(SUBMIT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: KHU_LOGIN_URL },
      body: new URLSearchParams({ csrf_token: csrf, login_user_id: schoolId, login_user_password: password }).toString(),
    });
    const page = await response.text();
    if (/로그인 오류|인증에 실패/.test(page)) return "rejected";
    const callback = /https:\/\/khcanvas\.khu\.ac\.kr\/learningx\/login\/from_cc\?result=[^"'\s<>]+/.exec(page)?.[0];
    if (!callback) return "failed";
    await (await deps.fetch(callback.replaceAll("&amp;", "&"), { headers: { Referer: `${SSO_ORIGIN}/` } })).text();
    return (await deps.signedIn()) ? "signed_in" : "failed";
  } catch {
    return "failed";
  }
}
