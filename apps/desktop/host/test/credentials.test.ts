import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CredentialService } from "../src/credential-service.ts";
import { CredentialStore, type SecretCipher } from "../src/credential-store.ts";
import { KHU_LOGIN_URL, schoolLogin, type SchoolLoginResult } from "../src/school-login.ts";

/** Stand-in for safeStorage: reversible, but the file never holds the plain text. */
const cipher = (available = true): SecretCipher => ({
  available: () => available,
  encrypt: (plain) => Buffer.from(Buffer.from(plain, "utf8").map((b) => b ^ 0x5a)),
  decrypt: (data) => Buffer.from(data.map((b) => b ^ 0x5a)).toString("utf8"),
});

function store(available = true) {
  const file = join(mkdtempSync(join(tmpdir(), "wbs040-")), "credentials.bin");
  return { file, store: new CredentialStore(file, cipher(available)) };
}

function service(results: SchoolLoginResult[] = ["signed_in"], opts: { signedIn?: boolean; canvas?: "ok" | "rejected" | "failed"; available?: boolean } = {}) {
  const s = store(opts.available);
  const logins: string[] = [];
  const svc = new CredentialService({
    store: s.store,
    login: async (id) => { logins.push(id); return results.shift() ?? "failed"; },
    signedIn: async () => opts.signedIn ?? false,
    checkCanvasToken: async () => opts.canvas ?? "ok",
  });
  return { ...s, svc, logins };
}

test("saved details are encrypted on disk, owner-only, and status never carries values", async () => {
  const { svc, file } = service();
  const status = await svc.saveSchool({ schoolId: "2026000001", password: "synthetic-pw" });
  assert.deepEqual(status, { school: true, schoolRejected: false, canvasToken: false, available: true });
  const raw = readFileSync(file);
  assert.equal(raw.includes(Buffer.from("synthetic-pw")), false);
  assert.equal(raw.includes(Buffer.from("2026000001")), false);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-pw|2026000001/);
});

test("the school is asked once before saving; a rejection saves nothing", async () => {
  const { svc, logins } = service(["rejected"]);
  await assert.rejects(svc.saveSchool({ schoolId: "x", password: "wrong" }), (e: { appError?: { code: string } }) => e.appError?.code === "AUTH_REQUIRED");
  assert.equal(logins.length, 1);
  assert.equal(svc.status().school, false);
});

test("an unreachable school saves nothing and says it can be retried", async () => {
  const { svc } = service(["failed"]);
  await assert.rejects(svc.saveSchool({ schoolId: "x", password: "y" }), (e: { appError?: { code: string; retryable: boolean } }) => e.appError?.code === "DOWNLOAD_FAILED" && e.appError.retryable);
  assert.equal(svc.status().school, false);
});

test("before a run: a lapsed session is renewed once; a live one is left alone", async () => {
  const lapsed = service(["signed_in", "signed_in"]);
  await lapsed.svc.saveSchool({ schoolId: "id", password: "pw" });
  await lapsed.svc.ensureSignedIn();
  assert.equal(lapsed.logins.length, 2);

  const live = service(["signed_in"], { signedIn: true });
  await live.svc.saveSchool({ schoolId: "id", password: "pw" });
  await live.svc.ensureSignedIn();
  assert.equal(live.logins.length, 1, "only the save-time check");
});

test("a password the school starts refusing is never tried again until saved anew (lockout guard)", async () => {
  const { svc, logins } = service(["signed_in", "rejected", "signed_in"]);
  await svc.saveSchool({ schoolId: "id", password: "old" });
  await svc.ensureSignedIn();
  assert.equal(svc.status().schoolRejected, true);
  await svc.ensureSignedIn();
  await svc.ensureSignedIn();
  assert.equal(logins.length, 2);
  await svc.saveSchool({ schoolId: "id", password: "new" });
  assert.equal(svc.status().schoolRejected, false);
});

test("nothing saved means no sign-in attempt", async () => {
  const { svc, logins } = service();
  await svc.ensureSignedIn();
  assert.equal(logins.length, 0);
});

test("Canvas token is saved only when Canvas accepts it, and can be cleared on its own", async () => {
  const bad = service([], { canvas: "rejected" });
  await assert.rejects(bad.svc.saveCanvasToken({ token: "synthetic-token-1" }));
  assert.equal(bad.svc.canvasToken(), undefined);

  const good = service();
  await good.svc.saveSchool({ schoolId: "id", password: "pw" });
  await good.svc.saveCanvasToken({ token: "synthetic-token-2" });
  assert.equal(good.svc.canvasToken(), "synthetic-token-2");
  assert.deepEqual(good.svc.clear({ which: "canvasToken" }), { school: true, schoolRejected: false, canvasToken: false, available: true });
  assert.deepEqual(good.svc.clear({ which: "school" }), { school: false, schoolRejected: false, canvasToken: false, available: true });
});

test("without Keychain-backed encryption nothing is saved", async () => {
  const { svc, logins } = service(["signed_in"], { available: false });
  await assert.rejects(svc.saveSchool({ schoolId: "id", password: "pw" }));
  assert.equal(logins.length, 0, "no login attempt either");
  assert.equal(svc.status().available, false);
});

/** Synthetic SSO shaped like the real one (khu-login.sh flow). */
function sso(outcome: "ok" | "wrong" | "no-callback") {
  const cookies = new Map<string, string>();
  const calls: { url: string; method: string; body?: string; referer: string | null }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}), referer: new Headers(init?.headers).get("referer") });
    if (url === KHU_LOGIN_URL) {
      cookies.set("xn_sso_csrf_token_for_this_login", "csrf-synthetic");
      return new Response("<form>");
    }
    if (url === "https://e-campus.khu.ac.kr/xn-sso/gw-cb.php") {
      if (outcome === "wrong") return new Response("<p>로그인 오류</p>");
      if (outcome === "no-callback") return new Response("<html>changed</html>");
      return new Response(`<iframe src="https://khcanvas.khu.ac.kr/learningx/login/from_cc?result=abc&amp;x=1"></iframe>`);
    }
    if (url === "https://khcanvas.khu.ac.kr/learningx/login/from_cc?result=abc&x=1") {
      cookies.set("xn_api_token", "t");
      return new Response("ok");
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof globalThis.fetch;
  return { calls, deps: { fetch, cookie: async (_u: string, n: string) => cookies.get(n), signedIn: async () => cookies.has("xn_api_token") } };
}

test("SSO replay: CSRF from the login page, form post, then the LearningX callback", async () => {
  const { calls, deps } = sso("ok");
  assert.equal(await schoolLogin(deps, "id-1", "pw-1"), "signed_in");
  const post = calls.find((c) => c.method === "POST")!;
  assert.deepEqual(Object.fromEntries(new URLSearchParams(post.body)), { csrf_token: "csrf-synthetic", login_user_id: "id-1", login_user_password: "pw-1" });
  assert.equal(calls.at(-1)!.referer, "https://e-campus.khu.ac.kr/");
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("SSO replay reports a rejection without retrying, and a changed flow as failed", async () => {
  const wrong = sso("wrong");
  assert.equal(await schoolLogin(wrong.deps, "id", "bad"), "rejected");
  assert.equal(wrong.calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(await schoolLogin(sso("no-callback").deps, "id", "pw"), "failed");
});
