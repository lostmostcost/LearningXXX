import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { CanvasClient } from "../../packages/collector/src/index.ts";
import { SCHEMA_VERSION } from "../../packages/contracts/src/index.ts";
import type { IpcChannel, IpcRequest, IpcResponse, RunEvent, SyncRun } from "../../packages/contracts/src/index.ts";
import { startRun } from "../../packages/cli-adapter/src/index.ts";
import { LibraryService } from "../../apps/desktop/host/src/library-service.ts";
import { SessionService } from "../../apps/desktop/host/src/session-service.ts";
import { SessionStore } from "../../apps/desktop/host/src/session-store.ts";
import { RunHistory } from "../../apps/desktop/host/src/run-history.ts";
import { FileService } from "../../apps/desktop/host/src/file-service.ts";
import { createRouter } from "../../apps/desktop/host/src/router.ts";
import { createHandlers } from "../../apps/desktop/host/src/handlers.ts";
import { makeSyntheticPdf } from "../../apps/desktop/ui/src/synthetic-pdf.ts";

export const LMS = "https://lms.example.test";
export const STORAGE = "https://storage.example.test";
export const PDF = makeSyntheticPdf({ pages: ["Boolean algebra selected excerpt", "UNSELECTED_PAGE_CANARY"] });

export async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "integration operation did not settle within 5 seconds");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** All network and CLI endpoints are synthetic; no real CLI or browser sign-in can be reached. */
export async function harness(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wbs019-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataRoot = join(root, "data"), home = join(root, "fake-home"), record = join(root, "calls.jsonl");
  mkdirSync(dataRoot); mkdirSync(home);
  const cli = join(home, "synthetic-cli");
  writeFileSync(cli, `#!${process.execPath}\n${readFileSync(new URL("../../packages/cli-adapter/test/fake-claude.mjs", import.meta.url), "utf8")}`);
  chmodSync(cli, 0o755);
  const state = { user: 42, offline: false, expired: false, scenario: "ok", confirm: false, loginCount: 0,
    extraEnv: {} as NodeJS.ProcessEnv, external: join(root, "external") };
  mkdirSync(state.external);
  const network: { url: string; headers: Headers }[] = [];
  const progress: SyncRun[] = [], events: RunEvent[] = [], trash: string[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body));
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    network.push({ url: url.href, headers: new Headers(init?.headers) });
    if (state.offline) throw new TypeError("synthetic offline");
    if (url.origin === STORAGE) return new Response(PDF.slice(), { headers: { "content-type": "application/pdf" } });
    if (state.expired) return new Response("", { status: 401 });
    const path = url.pathname;
    if (path === "/api/v1/users/self") return json({ id: state.user });
    if (path === "/api/v1/courses/95899") return json({ id: 95899, name: "SYNTHETIC_COURSE_CANARY", enrollment_term_id: 122 });
    if (path.endsWith("/modules")) return json([{ id: 1, name: "1주차", position: 1 }]);
    if (path.endsWith("/modules/1/items")) return json([{ id: 10, type: "File", content_id: 9001 }]);
    if (path.endsWith("/files/9001")) return json({ id: 9001, display_name: "sample.pdf", filename: "sample.pdf", "content-type": "application/pdf", size: PDF.length,
      url: `${LMS}/files/9001/download`, modified_at: "2026-10-01T00:00:00Z" });
    if (path === "/files/9001/download") return new Response(null, { status: 302, headers: { location: `${STORAGE}/9001` } });
    if (path.endsWith("/discussion_topics") || path.endsWith("/assignments")) return json([]);
    return new Response("", { status: 404 });
  }) as typeof globalThis.fetch;
  const library = new LibraryService({ root: join(dataRoot, "library"),
    client: () => new CanvasClient({ baseUrl: LMS, fetch, getAuthHeaders: async () => ({ cookie: "synthetic-session" }) }),
    onProgress: (run) => progress.push(run), openLogin: () => { state.loginCount++; } });
  await library.init();
  const store = new SessionStore(join(dataRoot, "app-state.json"));
  const options = { dataRoot, store, history: (now: () => string) => new RunHistory(join(dataRoot, "history"), now),
    startCli: (req: Parameters<typeof startRun>[0], signal: AbortSignal) => startRun(req, {
      cliPath: cli, signal, killGraceMs: 10,
      env: { HOME: home, PATH: "/usr/bin:/bin", FAKE_SCENARIO: state.scenario, FAKE_RECORD: record, FAKE_EXTERNAL: state.external, ...state.extraEnv },
    }), onEvent: (e: RunEvent) => events.push(e) };
  let sessions = new SessionService(options);
  const filesFor = () => new FileService({ dataRoot, sessions, history: sessions.history!,
    chooseFolder: async () => state.external, confirmTrash: async () => state.confirm,
    trash: async (path) => { const target = join(root, `trashed-${trash.length}`); renameSync(path, target); trash.push(path); } });
  let router = createRouter(createHandlers(sessions, library, filesFor()));
  const call = async <C extends IpcChannel>(channel: C, payload: IpcRequest<C>) =>
    router({ schemaVersion: SCHEMA_VERSION, channel, payload });
  const ok = async <C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResponse<C>> => {
    const result = await call(channel, payload);
    assert.ok(result.ok, result.ok ? "" : `${channel}: ${result.error.code}`);
    return result.data as IpcResponse<C>;
  };
  const collect = async () => {
    const { syncRunId } = await ok("collection.run", { scope: "all_courses" });
    await until(() => progress.some((r) => r.id === syncRunId && r.status !== "running"));
    return syncRunId;
  };
  const calls = () => existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; stdin: string; cwd: string }) : [];
  return { root, dataRoot, state, network, progress, events, call, ok, collect, calls, store, trash,
    sessions: () => sessions,
    restart: () => { sessions = new SessionService(options); router = createRouter(createHandlers(sessions, library, filesFor())); } };
}
