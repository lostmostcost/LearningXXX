import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { z } from "zod";
import * as C from "../src/index.ts";

const FIXTURES = join(import.meta.dirname, "../../../tests/fixtures/contracts");
const load = (ref: string): unknown => {
  const [file, pointer] = ref.split("#");
  let value: unknown = JSON.parse(readFileSync(join(FIXTURES, file!), "utf8"));
  for (const key of (pointer ?? "").split("/").filter(Boolean)) {
    value = (value as Record<string, unknown>)[key];
  }
  return structuredClone(value);
};
const ok = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const r = C.parseVersioned(schema, input);
  assert.ok(r.ok, r.ok ? "" : `${r.error.code}: ${JSON.stringify(r.error.detail)}`);
  return r.value;
};

describe("consumer: every valid synthetic fixture parses", () => {
  const cases: [string, z.ZodType][] = [
    ["normal/manifest.json", C.CollectionManifest],
    ["other-account/manifest.json", C.CollectionManifest],
    ["normal/sync-run.json", C.SyncRun],
    ["expired/sync-run.json", C.SyncRun],
    ["interrupted/sync-run-partial.json", C.SyncRun],
    ["interrupted/sync-run-interrupted.json", C.SyncRun],
    ["normal/sessions.json", z.array(C.Session)],
    ["interrupted/run.json", C.Run],
    ["normal/events.json", z.array(C.RunEvent)],
    ["expired/events.json", z.array(C.RunEvent)],
    ["interrupted/events-cancelled.json", z.array(C.RunEvent)],
  ];
  for (const [file, schema] of cases) it(file, () => void ok(schema, load(file)));
});

describe("consumer: invalid cases fail with the expected code", () => {
  type Case = { name: string; schema: keyof typeof C; base: string; patch: Record<string, unknown>; expect: string };
  for (const c of load("invalid/cases.json") as Case[]) {
    it(c.name, () => {
      const input = { ...(load(c.base) as Record<string, unknown>) };
      for (const [k, v] of Object.entries(c.patch)) {
        if (v === null) delete input[k];
        else input[k] = v;
      }
      const r = C.parseVersioned(C[c.schema] as z.ZodType, input);
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.error.code, c.expect);
    });
  }
});

describe("versioning", () => {
  it("additive unknown fields in the same major are accepted and stripped", () => {
    const input = { ...(load("normal/sync-run.json") as object), addedInMinor: "x" };
    const value = ok(C.SyncRun, input) as Record<string, unknown>;
    assert.equal("addedInMinor" in value, false);
  });
  it("every versioned fixture declares the current major", () => {
    for (const f of ["normal/manifest.json", "normal/sync-run.json", "expired/sync-run.json"]) {
      assert.equal((load(f) as { schemaVersion: number }).schemaVersion, C.SCHEMA_VERSION);
    }
  });
});

describe("producer → consumer round trip", () => {
  it("a host-produced event stream survives JSON and passes stream checks", () => {
    const runId = crypto.randomUUID();
    let seq = 0;
    const at = "2026-11-01T00:00:00Z";
    const base = () => ({ schemaVersion: C.SCHEMA_VERSION, eventId: crypto.randomUUID(), runId, seq: seq++, occurredAt: at });
    const produced: C.RunEvent[] = [
      { ...base(), type: "run.started", payload: { appSessionId: crypto.randomUUID(), cliSessionId: crypto.randomUUID(), mode: "independent", apiKeySource: "none", tools: ["Read", "Glob", "Grep"], mcpServers: [] } },
      { ...base(), type: "text.delta", payload: { text: "hi" } },
      { ...base(), type: "run.failed", payload: { error: { code: "USAGE_LIMIT", message: "사용량 한도", retryable: true, retryAfter: at } } },
    ];
    const consumed = ok(z.array(C.RunEvent), JSON.parse(JSON.stringify(produced)));
    assert.deepEqual(consumed, produced);
    assert.deepEqual(C.checkEventStream(consumed), []);
  });

  it("every IPC channel round-trips a valid request through the host validator", () => {
    const sid = crypto.randomUUID();
    const samples: { [K in C.IpcChannel]: C.IpcRequest<K> } = {
      "collection.run": { scope: "course", courseId: sid },
      "collection.status": {},
      "library.manifest": { courseId: sid },
      "session.create": { mode: "independent", title: "새 독립 세션" },
      "session.list": { includeArchived: false },
      "session.rename": { appSessionId: sid, title: "이름" },
      "session.archive": { appSessionId: sid, archived: true },
      "run.start": {
        requestId: crypto.randomUUID(),
        draft: { text: "", attachmentIds: [], captureIds: [], targetSessionId: sid, intent: "translate_en_ko", selection: { assetId: sid, page: 3, text: "Boolean algebra" } },
      },
      "run.cancel": { runId: sid },
    };
    for (const channel of Object.keys(C.IpcChannels) as C.IpcChannel[]) {
      const schema = C.IpcChannels[channel].request as z.ZodType;
      assert.ok(schema.safeParse(JSON.parse(JSON.stringify(samples[channel]))).success, channel);
    }
  });
});

