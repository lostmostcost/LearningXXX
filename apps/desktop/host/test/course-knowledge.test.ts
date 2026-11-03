import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollectionManifest } from "@learningxxx/contracts";
import { CourseKnowledgeService, knowledgePrompt, parseKnowledge, type KnowledgeSources } from "../src/course-knowledge.ts";
import { viewingLine } from "../src/conversation-service.ts";

const COURSE = "11111111-1111-4111-8111-111111111111";
const W1 = "22222222-2222-4222-8222-222222222221";
const res = (id: string, kind: "file" | "notice" | "assignment", title: string, extra: Record<string, unknown> = {}) => ({
  resource: { id, courseId: COURSE, kind, source: "lms", sourceId: id.slice(-4), title, revision: 1, updatedAt: "2026-09-01T00:00:00Z", ...extra }, assets: [],
});
const manifest = (syllabus = "<p>평가: 중간 30% 기말 40%</p><p>월 10:30-12:00 전101</p>") => ({
  schemaVersion: 1, course: { id: COURSE, accountKey: "acct_abcdefgh", termId: "1", sourceCourseId: "1", title: "데이터베이스" },
  weeks: [{ id: W1, courseId: COURSE, sourceWeekId: "1", label: "1주차", order: 0 }], revision: 1, syncRunId: COURSE, generatedAt: "2026-09-01T00:00:00Z", tombstones: [],
  items: [
    { ...res("33333333-3333-4333-8333-333333333331", "notice", "강의계획서 (LMS)", { sourceId: "syllabus" }), body: syllabus },
    res("33333333-3333-4333-8333-333333333332", "file", "1장 관계 모델", { weekId: W1 }),
    { ...res("33333333-3333-4333-8333-333333333333", "assignment", "ERD 실습", { weekId: W1 }), assignment: { dueAt: "2026-09-10T14:59:00Z", timezone: "Asia/Seoul" } },
  ],
}) as unknown as CollectionManifest;
const sources = (over: Partial<KnowledgeSources> = {}): KnowledgeSources => ({
  manifest: manifest(), notes: [{ weekId: W1, kind: "transcript", title: "1주차 녹음", text: "[00:10] 오늘은 관계 모델을 배웁니다." }], syllabusFiles: [{ title: "강의계획서.pdf", text: "교재: 데이터베이스 개론" }], ...over,
});
const ANSWER = "# 데이터베이스\n\n## 과목 개요\n교재: 데이터베이스 개론\n\n## 평가\n중간 30%\n\n```json\n{\"meetings\": [{\"day\": \"월\", \"start\": \"10:30\", \"end\": \"12:00\", \"place\": \"전101\"}, {\"day\": \"x\", \"start\": \"1\", \"end\": \"2\"}]}\n```\n";

describe("course knowledge", () => {
  it("asks with the syllabus, weekly material, deadlines and transcript excerpts", () => {
    const prompt = knowledgePrompt(sources());
    for (const part of ["데이터베이스", "평가: 중간 30% 기말 40%", "교재: 데이터베이스 개론", "- 1주차", "1장 관계 모델", "[과제] ERD 실습 (마감 2026-09-10T14:59:00Z)", "오늘은 관계 모델을 배웁니다", "meetings"]) assert.ok(prompt.includes(part), part);
    assert.doesNotMatch(prompt, /<p>/, "HTML is turned into text");
  });

  it("keeps the Markdown without the JSON block and only valid meeting times", () => {
    const { markdown, meetings } = parseKnowledge(ANSWER);
    assert.ok(markdown.startsWith("# 데이터베이스") && !markdown.includes("```"));
    assert.deepEqual(meetings, [{ day: "월", start: "10:30", end: "12:00", place: "전101" }]);
    assert.deepEqual(parseKnowledge("# 제목\n본문").meetings, []);
  });

  it("makes, saves and reports the file as out of date when material changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "knowledge-"));
    let current = sources(), account: string | undefined = "acct_abcdefgh";
    const prompts: string[] = [];
    const service = new CourseKnowledgeService({ root, accountKey: () => account, sources: async () => current, write: async ({ prompt }) => { prompts.push(prompt); return ANSWER; }, now: () => new Date("2026-11-04T00:00:00Z") });
    try {
      assert.deepEqual(await service.get(COURSE), { stale: false, meetings: [], running: false });
      const made = await service.make(COURSE);
      assert.equal(made.generatedAt, "2026-11-04T00:00:00Z");
      assert.equal(made.meetings.length, 1);
      assert.match((await service.markdown(COURSE))!, /^# 데이터베이스/);
      assert.equal((await service.get(COURSE)).stale, false);
      current = sources({ manifest: manifest("<p>평가: 중간 35%</p>") });
      assert.equal((await service.get(COURSE)).stale, true);
      account = "acct_zzzzzzzz";
      assert.equal(await service.markdown(COURSE), undefined, "another account never sees it");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses an empty answer, a second run and a changed account", async () => {
    const root = await mkdtemp(join(tmpdir(), "knowledge-"));
    let account: string | undefined = "acct_abcdefgh", answer = "죄송합니다";
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const service = new CourseKnowledgeService({ root, accountKey: () => account, sources: async () => sources(), write: async () => { await gate; return answer; } });
    try {
      const first = service.make(COURSE);
      await assert.rejects(service.make(COURSE), /만드는 중/);
      release();
      await assert.rejects(first, /받지 못했습니다/);
      answer = ANSWER;
      const second = service.make(COURSE);
      account = "acct_zzzzzzzz";
      await assert.rejects(second, /계정이 바뀌었습니다/);
      account = "acct_abcdefgh";
      assert.equal(await service.markdown(COURSE), undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("viewing line", () => {
  it("names the week, material and page, and is empty without them", () => {
    assert.equal(viewingLine(undefined), "");
    assert.equal(viewingLine({ page: 3 }), "");
    const line = viewingLine({ week: "4주차", title: "LAB2.pdf", page: 3 });
    assert.match(line, /"4주차" 주차 · 자료 "LAB2.pdf" · 3쪽/);
  });
});
