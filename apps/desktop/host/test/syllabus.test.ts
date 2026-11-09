import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { CollectionManifest } from "@learningxxx/contracts";
import { parseDocx, parsePdfText, parseSyllabusHtml, syllabusText, tableBlocks } from "../src/syllabus-parse.ts";
import { schoolSyllabusUrl, SyllabusService, syllabusSources } from "../src/syllabus.ts";

const COURSE = "11111111-1111-4111-8111-111111111111";
const LINK = "http://sugang.khu.ac.kr/core?attribute=lectPlan&amp;p_year=2026&amp;p_code=AB100&amp;loginYn=N";

/** A syllabus page shaped like a common school form (synthetic content). */
const PAGE = `<!DOCTYPE html><html><head><title>강의계획서</title><script>var x = "<h2>no</h2>";</script></head><body>
<header><h1>2026학년도 2학기 강의계획서</h1><button>출력</button></header>
<div><h2>기본정보</h2><table><tbody>
<tr><th>강좌명</th><td>예시과목</td><th>교강사명</th><td>홍길동</td></tr>
<tr><th>이수구분</th><td>전공선택</td><th rowspan="2">연락처</th><td>로그인하세요</td></tr>
<tr><th>학점</th><td>3</td><td>로그인하세요</td></tr>
<tr><th>강의시간<br/>강의실</th><td>화 10:30-11:45 (A동 101)<br/></td><th>면담시간</th><td></td></tr>
</tbody></table>
<h2>수업운영방식</h2><table><thead><tr><th rowspan="2"></th><th>대면수업</th><th>실시간<br/>온라인</th><th>비실시간</th></tr></thead>
<tbody><tr><th rowspan="2">수업<br/>운영방식</th><td></td><td>○</td><td></td></tr><tr><th>추가설명</th><td colspan="3">격주 온라인</td></tr></tbody></table>
<h2>교재 및 참고자료</h2><table><thead><tr><th colspan="2">교재구분</th><th>서명</th><th>저자명</th><th>출판사</th></tr></thead>
<tbody><tr><th rowspan="2">교재</th><th>1</th><td>예시 교과서</td><td>김저자</td><td>예시출판</td></tr><tr><th>2</th><td></td><td></td><td></td></tr></tbody></table>
<h2>평가방법</h2><table><thead><tr><th>평가항목</th><th>평가비율(%)</th><th>추가설명</th></tr></thead>
<tbody><tr><th>중간고사</th><td>40%</td><td></td></tr><tr><th>발표</th><td>0%</td><td></td></tr><tr><th>기말고사</th><td>60%</td><td>서술형</td></tr></tbody></table>
<!-- <h2>숨은 제목</h2> -->
<h2>주별강의내용</h2><table><thead><tr><th>차시</th><th>날짜</th><th>강의주제 및 내용</th><th>비고</th></tr></thead>
<tbody><tr><th>1주</th><td>9/1 ~ 9/7</td><td>소개</td><td></td></tr><tr><th>2주</th><td>9/8 ~ 9/14</td><td>기초<br>실습 &amp; 토론</td><td>과제 1</td></tr>
<tr><th>과제</th><td colspan="3"></td></tr></tbody></table></div>
<footer>COPYRIGHT</footer></body></html>`;

