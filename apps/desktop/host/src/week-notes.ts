import type { CollectionManifest, CourseLearningStatus, ImportedDocKind, LectureMention, MediaAsset, Recording, Transcript } from "@learningxxx/contracts";

/**
 * WBS-078: everything the app keeps for a week besides LMS files — lecture
 * transcripts, notes, assignment and notice text, announcements heard in
 * lectures — as plain text the course chat can read next to that week's PDFs.
 */
export interface WeekNote {
  /** Manifest week; undefined for "주차 없음". */
  weekId?: string | undefined;
  kind: "transcript" | "note" | "assignment" | "notice" | "mentions";
  title: string;
  text: string;
}

const PREFIX: Record<WeekNote["kind"], string> = { transcript: "녹음 전사", note: "정리본", assignment: "과제", notice: "공지", mentions: "강의에서 언급된 과제·시험" };
export const notePrefix = (kind: WeekNote["kind"]): string => PREFIX[kind];

/** Rough but safe: tags out, common entities decoded, paragraphs kept. Only for the AI's reading copy. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n").replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const clock = (ms: number) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

export interface WeekNoteSources {
  manifest: CollectionManifest;
  media?: { assets: readonly MediaAsset[]; recordings: readonly Recording[]; transcripts: readonly Transcript[]; importedDocs?: Record<string, ImportedDocKind[]> | undefined } | undefined;
  /** Reads a stored note of an original; undefined when it cannot. */
  doc?: ((assetId: string, kind: ImportedDocKind) => Promise<string | undefined>) | undefined;
  /** LMS week labels of online lectures (`commons:<id>`), to place downloaded lecture audio. */
  learning?: CourseLearningStatus | undefined;
  mentions?: readonly LectureMention[] | undefined;
  formatTime: (utc: string) => string;
}

/**
 * The notes of a course, each in the week it belongs to: a recording by the
 * week it was filed under, a downloaded online lecture by its LMS week, an
 * assignment or notice by its LMS week. For every original only its newest
 * transcript version is used (a hand-corrected one when made).
 */
export async function weekNotes(s: WeekNoteSources): Promise<WeekNote[]> {
  const notes: WeekNote[] = [];
  const weeks = new Map(s.manifest.weeks.map((w) => [w.id, w]));
  const weekByLabel = new Map(s.manifest.weeks.map((w) => [w.label, w.id]));
  const weekOf = (asset: MediaAsset): string | undefined => {
    if (asset.source.type === "recording") { const id = asset.source.recordingId; const w = s.media?.recordings.find((r) => r.id === id)?.weekId; return w && weeks.has(w) ? w : undefined; }
    if (asset.source.type === "lms_video") { const ref = `commons:${asset.source.sourceId}`; const label = s.learning?.items.find((i) => i.sourceRef === ref)?.weekLabel; return label ? weekByLabel.get(label) : undefined; }
    return undefined;
  };
  for (const asset of s.media?.assets ?? []) {
    if (asset.role !== "original") continue;
    const weekId = weekOf(asset);
    const newest = (s.media?.transcripts ?? []).filter((t) => t.sourceAssetId === asset.id).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (newest?.segments.some((x) => x.text.trim())) {
      notes.push({ weekId, kind: "transcript", title: asset.title, text: [`# ${asset.title} — 강의 전사`, `(${asset.source.type === "recording" ? "녹음" : "온라인 강의"} · 각 줄 앞은 녹음 시각)`, "", ...newest.segments.filter((x) => x.text.trim()).map((x) => `[${clock(x.startMs)}] ${x.text.trim()}`)].join("\n") });
    }
    for (const kind of ["readable_app", "readable"] as const) {
      if (!s.media?.importedDocs?.[asset.id]?.includes(kind) || !s.doc) continue;
      const text = await s.doc(asset.id, kind);
      if (text?.trim()) notes.push({ weekId, kind: "note", title: `${asset.title}${kind === "readable_app" ? "" : " (가져온 정리본)"}`, text: text.trim() });
    }
  }
  for (const { resource, assignment, body } of s.manifest.items) {
    if (resource.kind !== "assignment" && resource.kind !== "notice") continue;
    const head = resource.kind === "assignment" ? `마감: ${assignment?.dueAt ? s.formatTime(assignment.dueAt) : "정보 없음"}` : `게시: ${s.formatTime(resource.updatedAt)}`;
    notes.push({ weekId: resource.weekId && weeks.has(resource.weekId) ? resource.weekId : undefined, kind: resource.kind, title: resource.title, text: [`# ${resource.title}`, head, "", body ? htmlToText(body) : "(본문 없음 · LMS에서 확인)"].join("\n") });
  }
  const byWeek = new Map<string | undefined, LectureMention[]>();
  for (const m of s.mentions ?? []) {
    const asset = s.media?.assets.find((a) => a.id === m.assetId);
    const weekId = asset ? weekOf(asset) : undefined;
    byWeek.set(weekId, [...(byWeek.get(weekId) ?? []), m]);
  }
  for (const [weekId, list] of byWeek) {
    notes.push({ weekId, kind: "mentions", title: "강의에서 언급된 과제·시험", text: list.map((m) => `- ${m.title}${m.due ? ` (말한 마감: ${m.due})` : ""}: ${m.detail} — 근거 ${clock(m.startMs)} "${m.quote}"`).join("\n") });
  }
  return notes;
}
