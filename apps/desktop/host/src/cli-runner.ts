import { homedir } from "node:os";
import { createTextCompatibility, locateCli, probeCli, startRun } from "@learningxxx/cli-adapter";
import type { StartCli } from "./session-service.ts";

/** Finds and checks the official CLI before every run, so a logout or update surfaces at once. */
export function createCliRunner(env: NodeJS.ProcessEnv = process.env, home = homedir(), textCacheRoot?: string): StartCli {
  const textCompatibility = textCacheRoot ? createTextCompatibility(textCacheRoot) : undefined;
  return async (request, signal) => {
    if (signal?.aborted) return { ok: false, error: { code: 'RUN_INTERRUPTED', message: '실행을 취소했습니다.', retryable: true } };
    const located = locateCli(env, home);
    if (!located.ok) return located;
    const probe = await probeCli(located.path, env, undefined, signal);
    if (!probe.ok) return probe;
    if (signal?.aborted) return { ok: false, error: { code: 'RUN_INTERRUPTED', message: '실행을 취소했습니다.', retryable: true } };
    if (request.profile === 'text') {
      if (!textCompatibility) return { ok: false, error: { code: 'INTERNAL', message: '텍스트 작업의 호환성 저장소가 연결되지 않았습니다.', retryable: false } };
      const checked = await textCompatibility.check(located.path, probe.probe.version, env, signal);
      if (!checked.ok) return checked;
      if (signal?.aborted) return { ok: false, error: { code: 'RUN_INTERRUPTED', message: '실행을 취소했습니다.', retryable: true } };
      if (!await textCompatibility.unchanged(checked.identity)) return { ok: false, error: { code: 'CLI_VERSION_MISMATCH', message: 'Claude Code가 실행 전에 업데이트되었습니다. 다시 시도하면 새 버전을 확인합니다.', retryable: true } };
      const invalidates = (code: string) => code === 'CLI_VERSION_MISMATCH' || code === 'ISOLATION_VIOLATION' || code === 'SCOPE_VIOLATION';
      const outcome = await startRun(request, { cliPath: checked.identity.path, env, signal, textProof: checked.proof });
      if (!outcome.ok) { if (invalidates(outcome.error.code)) await textCompatibility.invalidate(checked.identity); return outcome; }
      return { ok: true, events: (async function* () {
        for await (const event of outcome.events) {
          if (event.type === 'run.failed' && invalidates(event.payload.error.code)) await textCompatibility.invalidate(checked.identity);
          yield event;
        }
      })() };
    }
    return startRun(request, { cliPath: located.path, env, signal });
  };
}
