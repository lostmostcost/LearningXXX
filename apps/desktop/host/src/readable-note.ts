import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "@learningxxx/contracts";
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
 * WBS-069: makes a readable note with the official Claude Code (the user's
 * subscription login), in an independent session: the most restricted mode
 * (read-only tools, no MCP, no slash commands) with an empty working folder,
 * so the run can only answer in text.
 */
export function createReadableRunner(startCli: StartCli, root: string, newId: () => string = randomUUID) {
  return async ({ text, title, signal }: { title: string; text: string; signal: AbortSignal }): Promise<string> => {
    const id = newId();
    const workspace = join(root, id);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, TIME_LIMIT_MS);
    try {
      const outcome = await startCli({ runId: newId(), appSessionId: id, mode: "independent", cliSessionId: newId(), resume: false, workspacePath: workspace, prompt: readablePrompt(title, text) }, abort.signal);
      if (!outcome.ok) throw Object.assign(new Error(outcome.error.message), { appError: outcome.error });
      let note = "";
      for await (const event of outcome.events) {
        if (event.type === "text.delta") note = (note + event.payload.text).slice(0, MAX_NOTE);
        else if (event.type === "run.failed") throw Object.assign(new Error(event.payload.error.message), { appError: event.payload.error });
        else if (event.type === "run.cancelled") throw Object.assign(new Error("cancelled"), { appError: AppError.parse({ code: "RUN_INTERRUPTED", message: abort.signal.aborted && !signal.aborted ? "정리본 만들기가 10분 안에 끝나지 않아 멈췄습니다." : "정리본 만들기를 멈췄습니다.", retryable: true }) });
        else if (event.type === "run.completed") return note;
      }
      throw Object.assign(new Error("interrupted"), { appError: AppError.parse({ code: "RUN_INTERRUPTED", message: "정리본을 끝까지 받지 못했습니다. 다시 시도하세요.", retryable: true }) });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
