import { Asset, AssignmentMetadata, MAX_BODY_CHARS, ManifestItem, Resource } from "@learningxxx/contracts";
import type { AppError, CollectionManifest, Course, Week } from "@learningxxx/contracts";
import { z } from "zod";
import type { AssetStore } from "./asset-store.ts";
import type { CanvasClient } from "./canvas-client.ts";
import { isPlaceholderWeek, stableId } from "./discovery.ts";
import { CollectionError, collectionError } from "./errors.ts";
import { LEARNINGX_FILE_TYPES, type LearningXClient } from "./learningx.ts";
import { DEFAULT_RETRY, withRetry, type RetryPolicy } from "./retry.ts";

type Item = z.infer<typeof ManifestItem>;
type Tombstone = CollectionManifest["tombstones"][number];
export type ResourceError = AppError & { resourceSourceId?: string };

const SourceId = z.union([z.number().int(), z.string().min(1)]).transform(String);
const Text = z.string().nullish().transform((v) => v ?? undefined);

const ModuleItem = z.object({
  type: z.string(),
  content_id: SourceId.optional(),
  html_url: Text,
});

const CanvasFile = z.object({
  id: SourceId,
  display_name: z.string().min(1),
  filename: Text,
  "content-type": Text,
  size: z.number().int().nonnegative(),
  url: Text,
  modified_at: Text,
  updated_at: Text,
  locked_for_user: z.boolean().optional(),
  hidden_for_user: z.boolean().optional(),
});
type CanvasFile = z.infer<typeof CanvasFile>;

/** One weekly LearningX module; items embed their Commons content (khu-ecampus-archive flow). */
const LearningXModule = z.object({
  module_id: SourceId.optional(),
  title: Text,
  module_items: z
    .array(
      z.object({
        content_type: Text,
        title: Text,
        url: Text,
        content_data: z
          .object({
            opened: z.boolean().nullish(),
            item_content_data: z
              .object({
                content_id: Text,
                content_type: Text,
                file_name: Text,
                last_updated_date: z.union([z.string(), z.number()]).nullish(),
              })
              .nullish(),
          })
          .nullish(),
      }),
    )
    .nullish(),
});

const CanvasAssignment = z.object({
  id: SourceId,
  name: z.string().min(1),
  due_at: Text,
  html_url: Text,
  updated_at: Text,
  created_at: Text,
  quiz_id: SourceId.optional(),
  description: Text,
});

const CanvasAnnouncement = z.object({
  id: SourceId,
  title: z.string().min(1),
  html_url: Text,
  posted_at: Text,
  created_at: Text,
  message: Text,
  attachments: z.array(CanvasFile.partial({ size: true }).extend({ size: z.number().int().nonnegative() })).optional(),
});

export interface ResourceCollectionInput {
  client: CanvasClient;
  store: AssetStore;
  course: Course;
  weeks: Week[];
  /** Last good manifest of this course: unchanged originals are reused and kept on failure. */
  previous?: CollectionManifest | undefined;
  now?: () => Date;
  /** Bounded retry for transient failures (WBS-009); tests pass a fake sleep. */
  retry?: RetryPolicy;
  /** KHU lecture materials live in LearningX, not Canvas files (WBS-039). */
  learningx?: LearningXClient | undefined;
}

export interface ResourceCollectionResult {
  items: Item[];
  tombstones: Tombstone[];
  /** One entry per failed listing or resource; a non-empty list makes the sync run `partial`. */
  errors: ResourceError[];
  /** Module item types that have no Resource kind yet (pages, discussions, links, …). */
  skippedTypes: Record<string, number>;
}

/**
 * Collects files (from weekly modules), announcements and assignments of one
 * course into contract items (WBS-008). Each resource fails on its own and
 * keeps its previous good item; only an expired login stops the whole run.
 * Revisions rise only when content changes, never on a title edit.
 */
