import type { CollectionManifest } from "@learningxxx/contracts";
import { makeSyntheticPdf } from "./synthetic-pdf.ts";

/**
 * Synthetic course for fixture mode (`?fixture`) and tests. One entry per
 * viewer state the A stage must show. No real course content.
 */
const course = "aaaaaaaa-0000-4000-8000-000000000001";
const week = (n: number) => `bbbbbbbb-0000-4000-8000-00000000000${n}`;
const res = (n: number) => `cccccccc-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const assetId = (n: number) => `dddddddd-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const sha = (n: number) => String(n).padStart(2, "0").repeat(32);
const lms = (path: string) => `https://lms.example.test/courses/SYN-101/${path}`;

const resource = (n: number, kind: "file" | "notice" | "assignment", title: string, weekN?: number, manual = false) => ({
  id: res(n),
  courseId: course,
  ...(weekN ? { weekId: week(weekN) } : {}),
  kind,
  source: manual ? ("manual" as const) : ("lms" as const),
  sourceId: `SYN-${n}`,
  ...(manual ? {} : { sourceUrl: lms(`${kind}s/SYN-${n}`) }),
  title,
  revision: 1,
  updatedAt: `2026-10-${String(10 + n).padStart(2, "0")}T01:00:00Z`,
});

const file = (n: number, mediaType: string, name: string) => ({
  id: assetId(n),
  resourceId: res(n),
  mediaType,
  bytes: 1024,
  sha256: sha(n),
  storageKey: `originals/${sha(n).slice(0, 2)}/${sha(n)}`,
  originalName: name,
});

export const FIXTURE_MANIFEST: CollectionManifest = {
  schemaVersion: 1,
  course: { id: course, accountKey: "acct_synthfixture01", termId: "2026-2", sourceCourseId: "SYN-101", title: "합성 과목 (디지털 논리 예제)" },
  weeks: [
    { id: week(1), courseId: course, sourceWeekId: "W01", label: "1주차", order: 0 },
    { id: week(2), courseId: course, sourceWeekId: "W02", label: "2주차 (보강)", order: 1 },
    { id: week(3), courseId: course, sourceWeekId: "W03", label: "3주차", order: 2 },
  ],
  revision: 1,
  syncRunId: "eeeeeeee-0000-4000-8000-000000000001",
  generatedAt: "2026-10-31T00:00:00Z",
  items: [
    { resource: resource(1, "file", "불 대수 기초 (텍스트 PDF)", 1), assets: [file(1, "application/pdf", "week01-boolean.pdf")] },
    { resource: resource(2, "file", "실습 안내 (PPTX)", 1), assets: [file(2, "application/vnd.openxmlformats-officedocument.presentationml.presentation", "week01-lab.pptx")] },
    { resource: resource(3, "file", "판서 스캔본 (텍스트 없음)", 2), assets: [file(3, "application/pdf", "week02-scan.pdf")] },
    { resource: resource(4, "file", "암호 걸린 보충 자료", 2), assets: [file(4, "application/pdf", "week02-locked.pdf")] },
    { resource: resource(5, "file", "손상된 PDF", 2), assets: [file(5, "application/pdf", "week02-broken.pdf")] },
    {
      resource: resource(6, "assignment", "과제 1: 진리표 작성", 2),
      assets: [],
      assignment: { resourceId: res(6), dueAt: "2026-11-07T14:59:00Z", timezone: "Asia/Seoul", timezoneBasis: "source_explicit", submissionUrl: lms("assignments/SYN-6") },
      body: "<h2>제출 방법</h2><p>3입력 다수결 회로의 진리표를 PDF 1쪽으로 제출합니다.</p><table><tr><th>A</th><th>B</th><th>C</th><th>Y</th></tr><tr><td>0</td><td>1</td><td>1</td><td>1</td></tr></table>",
    },
    { resource: resource(7, "file", "아직 받지 않은 자료", 3), assets: [] },
    {
      resource: resource(8, "assignment", "과제 2: 회로 설계 (마감 미정)", 3),
      assets: [],
      assignment: { resourceId: res(8), dueAt: null, timezone: "Asia/Seoul", timezoneBasis: "assumed_asia_seoul" },
    },
    // WBS-067: synthetic bodies, including markup the viewer must neutralize (script, handler, javascript: link).
    { resource: resource(9, "notice", "강의실 변경 안내"), assets: [file(9, "application/pdf", "room-map.pdf")],
      body: `<p>다음 주부터 강의실이 <strong>합성관 101호</strong>로 바뀝니다.</p><ul><li>시간은 같습니다.</li><li>첨부한 <em>배치도</em>를 확인하세요.</li></ul><p><a href="https://lms.example.test/courses/SYN-101">강의 홈</a> · <a href="javascript:alert(1)">나쁜 링크</a></p><script>alert("x")</script><p onclick="alert(1)">끝.</p>` },
    { resource: resource(10, "notice", "중간고사 범위"), assets: [] },
    { resource: resource(11, "notice", "3주차 휴강 공지", 3), assets: [] },
    { resource: resource(12, "file", "내가 추가한 정리 노트", undefined, true), assets: [file(12, "application/pdf", "my-notes.pdf")] },
  ],
  tombstones: [],
};

const BYTES: Record<string, () => Uint8Array> = {
  [assetId(1)]: () => makeSyntheticPdf({ pages: ["Boolean algebra basics", "AND OR NOT truth tables", "De Morgan laws"] }),
  [assetId(3)]: () => makeSyntheticPdf({ pages: [null, null] }),
  [assetId(4)]: () => makeSyntheticPdf({ pages: ["Locked supplement"], encrypted: true }),
  [assetId(5)]: () => new TextEncoder().encode("this is not a pdf"),
  [assetId(12)]: () => makeSyntheticPdf({ pages: ["My summary notes"] }),
  [assetId(9)]: () => makeSyntheticPdf({ pages: ["Room map (synthetic)"] }),
};

/** Fixture asset loader; unknown ids behave like a missing local original. */
export const loadFixtureAsset = async (id: string): Promise<Uint8Array | undefined> => BYTES[id]?.();
