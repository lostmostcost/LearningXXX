import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AUTOMATION, type AutomationSettings, type CourseMeeting } from "@learningxxx/contracts";
import { AutomationService, untilMeeting, type AutomationOptions } from "../src/automation.ts";

const C = "11111111-1111-4111-8111-111111111111", A = "22222222-2222-4222-8222-222222222222", T = "33333333-3333-4333-8333-333333333333", W = "44444444-4444-4444-8444-444444444444";

function setup(settings: Partial<AutomationSettings>, over: Partial<AutomationOptions> = {}, now = new Date("2026-11-02T00:00:00Z")) {
  const calls: string[] = [];
  const auto = new AutomationService({
    settings: () => ({ ...DEFAULT_AUTOMATION, ...settings }),
    correct: async ({ transcriptId }) => { calls.push(`correct:${transcriptId}`); return { transcriptId: "corrected" }; },
    readable: async ({ transcriptId }) => { calls.push(`readable:${transcriptId}`); },
    mentions: async ({ transcriptId }) => { calls.push(`mentions:${transcriptId}`); return 1; },
    courseMd: async (courseId) => { calls.push(`courseMd:${courseId}`); },
    review: async ({ weekId }) => { calls.push(`review:${weekId}`); },
    weekOf: async () => W,
    preview: { courses: async () => [{ id: C, title: "과목" }], meetings: async () => [], currentWeek: async () => W, has: async () => false, make: async ({ weekId }) => { calls.push(`preview:${weekId}`); } },
    now: () => now,
    ...over,
  });
  return { auto, calls };
}

describe("automation", () => {
  it("does nothing that uses Claude unless turned on", async () => {
    const { auto, calls } = setup({});
    auto.transcribed({ courseId: C, assetId: A, transcriptId: T, title: "1강" });
    auto.changed(C);
    await auto.tick();
    await auto.idle();
    assert.deepEqual(calls, []);
  });

  it("runs the turned-on steps in order, one at a time, later steps on the corrected version", async () => {
    const { auto, calls } = setup({ correct: true, readable: true, mentions: true, review: true, courseMd: true });
    auto.transcribed({ courseId: C, assetId: A, transcriptId: T, title: "1강" });
    auto.transcribed({ courseId: C, assetId: A, transcriptId: T, title: "1강" });
    await auto.idle();
    assert.deepEqual(calls, [`correct:${T}`, "readable:corrected", "mentions:corrected", `review:${W}`, `courseMd:${C}`]);
    assert.equal(auto.status().recent.length, 5);
    assert.ok(auto.status().recent.every((r) => r.ok));
  });

  it("records a failed step and still runs the next", async () => {
    const { auto, calls } = setup({ readable: true, mentions: true }, { readable: async () => { throw Object.assign(new Error("x"), { appError: { message: "사용량 한도" } }); } });
    auto.transcribed({ courseId: C, assetId: A, transcriptId: T, title: "1강" });
    await auto.idle();
    assert.deepEqual(calls, [`mentions:${T}`]);
    const failed = auto.status().recent.find((r) => !r.ok)!;
    assert.equal(failed.message, "사용량 한도");
  });

  it("makes course.md at most every 30 minutes per course", async () => {
    let now = new Date("2026-11-02T00:00:00Z");
    const { auto, calls } = setup({ courseMd: true }, { now: () => now });
    auto.changed(C); await auto.idle();
    now = new Date("2026-11-02T00:10:00Z");
    auto.changed(C); auto.changed(C); await auto.idle();
    assert.deepEqual(calls, [`courseMd:${C}`], "the second waits");
    auto.stop();
  });

  it("makes a preview within 3 hours before class, once per week", async () => {
    const meeting: CourseMeeting = { day: "월", start: "10:30", end: "12:00" };
    // Monday 2026-11-02 08:00 Seoul = 2026-11-01T23:00Z.
    assert.equal(untilMeeting(meeting, new Date("2026-11-01T23:00:00Z")), 2.5 * 3600_000);
    assert.equal(untilMeeting(meeting, new Date("2026-11-02T02:00:00Z")), 7 * 86_400_000 - 30 * 60_000, "just after it started: next week");
    let has = false;
    const near = setup({ preview: true }, { preview: { courses: async () => [{ id: C, title: "과목" }], meetings: async () => [meeting], currentWeek: async () => W, has: async () => has, make: async ({ weekId }) => { near.calls.push(`preview:${weekId}`); has = true; } } }, new Date("2026-11-01T23:00:00Z"));
    await near.auto.tick(); await near.auto.idle(); await near.auto.tick(); await near.auto.idle();
    assert.deepEqual(near.calls, [`preview:${W}`]);
    const far = setup({ preview: true }, { preview: { courses: async () => [{ id: C, title: "과목" }], meetings: async () => [meeting], currentWeek: async () => W, has: async () => false, make: async () => { far.calls.push("preview"); } } }, new Date("2026-11-01T15:00:00Z"));
    await far.auto.tick(); await far.auto.idle();
    assert.deepEqual(far.calls, [], "10.5 hours before: not yet");
  });
});
