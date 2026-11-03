import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollectionManifest } from "@learningxxx/contracts";
import { MemoService, cleanupPrompt } from "../src/memos.ts";

const COURSE = "11111111-1111-4111-8111-111111111111";
const W1 = "22222222-2222-4222-8222-222222222221";
const OTHER = "22222222-2222-4222-8222-222222222299";
const manifest = { course: { title: "데이터베이스" }, weeks: [{ id: W1, label: "4주차" }] } as unknown as CollectionManifest;

async function setup(answer = "# 4주차 메모\n- WHERE 절로 행 제한") {
  const root = await mkdtemp(join(tmpdir(), "memos-"));
  let account: string | undefined = "acct_abcdefgh", clock = 0;
  const prompts: string[] = [];
  const memos = new MemoService({
    root, accountKey: () => account, manifest: async () => manifest,
    notes: async () => [{ weekId: W1, kind: "transcript", title: "4주차 녹음", text: "WHERE 절은 FROM 뒤에 옵니다" }, { weekId: undefined, kind: "notice", title: "다른 공지", text: "무관" }],
    summary: async () => "# 데이터베이스\n평가: 중간 30%",
    write: async ({ prompt }) => { prompts.push(prompt); return answer; },
    now: () => new Date(Date.UTC(2026, 10, 4, 0, 0, clock++)),
  });
  return { memos, prompts, root, setAccount: (a: string | undefined) => { account = a; }, done: () => rm(root, { recursive: true, force: true }) };
}

describe("memos", () => {
  it("saves per week, refuses a stale editor, and lists memos for the chat", async () => {
    const t = await setup();
    try {
      const empty = await t.memos.get(COURSE, W1);
      assert.deepEqual(empty, { text: "", updatedAt: null, canUndo: false });
      const saved = await t.memos.save(COURSE, W1, "where 절 중요", null);
      assert.equal(saved.text, "where 절 중요");
      await assert.rejects(t.memos.save(COURSE, W1, "옛 화면에서 저장", null), /다른 곳에서 메모가 바뀌었습니다/);
      await t.memos.save(COURSE, undefined, "주차 없는 메모", null);
      assert.equal((await t.memos.get(COURSE, undefined)).text, "주차 없는 메모");
      await assert.rejects(t.memos.get(COURSE, OTHER), /없는 주차/);
      assert.deepEqual((await t.memos.notes(COURSE)).map((n) => [n.weekId, n.kind, n.text]).sort(), [[undefined, "memo", "주차 없는 메모"], [W1, "memo", "where 절 중요"]].sort());
    } finally { await t.done(); }
  });

  it("tidies with the course summary and that week's material, keeps the memo, and can use or undo the tidied copy", async () => {
    const t = await setup();
    try {
      const saved = await t.memos.save(COURSE, W1, "where 절 중요 📄 LAB2 3쪽", null);
      const cleaned = await t.memos.cleanup(COURSE, W1);
      assert.equal(cleaned.text, "where 절 중요 📄 LAB2 3쪽", "the memo itself is unchanged");
      assert.match(cleaned.cleaned!.text, /^# 4주차 메모/);
      const prompt = t.prompts[0]!;
      for (const part of ["데이터베이스", "4주차", "where 절 중요", "평가: 중간 30%", "WHERE 절은 FROM 뒤에"]) assert.ok(prompt.includes(part), part);
      assert.ok(!prompt.includes("무관"), "other weeks' material is not sent");
      const used = await t.memos.apply(COURSE, W1, "use_cleaned");
      assert.equal(used.text, cleaned.cleaned!.text);
      assert.equal(used.canUndo, true);
      const back = await t.memos.apply(COURSE, W1, "undo");
      assert.equal(back.text, saved.text);
      const dropped = await t.memos.apply(COURSE, W1, "discard_cleaned");
      assert.equal(dropped.cleaned, undefined);
    } finally { await t.done(); }
  });

  it("refuses an empty memo, a bad answer and another account", async () => {
    const t = await setup("죄송합니다");
    try {
      await assert.rejects(t.memos.cleanup(COURSE, W1), /정리할 메모가 없습니다/);
      await t.memos.save(COURSE, W1, "메모", null);
      await assert.rejects(t.memos.cleanup(COURSE, W1), /정리본을 받지 못했습니다/);
      t.setAccount("acct_zzzzzzzz");
      assert.equal((await t.memos.get(COURSE, W1)).text, "", "another account does not see it");
      t.setAccount(undefined);
      await assert.rejects(t.memos.get(COURSE, W1), /계정/);
    } finally { await t.done(); }
  });

  it("keeps the prompt to the student's words plus sourced additions", () => {
    const prompt = cleanupPrompt({ course: "C", week: "1주차", memo: "m", notes: [] });
    assert.match(prompt, /빠짐없이/);
    assert.match(prompt, /지어내지 않습니다/);
  });
});
