import { AppError } from "@learningxxx/contracts";

/**
 * WBS-058: hands in a file for a Canvas assignment the way the LMS web page
 * does — ask for an upload slot, upload the file, confirm the upload, then
 * make the submission — only after the student confirmed it (or a rule they
 * confirmed fires). Before anything is sent the assignment is read again:
 * file upload must be allowed, the extension accepted, the assignment open
 * and not locked. After any failure the LMS state is read before trying
 * again, so one request never becomes two submissions.
 */

export interface CanvasHttp {
  /** A request to the LMS (a path, or a URL on its origin: signed in) or to the upload host Canvas named (https, nothing of the sign-in). */
  request: (url: string, init: { method: "GET" | "POST"; body?: URLSearchParams | FormData }) => Promise<Response>;
}

export interface AssignmentCheck {
  id: string; name: string; dueAt: string | null; lockAt: string | null; unlockAt: string | null;
  types: string[]; extensions: string[]; lockedForUser: boolean; allowedAttempts: number | null;
  submission: { state: string; attempt: number | null; submittedAt: string | null; files: string[] };
}

/** Each step's HTTP status, for diagnostics; never bodies, names of files or ids of people. */
export type SubmitTrace = (step: "read" | "slot" | "upload" | "confirm_upload" | "submit" | "verify", status: number) => void;

type Code = "INVALID_REQUEST" | "AUTH_REQUIRED" | "NOT_FOUND" | "SOURCE_CHANGED" | "DOWNLOAD_FAILED";
function fail(code: Code, message: string, retryable = false): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable }) });
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
/** Canvas prefixes cookie-authenticated JSON with this guard (see collector CanvasClient). */
const JSON_GUARD = "while(1);";

async function json(response: Response, what: string): Promise<Json> {
  const text = await response.text().catch(() => "");
  // A manual redirect from the LMS itself means the session went to the login page.
  if (response.status === 401 || (response.status >= 300 && response.status < 400) || response.type === "opaqueredirect") fail("AUTH_REQUIRED", "학교 로그인이 필요합니다. 설정에서 학교 로그인을 확인한 뒤 다시 제출하세요.");
  if (response.status === 403) fail("AUTH_REQUIRED", `${what}: LMS가 이 요청을 거부했습니다(권한 없음). 로그인 상태를 확인하세요.`);
  if (response.status === 404) fail("NOT_FOUND", "LMS에서 과제를 찾지 못했습니다.");
  if (response.status === 422) fail("SOURCE_CHANGED", `${what}: LMS가 요청을 받지 않았습니다(422). 로그인 확인 값이 맞지 않을 수 있습니다.`);
  if (!response.ok) fail("DOWNLOAD_FAILED", `${what} 중 LMS가 ${response.status}로 답했습니다.`, response.status >= 500 || response.status === 429);
  try {
    return obj(JSON.parse(text.startsWith(JSON_GUARD) ? text.slice(JSON_GUARD.length) : text));
  } catch {
    return fail("SOURCE_CHANGED", `${what} 응답을 읽지 못했습니다. 로그인 상태를 확인한 뒤 다시 시도하세요.`);
  }
}

const ID = /^\d{1,20}$/;
const path = (courseId: string, assignmentId: string) => {
  if (!ID.test(courseId) || !ID.test(assignmentId)) fail("INVALID_REQUEST", "잘못된 과제 번호입니다.");
  return `/api/v1/courses/${courseId}/assignments/${assignmentId}`;
};

/** The assignment as Canvas sees it now, with this student's submission. */
export async function readAssignment(http: CanvasHttp, courseId: string, assignmentId: string, trace?: SubmitTrace): Promise<AssignmentCheck> {
  const response = await http.request(`${path(courseId, assignmentId)}?include[]=submission`, { method: "GET" });
  trace?.("read", response.status);
  const a = await json(response, "과제 확인");
  if (String(a.id ?? "") !== assignmentId) fail("SOURCE_CHANGED", "LMS가 다른 과제를 돌려주었습니다.");
  const s = obj(a.submission);
  return {
    id: String(a.id), name: str(a.name) ?? "과제", dueAt: str(a.due_at), lockAt: str(a.lock_at), unlockAt: str(a.unlock_at),
    types: (Array.isArray(a.submission_types) ? a.submission_types : []).map(String),
    extensions: (Array.isArray(a.allowed_extensions) ? a.allowed_extensions : []).map((x) => String(x).toLowerCase().replace(/^\./, "")),
    lockedForUser: a.locked_for_user === true, allowedAttempts: typeof a.allowed_attempts === "number" && a.allowed_attempts > 0 ? a.allowed_attempts : null,
    submission: {
      // A submission Canvas holds but which was never handed in has no attempt.
      state: str(s.workflow_state) ?? "unsubmitted", attempt: typeof s.attempt === "number" ? s.attempt : null, submittedAt: str(s.submitted_at),
      files: (Array.isArray(s.attachments) ? s.attachments : []).map((f) => str(obj(f).display_name) ?? "파일"),
    },
  };
}

export const extensionOf = (fileName: string) => (/\.([^./\\]+)$/.exec(fileName)?.[1] ?? "").toLowerCase();

