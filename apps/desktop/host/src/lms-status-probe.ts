import { appendFileSync, writeFileSync } from "node:fs";
import { BrowserWindow, session } from "electron";
import { KHU_CANVAS_BASE_URL, type CanvasClient } from "@learningxxx/collector";

/**
 * WBS-054 measurement (CR-054). Two diagnostic modes, both started by hand:
 *
 * --lms-status-probe=<file>: signs in with the saved details (the same one-time
 * sign-in a collection does), then GETs weekly-learning, assignment, quiz and
 * module lists and records only their SHAPE: field paths, types and the
 * distinct values of status-like fields. No titles, names, text, URLs, tokens.
 *
 * --lms-watch=<file>: opens the LMS in an app window and logs, while the user
 * opens a material, plays a lecture or submits work, each request's method,
 * host, path (long ids masked) and, for writes, the names of its body fields.
 * Nothing in either mode writes to the LMS by itself.
 */

const LMS_PARTITION = "persist:lms";
/** Fields whose values are content or identity, never recorded. */
const PRIVATE = /title|name|description|body|html|message|content$|text|url|href|filename|display|email|login|avatar|comment|author|user|instructor|token|key|secret|path|uuid/i;
/** Fields whose distinct values tell us how status works. */
const STATUS = /status|state|complet|attend|progress|view|watch|percent|done|opened|lock|submi|graded|grade_|score|required|unlock|use_|type|extension|requirement|allowed|attempt|position|published|late|missing|excused|points|_at$|duration|count/i;

type Shape = Record<string, { types: Set<string>; values: Set<string> }>;

function walk(shape: Shape, value: unknown, path: string, depth: number): void {
  if (depth > 6) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) walk(shape, item, `${path}[]`, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) walk(shape, child, path ? `${path}.${key}` : key, depth + 1);
    return;
  }
  const entry = (shape[path] ??= { types: new Set(), values: new Set() });
  entry.types.add(value === null ? "null" : typeof value);
  const leaf = path.split(".").pop()!.replace("[]", "");
  if (PRIVATE.test(leaf) || !STATUS.test(leaf) || entry.values.size >= 12) return;
  if (typeof value === "boolean" || value === null) entry.values.add(String(value));
  else if (typeof value === "number") entry.values.add(leaf.endsWith("_at") ? "number" : String(value));
  else if (typeof value === "string") entry.values.add(/_at$|date|time/i.test(leaf) ? (value ? "<date>" : "") : value.length <= 32 ? value : "<long>");
}

const plain = (shape: Shape) =>
  Object.fromEntries(Object.entries(shape).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.values.size ? `${[...v.types].join("|")} = ${[...v.values].join(" | ")}` : [...v.types].join("|")]));

export interface StatusProbeDeps {
  ensureSignedIn: () => Promise<void>;
  learningxToken: () => Promise<string | undefined>;
  canvas: () => CanvasClient;
  courses: () => Promise<{ sourceCourseId: string }[]>;
}

