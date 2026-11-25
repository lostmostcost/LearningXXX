import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CourseSyllabus, SyllabusSource } from "@learningxxx/contracts";
import { currentPlanRow, gradingTotal, needsRead, orderedSources, planWeekNumber } from "../src/syllabus.ts";

const src = (over: Partial<SyllabusSource>): SyllabusSource => ({ id: "0123456789abcdef", kind: "school", label: "수업계획서", ...over });
const doc = { title: "", sections: [{ heading: "x", blocks: [] }], facts: [], grading: [], weeks: [], books: [] };

describe("강의 정보 tab", () => {
  it("reads by itself only when a listed source was never read", () => {
    assert.equal(needsRead(undefined), false);
    assert.equal(needsRead({ sources: [] }), false, "no syllabus: nothing to fetch, the tab says so");
    assert.equal(needsRead({ sources: [src({})] }), true);
    assert.equal(needsRead({ sources: [src({ error: "연결 실패" })] }), false, "a failure waits for 다시 받기 (no retry loop)");
    assert.equal(needsRead({ sources: [src({ doc })] }), false);
  });

  it("marks this week's plan row by week number, whatever the label style", () => {
    assert.equal(planWeekNumber("10주"), 10); assert.equal(planWeekNumber("제3주"), 3); assert.equal(planWeekNumber("Week 4"), 4); assert.equal(planWeekNumber("기타"), undefined);
    const weeks = [{ label: "1주", topic: "a" }, { label: "9주", topic: "b" }, { label: "10주", topic: "c" }];
    assert.equal(currentPlanRow(weeks, "10주차"), 2);
    assert.equal(currentPlanRow(weeks, "기타 자료"), -1);
    assert.equal(currentPlanRow(weeks, undefined), -1);
  });

  it("adds up grading only when every item has a weight in one unit", () => {
    assert.deepEqual(gradingTotal([{ item: "중간", share: "30%", weight: 30 }, { item: "기말", share: "70%", weight: 70 }]), { total: 100, unit: "%" });
    assert.deepEqual(gradingTotal([{ item: "출석", share: "20점", weight: 20 }, { item: "시험", share: "80점", weight: 80 }]), { total: 100, unit: "점" });
    assert.equal(gradingTotal([{ item: "중간", share: "30%", weight: 30 }, { item: "태도", share: "수시", weight: null }]), undefined);
    assert.equal(gradingTotal([{ item: "a", share: "30%", weight: 30 }, { item: "b", share: "20점", weight: 20 }]), undefined);
    assert.equal(gradingTotal([]), undefined);
  });

  it("puts sources that were read first", () => {
    const s: CourseSyllabus = { sources: [src({ id: "aaaaaaaaaaaaaaaa", error: "x" }), src({ id: "bbbbbbbbbbbbbbbb", doc })] };
    assert.deepEqual(orderedSources(s).map((x) => x.id), ["bbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaa"]);
  });
});
