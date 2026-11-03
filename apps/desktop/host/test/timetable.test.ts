import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Timetable } from "../src/timetable.ts";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";

it("WBS-085: the student's times win over course.md, can be cleared back, and stay per account", async () => {
  const root = await mkdtemp(join(tmpdir(), "timetable-"));
  let account: string | undefined = "acct_abcdefgh";
  const t = new Timetable({ root, accountKey: () => account,
    courses: async () => [{ id: A, title: "논리회로", accountKey: "acct_abcdefgh" }, { id: B, title: "데이터베이스", accountKey: "acct_abcdefgh" }],
    found: async (id) => id === A ? [{ day: "월", start: "10:30", end: "12:00" }] : [] });
  try {
    assert.deepEqual((await t.get()).courses.map((c) => [c.title, c.source, c.meetings.length]), [["논리회로", "course_md", 1], ["데이터베이스", "none", 0]]);
    await t.set(B, [{ day: "수", start: "18:30", end: "20:00", place: "전101" }]);
    await t.set(A, []);
    const now = (await t.get()).courses;
    assert.deepEqual(now.map((c) => [c.source, c.meetings.length]), [["manual", 0], ["manual", 1]]);
    assert.deepEqual(await t.meetings(B), [{ day: "수", start: "18:30", end: "20:00", place: "전101" }]);
    await t.set(A, null);
    assert.equal((await t.get()).courses[0]!.source, "course_md");
    await assert.rejects(t.set("33333333-3333-4333-8333-333333333333", []), /현재 계정의 과목이 아닙니다/);
    account = "acct_zzzzzzzz";
    assert.deepEqual((await t.get()).courses, [], "another account sees none of these courses");
  } finally { await rm(root, { recursive: true, force: true }); }
});
