import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { SyncRun } from "@learningxxx/contracts";
import {
  CanvasClient,
  CollectionError,
  acquireCourseLock,
  collectCourse,
  createDirectoryStore,
  readSyncStatus,
  recoverInterruptedRuns,
  summarizeRun,
} from "../src/index.ts";
import type { AssetStore } from "../src/index.ts";
import { BASE, C, lms, noWait } from "./fake-lms.ts";

const accountKey = "acct_synthalpha01";

function setup(options: { store?: (inner: AssetStore) => AssetStore } = {}) {
  const fake = lms();
  const root = mkdtempSync(join(tmpdir(), "wbs009-"));
  const inner = createDirectoryStore(root);
  const store = options.store ? options.store(inner) : inner;
  const waits: number[] = [];
  const client = new CanvasClient({ baseUrl: BASE, fetch: fake.fetch, getAuthHeaders: async () => ({ Cookie: "session=synthetic" }) });
  const run = () => collectCourse({ client, store, root, accountKey, sourceCourseId: "1001", retry: noWait(waits) });
  const calls = (path: string) => fake.state.calls.filter((c) => c.url === `${BASE}${path}`).length;
  return { ...fake, root, run, waits, calls };
}

const originals = (root: string) => readdirSync(join(root, "originals"), { recursive: true }).filter((n) => String(n).includes("."));

describe("bounded retry", () => {
  test("a transient outage is retried and leaves no error", async () => {
    const { run, state, calls } = setup();
    state.flaky.set(`${C}/files/9002`, { left: 1, status: 503 });
    const r = await run();
    assert.equal(r.syncRun.status, "succeeded");
    assert.equal(calls(`${C}/files/9002`), 2);
  });

  test("retries stop after three tries and the item is reported", async () => {
    const { run, state, calls } = setup();
    state.flaky.set(`${C}/files/9002`, { left: 99, status: 503 });
    const r = await run();
    assert.equal(r.syncRun.status, "partial");
    assert.equal(calls(`${C}/files/9002`), 3);
  });

  test("an expired login is never retried", async () => {
    const { run, state, calls } = setup();
    state.flaky.set(C, { left: 99, status: 401 });
    const r = await run();
    assert.equal(r.syncRun.status, "failed");
    assert.equal(r.syncRun.errors[0]?.code, "AUTH_REQUIRED");
    assert.equal(calls(C), 1);
  });

  test("a short Retry-After is waited out; a long one is recorded with its time", async () => {
    const short = setup();
    short.state.flaky.set(`${C}/assignments?per_page=100`, { left: 1, status: 429, headers: { "retry-after": "5" } });
    assert.equal((await short.run()).syncRun.status, "succeeded");
    assert.ok(short.waits.some((ms) => ms > 3000 && ms <= 5000), `waited ${short.waits}`);

    const long = setup();
    long.state.flaky.set(`${C}/assignments?per_page=100`, { left: 99, status: 429, headers: { "retry-after": "3600" } });
    const r = await long.run();
    assert.equal(r.syncRun.status, "partial");
    assert.equal(r.syncRun.errors[0]?.code, "RATE_LIMITED");
    assert.ok(r.syncRun.errors[0]?.retryAfter);
    assert.equal(long.calls(`${C}/assignments?per_page=100`), 1, "not hammered");
    assert.ok(summarizeRun(r.syncRun, r.changes).lines.some((l) => l.includes(r.syncRun.errors[0]!.retryAfter!)));
  });
});

