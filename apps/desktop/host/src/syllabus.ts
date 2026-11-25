import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AccountKey, AppError, CourseMeeting, CourseSyllabus, Id, SyllabusSource, type CollectionManifest } from "@learningxxx/contracts";
import { SYLLABUS_TITLE } from "./course-knowledge.ts";
import { htmlToText } from "./week-notes.ts";
import { parseDocx, parsePdfText, parseSyllabusHtml, syllabusMeetings, syllabusText } from "./syllabus-parse.ts";

/**
 * WBS-107: the course syllabus, read by the app itself so the student does
 * not open it on the web. Sources, all read only:
 * - the school's syllabus page the LMS syllabus links to (KHU: the public
 *   수강신청 강의계획서 page, which needs no sign-in);
 * - the LMS syllabus text itself, when it holds more than those links;
 * - syllabus files posted in the LMS (Word or PDF), already collected.
 * Each is turned into sections without AI (syllabus-parse.ts) and kept on
 * this Mac. A source that fails keeps its last copy and says why.
 */

/** Only pages on these hosts are fetched from links in the LMS syllabus (https). */
export const SCHOOL_SYLLABUS_HOSTS: ReadonlySet<string> = new Set(["sugang.khu.ac.kr"]);
const MAX_PAGE = 3 * 1024 * 1024;
const MAX_SCHOOL_PAGES = 4;
const MAX_FILES = 3;
const TIMEOUT_MS = 20_000;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function fail(code: "AUTH_REQUIRED" | "NOT_FOUND" | "SCOPE_VIOLATION", message: string): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable: false }) });
}
const sourceId = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);
const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** A syllabus page link from LMS HTML, made https and checked against the allowed hosts. */
export function schoolSyllabusUrl(href: string): string | undefined {
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (!SCHOOL_SYLLABUS_HOSTS.has(url.hostname) || url.username || url.password || url.port) return undefined;
    url.protocol = "https:"; url.hash = "";
    return url.href;
  } catch { return undefined; }
}

type Planned = { id: string; kind: SyllabusSource["kind"]; label: string; url?: string; resourceId?: string; assetId?: string; mediaType?: string; html?: string };

/** What the collected course says its syllabus is, in the order it is shown. */
export function syllabusSources(manifest: CollectionManifest): Planned[] {
  const notices = manifest.items.filter((i) => i.resource.kind === "notice" && i.body && (i.resource.sourceId === "syllabus" || SYLLABUS_TITLE.test(i.resource.title)));
  const out: Planned[] = [];
  for (const item of notices) {
    const html = item.body!;
    const links = [...html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi)];
    for (const [, a, b, inner] of links) {
      const url = schoolSyllabusUrl((a ?? b ?? "").replace(/&amp;/g, "&"));
      if (!url || out.some((s) => s.url === url) || out.filter((s) => s.kind === "school").length >= MAX_SCHOOL_PAGES) continue;
      const text = htmlToText(inner ?? "").replace(/[▶►→]/g, "").replace(/바로\s*가기/g, "").replace(/\s+/g, " ").trim();
      out.push({ id: sourceId(`school:${url}`), kind: "school", label: text || "학교 강의계획서", url });
    }
    // The LMS text itself, when it says more than the links do.
    const rest = htmlToText(html.replace(/<a\b[\s\S]*?<\/a\s*>/gi, " ")).replace(/\s+/g, " ").trim();
    if (rest.length >= 40) out.push({ id: sourceId(`lms:${item.resource.id}`), kind: "lms", label: item.resource.title, resourceId: item.resource.id, html, ...(item.resource.sourceUrl ? { url: item.resource.sourceUrl } : {}) });
  }
  for (const item of manifest.items) {
    if (out.filter((s) => s.kind === "file").length >= MAX_FILES) break;
    if (item.resource.kind === "notice" || item.resource.kind === "assignment") continue;
    for (const asset of item.assets) {
      if (asset.mediaType !== DOCX && asset.mediaType !== "application/pdf") continue;
      if (!/강의\s*계획서|수업\s*계획서|syllabus/i.test(`${item.resource.title} ${asset.originalName}`)) continue;
      out.push({ id: sourceId(`file:${asset.id}`), kind: "file", label: asset.originalName, resourceId: item.resource.id, assetId: asset.id, mediaType: asset.mediaType });
      break;
    }
  }
  return out;
}

