import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AppError, Course, Week } from "@learningxxx/contracts";
import { CanvasClient, CollectionError, discoverCourse, listActiveCourses } from "../src/index.ts";
import { nextLink } from "../src/canvas-client.ts";

const BASE = "https://lms.example.test";
const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const COURSE_PATH = "/api/v1/courses/1001";
const MODULES_PATH = `${COURSE_PATH}/modules?per_page=100`;

type Reply = { status?: number; body?: string; headers?: Record<string, string> };

function server(routes: Record<string, Reply>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, init });
    const reply = routes[url.pathname + url.search];
    assert.ok(reply, `unexpected request ${url.href}`);
    return new Response(reply.body ?? "", { status: reply.status ?? 200, headers: reply.headers ?? {} });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const client = (fetch: typeof globalThis.fetch) =>
  new CanvasClient({
    baseUrl: BASE,
    fetch,
    getAuthHeaders: async () => ({ Cookie: "session=synthetic" }),
    now: () => new Date("2026-11-02T00:00:00Z"),
  });

const healthy = (): Record<string, Reply> => ({
  [COURSE_PATH]: { body: `while(1);${fixture("course.json")}` },
  [MODULES_PATH]: {
    body: fixture("modules-page1.json"),
    headers: { link: `<${BASE}${COURSE_PATH}/modules?page=2>; rel="next", <${BASE}${COURSE_PATH}/modules?page=2>; rel="last"` },
  },
  [`${COURSE_PATH}/modules?page=2`]: { body: fixture("modules-page2.json") },
});

const discover = (fetch: typeof globalThis.fetch, accountKey = "acct_synthalpha01") =>
  discoverCourse({ client: client(fetch), accountKey, sourceCourseId: "1001" });

