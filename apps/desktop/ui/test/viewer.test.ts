import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CollectionManifest } from "@learningxxx/contracts";
import * as legacyPdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { hasSelectableText, pdfErrorState, viewTarget } from "../src/document.ts";
import { FIXTURE_MANIFEST, loadFixtureAsset } from "../src/fixtures.ts";
import { buildLibrary, deadline, externalUrl, formatSeoul } from "../src/library.ts";
import { openPdf } from "../src/pdf.ts";
import { makeSyntheticPdf } from "../src/synthetic-pdf.ts";

const library = buildLibrary(FIXTURE_MANIFEST);
const byTitle = (title: string) => {
  const all = [...library.notices, ...library.other, ...library.weeks.flatMap((w) => w.entries)];
  const found = all.find((e) => e.resource.title === title);
  assert.ok(found, title);
  return found;
};

describe("fixture and library model", () => {
  test("the fixture manifest satisfies the shared contract", () => {
    assert.ok(CollectionManifest.safeParse(FIXTURE_MANIFEST).success);
  });

  test("weeks follow order and keep LMS labels; every resource appears once", () => {
    assert.deepEqual(library.weeks.map((w) => w.week.label), ["1주차", "2주차 (보강)", "3주차"]);
    const shown = library.notices.length + library.other.length + library.weeks.reduce((n, w) => n + w.entries.length, 0);
    assert.equal(shown, FIXTURE_MANIFEST.items.length);
  });

  test("course notices are newest first; a week notice stays in its week; manual files go to 'other'", () => {
    assert.deepEqual(library.notices.map((e) => e.resource.title), ["중간고사 범위", "강의실 변경 안내"]);
    assert.ok(library.weeks[2]!.entries.some((e) => e.resource.title === "3주차 휴강 공지"));
    assert.deepEqual(library.other.map((e) => e.resource.source), ["manual"]);
  });

  test("within a week notices come first, then files, then assignments", () => {
    assert.deepEqual(library.weeks[2]!.entries.map((e) => e.resource.kind), ["notice", "file", "assignment"]);
  });
});

describe("deadlines are shown in Seoul time", () => {
  const due = byTitle("과제 1: 진리표 작성").assignment!;
  test("UTC 14:59 is 23:59 the same day in Seoul", () => {
    assert.match(formatSeoul("2026-11-07T14:59:00Z"), /11월 7일 \(토\) 23:59/);
  });
  test("open, soon (≤48h), overdue", () => {
    assert.equal(deadline(due, new Date("2026-11-01T00:00:00Z")).status, "open");
    assert.equal(deadline(due, new Date("2026-11-06T00:00:00Z")).status, "soon");
    assert.equal(deadline(due, new Date("2026-11-07T15:00:00Z")).status, "overdue");
  });
  test("a missing deadline stays unknown, with no time zone note", () => {
    const d = deadline(byTitle("과제 2: 회로 설계 (마감 미정)").assignment!, new Date());
    assert.deepEqual(d, { status: "none", text: "마감 정보 없음" });
  });
  test("an assumed Seoul time zone is disclosed next to the time", () => {
    const d = deadline({ ...due, timezoneBasis: "assumed_asia_seoul" }, new Date("2026-11-01T00:00:00Z"));
    assert.ok(d.note?.includes("서울 시간"));
    assert.equal(deadline(due, new Date("2026-11-01T00:00:00Z")).note, undefined);
  });
  test("only https source links are opened outside", () => {
    assert.ok(externalUrl(byTitle("강의실 변경 안내").resource)?.startsWith("https://"));
    assert.equal(externalUrl({ ...byTitle("강의실 변경 안내").resource, sourceUrl: "http://lms.example.test/x" }), undefined);
    assert.equal(externalUrl(byTitle("내가 추가한 정리 노트").resource), undefined);
  });
});

describe("viewer target per entry", () => {
  const cases: [string, string][] = [
    ["불 대수 기초 (텍스트 PDF)", "pdf"],
    ["실습 안내 (PPTX)", "unsupported"],
    ["아직 받지 않은 자료", "no_original"],
    ["강의실 변경 안내", "notice"],
    ["과제 1: 진리표 작성", "assignment"],
  ];
  for (const [title, kind] of cases) test(`${title} → ${kind}`, () => assert.equal(viewTarget(byTitle(title)).kind, kind));

  test("a supported asset is chosen even when it is not first", () => {
    const entry = byTitle("불 대수 기초 (텍스트 PDF)");
    const pptx = byTitle("실습 안내 (PPTX)").assets[0]!;
    const target = viewTarget({ ...entry, assets: [pptx, ...entry.assets] });
    assert.equal(target.kind, "pdf");
  });

  test("password errors map to encrypted, anything else to broken", () => {
    assert.deepEqual(pdfErrorState({ name: "PasswordException" }), { kind: "encrypted" });
    assert.deepEqual(pdfErrorState(new Error("x")), { kind: "broken" });
    assert.equal(hasSelectableText([" ", "\n"]), false);
  });
});

describe("PDF states with pdf.js on synthetic files", () => {
  const open = (bytes: Uint8Array) => openPdf(legacyPdfjs, bytes, { verbosity: 0 });
  const fixture = async (title: string) => (await loadFixtureAsset(byTitle(title).assets[0]!.id))!;

  test("text PDF: ready with text and page count, input bytes untouched", async () => {
    const bytes = await fixture("불 대수 기초 (텍스트 PDF)");
    const length = bytes.length;
    const result = await open(bytes);
    assert.deepEqual(result.state, { kind: "ready", pageCount: 3, hasText: true });
    assert.equal(bytes.length, length);
    await result.close();
  });

  test("scan-like PDF: ready without selectable text", async () => {
    const result = await open(await fixture("판서 스캔본 (텍스트 없음)"));
    assert.deepEqual(result.state, { kind: "ready", pageCount: 2, hasText: false });
    await result.close();
  });

  test("encrypted PDF is reported, not rendered", async () => {
    assert.deepEqual((await open(await fixture("암호 걸린 보충 자료"))).state, { kind: "encrypted" });
  });

  test("non-PDF bytes are reported as broken", async () => {
    assert.deepEqual((await open(await fixture("손상된 PDF"))).state, { kind: "broken" });
  });

  test("text on a later page still counts", async () => {
    const result = await open(makeSyntheticPdf({ pages: [null, "Appendix (c) text"] }));
    assert.deepEqual(result.state, { kind: "ready", pageCount: 2, hasText: true });
    await result.close();
  });

  test("missing originals resolve to undefined", async () => {
    assert.equal(await loadFixtureAsset("ffffffff-0000-4000-8000-000000000000"), undefined);
  });
});
