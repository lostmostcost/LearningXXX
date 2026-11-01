import assert from "node:assert/strict";

export const BASE = "https://lms.example.test";
export const STORAGE = "https://files.example.test";
export const C = "/api/v1/courses/1001";

/** Mutable synthetic LMS. Downloads redirect to a separate storage origin like Canvas does. */
export function lms() {
  const state = {
    files: new Map<string, { name: string; body: string; modified: string; locked?: boolean; url?: string; served?: string }>([
      ["9001", { name: "week1-boolean.pdf", body: "%PDF-synthetic-1", modified: "2026-10-01T00:00:00Z" }],
      ["9002", { name: "week2-lab.pptx", body: "synthetic-pptx", modified: "2026-10-02T00:00:00Z" }],
      ["9003", { name: "notice-map.pdf", body: "%PDF-synthetic-map", modified: "2026-10-03T00:00:00Z" }],
    ]),
    modules: new Map<string, unknown[]>([
      ["501", [
        { id: 1, type: "File", content_id: 9001, html_url: `${BASE}/courses/1001/modules/items/1` },
        { id: 2, type: "Page", html_url: `${BASE}/courses/1001/pages/intro` },
        { id: 3, type: "Assignment", content_id: 7001 },
      ]],
      ["502", [
        { id: 4, type: "File", content_id: 9002 },
        { id: 5, type: "File", content_id: 9001 },
        { id: 6, type: "Quiz", content_id: 8001 },
        { id: 7, type: "ExternalUrl" },
      ]],
    ]),
    announcements: [
      { id: 6001, title: "강의실 변경", html_url: `${BASE}/courses/1001/discussion_topics/6001`, posted_at: "2026-10-05T01:00:00Z", attachments: [{ id: 9003, display_name: "map.pdf", filename: "notice-map.pdf", "content-type": "application/pdf", size: 18, url: `${BASE}/files/9003/download?verifier=s` }] },
      { id: 6002, title: "예약 공지", posted_at: null },
    ] as Record<string, unknown>[],
    assignments: [
      { id: 7001, name: "과제 1", due_at: "2026-11-07T14:59:00Z", html_url: `${BASE}/courses/1001/assignments/7001`, updated_at: "2026-10-04T00:00:00Z" },
      { id: 7002, name: "퀴즈 1", due_at: "2026-11-10T23:59:00", html_url: `${BASE}/courses/1001/assignments/7002`, updated_at: "2026-10-04T00:00:00Z", quiz_id: 8001 },
      { id: 7003, name: "기말 보고서", due_at: null, html_url: "http://insecure.example.test/a", updated_at: "2026-10-04T00:00:00Z" },
    ] as Record<string, unknown>[],
    failing: new Set<string>(),
    calls: [] as { url: string; cookie: string | null }[],
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    const headers = new Headers(init?.headers);
    state.calls.push({ url: url.href, cookie: headers.get("cookie") });
    if (state.failing.has(path) || state.failing.has(url.href)) return new Response("down", { status: 503 });
    if (url.origin === STORAGE) {
      const file = state.files.get(url.pathname.split("/").pop()!);
      return file ? new Response(file.served ?? file.body) : new Response("", { status: 404 });
    }
    if (path === C) return json({ id: 1001, name: "합성 논리회로", enrollment_term_id: 77 });
    if (path === `${C}/modules?per_page=100`) return json([{ id: 501, name: "1주차", position: 1 }, { id: 502, name: "2주차", position: 2 }]);
    let m = /^\/api\/v1\/courses\/1001\/modules\/(\d+)\/items\?per_page=100$/.exec(path);
    if (m) return json(state.modules.get(m[1]!) ?? []);
    m = /^\/api\/v1\/courses\/1001\/files\/(\d+)$/.exec(path);
    if (m) {
      const f = state.files.get(m[1]!);
      if (!f) return json({ message: "not found" }, 404);
      return json({ id: Number(m[1]), display_name: f.name, filename: f.name, "content-type": f.name.endsWith(".pdf") ? "application/pdf" : "application/vnd.ms-powerpoint; charset=x", size: Buffer.byteLength(f.body), url: f.url ?? `${BASE}/files/${m[1]}/download?verifier=s`, modified_at: f.modified, updated_at: f.modified, locked_for_user: f.locked ?? false });
    }
    m = /^\/files\/(\d+)\/download/.exec(url.pathname);
    if (m) return new Response(null, { status: 302, headers: { location: `${STORAGE}/blob/${m[1]}` } });
    if (path === `${C}/discussion_topics?only_announcements=true&per_page=100`) return json(state.announcements);
    if (path === `${C}/assignments?per_page=100`) return json(state.assignments);
    assert.fail(`unexpected request ${url.href}`);
  }) as typeof globalThis.fetch;
  return { state, fetch };
}