const Stored = z.object({ refreshedAt: z.string().optional(), sources: z.array(SyllabusSource) });

export interface SyllabusOptions {
  root: string;
  accountKey: () => string | undefined;
  manifest: (courseId: string) => Promise<CollectionManifest | undefined>;
  /** Bytes of a collected file. */
  asset: (courseId: string, assetId: string) => Promise<Uint8Array>;
  pdfPages: (bytes: Uint8Array) => Promise<string[]>;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export class SyllabusService {
  readonly #o: SyllabusOptions;
  readonly #running = new Map<string, Promise<CourseSyllabus>>();
  constructor(options: SyllabusOptions) { this.#o = options; }

  #dir(courseId: string): { key: string; dir: string } {
    const key = this.#o.accountKey();
    if (!key) fail("AUTH_REQUIRED", "학교 자료를 먼저 수집해 계정을 확인하세요.");
    return { key, dir: join(this.#o.root, AccountKey.parse(key), Id.parse(courseId)) };
  }

  async #stored(dir: string): Promise<z.infer<typeof Stored> | undefined> {
    try { return Stored.parse(JSON.parse(await readFile(join(dir, "syllabus.json"), "utf8"))); } catch { return undefined; }
  }

  /** What is kept, with sources the course now lists but not read yet (no doc, no error). */
  async get(courseId: string): Promise<CourseSyllabus> {
    const { dir } = this.#dir(courseId);
    const manifest = await this.#o.manifest(courseId);
    const stored = await this.#stored(dir);
    const planned = manifest ? syllabusSources(manifest) : [];
    const kept = new Map(stored?.sources.map((s) => [s.id, s]) ?? []);
    const sources = planned.map((p) => kept.get(p.id) ?? SyllabusSource.parse({ id: p.id, kind: p.kind, label: p.label, ...(p.url ? { url: p.url } : {}), ...(p.resourceId ? { resourceId: p.resourceId } : {}) }));
    return { sources, ...(stored?.refreshedAt ? { refreshedAt: stored.refreshedAt } : {}) };
  }

  /** Text for course.md and the chat (only sources read successfully). */
  async text(courseId: string): Promise<{ title: string; text: string }[]> {
    try {
      const { sources } = await this.get(courseId);
      return sources.filter((s) => s.doc).map((s) => ({ title: s.label, text: syllabusText(s.doc!) }));
    } catch { return []; }
  }

  /**
   * Weekly class times the syllabus states (first source that has them).
   * With `readIfUnread`, a listed source never read is read first, so the
   * timetable fills itself the first time it is shown.
   */
  async meetings(courseId: string, readIfUnread = false): Promise<CourseMeeting[]> {
    try {
      let state = await this.get(courseId);
      if (readIfUnread && state.sources.some((s) => !s.doc && !s.error)) state = await this.refresh(courseId);
      for (const s of state.sources) {
        const found = s.doc ? syllabusMeetings(s.doc).flatMap((m) => { const ok = CourseMeeting.safeParse(m); return ok.success ? [ok.data] : []; }) : [];
        if (found.length) return found;
      }
    } catch { /* no account, no manifest or unreadable: no times */ }
    return [];
  }

  refresh(courseId: string): Promise<CourseSyllabus> {
    const running = this.#running.get(courseId);
    if (running) return running;
    const job = this.#refresh(courseId).finally(() => this.#running.delete(courseId));
    this.#running.set(courseId, job);
    return job;
  }

  async #refresh(courseId: string): Promise<CourseSyllabus> {
    const { key, dir } = this.#dir(courseId);
    const manifest = await this.#o.manifest(courseId) ?? fail("NOT_FOUND", "이 과목의 수집 자료가 없습니다. 자료 수집을 먼저 하세요.");
    const previous = new Map((await this.#stored(dir))?.sources.map((s) => [s.id, s]) ?? []);
    const now = () => stamp(this.#o.now?.() ?? new Date());
    const sources: SyllabusSource[] = [];
    for (const p of syllabusSources(manifest)) {
      const base = { id: p.id, kind: p.kind, label: p.label, ...(p.url ? { url: p.url } : {}), ...(p.resourceId ? { resourceId: p.resourceId } : {}) };
      try {
        const { doc, original } = await this.#read(courseId, p);
        if (!doc.sections.length) throw new Error("강의계획서 내용을 찾지 못했습니다. 원문에서 확인하세요.");
        sources.push(SyllabusSource.parse({ ...base, fetchedAt: now(), doc, ...(original ? { original } : {}) }));
      } catch (error) {
        const message = error instanceof Error && error.message ? error.message : "강의계획서를 읽지 못했습니다.";
        const old = previous.get(p.id);
        sources.push(SyllabusSource.parse({ ...base, ...(old?.doc ? { doc: old.doc, fetchedAt: old.fetchedAt } : {}), ...(old?.original ? { original: old.original } : {}), error: old?.doc ? `${message} 이전에 받은 내용을 보여 줍니다.` : message }));
      }
    }
    if (this.#o.accountKey() !== key) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다. 강의계획서를 저장하지 않았습니다.");
    const result = { refreshedAt: now(), sources };
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `syllabus.json.${process.pid}.tmp`);
    await writeFile(temp, JSON.stringify(result), { mode: 0o600 });
    await rename(temp, join(dir, "syllabus.json"));
    return result;
  }

  async #read(courseId: string, p: Planned): Promise<{ doc: ReturnType<typeof parseSyllabusHtml>; original?: string }> {
    if (p.kind === "lms") return { doc: parseSyllabusHtml(p.html!), original: p.html! };
    if (p.kind === "file") {
      const bytes = await this.#o.asset(courseId, p.assetId!).catch(() => { throw new Error("이 Mac에 받은 계획서 파일이 없습니다. 자료 수집을 다시 하세요."); });
      const doc = p.mediaType === DOCX ? parseDocx(bytes, p.label) : parsePdfText(await this.#o.pdfPages(bytes).catch(() => []), p.label);
      if (!doc) throw new Error(p.mediaType === DOCX ? "Word 파일을 읽지 못했습니다." : "PDF에서 글자를 읽지 못했습니다(스캔본일 수 있습니다).");
      return { doc };
    }
    const html = await this.#page(p.url!);
    const doc = parseSyllabusHtml(html);
    const body = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html)?.[1] ?? html;
    return { doc, original: body.slice(0, 300_000) };
  }

  /** One GET of a school syllabus page: https, allowed host (also after redirects), HTML, bounded size and time. */
  async #page(url: string): Promise<string> {
    let response: Response;
    try {
      response = await (this.#o.fetch ?? globalThis.fetch)(url, { method: "GET", redirect: "follow", headers: { Accept: "text/html" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch { throw new Error("학교 강의계획서 사이트에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 받으세요."); }
    const final = response.url ? schoolSyllabusUrl(response.url) : url;
    if (!final || new URL(final).protocol !== "https:" || (response.url && new URL(response.url).protocol !== "https:")) { await response.body?.cancel(); throw new Error("학교 사이트가 다른 주소로 안내해 받지 않았습니다."); }
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`학교 강의계획서 사이트가 응답하지 않았습니다(${response.status}). 잠시 뒤 다시 받으세요.`); }
    const type = response.headers.get("content-type") ?? "";
    if (type && !/html/i.test(type)) { await response.body?.cancel(); throw new Error("받은 내용이 강의계획서 페이지가 아닙니다."); }
    if (Number(response.headers.get("content-length")) > MAX_PAGE) { await response.body?.cancel(); throw new Error("강의계획서 페이지가 너무 큽니다."); }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PAGE) throw new Error("강의계획서 페이지가 너무 큽니다.");
    const head = Buffer.from(bytes.subarray(0, 2048)).toString("latin1");
    const charset = /charset=([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? "utf-8";
    try { return new TextDecoder(charset.toLowerCase()).decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
  }
}