/** Why a file cannot be handed in now, or undefined when it can. */
export function cannotSubmit(a: AssignmentCheck, fileName: string, now: Date): string | undefined {
  const ext = extensionOf(fileName);
  if (!a.types.includes("online_upload")) return "이 과제는 파일 제출을 받지 않습니다(LMS에서 직접 제출하세요).";
  if (a.lockedForUser) return "LMS가 이 과제를 잠가 두었습니다.";
  if (a.unlockAt && Date.parse(a.unlockAt) > now.getTime()) return "아직 제출 기간이 아닙니다.";
  if (a.lockAt && Date.parse(a.lockAt) <= now.getTime()) return "제출 기간이 끝났습니다.";
  if (a.extensions.length && !a.extensions.includes(ext)) return `허용된 형식이 아닙니다(${a.extensions.join(", ")}).`;
  if (a.allowedAttempts !== null && (a.submission.attempt ?? 0) >= a.allowedAttempts) return "제출 가능 횟수를 모두 썼습니다.";
  return undefined;
}

/** Shown before confirming, but not a reason to refuse: Canvas records the submission as late. */
export function lateNote(a: AssignmentCheck, now: Date): string | undefined {
  return a.dueAt && Date.parse(a.dueAt) < now.getTime() ? "마감이 지나 LMS에 지각 제출로 기록됩니다." : undefined;
}

export interface SubmitResult { attempt: number | null; submittedAt: string | null; files: string[] }

/**
 * Uploads one file and submits it. `before` is the submission read when the
 * student confirmed; if the LMS shows a newer attempt than that, the work is
 * already done and nothing is sent again.
 */
export async function submitFile(http: CanvasHttp, input: { courseId: string; assignmentId: string; file: { name: string; bytes: Uint8Array; contentType: string }; before: AssignmentCheck; now?: Date; trace?: SubmitTrace }): Promise<SubmitResult> {
  const { trace } = input;
  const base = path(input.courseId, input.assignmentId);
  const current = await readAssignment(http, input.courseId, input.assignmentId, trace);
  if ((current.submission.attempt ?? 0) > (input.before.submission.attempt ?? 0)) {
    return { attempt: current.submission.attempt, submittedAt: current.submission.submittedAt, files: current.submission.files };
  }
  const problem = cannotSubmit(current, input.file.name, input.now ?? new Date());
  if (problem) fail("INVALID_REQUEST", problem);
  // 1. Upload slot.
  const slotResponse = await http.request(`${base}/submissions/self/files`, { method: "POST", body: new URLSearchParams({ name: input.file.name, size: String(input.file.bytes.byteLength), content_type: input.file.contentType, on_duplicate: "rename" }) });
  trace?.("slot", slotResponse.status);
  const slot = await json(slotResponse, "업로드 준비");
  const uploadUrl = str(slot.upload_url) ?? fail("SOURCE_CHANGED", "LMS가 업로드 주소를 주지 않았습니다.");
  // 2. The file, after the fields Canvas asked for (the upload host reads them first).
  const form = new FormData();
  for (const [k, v] of Object.entries(obj(slot.upload_params))) form.append(k, String(v));
  form.append("file", new Blob([new Uint8Array(input.file.bytes)], { type: input.file.contentType }), input.file.name);
  const uploaded = await http.request(uploadUrl, { method: "POST", body: form });
  trace?.("upload", uploaded.status);
  // 3. Confirm: a redirect (or a 201 naming a location without the file) must be followed so Canvas marks the file ready.
  let fileJson: Json;
  const location = uploaded.headers.get("location");
  if (uploaded.status >= 300 && uploaded.status < 400) {
    await uploaded.body?.cancel().catch(() => undefined);
    const confirmed = await http.request(location ?? fail("SOURCE_CHANGED", "업로드 확인 주소가 없습니다."), { method: "GET" });
    trace?.("confirm_upload", confirmed.status);
    fileJson = await json(confirmed, "파일 올리기 확인");
  } else {
    if (uploaded.status === 401 || uploaded.status === 403) fail("AUTH_REQUIRED", "업로드 서버가 파일을 받지 않았습니다(권한). 다시 시도하세요.", true);
    fileJson = await json(uploaded, "파일 올리기");
    const next = str(fileJson.location) ?? location;
    if (fileJson.id === undefined && next) {
      const confirmed = await http.request(next, { method: "GET" });
      trace?.("confirm_upload", confirmed.status);
      fileJson = await json(confirmed, "파일 올리기 확인");
    }
  }
  const fileId = String(fileJson.id ?? "");
  if (!ID.test(fileId)) fail("SOURCE_CHANGED", "올린 파일 번호를 받지 못했습니다.");
  // 4. The submission.
  const submitted = await http.request(`${base}/submissions`, { method: "POST", body: new URLSearchParams({ "submission[submission_type]": "online_upload", "submission[file_ids][]": fileId }) });
  trace?.("submit", submitted.status);
  await json(submitted, "제출");
  const after = await readAssignment(http, input.courseId, input.assignmentId);
  trace?.("verify", (after.submission.attempt ?? 0) > (input.before.submission.attempt ?? 0) ? 200 : 0);
  if ((after.submission.attempt ?? 0) <= (input.before.submission.attempt ?? 0)) fail("SOURCE_CHANGED", "LMS에서 새 제출을 확인하지 못했습니다. LMS에서 상태를 확인하세요.");
  return { attempt: after.submission.attempt, submittedAt: after.submission.submittedAt, files: after.submission.files };
}
