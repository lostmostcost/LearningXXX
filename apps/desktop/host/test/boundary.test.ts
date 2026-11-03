import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { IpcChannels } from "@learningxxx/contracts";
import { isAllowedLoginUrl, LOGIN_WEB_PREFERENCES, WEB_PREFERENCES, WINDOW_SIZE } from "../src/window-options.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("renderer isolation stays on", () => {
  assert.deepEqual(WEB_PREFERENCES, {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    webviewTag: false,
  });
});

test("preload exposes exactly the contract channels", () => {
  const listed = [...read("../src/preload.cjs").matchAll(/^\s+"([a-z]+\.[a-zA-Z]+)",$/gm)].map((m) => m[1]);
  assert.deepEqual(listed.sort(), Object.keys(IpcChannels).sort());
});

test("preload exposes only invoke, and no raw ipcRenderer", () => {
  const preload = read("../src/preload.cjs");
  assert.match(preload, /exposeInMainWorld\("host", \{\s+invoke\(/);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer/);
  assert.doesNotMatch(preload, /child_process|require\("(?!electron)/);
});

test("renderer source cannot reach Node or run commands", () => {
  const dir = new URL("../../ui/src/", import.meta.url);
  for (const name of readdirSync(dir)) {
    assert.doesNotMatch(read(`../../ui/src/${name}`), /from "(electron|node:[a-z_/]+|child_process|fs)"|\bipcRenderer\b|\beval\(|new Function/, name);
  }
});

test("the page refuses remote and inline scripts", () => {
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(read("../../ui/index.html"))?.[1] ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline.*script|unsafe-eval|https?:/);
});

test("the window can shrink to the narrow layout", () => {
  assert.ok(WINDOW_SIZE.minWidth < 900);
});

test("the remote login window has no preload and no Node access", () => {
  assert.equal(LOGIN_WEB_PREFERENCES.sandbox, true);
  assert.equal(LOGIN_WEB_PREFERENCES.nodeIntegration, false);
  assert.equal("preload" in LOGIN_WEB_PREFERENCES, false);
});

test("login navigation stays on https", () => {
  assert.equal(isAllowedLoginUrl("https://khcanvas.khu.ac.kr/login"), true);
  assert.equal(isAllowedLoginUrl("http://khcanvas.khu.ac.kr/login"), false);
  assert.equal(isAllowedLoginUrl("file:///etc/passwd"), false);
});

test("host code never reads session cookies or credentials", () => {
  // WBS-039: the one exception is the LearningX token, which LearningX only accepts as a bearer header.
  const session = read("../src/lms-session.ts");
  const cookieUses = session.match(/cookies\.\w+\([^)]*\)/g) ?? [];
  // WBS-040: the saved-details sign-in reads one cookie by name (the SSO CSRF token, see school-login.ts).
  // WBS-056: the LMS page's own window for the sign-in reads the same CSRF cookie by name.
  // WBS-058: an assignment submission sends Canvas's CSRF cookie back to Canvas as a header.
  assert.deepEqual(cookieUses, ["cookies.get({ url: KHU_CANVAS_BASE_URL, name: LEARNINGX_TOKEN })", "cookies.get({ url, name })", "cookies.off(\"changed\", onCookie)", "cookies.on(\"changed\", onCookie)", "cookies.off(\"changed\", onCookie)",
    "cookies.get({ url, name })", "cookies.get({ url: KHU_CANVAS_BASE_URL, name: CANVAS_CSRF })"]);
  assert.match(session, /const CANVAS_CSRF = "_csrf_token";/);
  assert.match(session, /const LEARNINGX_TOKEN = "xn_api_token";/);
  for (const [name, source] of [["lms-session.ts", session], ["lms-probe.ts", read("../src/lms-probe.ts")]] as const) {
    assert.doesNotMatch(source, /document\.cookie|executeJavaScript|password/i, name);
  }
  assert.doesNotMatch(read("../src/lms-probe.ts"), /cookies\./, "lms-probe.ts");
});

test("saved sign-in details are never logged and only go to the school (WBS-040)", () => {
  for (const name of ["credential-store.ts", "credential-service.ts", "school-login.ts"]) {
    assert.doesNotMatch(read(`../src/${name}`), /console\.|process\.std(out|err)/, name);
  }
  const login = read("../src/school-login.ts");
  for (const url of login.match(/https:\/\/[a-z0-9.-]+/g) ?? []) {
    assert.match(url, /^https:\/\/(e-campus|khcanvas)\.khu\.ac\.kr$/, url);
  }
});
