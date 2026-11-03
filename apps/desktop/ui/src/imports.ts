import type { ImportItem } from "@learningxxx/contracts";

export interface ImportGroup {
  key: string;
  /** "과목 · 3주차" or the folder path when the course is unknown. */
  title: string;
  items: ImportItem[];
}

/** WBS-066: the scan grouped by course and week, in folder order, with counts for the heading. */
export function importSummary(items: readonly ImportItem[]): { new: number; imported: number; noCourse: number; groups: ImportGroup[] } {
  const groups = new Map<string, ImportGroup>();
  for (const item of items) {
    const [courseDir = "", weekDir = ""] = item.path.split("/");
    const key = `${item.courseId ?? courseDir}/${weekDir}`;
    const title = `${item.courseTitle ?? `${courseDir} (앱에 없는 과목)`} · ${item.weekLabel ?? weekDir}`;
    const group = groups.get(key) ?? { key, title, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return {
    new: items.filter((i) => i.status === "new").length,
    imported: items.filter((i) => i.status === "imported").length,
    noCourse: items.filter((i) => i.status === "no_course").length,
    groups: [...groups.values()],
  };
}