export async function collectResources(input: ResourceCollectionInput): Promise<ResourceCollectionResult> {
  const { client, store, course, weeks, previous } = input;
  const now = input.now ?? (() => new Date());
  const cid = course.sourceCourseId;
  const errors: ResourceError[] = [];
  const skippedTypes: Record<string, number> = {};
  const prevItems = new Map((previous?.items ?? []).map((i) => [i.resource.id, i]));
  const items = new Map<string, Item>();
  const complete = { file: true, notice: true, assignment: true };
  const hidden = new Set<string>();

  const retry = input.retry ?? DEFAULT_RETRY;
  const attempt = async <T>(sourceId: string | undefined, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await withRetry(work, retry);
    } catch (error) {
      if (!(error instanceof CollectionError) || error.appError.code === "AUTH_REQUIRED") throw error;
      errors.push({ ...error.appError, ...(sourceId === undefined ? {} : { resourceSourceId: sourceId }) });
      return undefined;
    }
  };
  /** Keeps the previous good item when a resource could not be collected this time. */
  const keepPrevious = (id: string) => {
    const prev = prevItems.get(id);
    if (prev) items.set(id, prev);
  };

  // 1. Weekly modules link files and assignments to weeks; the first (earliest) week wins.
  const fileWeek = new Map<string, { weekId: string; url: string | undefined }>();
  const assignmentWeek = new Map<string, string>();
  const quizWeek = new Map<string, string>();
  for (const week of [...weeks].sort((a, b) => a.order - b.order)) {
    if (isPlaceholderWeek(week)) continue; // WBS-074: a week the LMS does not have holds nothing there
    const raw = await attempt(undefined, () => client.getList(`/api/v1/courses/${cid}/modules/${week.sourceWeekId}/items?per_page=100`));
    if (raw === undefined) {
      complete.file = complete.assignment = false;
      continue;
    }
    for (const entry of raw) {
      const item = ModuleItem.safeParse(entry);
      if (!item.success) continue;
      const { type, content_id: contentId } = item.data;
      if (type === "File" && contentId && !fileWeek.has(contentId)) fileWeek.set(contentId, { weekId: week.id, url: item.data.html_url });
      else if (type === "Assignment" && contentId && !assignmentWeek.has(contentId)) assignmentWeek.set(contentId, week.id);
      else if (type === "Quiz" && contentId && !quizWeek.has(contentId)) quizWeek.set(contentId, week.id);
      else if (type !== "File" && type !== "Assignment" && type !== "Quiz") skippedTypes[type] = (skippedTypes[type] ?? 0) + 1;
    }
  }

  const resource = (kind: Resource["kind"], sourceId: string, fields: { weekId?: string | undefined; title: string; url?: string | undefined; updatedAt: string }) => ({
    id: stableId("resource", course.id, kind, sourceId),
    courseId: course.id,
    ...(fields.weekId ? { weekId: fields.weekId } : {}),
    kind,
    source: "lms" as const,
    sourceId,
    ...(sameOriginHttps(fields.url, client) ? { sourceUrl: fields.url } : {}),
    title: fields.title,
    updatedAt: fields.updatedAt,
  });

  const assetFor = async (resourceId: string, file: CanvasFile): Promise<z.infer<typeof Asset>> => {
    const id = stableId("asset", resourceId, file.id);
    const prev = prevItems.get(resourceId)?.assets.find((a) => a.id === id);
    const prevResource = prevItems.get(resourceId)?.resource;
    // A file resource's updatedAt is the file's modification time; notice attachments get a new id when replaced.
    const sameVersion = prevResource?.kind !== "file" || toUtc(file.modified_at ?? file.updated_at)?.at === prevResource.updatedAt;
    // Unchanged at the source and intact on disk: reuse without downloading again.
    if (prev && prev.bytes === file.size && sameVersion && (await store.verify(prev.storageKey, prev.sha256))) {
      return { ...prev, originalName: file.display_name };
    }
    if (!file.url) throw collectionError("SOURCE_CHANGED", "LMS가 이 파일의 다운로드 주소를 주지 않았습니다.");
    const { body, contentType } = await client.download(file.url);
    const name = file.filename ?? file.display_name;
    const stored = await store.put(body, { expectedBytes: file.size, extension: extensionOf(name) });
    return Asset.parse({
      id,
      resourceId,
      mediaType: mediaType(file["content-type"] ?? contentType),
      bytes: stored.bytes,
      sha256: stored.sha256,
      storageKey: stored.storageKey,
      originalName: file.display_name,
    });
  };

  // 2. Files referenced from modules.
  for (const [fileId, link] of fileWeek) {
    const id = stableId("resource", course.id, "file", fileId);
    const done = await attempt(fileId, async () => {
      const file = parse(CanvasFile, await client.getObject(`/api/v1/courses/${cid}/files/${fileId}`));
      if (file.locked_for_user || file.hidden_for_user) {
        hidden.add(id);
        return true;
      }
      const updatedAt = toUtc(file.modified_at ?? file.updated_at)?.at ?? keepTime(prevItems.get(id), now);
      const res = resource("file", fileId, { weekId: link.weekId, title: file.display_name, url: link.url, updatedAt });
      items.set(id, withRevision({ resource: res, assets: [await assetFor(id, file)] }, prevItems.get(id)));
      return true;
    });
    if (!done) keepPrevious(id);
  }

  // 2b. LearningX lecture materials. Only listed, opened files are fetched, and an
  //     unchanged one (same update time, intact on disk) is never downloaded again.
  if (input.learningx) {
    const lx = input.learningx;
    const raw = await attempt(undefined, () => lx.modules(cid));
    if (raw === undefined) complete.file = false;
    const byModule = new Map(weeks.map((w) => [w.sourceWeekId, w.id]));
    const byLabel = new Map(weeks.map((w) => [w.label.trim(), w.id]));
    const seen = new Set<string>();
    for (const entry of raw ?? []) {
      const mod = LearningXModule.safeParse(entry);
      if (!mod.success) {
        errors.push(collectionError("SOURCE_CHANGED", "강의 자료 주차 형식이 예상과 다릅니다.").appError);
        complete.file = false;
        continue;
      }
      const weekId = (mod.data.module_id && byModule.get(mod.data.module_id)) || (mod.data.title && byLabel.get(mod.data.title.trim())) || undefined;
      for (const it of mod.data.module_items ?? []) {
        if (it.content_type !== "attendance_item") continue;
        const icd = it.content_data?.item_content_data;
        const ext = (icd?.content_type ?? "").toLowerCase();
        if (!LEARNINGX_FILE_TYPES.has(ext)) {
          skippedTypes[`learningx:${ext || "unknown"}`] = (skippedTypes[`learningx:${ext || "unknown"}`] ?? 0) + 1;
          continue;
        }
        const contentId = icd?.content_id;
        if (!contentId || contentId === "not_open" || it.content_data?.opened === false) {
          skippedTypes["learningx:not_open"] = (skippedTypes["learningx:not_open"] ?? 0) + 1;
          continue;
        }
        const sourceId = `commons:${contentId}`;
        if (seen.has(sourceId)) continue;
        seen.add(sourceId);
        const id = stableId("resource", course.id, "file", sourceId);
        const prev = prevItems.get(id);
        const title = it.title ?? icd?.file_name ?? "강의 자료";
        const originalName = icd?.file_name ?? `${title}.${ext}`;
        const updatedAt = sourceTime(icd?.last_updated_date) ?? keepTime(prev, now);
        const done = await attempt(sourceId, async () => {
          const res = resource("file", sourceId, { weekId, title, url: it.url, updatedAt });
          const old = prev?.assets[0];
          if (old && prev.resource.updatedAt === updatedAt && (await store.verify(old.storageKey, old.sha256))) {
            items.set(id, withRevision({ resource: res, assets: [{ ...old, originalName }] }, prev));
            return true;
          }
          const { bytes, extension } = await lx.download(contentId, ext);
          const stored = await store.put(new Blob([bytes]).stream(), { expectedBytes: bytes.length, extension });
          const asset = Asset.parse({
            id: stableId("asset", id, contentId),
            resourceId: id,
            mediaType: MEDIA_TYPES[extension] ?? "application/octet-stream",
            bytes: stored.bytes,
            sha256: stored.sha256,
            storageKey: stored.storageKey,
            originalName,
          });
          items.set(id, withRevision({ resource: res, assets: [asset] }, prev));
          return true;
        });
        if (!done) keepPrevious(id);
      }
    }
  }

  // 3. Announcements: course-level notices, attachments kept as assets.
  const announcements = await attempt(undefined, () => client.getList(`/api/v1/courses/${cid}/discussion_topics?only_announcements=true&per_page=100`));
  if (announcements === undefined) complete.notice = false;
  for (const raw of announcements ?? []) {
    const parsed = CanvasAnnouncement.safeParse(raw);
    if (!parsed.success) {
      errors.push(collectionError("SOURCE_CHANGED", "LMS 공지 형식이 예상과 다릅니다.").appError);
      complete.notice = false;
      continue;
    }
    const a = parsed.data;
    const posted = toUtc(a.posted_at ?? a.created_at)?.at;
    if (posted === undefined) continue; // not published yet
    const id = stableId("resource", course.id, "notice", a.id);
    const done = await attempt(a.id, async () => {
      const res = resource("notice", a.id, { title: a.title, url: a.html_url, updatedAt: posted });
      const assets = [];
      for (const file of a.attachments ?? []) assets.push(await assetFor(id, { ...file, display_name: file.display_name ?? file.filename ?? "첨부" }));
      items.set(id, withRevision({ resource: res, assets, ...body(a.message) }, prevItems.get(id)));
      return true;
    });
    if (!done) keepPrevious(id);
  }

  // 4. Assignments, linked to a week through an Assignment or Quiz module item.
  const assignments = await attempt(undefined, () => client.getList(`/api/v1/courses/${cid}/assignments?per_page=100`));
  if (assignments === undefined) complete.assignment = false;
  for (const raw of assignments ?? []) {
    const parsed = CanvasAssignment.safeParse(raw);
    if (!parsed.success) {
      errors.push(collectionError("SOURCE_CHANGED", "LMS 과제 형식이 예상과 다릅니다.").appError);
      complete.assignment = false;
      continue;
    }
    const a = parsed.data;
    const id = stableId("resource", course.id, "assignment", a.id);
    const weekId = assignmentWeek.get(a.id) ?? (a.quiz_id ? quizWeek.get(a.quiz_id) : undefined);
    const due = toUtc(a.due_at);
    const updatedAt = toUtc(a.updated_at ?? a.created_at)?.at ?? keepTime(prevItems.get(id), now);
    const res = resource("assignment", a.id, { weekId, title: a.name, url: a.html_url, updatedAt });
    const assignment = AssignmentMetadata.parse({
      resourceId: id,
      dueAt: due?.at ?? null,
      timezone: "Asia/Seoul",
      timezoneBasis: due?.assumed ? "assumed_asia_seoul" : "source_explicit",
      ...(sameOriginHttps(a.html_url, client) ? { submissionUrl: a.html_url } : {}),
    });
    items.set(id, withRevision({ resource: res, assets: [], assignment, ...body(a.description) }, prevItems.get(id)));
  }

  // 5. Tombstones only for kinds whose listing completed, so a failed listing never "deletes" anything.
  const removedAt = utc(now());
  const tombstones = new Map<string, Tombstone>();
  for (const t of previous?.tombstones ?? []) if (!items.has(t.resourceId)) tombstones.set(t.resourceId, t);
  for (const [id, prev] of prevItems) {
    if (items.has(id) || tombstones.has(id) || !complete[prev.resource.kind]) continue;
    tombstones.set(id, { resourceId: id, removedAt, reason: hidden.has(id) ? "hidden_at_source" : "deleted_at_source" });
  }
  // A listing failed or this resource failed: the previous good item stays.
  for (const [id, prev] of prevItems) if (!items.has(id) && !tombstones.has(id)) items.set(id, prev);

  return {
    items: [...items.values()].sort((a, b) => a.resource.id.localeCompare(b.resource.id)).map((i) => ManifestItem.parse(i)),
    tombstones: [...tombstones.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
    errors,
    skippedTypes,
  };
}