export async function runLmsStatusProbe(out: string, deps: StatusProbeDeps): Promise<void> {
  const report: Record<string, unknown> = {};
  const outcomes: string[] = [];
  await deps.ensureSignedIn().catch(() => outcomes.push("sign-in failed"));
  const token = await deps.learningxToken();
  report.learningxSignedIn = token !== undefined;
  const lms = session.fromPartition(LMS_PARTITION);
  const shapes: Record<string, Shape> = { lxModule: {}, lxItem: {}, lxAttendanceItem: {}, assignment: {}, quiz: {}, canvasModule: {} };
  const itemTypes: Record<string, number> = {};
  const lx = async (path: string) => {
    const response = await lms.fetch(`${KHU_CANVAS_BASE_URL}/learningx/api/v1/${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    outcomes.push(`lx ${path.replace(/\d{3,}/g, "#")} ${response.status}`);
    return response.ok ? ((await response.json()) as unknown) : undefined;
  };
  const canvasList = async (path: string) => {
    try {
      return await deps.canvas().getList(path);
    } catch (error) {
      outcomes.push(`canvas ${path.replace(/\d{3,}/g, "#")} failed ${(error as { appError?: { code?: string } }).appError?.code ?? (error as Error).name}`);
      return [];
    }
  };
  for (const { sourceCourseId } of await deps.courses()) {
    const modules = token ? await lx(`courses/${sourceCourseId}/modules?include_detail=true`) : undefined;
    let attendanceSamples = 0;
    for (const module of Array.isArray(modules) ? modules : []) {
      const { module_items: items = [], ...rest } = module as { module_items?: unknown[] };
      walk(shapes.lxModule!, rest, "", 0);
      for (const item of items as Record<string, unknown>[]) {
        walk(shapes.lxItem!, item, "", 0);
        const detail = (item.content_data as { item_content_data?: { content_type?: unknown } } | undefined)?.item_content_data;
        const kind = `${String(item.content_type)}/${String(detail?.content_type ?? "-")}`;
        itemTypes[kind] = (itemTypes[kind] ?? 0) + 1;
        if (item.content_type === "attendance_item" && attendanceSamples < 4) {
          attendanceSamples += 1;
          walk(shapes.lxAttendanceItem!, await lx(`courses/${sourceCourseId}/attendance_items/${String(item.content_id)}`), "", 0);
        }
      }
    }
    for (const a of await canvasList(`/api/v1/courses/${sourceCourseId}/assignments?include[]=submission&per_page=100`)) walk(shapes.assignment!, a, "", 0);
    for (const q of await canvasList(`/api/v1/courses/${sourceCourseId}/quizzes?per_page=100`)) walk(shapes.quiz!, q, "", 0);
    for (const m of await canvasList(`/api/v1/courses/${sourceCourseId}/modules?include[]=items&per_page=100`)) walk(shapes.canvasModule!, m, "", 0);
  }
  report.itemTypes = itemTypes;
  report.shapes = Object.fromEntries(Object.entries(shapes).map(([k, v]) => [k, plain(v)]));
  report.outcomes = outcomes;
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}

/** Path with long numbers and hex ids masked, query keys kept and values dropped. */
function maskedPath(raw: string): string {
  const url = new URL(raw);
  const path = url.pathname.replace(/\/[0-9a-f]{12,}(?=\/|$)/gi, "/<id>").replace(/\d{3,}/g, "#");
  const keys = [...url.searchParams.keys()];
  return `${url.host}${path}${keys.length ? `?${keys.join("&")}` : ""}`;
}

function bodyFieldNames(details: Electron.OnBeforeRequestListenerDetails): string {
  const raw = details.uploadData?.map((part) => (part.bytes ? part.bytes.toString("utf8", 0, 4096) : part.file ? "<file>" : "")).join("") ?? "";
  if (!raw) return "";
  try {
    return `json:${Object.keys(JSON.parse(raw) as object).join(",")}`;
  } catch {
    if (raw.includes("<file>")) return "multipart/file";
    return `form:${[...new URLSearchParams(raw).keys()].slice(0, 30).join(",")}`;
  }
}

/** Keeps the window open until the user closes it; every LMS request is logged as one line. */
export async function runLmsWatch(out: string, deps: { ensureSignedIn: () => Promise<void> }): Promise<void> {
  await deps.ensureSignedIn().catch(() => undefined);
  const lms = session.fromPartition(LMS_PARTITION);
  writeFileSync(out, `# LMS 요청 기록 ${new Date().toISOString()} — 방법 호스트/경로(긴 번호 가림) [쓰기 요청의 본문 필드 이름]\n`);
  lms.webRequest.onBeforeRequest({ urls: ["https://*.khu.ac.kr/*"] }, (details, callback) => {
    if (!/\.(png|jpe?g|gif|svg|woff2?|css|ico)(\?|$)/i.test(details.url)) {
      const write = details.method !== "GET" && details.method !== "HEAD" ? ` [${bodyFieldNames(details)}]` : "";
      appendFileSync(out, `${new Date().toISOString().slice(11, 19)} ${details.method} ${details.resourceType} ${maskedPath(details.url)}${write}\n`);
    }
    callback({});
  });
  const window = new BrowserWindow({ width: 1280, height: 900, title: "LMS 요청 기록 (닫으면 끝)", webPreferences: { partition: LMS_PARTITION, sandbox: true, contextIsolation: true } });
  await window.loadURL(`${KHU_CANVAS_BASE_URL}/`).catch(() => undefined);
  await new Promise<void>((resolve) => window.once("closed", () => resolve()));
}
