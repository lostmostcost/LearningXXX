import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollectionManifest } from "@learningxxx/contracts";
import { StudyNotes, studyPrompt } from "../src/study-notes.ts";
import type { WeekNote } from "../src/week-notes.ts";

const C = "11111111-1111-4111-8111-111111111111", W1 = "22222222-2222-4222-8222-222222222221", W2 = "22222222-2222-4222-8222-222222222222";
const manifest = { course: { title: "논리회로" }, weeks: [{ id: W1, label: "3주차" }, { id: W2, label: "4주차" }], items: [{ resource: { weekId: W2, title: "4장 조합회로.pdf" }, assets: [] }] } as unknown as CollectionManifest;

describe("study notes", () => {
  it("reviews from the transcript, previews from the week's PDFs, and keeps them per week for the chat", async () => {
    const root = await mkdtemp(join(tmpdir(), "study-"));
    const prompts: string[] = [];
    const notes: WeekNote[] = [{ weekId: W1, kind: "transcript", title: "3주차 녹음", text: "[01:00] 카르노 맵은…" }];
    const study = new StudyNotes({ root, accountKey: () => "acct_abcdefgh", manifest: async () => manifest, notes: async () => notes, summary: async () => "# 논리회로",
      pdfText: async () => [{ title: "4장 조합회로.pdf", text: "멀티플렉서" }], write: async ({ prompt }) => { prompts.push(prompt); return prompt.includes("복습") ? "# 3주차 복습 노트\n- 카르노 맵" : "# 4주차 예습 노트\n- 멀티플렉서"; },
      now: () => new Date("2026-11-04T00:00:00Z") });
    try {
      await assert.rejects(study.make(C, W2, "review"), /전사나 정리본이 없어/);
      const review = await study.make(C, W1, "review");
      assert.match(review.markdown, /^# 3주차 복습 노트/);
      assert.ok(prompts[0]!.includes("카르노 맵은") && prompts[0]!.includes("확인 질문"));
      const preview = await study.make(C, W2, "preview");
      assert.ok(prompts[1]!.includes("멀티플렉서") && prompts[1]!.includes("4장 조합회로.pdf"));
      assert.equal(preview.weekId, W2);
      assert.deepEqual((await study.list(C)).map((n) => [n.weekId, n.kind]).sort(), [[W1, "review"], [W2, "preview"]].sort());
      assert.equal(await study.has(C, W2, "preview"), true);
      assert.deepEqual((await study.weekNotes(C)).map((n) => [n.weekId, n.title]).sort(), [[W1, "복습 노트"], [W2, "예습 노트"]].sort());
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("asks not to invent", () => {
    assert.match(studyPrompt("preview", { course: "C", week: "1주차", materials: [], notes: [] }), /지어내지 않습니다/);
  });
});
