import { accessSync, constants } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { EngineError } from '@learningxxx/transcriber';
import type { IpcResponse } from '@learningxxx/contracts';
type Status = IpcResponse<'stt.status'>;
interface Options { root: string; source: string; model: string; supported?: boolean; onReady?: () => Promise<void>; probe?: () => Promise<boolean>; install?: (signal: AbortSignal, stage: (value: string) => void) => Promise<void> }
const setupErrors: Record<string, string> = { python: 'Python 실행 환경이 없습니다. 터미널에서 brew install uv 후 엔진을 다시 준비해 주세요.' };
const stages: Record<string, string> = { environment: '실행 환경 준비 중', dependencies: '전사 프로그램 설치 중', models: '음성 모델 준비 중 · 처음에는 시간이 걸립니다', verify: '전사 엔진 확인 중' };
export class SttRuntimeService {
  #o: Options; #state: Status = { state: 'missing', message: '전사 엔진을 준비해 주세요.' }; #checked = 0;
  #probeTask: Promise<Status> | undefined; #installTask: Promise<void> | undefined; #abort: AbortController | undefined; #closing = false; #active = 0;
  constructor(options: Options) { this.#o = options; }
  async status(refresh = false): Promise<Status> {
    if (!(this.#o.supported ?? (process.platform === 'darwin' && process.arch === 'arm64'))) return { state: 'unsupported', message: '로컬 전사는 Apple Silicon Mac에서 지원합니다.' };
    if (this.#installTask || !refresh && Date.now() - this.#checked < 30_000) return { ...this.#state };
    if (this.#probeTask) return this.#probeTask;
    const work = (async () => {
      let ready = false;
      try { ready = await (this.#o.probe?.() ?? this.#probe()); } catch { /* Not installed/usable. */ }
      if (!this.#installTask) { this.#state = ready ? { state: 'ready', message: '이 Mac에서 자동 전사할 준비가 됐습니다.' } : { state: 'missing', message: '전사 엔진 또는 음성 모델 준비가 필요합니다.' }; this.#checked = Date.now(); }
      return { ...this.#state };
    })();
    this.#probeTask = work;
    try { return await work; } finally { if (this.#probeTask === work) this.#probeTask = undefined; }
  }
  async #probe() {
    const python = join(this.#o.root, '.venv/bin/python'); accessSync(python, constants.X_OK);
    const { stdout } = await promisify(execFile)(python, ['-I', join(this.#o.source, 'python/runtime.py'), '--home', join(this.#o.root, 'hf'), '--model', this.#o.model], { env: this.#env(), timeout: 30_000, maxBuffer: 65536 });
    return JSON.parse(stdout).ready === true;
  }
  #env() { return { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '', HF_HUB_DISABLE_TELEMETRY: '1', PYTHONUNBUFFERED: '1' }; }
  async requireReady() {
    if (this.#closing || (await this.status(true)).state !== 'ready' || this.#closing) throw new EngineError('ENGINE_UNAVAILABLE', '전사 탭에서 엔진 준비를 먼저 완료해 주세요.', false);
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.#active++;
    try { await this.requireReady(); return await work(); } finally { this.#active--; }
  }
  async prepare(): Promise<Status> {
    if (this.#closing) throw new Error('App closing');
    if (this.#installTask) return { ...this.#state };
    if ((await this.status()).state === 'unsupported') return { ...this.#state, state: 'unsupported', message: 'Apple Silicon Mac이 필요합니다.' };
    if (this.#closing) throw new Error("App closing");
    if (this.#active) throw Object.assign(new Error('전사가 끝난 뒤 엔진을 복구해 주세요.'), { appError: { code: 'INVALID_REQUEST', message: '전사가 끝난 뒤 엔진을 복구해 주세요.', retryable: true } });
    // Recheck after asynchronous probe so double clicks cannot run two installers.
    if (this.#installTask) return { ...this.#state };
    const abort = new AbortController(); this.#abort = abort;
    this.#state = { state: 'installing', message: stages.environment! };
    const stage = (value: string) => { if (!abort.signal.aborted && stages[value]) this.#state = { state: 'installing', message: stages[value]! }; };
    const work = (async () => {
      try {
        await (this.#o.install?.(abort.signal, stage) ?? this.#install(abort.signal, stage));
        abort.signal.throwIfAborted();
        if (!await (this.#o.probe?.() ?? this.#probe())) throw new Error('Not ready');
        abort.signal.throwIfAborted(); this.#state = { state: 'ready', message: '전사 엔진이 준비됐습니다. 대기 중인 전사를 다시 시작합니다.' }; this.#checked = Date.now();
        await this.#o.onReady?.().catch(() => undefined);
      } catch (error) { const reason = (error as { setupReason?: string })?.setupReason; this.#state = { state: 'failed', message: abort.signal.aborted ? '엔진 준비를 중단했습니다. 다시 준비할 수 있습니다.' : (reason ? setupErrors[reason] : undefined) ?? '엔진 준비에 실패했습니다. 네트워크와 저장 공간을 확인한 뒤 다시 시도해 주세요.' }; this.#checked = Date.now(); }
    })();
    this.#installTask = work;
    void work.finally(() => { if (this.#installTask === work) { this.#installTask = undefined; this.#abort = undefined; } });
    return { ...this.#state };
  }
  #install(signal: AbortSignal, stage: (value: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', [join(this.#o.source, 'setup.sh'), this.#o.root, this.#o.model], { env: this.#env(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let failureReason: string | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => { try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch {} timer = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000); };
      signal.addEventListener('abort', abort, { once: true });
      createInterface({ input: child.stdout }).on('line', line => { if (line.startsWith('STT_STAGE:')) stage(line.slice(10)); if (line.startsWith('STT_ERROR:') && setupErrors[line.slice(10)]) failureReason = line.slice(10); });
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', code => { if (signal.aborted && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } clearTimeout(timer); signal.removeEventListener('abort', abort); if (code === 0 && !signal.aborted) resolve(); else reject(Object.assign(new Error('Setup failed'), { setupReason: failureReason })); });
      if (signal.aborted) abort();
    });
  }
  async cancel(): Promise<Status> { this.#abort?.abort(); await this.#installTask; return { ...this.#state }; }
  async stop() { this.#closing = true; await this.cancel(); }
}
