import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { locateDocker } from '@learningxxx/app-modifier';
import type { IpcResponse } from '@learningxxx/contracts';

type Run = (file: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; pathEntries?: string[] }) => Promise<string>;
interface Media {
  duration(input: { path: string; signal: AbortSignal }): Promise<number>;
  render(input: { directory: string; duration: number; signal: AbortSignal }): Promise<string>;
}
interface Helpers { runProgram: Run; assertFile(path: string, signature?: string): Promise<void>; createMediaRuntime(options: { node: string; hyperframes: string; ffprobe: string }): Media }
const IMAGE = 'learningxxx-artifact-pdf:1';
const fail: (message: string) => never = message => { throw Object.assign(new Error(message), { appError: { code: 'INVALID_REQUEST', message, retryable: false } }); };
const first = (paths: string[]) => paths.find(p => existsSync(p));

/** Fixed local programs; no model/renderer command, environment or image names. */
export class ArtifactRuntimes {
  #engineRoot: string; #hostRoot: string; #browserReady = false; #stopped = false;
  #setup: { which: 'video' | 'pptx'; abort: AbortController; work: Promise<void> } | undefined;
  #cached: { at: number; value: IpcResponse<'artifacts.runtime'> } | undefined;
  constructor(engineRoot: string, hostRoot: string) { this.#engineRoot = engineRoot; this.#hostRoot = hostRoot; }
  async #helpers() { return await import(pathToFileURL(join(this.#engineRoot, 'src/runtime.mjs')).href) as Helpers; }
  #tools() {
    const node = first([join(homedir(), `.local/share/learningxxx/node-v24.22.2-darwin-${process.arch}/bin/node`), '/opt/homebrew/bin/node', '/usr/local/bin/node']);
    const ffprobe = first(['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe']);
    const ffmpeg = first(['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']);
    const hyperframes = join(this.#engineRoot, 'node_modules/hyperframes/bin/hyperframes.mjs');
    const browser = this.#browserReady || existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    return { node, ffprobe, ffmpeg, hyperframes, browser, docker: locateDocker() };
  }
  #videoTools() {
    const t = this.#tools();
    if (!t.node || !t.ffprobe || !t.ffmpeg || !existsSync(t.hyperframes)) fail('영상 출력 도구가 필요합니다. Node·FFmpeg와 앱 의존성을 준비한 뒤 다시 시도하세요.');
    return { node: t.node, ffprobe: t.ffprobe, hyperframes: t.hyperframes };
  }
  async status(): Promise<IpcResponse<'artifacts.runtime'>> {
    if (this.#cached && Date.now() - this.#cached.at < 10_000 && !this.#setup) return this.#cached.value;
    const t = this.#tools(), { runProgram } = await this.#helpers();
    let pptx = false;
    if (t.docker) try { await runProgram(t.docker, ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], { timeoutMs: 10_000 }); pptx = true; } catch { /* Missing Docker/image is a preflight state, never a paid retry. */ }
    const video = !!(t.node && t.ffprobe && t.ffmpeg && existsSync(t.hyperframes) && t.browser);
    const value = { video, pptx, preparing: !!this.#setup, message: this.#setup ? '로컬 출력 도구를 준비하고 있습니다…' : video && pptx ? '영상·PPT PDF 출력 도구가 준비됐습니다.' : '필요한 로컬 출력 도구를 준비한 뒤 파일 만들기를 선택하세요. 도구 준비에는 음성 API를 호출하지 않습니다.' };
    this.#cached = { at: Date.now(), value }; return value;
  }
  async setup(which: 'video' | 'pptx') {
    if (this.#stopped) fail('앱 종료 중입니다.');
    if (this.#setup) return this.status();
    const abort = new AbortController();
    const work = Promise.resolve().then(async () => {
      const { runProgram } = await this.#helpers();
      if (which === 'video') {
        const t = this.#videoTools();
        await runProgram(t.node, [t.hyperframes, 'browser', 'ensure'], { signal: abort.signal, timeoutMs: 10 * 60_000, pathEntries: [dirname(t.node), dirname(t.ffprobe)] });
        this.#browserReady = true;
      } else {
        const docker = this.#tools().docker; if (!docker) fail('PPT PDF 출력 도구 준비에는 실행 중인 Docker Desktop이 필요합니다.');
        const context = join(this.#hostRoot, 'runtime');
        await runProgram(docker, ['build', '-f', join(context, 'LibreOffice.Dockerfile'), '-t', IMAGE, context], { signal: abort.signal, timeoutMs: 15 * 60_000 });
      }
    }).finally(() => { this.#setup = undefined; this.#cached = undefined; });
    this.#setup = { which, abort, work };
    try { await work; } catch { fail('출력 도구를 준비하지 못했습니다. 연결과 Docker 상태를 확인한 뒤 직접 다시 시도하세요.'); }
    return this.status();
  }
  async preflight(kind: 'video' | 'slides', signal: AbortSignal) {
    signal.throwIfAborted(); if (this.#stopped || this.#setup) fail('진행 중인 도구 준비를 마친 뒤 다시 시도하세요.');
    const { runProgram } = await this.#helpers();
    if (kind === 'video') {
      const t = this.#videoTools();
      // Do this before any TTS request. A missing browser must not waste narration credits.
      await runProgram(t.node, [t.hyperframes, 'browser', 'path'], { signal, timeoutMs: 120_000, pathEntries: [dirname(t.node), dirname(t.ffprobe)] });
      await runProgram(t.ffprobe, ['-version'], { signal, timeoutMs: 10_000 }); this.#browserReady = true;
    } else {
      const docker = this.#tools().docker; if (!docker) fail('PPT PDF 출력 도구를 먼저 준비하세요.');
      try { await runProgram(docker, ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], { signal, timeoutMs: 10_000 }); }
      catch { signal.throwIfAborted(); fail('PPT PDF 출력 도구를 먼저 준비하세요.'); }
    }
    signal.throwIfAborted();
  }
  async duration(input: { path: string; signal: AbortSignal }) { return (await this.#helpers()).createMediaRuntime(this.#videoTools()).duration(input); }
  async render(input: { directory: string; duration: number; signal: AbortSignal }) { return (await this.#helpers()).createMediaRuntime(this.#videoTools()).render(input); }
  async pptxPdf({ path, directory, signal }: { path: string; directory: string; signal: AbortSignal }) {
    if (path !== join(directory, 'draft.pptx') || /[,\r\n]/.test(directory)) fail('PPT 출력 경로가 올바르지 않습니다.');
    await this.preflight('slides', signal);
    const docker = this.#tools().docker!;
    const { runProgram, assertFile } = await this.#helpers(), name = `learningxxx-pptx-${randomUUID()}`;
    await mkdir(join(directory, 'pdf'), { mode: 0o700 });
    try {
      await runProgram(docker, ['run', '--rm', '--pull=never', '--name', name, '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,size=256m', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--env', 'HOME=/tmp', '--mount', `type=bind,src=${directory},dst=/work`, IMAGE,
        '/usr/bin/soffice', '-env:UserInstallation=file:///tmp/lo-profile', '--headless', '--convert-to', 'pdf', '--outdir', '/work/pdf', '/work/draft.pptx'], { signal, timeoutMs: 5 * 60_000 });
    } finally {
      // Killing the Docker CLI alone does not stop its daemon-owned container.
      await runProgram(docker, ['rm', '--force', name], { timeoutMs: 10_000 }).catch(() => undefined);
    }
    signal.throwIfAborted(); const file = join(directory, 'pdf/draft.pdf'); await assertFile(file, '%PDF-'); return file;
  }
  async stop() { this.#stopped = true; this.#setup?.abort.abort(); await this.#setup?.work.catch(() => undefined); }
}