async function failure(routes: Record<string, Reply>) {
  const error = await discover(server(routes).fetch).then(
    () => assert.fail("expected a failure"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof CollectionError);
  AppError.parse(error.appError);
  return error.appError;
}

test("collects a course and ordered weeks across pages into contract types", async () => {
  const { course, weeks } = await discover(server(healthy()).fetch);
  Course.parse(course);
  weeks.forEach((w) => Week.parse(w));
  assert.equal(course.title, "합성 논리회로");
  assert.equal(course.termId, "77");
  assert.deepEqual(weeks.map((w) => w.label), ["1주차", "2주차", "3주차"]);
  assert.deepEqual(weeks.map((w) => w.order), [0, 1, 2]);
  assert.ok(weeks.every((w) => w.courseId === course.id));
});

test("collecting twice yields identical IDs", async () => {
  assert.deepEqual(await discover(server(healthy()).fetch), await discover(server(healthy()).fetch));
});

test("the same course under another account gets a different identity", async () => {
  const alpha = await discover(server(healthy()).fetch);
  const beta = await discover(server(healthy()).fetch, "acct_synthbeta02");
  assert.notEqual(alpha.course.id, beta.course.id);
  assert.equal(alpha.course.sourceCourseId, beta.course.sourceCourseId);
});

test("sends only read requests, and no automatic redirects", async () => {
  const { calls, fetch } = server(healthy());
  await discover(fetch);
  assert.equal(calls.length, 3);
  for (const { init } of calls) {
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
  }
});

for (const [name, reply] of [
  ["401", { status: 401, body: "{}" }],
  ["redirect to login", { status: 302, headers: { location: "https://sso.example.test/login" } }],
] as [string, Reply][]) {
  test(`session expiry by ${name} is AUTH_REQUIRED and not retryable`, async () => {
    const error = await failure({ ...healthy(), [COURSE_PATH]: reply });
    assert.equal(error.code, "AUTH_REQUIRED");
    assert.equal(error.retryable, false);
  });
}

test("rate limiting reports the retry time", async () => {
  const error = await failure({ ...healthy(), [COURSE_PATH]: { status: 429, headers: { "retry-after": "30" } } });
  assert.equal(error.code, "RATE_LIMITED");
  assert.equal(error.retryAfter, "2026-11-02T00:00:30Z");
});

test("Canvas 403 throttling is rate limiting, not a lost course", async () => {
  const error = await failure({ ...healthy(), [COURSE_PATH]: { status: 403, body: "403 Forbidden (Rate Limit Exceeded)" } });
  assert.equal(error.code, "RATE_LIMITED");
});

test("server errors are retryable", async () => {
  const error = await failure({ ...healthy(), [COURSE_PATH]: { status: 503 } });
  assert.equal(error.code, "DOWNLOAD_FAILED");
  assert.equal(error.retryable, true);
});

test("network failure is retryable and hides the cause", async () => {
  const fetch = (async () => {
    throw new Error("session=synthetic leaked");
  }) as typeof globalThis.fetch;
  const error = await discover(fetch).catch((e: unknown) => e);
  assert.ok(error instanceof CollectionError);
  assert.equal(error.appError.code, "DOWNLOAD_FAILED");
  assert.doesNotMatch(JSON.stringify(error.appError), /synthetic/);
});

for (const [name, patch] of [
  ["a missing course", { [COURSE_PATH]: { status: 404 } }],
  ["an HTML page served with 200", { [COURSE_PATH]: { body: "<html>로그인</html>" } }],
  ["a changed course shape", { [COURSE_PATH]: { body: '{"id":1001}' } }],
  ["another course", { [COURSE_PATH]: { body: '{"id":2,"name":"x","enrollment_term_id":1}' } }],
  ["a non-list module reply", { [MODULES_PATH]: { body: "{}" } }],
  ["a changed module shape", { [MODULES_PATH]: { body: '[{"id":1}]' } }],
  ["duplicate modules", { [MODULES_PATH]: { body: '[{"id":1,"name":"a","position":1},{"id":1,"name":"b","position":2}]' } }],
] as [string, Record<string, Reply>][]) {
  test(`${name} is SOURCE_CHANGED`, async () => {
    assert.equal((await failure({ ...healthy(), ...patch })).code, "SOURCE_CHANGED");
  });
}

test("a pagination link to another origin never receives credentials", async () => {
  const routes = healthy();
  routes[MODULES_PATH] = { body: "[]", headers: { link: '<https://evil.example.test/steal>; rel="next"' } };
  const { calls, fetch } = server(routes);
  const error = await discover(fetch).catch((e: unknown) => e);
  assert.ok(error instanceof CollectionError);
  assert.equal(error.appError.code, "SOURCE_CHANGED");
  assert.ok(calls.every(({ url }) => url.startsWith(BASE)));
});

test("an endless pagination loop stops", async () => {
  const routes = healthy();
  routes[MODULES_PATH] = { body: "[]", headers: { link: `<${BASE}${MODULES_PATH}>; rel="next"` } };
  assert.equal((await failure(routes)).code, "SOURCE_CHANGED");
});

test("refuses plain http so credentials never travel unencrypted", () => {
  assert.throws(() => new CanvasClient({ baseUrl: "http://lms.example.test", getAuthHeaders: async () => ({}) }));
});

test("refuses a course ID that could alter the request path", async () => {
  await assert.rejects(discoverCourse({ client: client(server({}).fetch), accountKey: "acct_synthalpha01", sourceCourseId: "1/../2" }));
});

test("nextLink ignores other relations", () => {
  assert.equal(nextLink('<https://a.test/1>; rel="last"', "https://a.test"), undefined);
  assert.equal(nextLink(null, "https://a.test"), undefined);
});

test("active courses: only named, unrestricted student courses, in Canvas order (WBS-041)", async () => {
  const { fetch } = server({
    "/api/v1/courses?enrollment_state=active&enrollment_type=student&per_page=100": {
      body: JSON.stringify([
        { id: 95899, name: "논리회로" },
        { id: 97001, name: "자료구조" },
        { id: 97002, access_restricted_by_date: true },
        { id: 97003, name: "잠긴 과목", access_restricted_by_date: true },
        { id: 95899, name: "중복" },
      ]),
    },
  });
  assert.deepEqual(await listActiveCourses(client(fetch)), ["95899", "97001"]);
});

test("WBS-074: a week number the LMS skips gets an empty week in its place; unnumbered modules stay where they are", async () => {
  const { fillWeekGaps, isPlaceholderWeek, weekNumberOf } = await import("../src/discovery.ts");
  const courseId = "11111111-1111-4111-8111-000000000001";
  const week = (sid: string, label: string, order: number) => Week.parse({ id: `22222222-2222-4222-8222-${sid.padStart(12, "0")}`, courseId, sourceWeekId: sid, label, order });
  const filled = fillWeekGaps(courseId, [week("1", "오리엔테이션", 0), week("2", "1주차", 1), week("3", "2주차 (9/8~)", 2), week("4", "5주차", 3), week("5", "참고 자료", 4)]);
  assert.deepEqual(filled.map((w) => [w.label, isPlaceholderWeek(w)]), [
    ["오리엔테이션", false], ["1주차", false], ["2주차 (9/8~)", false], ["3주차", true], ["4주차", true], ["5주차", false], ["참고 자료", false],
  ]);
  assert.deepEqual(filled.map((w) => w.order), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(filled.map((w) => w.id)).size, filled.length);
  assert.equal(fillWeekGaps(courseId, filled.slice(0, 3)).length, 3, "nothing to fill");
  assert.deepEqual(fillWeekGaps(courseId, [week("9", "Week 1", 0), week("8", "Week 3", 1)]).map((w) => w.label), ["Week 1", "2주차", "Week 3"]);
  assert.equal(fillWeekGaps(courseId, [week("1", "Intro", 0)]).length, 1);
  assert.equal(weekNumberOf("12주차 기말"), 12);
  assert.equal(weekNumberOf("자료"), undefined);
  // The same gap always gets the same id, so recordings filed under it stay there after the next collection.
  assert.equal(fillWeekGaps(courseId, [week("2", "1주차", 0), week("4", "3주차", 1)])[1]!.id, fillWeekGaps(courseId, [week("2", "1주차", 0), week("4", "3주차", 1)])[1]!.id);
});
