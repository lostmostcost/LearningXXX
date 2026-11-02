import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CollectionManifest } from "@learningxxx/contracts";

/** Keeps the file short enough to be useful context on every turn. */
const MAX_ITEMS = 150;

const KIND = { file: "자료", notice: "공지", assignment: "과제" } as const;

/**
 * What a course session should know without being told each time (WBS-020
 * self-test: "it did not know which course this was"): the course and the
 * list of collected materials by week. Titles only; the files themselves are
 * still sent only when the user attaches them. Independent sessions never get
 * this, because they never have a course.
 */
export function courseBrief(manifest: CollectionManifest): string {
  const { course } = manifest;
  const weeks = manifest.weeks.toSorted((a, b) => a.order - b.order);
  const lines = [
    "# 이 대화의 과목",
    "",
    `이 대화는 LearningXXX 앱의 과목 세션입니다. 과목: **${course.title}** (LMS 과목 번호 ${course.sourceCourseId}).`,
    "질문은 이 과목의 수업 맥락에서 답하세요.",
    "",
    "## 수집된 자료 목록",
    "",
  ];
  let shown = 0;
  const section = (label: string, items: CollectionManifest["items"]) => {
    if (!items.length || shown >= MAX_ITEMS) return;
    lines.push(`- ${label}`);
    for (const { resource } of items) {
      if (shown >= MAX_ITEMS) break;
      lines.push(`  - [${KIND[resource.kind]}] ${resource.title}`);
      shown += 1;
    }
  };
  for (const week of weeks) section(week.label, manifest.items.filter((i) => i.resource.weekId === week.id));
  section("주차 없음", manifest.items.filter((i) => i.resource.weekId === undefined || !weeks.some((w) => w.id === i.resource.weekId)));
  if (shown === 0) lines.push("- (아직 수집된 자료가 없습니다)");
  if (shown < manifest.items.length) lines.push(`- 외 ${manifest.items.length - shown}개`);
  lines.push(
    "",
    "자료 파일 자체는 이 폴더에 없습니다. 내용이 필요하면 사용자가 첨부한 파일을 읽고, 첨부가 없으면 어떤 자료를 첨부하면 되는지 알려 주세요.",
    "",
  );
  return lines.join("\n");
}

/**
 * Writes the brief next to the course's session folders, never inside one, so
 * it is not part of what the AI can edit or what a run's change list shows.
 * The CLI gets it as --append-system-prompt-file.
 */
export function writeCourseBrief(file: string, brief: string): void {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && readFileSync(file, "utf8") === brief) return;
  const temp = `${file}.${randomUUID()}.tmp`; // two sessions of a course may start together
  writeFileSync(temp, brief);
  renameSync(temp, file);
}