/**
 * Revision rises only when content changes: file bytes (hash), a notice's post
 * time or attachments, an assignment's deadline. Title edits keep the revision.
 */
/** WBS-067: the body as the LMS sent it (empty bodies left out), cut at the contract limit. */
function body(html: string | undefined): { body?: string } {
  const text = html?.trim();
  return text ? { body: text.slice(0, MAX_BODY_CHARS) } : {};
}

function withRevision(item: Omit<Item, "resource"> & { resource: Omit<Resource, "revision"> }, prev: Item | undefined): Item {
  // A body counts as a change only when both sides have one, so the first collection that adds bodies is not "changed".
  const bodies = prev?.body !== undefined && item.body !== undefined;
  const fingerprint = (i: { resource: { kind: string; updatedAt: string }; assets: { sha256: string }[]; assignment?: { dueAt: string | null } | undefined; body?: string | undefined }) =>
    JSON.stringify([
      i.assets.map((a) => a.sha256).sort(),
      i.resource.kind === "notice" ? i.resource.updatedAt : null,
      i.assignment?.dueAt ?? null,
      bodies ? i.body ?? null : null,
    ]);
  const revision = prev === undefined ? 1 : fingerprint(prev) === fingerprint(item) ? prev.resource.revision : prev.resource.revision + 1;
  return { ...item, resource: Resource.parse({ ...item.resource, revision }) };
}

