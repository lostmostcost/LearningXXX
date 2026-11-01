import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError, SCHEMA_VERSION } from "@learningxxx/contracts";
import { createRouter } from "../src/router.ts";

const envelope = (channel: string, payload: unknown = {}) => ({ schemaVersion: SCHEMA_VERSION, channel, payload });
const router = createRouter({
  "session.list": async () => ({ sessions: [] }),
});

async function code(raw: unknown, handle = router) {
  const result = await handle(raw);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  AppError.parse(result.error);
  return result.error.code;
}

test("a valid read reaches its handler", async () => {
  assert.deepEqual(await router(envelope("session.list", { includeArchived: false })), { ok: true, data: { sessions: [] } });
});

test("unknown channels are rejected", async () => {
  assert.equal(await code(envelope("shell.exec", { command: "rm -rf /" })), "INVALID_REQUEST");
});

test("non-object input is rejected", async () => {
  for (const raw of [null, undefined, "collection.status", 1]) assert.equal(await code(raw), "INVALID_REQUEST");
});

test("another schema major asks for an update", async () => {
  assert.equal(await code({ schemaVersion: SCHEMA_VERSION + 1, channel: "collection.status", payload: {} }), "SCHEMA_VERSION_UNSUPPORTED");
});

test("a bad payload never reaches the handler", async () => {
  let called = false;
  const handle = createRouter({ "session.list": async () => ((called = true), { sessions: [] }) });
  assert.equal(await code(envelope("session.list", { includeArchived: "yes" }), handle), "INVALID_REQUEST");
  assert.equal(called, false);
});

test("an independent session cannot carry a course", async () => {
  const payload = { mode: "independent", title: "t", courseId: "11111111-1111-4111-8111-000000000001" };
  assert.equal(await code(envelope("session.create", payload)), "INVALID_REQUEST");
});

test("channels without an implementation report so", async () => {
  assert.equal(await code(envelope("collection.run", { scope: "all_courses" })), "INTERNAL");
});

test("internal failures do not leak their text", async () => {
  const handle = createRouter({
    "collection.status": async () => {
      throw new Error("/Users/someone/secret");
    },
  });
  const result = await handle(envelope("collection.status"));
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("a handler reply that breaks the contract is not sent", async () => {
  const handle = createRouter({ "session.list": async () => ({ sessions: "nope" }) as never });
  assert.equal(await code(envelope("session.list", { includeArchived: false }), handle), "INTERNAL");
});

test("typed collection errors pass through", async () => {
  const appError = { code: "AUTH_REQUIRED", message: "다시 로그인하세요.", retryable: false } as const;
  const handle = createRouter({
    "collection.status": async () => {
      throw Object.assign(new Error("x"), { appError });
    },
  });
  assert.equal(await code(envelope("collection.status"), handle), "AUTH_REQUIRED");
});
