import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { childEnv, locateCli, probeCli } from '@learningxxx/cli-adapter';
import type { Session } from '@learningxxx/contracts';

type Disposable = { dispose(): void };
export interface Pty {
  pid: number; write(data: string): void; resize(cols: number, rows: number): void; kill(signal?: string): void;
  onData(callback: (data: string) => void): Disposable;
  onExit(callback: (event: { exitCode: number }) => void): Disposable;
}
export type SpawnPty = (file: string, args: string[], options: { cwd: string; env: Record<string, string>; cols: number; rows: number; name: string }) => Promise<Pty>;
interface Entry { id: string; session: string; pty: Pty; chunks: { seq: number; data: string }[]; seq: number; bytes: number; clippedSeq: number; state: 'running' | 'exited'; exitCode?: number; closing: boolean; subscriptions: Disposable[] }
export interface TerminalOptions {
  hookPath?: string;
  root: string; getSession: (id: string) => Session; env?: NodeJS.ProcessEnv;
  prepare?: () => Promise<{ path: string; env: Record<string, string> }>;
  spawn?: SpawnPty; stopGroup?: (pty: Pty) => void;
}
const MAX_BUFFER = 512_000;
const fail = (message: string): never => { throw Object.assign(new Error(message), { appError: { code: 'INVALID_REQUEST', message, retryable: false } }); };
export class NativeTerminalService {
  #options: TerminalOptions;
  #entries = new Map<string, Entry>();
  #sessions = new Map<string, string>();
  #opening = new Map<string, Promise<{ terminalId: string }>>();
  #closing = false;
  constructor(options: TerminalOptions) { this.#options = options; }
  async open(request: { appSessionId: string; cols: number; rows: number }) {
    const session = this.#options.getSession(request.appSessionId);
    if (session.engine !== 'native') fail('기존 채팅 기록입니다. 새 Claude Code 대화를 만드세요.');
    if (session.archivedAt || session.status === 'running') fail('보관되었거나 기존 채팅에서 실행 중인 세션입니다.');
    if (this.#closing) fail('앱을 종료하는 중입니다.');
    const existing = this.#entries.get(this.#sessions.get(session.appSessionId) ?? '');
    if (existing?.closing && existing.state === 'running') fail('Claude Code를 종료하는 중입니다. 잠시 후 다시 연결하세요.');
    if (existing?.state === 'running') return { terminalId: existing.id };
    const pending = this.#opening.get(session.appSessionId);
    if (pending) return pending;
    const work = this.#start(session.appSessionId, request.cols, request.rows);
    this.#opening.set(session.appSessionId, work);
    try { return await work; } finally { this.#opening.delete(session.appSessionId); }
  }
  async #start(appSessionId: string, cols: number, rows: number) {
    if ([...this.#entries.values()].filter(e => e.state === 'running').length + this.#opening.size >= 8) fail('열린 Claude Code가 많습니다. 사용하지 않는 세션을 종료하세요.');
    const prepared = this.#options.prepare ? await this.#options.prepare() : await this.#prepare();
    if (this.#closing) fail('앱을 종료하는 중입니다.');
    // The renderer supplies a session ID, never executable paths, flags, cwd or environment.
    if (!/^[0-9a-f-]{36}$/i.test(appSessionId)) fail('잘못된 세션입니다.');
    mkdirSync(this.#options.root, { recursive: true });
    const root = realpathSync(this.#options.root), cwd = join(root, appSessionId);
    mkdirSync(cwd, { recursive: true });
    const real = realpathSync(cwd), inside = relative(root, real);
    if (inside.startsWith('..') || isAbsolute(inside)) fail('세션 폴더 경계를 벗어났습니다.');
    const marker = join(real, '.learningxxx-started');
    let saved: { sessionId?: unknown; transcriptPath?: unknown } = {};
    const sessionFile = join(real, '.learningxxx-session.json');
    try { saved = JSON.parse(readFileSync(sessionFile, 'utf8')); } catch { /* no saved session */ }
    const mapped = typeof saved.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(saved.sessionId);
    const resumable = mapped && typeof saved.transcriptPath === 'string' && saved.transcriptPath.endsWith(`/${saved.sessionId}.jsonl`) && existsSync(saved.transcriptPath);
    const args = resumable ? ['--resume', saved.sessionId as string] : mapped ? [] : existsSync(marker) ? ['--continue'] : [];
    args.push('--permission-mode', 'default');
    if (this.#options.hookPath) {
      const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      const command = `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(this.#options.hookPath)} ${quote(sessionFile)}`;
      args.push('--settings', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command, timeout: 5 }] }] } }));
    }
    if (this.#options.getSession(appSessionId).archivedAt || this.#options.getSession(appSessionId).status === 'running') fail('기존 채팅이 실행 중입니다.');
    const spawn = this.#options.spawn ?? (async (file, args, options) => (await import('node-pty')).spawn(file, args, options));
    let pty: Pty | undefined;
    try { pty = await spawn(prepared.path, args, { cwd: real, env: prepared.env, cols, rows, name: 'xterm-256color' }); }
    catch { fail('Claude Code 터미널을 시작하지 못했습니다. Mac 터미널 모듈 설치 상태를 확인하세요.'); }
    if (!pty) return fail('터미널 연결을 만들지 못했습니다.');
    if (this.#closing || this.#options.getSession(appSessionId).archivedAt) { this.#stop(pty); fail('앱을 종료하는 중입니다.'); }
    if (this.#entries.size >= 16) {
      for (const [key, old] of this.#entries) if (old.state === 'exited') { this.#entries.delete(key); this.#sessions.delete(old.session); if (this.#entries.size < 16) break; }
    }
    const entry: Entry = { id: randomUUID(), session: appSessionId, pty, chunks: [], seq: 0, bytes: 0, clippedSeq: 0, state: 'running', closing: false, subscriptions: [] };
    if (this.#sessions.has(appSessionId)) this.#entries.delete(this.#sessions.get(appSessionId)!);
    this.#entries.set(entry.id, entry); this.#sessions.set(appSessionId, entry.id);
    entry.subscriptions.push(pty.onData(data => {
      // Bound replay memory, including a single unexpectedly large output event.
      const clipped = data.length > MAX_BUFFER ? data.slice(-MAX_BUFFER) : data;
      entry.chunks.push({ seq: ++entry.seq, data: clipped }); entry.bytes += clipped.length;
      if (clipped.length !== data.length) entry.clippedSeq = entry.seq;
      while (entry.bytes > MAX_BUFFER && entry.chunks.length > 1) entry.bytes -= entry.chunks.shift()!.data.length;
    }));
    entry.subscriptions.push(pty.onExit(({ exitCode }) => { entry.state = 'exited'; entry.exitCode = exitCode; entry.subscriptions.forEach(s => s.dispose()); entry.subscriptions = []; }));
    try { writeFileSync(marker, 'Native Claude history belongs to the CLI; continue only in this directory.\n', { mode: 0o600 }); }
    catch { this.close({ terminalId: entry.id }); fail('세션 재개 정보를 저장하지 못했습니다.'); }
    return { terminalId: entry.id };
  }
  async #prepare() {
    const env = this.#options.env ?? process.env, located = locateCli(env, homedir());
    if (!located.ok) throw Object.assign(new Error(located.error.message), { appError: located.error });
    const checked = await probeCli(located.path, env);
    if (!checked.ok) throw Object.assign(new Error(checked.error.message), { appError: checked.error });
    return { path: located.path, env: Object.fromEntries(Object.entries(childEnv(env)).filter((pair): pair is [string, string] => pair[1] !== undefined)) };
  }
  #entry(id: string) { const entry = this.#entries.get(id); if (!entry) return fail('터미널이 종료되었거나 앱이 다시 시작됐습니다. 다시 연결하세요.'); this.#options.getSession(entry.session); return entry; }
  read({ terminalId, after }: { terminalId: string; after: number }) {
    const e = this.#entry(terminalId), first = e.chunks[0]?.seq ?? e.seq + 1;
    return { chunks: e.chunks.filter(c => c.seq > after), state: e.state, gap: after < first - 1 || after < e.clippedSeq, ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}) };
  }
  write({ terminalId, data }: { terminalId: string; data: string }) { const e = this.#entry(terminalId); if (e.state !== 'running' || e.closing) fail('종료된 터미널입니다. 다시 연결하세요.'); e.pty.write(data); return {}; }
  resize({ terminalId, cols, rows }: { terminalId: string; cols: number; rows: number }) { const e = this.#entry(terminalId); if (e.state === 'running') e.pty.resize(cols, rows); return {}; }
  #stop(pty: Pty) {
    if (this.#options.stopGroup) return this.#options.stopGroup(pty);
    try { process.kill(-pty.pid, 'SIGHUP'); } catch { try { pty.kill(); } catch { /* already exited */ } }
  }
  close({ terminalId }: { terminalId: string }) { const e = this.#entry(terminalId); if (e.state === 'running' && !e.closing) { e.closing = true; this.#stop(e.pty); } return {}; }
  isActive(appSessionId: string) { return this.#opening.has(appSessionId) || this.#entries.get(this.#sessions.get(appSessionId) ?? '')?.state === 'running'; }
  stopSession(appSessionId: string) { const id = this.#sessions.get(appSessionId); if (id) this.close({ terminalId: id }); }
  async stopAll() {
    this.#closing = true;
    for (const e of this.#entries.values()) if (e.state === 'running') this.close({ terminalId: e.id });
    const deadline = Date.now() + 1200;
    while ([...this.#entries.values()].some(e => e.state === 'running') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    for (const e of this.#entries.values()) if (e.state === 'running') {
      if (this.#options.stopGroup) this.#options.stopGroup(e.pty);
      else { try { process.kill(-e.pty.pid, 'SIGKILL'); } catch { try { e.pty.kill('SIGKILL'); } catch { /* already gone */ } } }
    }
  }
}
