import { AppError } from "@learningxxx/contracts";

/**
 * WBS-058: hands in a file for a Canvas assignment the way the LMS web page
 * does — ask for an upload slot, upload the file, then make the submission —
 * only after the student confirmed it (or a rule they confirmed fires).
 * Before anything is sent the assignment is read again: file upload must be
 * allowed, the extension accepted, the assignment open and not locked. After
 * any failure the LMS state is read before trying again, so one request never
 * becomes two submissions.
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

function fail(code: "INVALID_REQUEST" | "AUTH_REQUIRED" | "NOT_FOUND" | "SOURCE_CHANGED" | "INTERNAL", message: string, retryable = false): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable }) });
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

async function json(response: Response, what: string): Promise<Json> {
  if (response.status === 401 || response.status === 403) fail("AUTH_REQUIRED", "학교 로그인이 필요합니다. 로그인한 뒤 다시 제출하세요.");
  if (response.status === 404) fail("NOT_FOUND", "LMS에서 과제를 찾지 못했습니다.");
  if (!response.ok) fail("INTERNAL", `${what} 중 LMS가 ${response.status}로 답했습니다.`, true);
  return obj(await response.json().catch(() => fail("SOURCE_CHANGED", `${what} 응답을 읽지 못했습니다.`)));
}

const ID = /^\d{1,20}$/;
const path = (courseId: string, assignmentId: string) => {
  if (!ID.test(courseId) || !ID.test(assignmentId)) fail("INVALID_REQUEST", "잘못된 과제 번호입니다.");
  return `/api/v1/courses/${courseId}/assignments/${assignmentId}`;
};

/** The assignment as Canvas sees it now, with this student's submission. */
export async function readAssignment(http: CanvasHttp, courseId: string, assignmentId: string): Promise<AssignmentCheck> {
  const a = await json(await http.request(`${path(courseId, assignmentId)}?include[]=submission`, { method: "GET" }), "과제 확인");
  const s = obj(a.submission);
  return {
    id: String(a.id), name: str(a.name) ?? "과제", dueAt: str(a.due_at), lockAt: str(a.lock_at), unlockAt: str(a.unlock_at),
    types: (Array.isArray(a.submission_types) ? a.submission_types : []).map(String),
    extensions: (Array.isArray(a.allowed_extensions) ? a.allowed_extensions : []).map((x) => String(x).toLowerCase()),
    lockedForUser: a.locked_for_user === true, allowedAttempts: typeof a.allowed_attempts === "number" && a.allowed_attempts > 0 ? a.allowed_attempts : null,
    submission: {
      state: str(s.workflow_state) ?? "unsubmitted", attempt: typeof s.attempt === "number" ? s.attempt : null, submittedAt: str(s.submitted_at),
      files: (Array.isArray(s.attachments) ? s.attachments : []).map((f) => str(obj(f).display_name) ?? "파일"),
    },
  };
}

/** Why a file cannot be handed in now, or undefined when it can. */
export function cannotSubmit(a: AssignmentCheck, fileName: string, now: Date): string | undefined {
  const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
  if (!a.types.includes("online_upload")) return "이 과제는 파일 제출을 받지 않습니다(LMS에서 직접 제출하세요).";
  if (a.lockedForUser) return "LMS가 이 과제를 잠가 두었습니다.";
  if (a.unlockAt && Date.parse(a.unlockAt) > now.getTime()) return "아직 제출 기간이 아닙니다.";
  if (a.lockAt && Date.parse(a.lockAt) <= now.getTime()) return "제출 기간이 끝났습니다.";
  if (a.extensions.length && !a.extensions.includes(ext)) return `허용된 형식이 아닙니다(${a.extensions.join(", ")}).`;
  if (a.allowedAttempts !== null && (a.submission.attempt ?? 0) >= a.allowedAttempts) return "제출 가능 횟수를 모두 썼습니다.";
  return undefined;
}

export interface SubmitResult { attempt: number | null; submittedAt: string | null; files: string[] }

/**
 * Uploads one file and submits it. `before` is the submission read when the
 * student confirmed; if the LMS shows a newer attempt than that, the work is
 * already done and nothing is sent again.
 */
export async function submitFile(http: CanvasHttp, input: { courseId: string; assignmentId: string; file: { name: string; bytes: Uint8Array; contentType: string }; before: AssignmentCheck; now?: Date }): Promise<SubmitResult> {
  const base = path(input.courseId, input.assignmentId);
  const current = await readAssignment(http, input.courseId, input.assignmentId);
  if ((current.submission.attempt ?? 0) > (input.before.submission.attempt ?? 0)) {
    return { attempt: current.submission.attempt, submittedAt: current.submission.submittedAt, files: current.submission.files };
  }
  const problem = cannotSubmit(current, input.file.name, input.now ?? new Date());
  if (problem) fail("INVALID_REQUEST", problem);
  // 1. Upload slot.
  const slot = await json(await http.request(`${base}/submissions/self/files`, { method: "POST", body: new URLSearchParams({ name: input.file.name, size: String(input.file.bytes.byteLength), content_type: input.file.contentType, on_duplicate: "rename" }) }), "업로드 준비");
  const uploadUrl = str(slot.upload_url) ?? fail("SOURCE_CHANGED", "LMS가 업로드 주소를 주지 않았습니다.");
  // 2. The file, with the fields Canvas asked for first.
  const form = new FormData();
  for (const [k, v] of Object.entries(obj(slot.upload_params))) form.append(k, String(v));
  form.append("file", new Blob([new Uint8Array(input.file.bytes)], { type: input.file.contentType }), input.file.name);
  let uploaded = await http.request(uploadUrl, { method: "POST", body: form });
  if (uploaded.status >= 300 && uploaded.status < 400) {
    const next = uploaded.headers.get("location") ?? fail("SOURCE_CHANGED", "업로드 확인 주소가 없습니다.");
    uploaded = await http.request(next, { method: "GET" });
  }
  const fileId = str(String((await json(uploaded, "파일 올리기")).id ?? "")) ?? fail("SOURCE_CHANGED", "올린 파일 번호를 받지 못했습니다.");
  if (!ID.test(fileId)) fail("SOURCE_CHANGED", "올린 파일 번호가 이상합니다.");
  // 3. The submission.
  await json(await http.request(`${base}/submissions`, { method: "POST", body: new URLSearchParams({ "submission[submission_type]": "online_upload", "submission[file_ids][]": fileId }) }), "제출");
  const after = await readAssignment(http, input.courseId, input.assignmentId);
  if ((after.submission.attempt ?? 0) <= (input.before.submission.attempt ?? 0)) fail("SOURCE_CHANGED", "LMS에서 새 제출을 확인하지 못했습니다. LMS에서 상태를 확인하세요.");
  return { attempt: after.submission.attempt, submittedAt: after.submission.submittedAt, files: after.submission.files };
}