describe("invariants", () => {
  it("event stream checker catches gaps, foreign runs and events after terminal", () => {
    const events = load("normal/events.json") as C.RunEvent[];
    assert.deepEqual(C.checkEventStream(events), []);
    const gap = events.filter((_, i) => i !== 2);
    assert.ok(C.checkEventStream(gap).some((p) => p.includes("seq gap")));
    const after = [...events, { ...events[1]!, seq: events.length }];
    assert.ok(C.checkEventStream(after).some((p) => p.includes("after terminal")));
    const foreign = events.map((e, i) => (i === 1 ? { ...e, runId: crypto.randomUUID() } : e));
    assert.ok(C.checkEventStream(foreign).some((p) => p.includes("another run")));
  });

  it("other account's copy of the same LMS course stays a separate course", () => {
    const a = ok(C.CollectionManifest, load("normal/manifest.json"));
    const b = ok(C.CollectionManifest, load("other-account/manifest.json"));
    assert.equal(a.course.sourceCourseId, b.course.sourceCourseId);
    assert.notEqual(a.course.accountKey, b.course.accountKey);
    assert.notEqual(a.course.id, b.course.id);
    const idsA = new Set(a.items.map((i) => i.resource.id));
    assert.ok(b.items.every((i) => !idsA.has(i.resource.id)), "resource ids must not collide across accounts");
  });

  it("manifest rejects cross-course references and live+tombstoned resources", () => {
    const m = load("normal/manifest.json") as { items: { resource: { courseId: string; id: string } }[]; tombstones: { resourceId: string }[] };
    m.items[0]!.resource.courseId = "11111111-1111-4111-8111-000000000002";
    assert.equal(C.CollectionManifest.safeParse(m).success, false);
    const t = load("normal/manifest.json") as typeof m;
    t.tombstones.push({ ...t.tombstones[0]!, resourceId: t.items[0]!.resource.id });
    assert.equal(C.CollectionManifest.safeParse(t).success, false);
  });

  it("independent session.create has no way to pass the browsing course", () => {
    const req = C.IpcChannels["session.create"].request;
    assert.equal(req.safeParse({ mode: "independent", title: "x", courseId: crypto.randomUUID() }).success, false);
    assert.equal(req.safeParse({ mode: "course", title: "x" }).success, false);
  });

  it("translate intent requires a selection; empty drafts are rejected", () => {
    const sid = crypto.randomUUID();
    const base = { text: "", attachmentIds: [], captureIds: [], targetSessionId: sid };
    assert.equal(C.ComposerDraft.safeParse({ ...base, intent: "chat" }).success, false);
    assert.equal(C.ComposerDraft.safeParse({ ...base, text: "번역해줘", intent: "translate_en_ko" }).success, false);
  });

  it("IPC errors use the shared result envelope", () => {
    const schema = C.ipcResult(z.object({ syncRunId: C.Id }));
    assert.ok(schema.safeParse({ ok: false, error: { code: "AUTH_REQUIRED", message: "로그인 필요", retryable: false } }).success);
    assert.equal(schema.safeParse({ ok: true, error: {} }).success, false);
  });
});

describe("fixture privacy (ARCH-001: synthetic data only)", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(FIXTURES);
  for (const file of files) {
    it(file.slice(FIXTURES.length + 1), () => {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.]+/, "e-mail address");
      assert.doesNotMatch(text, /\b20\d{8}\b/, "student-number-like digits");
      assert.doesNotMatch(text, /cookie|bearer|sk-ant|session_token|password/i, "credential-like text");
      for (const url of text.match(/https?:\/\/[^"\s]+/g) ?? []) {
        assert.match(new URL(url).hostname, /\.test$/, `non-synthetic host ${url}`);
      }
    });
  }
});