describe("syllabus parsing", () => {
  it("reads a school form into fields, ticked columns, tables and highlights", () => {
    const doc = parseSyllabusHtml(PAGE);
    assert.equal(doc.title, "2026학년도 2학기 강의계획서");
    assert.deepEqual(doc.sections.map((s) => s.heading), ["기본정보", "수업운영방식", "교재 및 참고자료", "평가방법", "주별강의내용"], "script, comments, header and footer are not content");
    const facts = Object.fromEntries(doc.facts.map((f) => [f.label, f]));
    assert.equal(facts["교강사명"]?.value, "홍길동");
    assert.deepEqual(facts["연락처"], { label: "연락처", value: "학교 로그인 후 공개", hidden: true }, "a value the page hides without sign-in is marked, not shown as data");
    assert.equal(facts["강의시간 강의실"]?.value, "화 10:30-11:45 (A동 101)");
    assert.equal(facts["면담시간"], undefined, "empty values are dropped");
    // The header's row span ends with its <thead>, so ○ stays under its own column.
    assert.match(facts["수업 운영방식"]?.value ?? "", /^실시간 온라인 · 격주 온라인$/);
    assert.deepEqual(doc.grading, [{ item: "중간고사", share: "40%", weight: 40 }, { item: "기말고사", share: "60%", weight: 60, note: "서술형" }], "0% rows without a note are left out");
    assert.deepEqual(doc.weeks, [{ label: "1주", date: "9/1 ~ 9/7", topic: "소개" }, { label: "2주", date: "9/8 ~ 9/14", topic: "기초\n실습 & 토론", note: "과제 1" }]);
    assert.deepEqual(doc.books, ["예시 교과서 · 김저자 · 예시출판"]);
    const text = syllabusText(doc);
    assert.match(text, /\| 중간고사 \| 40% \|/);
    assert.doesNotMatch(text, /DOCTYPE|<|COPYRIGHT|출력|숨은/);
  });

  it("shows an unknown page as its text and fields, with no invented highlights", () => {
    const doc = parseSyllabusHtml("<p>이 과목은 매주 토론으로 진행합니다.</p><p>담당 교수: 김교수</p><p>기타 안내</p>");
    assert.deepEqual(doc.facts, [{ label: "담당 교수", value: "김교수" }]);
    assert.deepEqual(doc.grading, []);
    assert.deepEqual(doc.weeks, []);
    assert.equal(doc.sections.length, 1);
  });

  it("turns a two-column label table into fields and keeps wide tables as tables", () => {
    const cell = (text: string) => ({ text, th: false, colspan: 1, rowspan: 1 });
    const blocks = tableBlocks([[{ ...cell("항목"), th: true }, { ...cell("내용"), th: true }], [cell("교수"), cell("이교수")], [cell("시간"), cell("목 3교시")]]);
    assert.deepEqual(blocks, [{ type: "fields", fields: [{ label: "항목", value: "내용" }, { label: "교수", value: "이교수" }, { label: "시간", value: "목 3교시" }] }]);
  });

  it("reads a Word syllabus: label lines, a weekly plan in text, a points table with merged cells", () => {
    const run = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
    const tc = (t: string, props = "") => `<w:tc>${props ? `<w:tcPr>${props}</w:tcPr>` : ""}${run(t)}</w:tc>`;
    const xml = `<?xml version="1.0"?><w:document><w:body>${run("교강사 : 박교수")}${run("강의시간 : 월 9:00 – 11:45")}${run("1주 9/7 오리엔테이션")}${run("과목 소개")}${run("2주 9/14 트렌드")}${run("3주 9/21 개발 &amp; 기획")}
      <w:tbl><w:tr>${tc("항 목")}${tc("배 점")}${tc("기 타")}</w:tr><w:tr>${tc("출석")}${tc("20점")}${tc("결석 1점 감점", '<w:vMerge w:val="restart"/>')}</w:tr><w:tr>${tc("시험")}${tc("80점")}${tc("", "<w:vMerge/>")}</w:tr><w:tr>${tc("총점")}${tc("100점")}${tc("")}</w:tr></w:tbl></w:body></w:document>`;
    const doc = parseDocx(zip({ "[Content_Types].xml": "<x/>", "word/document.xml": xml }), "계획서.docx");
    assert.ok(doc);
    assert.deepEqual(doc.facts.map((f) => [f.label, f.value]), [["교강사", "박교수"], ["강의시간", "월 9:00 – 11:45"]]);
    assert.deepEqual(doc.weeks.map((w) => [w.label, w.date, w.topic, w.note]), [["1주", "9/7", "오리엔테이션", "과목 소개"], ["2주", "9/14", "트렌드", undefined], ["3주", "9/21", "개발 & 기획", undefined]]);
    assert.deepEqual(doc.grading, [{ item: "출석", share: "20점", weight: 20, note: "결석 1점 감점" }, { item: "시험", share: "80점", weight: 80 }], "the total row is not an item");
    assert.equal(parseDocx(new TextEncoder().encode("not a zip"), "x"), undefined);
  });

  it("reads PDF page text", () => {
    const doc = parsePdfText(["담당교수 : 최교수\n평가 안내"], "계획서.pdf");
    assert.deepEqual(doc?.facts, [{ label: "담당교수", value: "최교수" }]);
    assert.equal(parsePdfText(["  ", ""], "x"), undefined);
  });
});

/** A minimal ZIP (deflated entries) for the Word test. */
function zip(files: Record<string, string>): Uint8Array {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text); const data = deflateRawSync(raw); const n = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data); centrals.push(central, n); offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, end]));
}

const manifest = (body: string, extra: unknown[] = []) => ({
  schemaVersion: 1, course: { id: COURSE, accountKey: "acct_abcdefgh", termId: "1", sourceCourseId: "1", title: "예시과목" },
  weeks: [], revision: 1, syncRunId: COURSE, generatedAt: "2026-09-01T00:00:00Z", tombstones: [],
  items: [{ resource: { id: "33333333-3333-4333-8333-333333333331", courseId: COURSE, kind: "notice", source: "lms", sourceId: "syllabus", sourceUrl: "https://khcanvas.khu.ac.kr/courses/1/assignments/syllabus", title: "강의계획서 (LMS)", revision: 1, updatedAt: "2026-09-01T00:00:00Z" }, assets: [], body }, ...extra],
}) as unknown as CollectionManifest;

