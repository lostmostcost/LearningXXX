import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { AppError, MentionCandidate } from "@learningxxx/contracts";
import type { StartCli } from "./session-service.ts";

/** Longest note kept; a lecture note is far shorter. */
const MAX_NOTE = 300_000;
/** A run that takes longer than this is stopped. */
const TIME_LIMIT_MS = 10 * 60_000;

/** The request to the CLI. The transcript itself goes in the prompt (stdin), never as a file the CLI could change. */
export function readablePrompt(title: string, text: string): string {
  return [
    "다음은 강의를 자동으로 받아 적은 전사문입니다. 내용을 더하거나 빼지 말고, 읽기 쉬운 강의 정리본으로 다듬어 주세요.",
    "",
    "규칙:",
    "- Markdown만 출력합니다(앞뒤 설명 없이).",
    "- 주제가 바뀌는 곳에 소제목(##)을 두고, 문단마다 시작 시각 [mm:ss]를 앞에 붙입니다.",
    "- 말버릇·반복·끊긴 말은 정리하되 강의 내용과 순서는 그대로 둡니다.",
    "- 문맥상 명백한 인식 오류만 고치고, 확실하지 않은 단어는 원문 그대로 두고 뒤에 (?)를 붙입니다.",
    "- 과제·시험·제출에 대한 언급은 빠뜨리지 않습니다.",
    "",
    `강의: ${title}`,
    "",
    "전사문:",
    text,
  ].join("\n");
}

/**
 * WBS-069/070: one answer in text from the official Claude Code (the user's
 * subscription login), in an independent session: the most restricted mode
 * (read-only tools, no MCP, no slash commands) with an empty working folder,
 * so the run can only answer. `what` names the job in messages.
 */
export function createClaudeTextRunner(startCli: StartCli, root: string, newId: () => string = randomUUID) {
  return async ({ prompt, what, signal }: { prompt: string; what: string; signal: AbortSignal }): Promise<string> => {
    const id = newId();
    const workspace = join(root, id);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, TIME_LIMIT_MS);
    try {
      const outcome = await startCli({ runId: newId(), appSessionId: id, mode: "independent", cliSessionId: newId(), resume: false, workspacePath: workspace, prompt }, abort.signal);
      if (!outcome.ok) throw Object.assign(new Error(outcome.error.message), { appError: outcome.error });
      let answer = "";
      for await (const event of outcome.events) {
        if (event.type === "text.delta") answer = (answer + event.payload.text).slice(0, MAX_NOTE);
        else if (event.type === "run.failed") throw Object.assign(new Error(event.payload.error.message), { appError: event.payload.error });
        else if (event.type === "run.cancelled") throw Object.assign(new Error("cancelled"), { appError: AppError.parse({ code: "RUN_INTERRUPTED", message: abort.signal.aborted && !signal.aborted ? `${what}가 10분 안에 끝나지 않아 멈췄습니다.` : `${what}를 멈췄습니다.`, retryable: true }) });
        else if (event.type === "run.completed") return answer;
      }
      throw Object.assign(new Error("interrupted"), { appError: AppError.parse({ code: "RUN_INTERRUPTED", message: `${what} 결과를 끝까지 받지 못했습니다. 다시 시도하세요.`, retryable: true }) });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

/** WBS-069: a readable note of a transcript. */
export function createReadableRunner(startCli: StartCli, root: string, newId: () => string = randomUUID) {
  const run = createClaudeTextRunner(startCli, root, newId);
  return ({ text, title, signal }: { title: string; text: string; signal: AbortSignal }) => run({ prompt: readablePrompt(title, text), what: "정리본 만들기", signal });
}

/** WBS-070: the request for assignment/exam announcements. Only JSON comes back. */
export function mentionsPrompt(title: string, text: string): string {
  return [
    "다음은 강의 전사문입니다. 강의자가 과제·시험·퀴즈·제출·발표 등 학생이 해야 할 일이나 일정에 대해 말한 부분만 찾아 주세요.",
    "",
    "JSON 배열 하나만 출력합니다(앞뒤 설명·코드 블록 없이). 없으면 [] 입니다. 각 항목:",
    '{"kind": "assignment" | "exam" | "other", "title": "짧은 제목", "detail": "무엇을 어떻게 하는지 한두 문장", "due": "말한 마감·날짜(없으면 생략)", "at": "그 말이 나온 시각 mm:ss"}',
    "",
    "- 전사문에 실제로 있는 말만, 추측하지 않습니다. 같은 일을 여러 번 말했으면 하나로, 시각은 가장 자세히 말한 곳.",
    "",
    `강의: ${title}`,
    "",
    "전사문:",
    text,
  ].join("\n");
}

/**
 * WBS-070: the model's answer → candidates. Anything that is not a valid item
 * is dropped. The time is snapped to the transcript segment it falls in, and
 * the quote is that segment's own text, so the evidence never comes from the
 * model.
 */
export function parseMentions(answer: string, transcript: { id: string; segments: readonly { startMs: number; endMs: number; text: string }[] }): MentionCandidate[] {
  const from = answer.indexOf("["), to = answer.lastIndexOf("]");
  if (from < 0 || to <= from) return [];
  let raw: unknown;
  try { raw = JSON.parse(answer.slice(from, to + 1)); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: MentionCandidate[] = [];
  for (const entry of raw.slice(0, 50)) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const m = typeof e.at === "string" ? /^(\d{1,3}):(\d{2})(?::(\d{2}))?$/.exec(e.at.trim()) : null;
    if (!m) continue;
    const ms = (m[3] !== undefined ? (+m[1]! * 3600 + +m[2]! * 60 + +m[3]) : (+m[1]! * 60 + +m[2]!)) * 1000;
    const segment = transcript.segments.find((s) => s.startMs <= ms && ms < Math.max(s.endMs, s.startMs + 1000)) ?? transcript.segments.toSorted((a, b) => Math.abs(a.startMs - ms) - Math.abs(b.startMs - ms))[0];
    if (!segment || Math.abs(segment.startMs - ms) > 60_000 && !(segment.startMs <= ms && ms <= segment.endMs)) continue;
    const parsed = MentionCandidate.safeParse({
      kind: e.kind, title: typeof e.title === "string" ? e.title.slice(0, 200) : e.title, detail: typeof e.detail === "string" ? e.detail.slice(0, 2000) : "",
      ...(typeof e.due === "string" && e.due.trim() ? { due: e.due.trim().slice(0, 200) } : {}),
      transcriptId: transcript.id, startMs: segment.startMs, quote: segment.text.slice(0, 1000),
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