describe("one run at a time", () => {
  test("a second start while one is running is refused without writing anything", async () => {
    const { run, root } = setup();
    const lock = await acquireCourseLock(root, { accountKey, sourceCourseId: "1001", syncRunId: "x" });
    const error = await run().then(() => assert.fail("expected RUN_ALREADY_ACTIVE"), (e: unknown) => e);
    assert.ok(error instanceof CollectionError);
    assert.equal(error.appError.code, "RUN_ALREADY_ACTIVE");
    assert.equal(existsSync(join(root, "sync-runs")), false);
    await lock.release();
    assert.equal((await run()).syncRun.status, "succeeded");
  });

  test("two simultaneous starts: exactly one runs", async () => {
    const { run } = setup();
    const results = await Promise.allSettled([run(), run()]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.equal((rejected.reason as CollectionError).appError.code, "RUN_ALREADY_ACTIVE");
  });

  test("a lock left by a dead process is taken over", async () => {
    const { run, root } = setup();
    mkdirSync(join(root, "locks"), { recursive: true });
    const lockFile = readdirSync(join(root, "locks"));
    assert.deepEqual(lockFile, []);
    const held = await acquireCourseLock(root, { accountKey, sourceCourseId: "1001", syncRunId: "dead" });
    void held; // never released: simulates a crash
    const [name] = readdirSync(join(root, "locks"));
    writeFileSync(join(root, "locks", name!), JSON.stringify({ pid: 2 ** 22 + 12345, syncRunId: "dead", startedAt: new Date().toISOString() }));
    assert.equal((await run()).syncRun.status, "succeeded");
    assert.deepEqual(readdirSync(join(root, "locks")), [], "lock released after the run");
  });
});

describe("after an interruption", () => {
  test("a run left as running becomes interrupted and partial downloads are removed", async () => {
    const { run, root } = setup();
    mkdirSync(join(root, "sync-runs"), { recursive: true });
    mkdirSync(join(root, "tmp"), { recursive: true });
    const stuck = SyncRun.parse({ schemaVersion: 1, id: "99999999-9999-4999-8999-000000000001", accountKey, trigger: "manual", scope: "course", startedAt: "2026-11-01T08:00:00Z", status: "running", errors: [] });
    writeFileSync(join(root, "sync-runs", `${stuck.id}.json`), JSON.stringify(stuck));
    writeFileSync(join(root, "tmp", "half.part"), "partial bytes");
    const r = await run();
    assert.equal(r.syncRun.status, "succeeded");
    const recovered = SyncRun.parse(JSON.parse(readFileSync(join(root, "sync-runs", `${stuck.id}.json`), "utf8")));
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.errors.at(-1)?.code, "RUN_INTERRUPTED");
    assert.deepEqual(readdirSync(join(root, "tmp")), []);
    assert.ok(summarizeRun(recovered, { added: [], updated: [], removed: [] }).lines[0]!.includes("중간에 멈췄습니다"));
    assert.deepEqual(await recoverInterruptedRuns(root), [], "recovery is idempotent");
  });

  test("re-running after a crash mid-download ends in the same state with no duplicate originals", async () => {
    let crash = true;
    const crashing = setup({
      store: (inner) => ({
        ...inner,
        put: async (body, meta) => {
          const stored = await inner.put(body, meta);
          if (crash) {
            crash = false;
            throw new Error("process killed");
          }
          return stored;
        },
      }),
    });
    const first = await crashing.run();
    assert.equal(first.syncRun.status, "failed");
    assert.equal(first.written, false);
    const second = await crashing.run();
    assert.equal(second.syncRun.status, "succeeded");

    const clean = setup();
    const reference = await clean.run();
    assert.deepEqual(second.manifest?.items, reference.manifest?.items);
    assert.equal(originals(crashing.root).length, originals(clean.root).length);
  });
});

describe("change tracking and status text", () => {
  test("added, updated and removed are counted against the previous manifest", async () => {
    const { run, state } = setup();
    const first = await run();
    assert.equal(first.changes.added.length, 6);
    const again = await run();
    assert.deepEqual(again.changes, { added: [], updated: [], removed: [] });
    state.assignments[0]!.due_at = "2026-11-21T14:59:00Z";
    state.assignments.pop();
    const third = await run();
    assert.equal(third.changes.updated.length, 1);
    assert.equal(third.changes.removed.length, 1);
    const text = summarizeRun(third.syncRun, third.changes);
    assert.equal(text.tone, "ok");
    assert.ok(text.lines.some((l) => l.includes("바뀐 자료 1개") && l.includes("사라진 자료 1개")));
    assert.ok(text.lines.some((l) => l.includes("지우지 않았습니다")));
  });

  test("login required and partial failure read differently", async () => {
    const expired = setup();
    expired.state.flaky.set(C, { left: 99, status: 401 });
    const auth = await expired.run();
    const authText = summarizeRun(auth.syncRun, auth.changes);
    assert.equal(authText.tone, "error");
    assert.ok(authText.lines[0]!.includes("로그인이 필요합니다"));

    const partialSetup = setup();
    partialSetup.state.failing.add(`${C}/files/9002`);
    const partial = await partialSetup.run();
    const partialText = summarizeRun(partial.syncRun, partial.changes);
    assert.equal(partialText.tone, "warning");
    assert.ok(partialText.lines[0]!.includes("자료 1개를 받지 못했습니다"));
    assert.equal((await readSyncStatus(partialSetup.root, accountKey)).lastSucceeded, undefined);
  });
});