describe("syllabus sources and service", () => {
  it("fetches only https pages on the school's syllabus host", () => {
    assert.equal(schoolSyllabusUrl("http://sugang.khu.ac.kr/core?a=1#x"), "https://sugang.khu.ac.kr/core?a=1");
    for (const bad of ["https://evil.example/core", "https://sugang.khu.ac.kr.evil.example/", "javascript:alert(1)", "https://u:p@sugang.khu.ac.kr/", "https://sugang.khu.ac.kr:8443/", "/core"]) assert.equal(schoolSyllabusUrl(bad), undefined, bad);
  });

  it("lists school links, the LMS text when it says more, and posted syllabus files", () => {
    const file = { resource: { id: "33333333-3333-4333-8333-333333333332", courseId: COURSE, kind: "file", source: "lms", sourceId: "commons:1", title: "2학기 강의계획서", revision: 1, updatedAt: "2026-09-01T00:00:00Z" },
      assets: [{ id: "44444444-4444-4444-8444-444444444441", resourceId: "33333333-3333-4333-8333-333333333332", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: 10, sha256: "a".repeat(64), storageKey: "x", originalName: "강의계획서.docx" }] };
    const links = syllabusSources(manifest(`<a href="${LINK}"><h2>수업계획서 1 바로가기 ▶</h2></a><a href="${LINK}">dup</a><a href="https://evil.example/">x</a>`, [file]));
    assert.deepEqual(links.map((s) => [s.kind, s.label]), [["school", "수업계획서 1"], ["file", "강의계획서.docx"]]);
    const withText = syllabusSources(manifest(`<p>이 과목은 매주 화요일 대면으로 진행하며 평가는 중간 40%, 기말 60%로 합니다. 출석은 필수입니다.</p>`));
    assert.deepEqual(withText.map((s) => s.kind), ["lms"]);
  });

  it("reads and keeps the page; a later failure keeps the last copy; nothing is saved for another account", async () => {
    const root = await mkdtemp(join(tmpdir(), "syllabus-"));
    try {
      let account = "acct_abcdefgh"; let mode: "ok" | "down" | "away" = "ok"; const asked: string[] = [];
      const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        asked.push(String(url)); assert.equal(init?.method, "GET");
        if (mode === "down") return new Response("busy", { status: 503 });
        const response = new Response(PAGE, { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });
        Object.defineProperty(response, "url", { value: mode === "away" ? "https://evil.example/" : String(url) });
        return response;
      }) as typeof globalThis.fetch;
      const service = new SyllabusService({ root, accountKey: () => account, manifest: async () => manifest(`<a href="${LINK}">수업계획서 바로가기</a>`), asset: async () => new Uint8Array(), pdfPages: async () => [], fetch, now: () => new Date("2026-11-09T01:02:03.456Z") });
      const before = await service.get(COURSE);
      assert.equal(before.sources.length, 1); assert.equal(before.sources[0]!.doc, undefined); assert.equal(asked.length, 0, "get never fetches");
      const first = await service.refresh(COURSE);
      assert.deepEqual(asked, ["https://sugang.khu.ac.kr/core?attribute=lectPlan&p_year=2026&p_code=AB100&loginYn=N"]);
      assert.equal(first.sources[0]!.doc?.grading.length, 2);
      assert.equal(first.sources[0]!.fetchedAt, "2026-11-09T01:02:03Z");
      assert.ok(first.sources[0]!.original?.includes("평가방법") && !first.sources[0]!.original.includes("<head>"));
      assert.deepEqual(await service.get(COURSE), first, "kept on disk");
      assert.match(await service.text(COURSE).then((t) => t[0]!.text), /중간고사/);

      mode = "down";
      const failed = await service.refresh(COURSE);
      assert.match(failed.sources[0]!.error ?? "", /503.*이전에 받은 내용/);
      assert.equal(failed.sources[0]!.doc?.grading.length, 2, "the last copy stays");
      mode = "away";
      assert.match((await service.refresh(COURSE)).sources[0]!.error ?? "", /다른 주소/);

      mode = "ok";
      const saved = await readFile(join(root, "acct_abcdefgh", COURSE, "syllabus.json"), "utf8");
      const switching = service.refresh(COURSE); account = "acct_zzzzzzzz";
      await assert.rejects(switching, /계정이 바뀌었습니다/);
      assert.equal(await readFile(join(root, "acct_abcdefgh", COURSE, "syllabus.json"), "utf8"), saved);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