const utc = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Canvas sends ISO 8601 with a zone. A value without one is read as Seoul
 * time and flagged, so the UI can say the zone was assumed (SPEC-001).
 */
export function toUtc(value: string | undefined): { at: string; assumed: boolean } | undefined {
  if (!value) return undefined;
  const assumed = !/(Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const date = new Date(assumed ? `${value}+09:00` : value);
  return Number.isNaN(date.getTime()) ? undefined : { at: utc(date), assumed };
}

/** LearningX sends either epoch time (s or ms) or a date string. */
function sourceTime(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number" || /^\d+$/.test(value)) {
    const n = Number(value);
    const date = new Date(n > 1e12 ? n : n * 1000);
    return Number.isNaN(date.getTime()) ? undefined : utc(date);
  }
  return toUtc(value)?.at;
}

const MEDIA_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  doc: "application/msword",
  ppt: "application/vnd.ms-powerpoint",
  xls: "application/vnd.ms-excel",
  hwp: "application/x-hwp",
  hwpx: "application/hwp+zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

const keepTime = (prev: Item | undefined, now: () => Date) => prev?.resource.updatedAt ?? utc(now());

function sameOriginHttps(url: string | undefined, client: CanvasClient): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.origin === client.origin;
  } catch {
    return false;
  }
}

function mediaType(raw: string | undefined): string {
  const type = raw?.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z]+\/[0-9a-z.+-]+$/.test(type) ? type : "application/octet-stream";
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw collectionError("SOURCE_CHANGED", "LMS 응답 형식이 예상과 다릅니다.");
}
