import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { ArtifactJob, ArtifactPlan } from '@learningxxx/contracts';
import type { ArtifactScope, CollectionManifest, IpcResponse } from '@learningxxx/contracts';
import type { AssignmentSource } from './assignment-workspaces.ts';

type Job = z.infer<typeof ArtifactJob>;
type FileKind = 'pdf' | 'pptx' | 'mp4';
export interface ArtifactEngine {
  prepare(input: unknown, options: { signal: AbortSignal; allowMissing: boolean }): Promise<{ id: string; directory: string; reviewToken: string; plan: unknown }>;
  export(id: string, token: string, options: { signal: AbortSignal }): Promise<{ directory: string; files: string[] }>;
}
interface Options {
  root: string; accountKey(): string | undefined;
  manifest(courseId: string): Promise<CollectionManifest | undefined>;
  sources(scope: ArtifactScope, manifest: CollectionManifest): Promise<AssignmentSource[]>;
  isQuiz?(scope: ArtifactScope, manifest: CollectionManifest): Promise<boolean>;
  engine(): ArtifactEngine;
  beforeExport(kind: ArtifactScope['kind'], signal: AbortSignal): Promise<void>;
  show(path: string, how: 'open' | 'reveal'): Promise<void>;
}
const RecordSchema = ArtifactJob.extend({ account: z.string(), directory: z.string().optional(), engineId: z.string().uuid().optional(), paths: z.record(z.string(), z.object({ relative: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })) });
type Record = z.infer<typeof RecordSchema>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const fail: (message: string) => never = message => { throw Object.assign(new Error(message), { appError: { code: 'INVALID_REQUEST', message, retryable: false } }); };
const inside = (root: string, path: string) => { const p = relative(root, path); return p !== '..' && !p.startsWith('../') && !isAbsolute(p); };
const explanation = (e: unknown) => {
  const error = e as { code?: string; appError?: { message: string } };
  if (error.appError) return error.appError.message;
  if (error.code === 'TOO_LARGE') return '입력 한도(전체 50만 자)를 넘습니다. 초기 입력 범위를 명시적으로 줄여 주세요.';
  if (error.code === 'MISSING_INSTRUCTIONS') return '과제 안내가 필요합니다.';
  if (error.code === 'VOICE_HTTP_400') return 'HeyGen이 선택한 음성·Starfish 엔진·한국어 조합을 거절했습니다(HTTP 400). HeyGen의 음성 지원과 현재 플랜을 확인하세요. 인증·목록 조회 성공은 음성 생성 가능을 보장하지 않으며 자동 재시도하지 않습니다.';
  if (error.code?.startsWith('VOICE_')) return 'HeyGen 음성을 생성하지 못했습니다. 키·음성·API 크레딧을 확인하세요. 과금 결과가 불확실할 수 있어 자동 재시도하지 않습니다.';
  return '생성·출력 검증을 완료하지 못했습니다. 이전 파일과 계획을 보존했으며 자동 재실행하지 않습니다.';
};

/** Host-owned scopes, exact-plan review and explicit paid export. No renderer paths. */
export class ArtifactWorkflows {
  #o: Options; #records = new Map<string, Record>(); #engines = new Map<string, ArtifactEngine>();
  #active = new Map<string, { abort: AbortController; work: Promise<void> }>();
  #courses = new Set<string>();
  #stopped = false;
  constructor(options: Options) {
    this.#o = options;
    for (const folder of [options.root, join(options.root, 'index'), join(options.root, 'outputs')]) {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      if (lstatSync(folder).isSymbolicLink()) fail('생성 결과 저장 폴더 경계가 바뀌었습니다.');
    }
    for (const name of readdirSync(join(options.root, 'index')).filter(n => /^[a-f0-9-]{36}\.json$/i.test(n))) {
      const path = join(options.root, 'index', name);
      let fd: number | undefined;
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 2_000_000) continue;
        const r = RecordSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
        if (`${r.id}.json` !== name) continue;
        if (['generating', 'needs_review', 'exporting'].includes(r.phase)) { r.phase = 'interrupted'; r.error = '앱 종료로 중단됐습니다. 보존 파일은 유지하며 모델·음성 API를 자동 재실행하지 않습니다.'; delete r.reviewToken; this.#save(r); }
        this.#records.set(r.id, r);
      } catch { /* Preserve malformed records; never infer permission from them. */ }
      finally { if (fd !== undefined) closeSync(fd); }
    }
  }
  get outputRoot() { return join(this.#o.root, 'outputs'); }
  #save(r: Record) {
    const root = this.#o.root, folder = join(root, 'index');
    if (lstatSync(root).isSymbolicLink() || lstatSync(folder).isSymbolicLink()) fail('생성 기록 폴더 경계가 바뀌었습니다.');
    const path = join(folder, `${r.id}.json`), tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(r), { flag: 'wx', mode: 0o600 }); renameSync(tmp, path);
    this.#records.set(r.id, r);
  }
  #assert(account: string, signal?: AbortSignal) { signal?.throwIfAborted(); if (this.#stopped) fail('앱 종료 중에는 새 생성을 시작할 수 없습니다.'); if (this.#o.accountKey() !== account) fail('학교 계정이 바뀌어 생성을 중단했습니다.'); }
  async #course(courseId: string) {
    const account = this.#o.accountKey(); if (!account) fail('수집된 학교 계정이 필요합니다.');
    const manifest = await this.#o.manifest(courseId);
    if (!manifest || manifest.course.id !== courseId || manifest.course.accountKey !== account) fail('현재 계정의 과목이 아닙니다.');
    this.#assert(account); return { account, manifest };
  }
  async #context(scope: ArtifactScope) {
    const c = await this.#course(scope.courseId);
    if (scope.kind === 'video' ? !scope.weekId || !!scope.assignmentId || !c.manifest.weeks.some(w => w.id === scope.weekId) : !scope.assignmentId || !!scope.weekId || !c.manifest.items.some(i => i.resource.id === scope.assignmentId && i.resource.kind === 'assignment' && !!i.body?.trim() && !/^quiz:/.test(i.resource.sourceId))) fail('주차 또는 과제 안내를 확인해 주세요.');
    if (scope.kind === 'slides' && await this.#o.isQuiz?.(scope, c.manifest)) fail('퀴즈는 LMS에서 직접 응시해 주세요.');
    this.#assert(c.account);
    return c;
  }
  async inputs(scope: ArtifactScope): Promise<IpcResponse<'artifacts.inputs'>> {
    const c = await this.#context(scope), sources = await this.#o.sources(scope, c.manifest); this.#assert(c.account);
    return { token: digest(JSON.stringify(sources)), sources: sources.map(({ text, weekId: _week, assignmentId, kind: _kind, ...s }) => ({ ...s, characters: text?.length ?? 0, required: scope.kind === 'slides' && assignmentId === scope.assignmentId })) };
  }
  #public(r: Record): Job { this.#assert(r.account); return ArtifactJob.parse(structuredClone(r)); }
  async #owned(courseId: string, id: string) {
    const c = await this.#course(courseId), r = this.#records.get(id);
    if (!r || r.account !== c.account || r.scope.courseId !== courseId) fail('이 계정·과목의 생성 결과가 아닙니다.');
    return r;
  }
  async list(courseId: string) {
    const { account } = await this.#course(courseId);
    return { jobs: [...this.#records.values()].filter(r => r.account === account && r.scope.courseId === courseId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(r => this.#public(r)) };
  }
  async state(courseId: string, id: string) { return this.#public(await this.#owned(courseId, id)); }
  #start(r: Record, work: (signal: AbortSignal) => Promise<void>) {
    this.#assert(r.account);
    const key = `${r.account}/${r.scope.courseId}`;
    if (this.#courses.has(key)) fail('이 과목에서 진행 중인 생성을 먼저 마쳐 주세요.');
    const abort = new AbortController(); this.#courses.add(key);
    const timer = setInterval(() => { if (this.#o.accountKey() !== r.account) abort.abort(); }, 100);
    // Deferring the body ensures cancellation is registered before any async work.
    const promise = Promise.resolve().then(() => work(abort.signal)).finally(() => { clearInterval(timer); this.#courses.delete(key); this.#active.delete(r.id); if (r.phase !== 'needs_review') this.#engines.delete(r.id); });
    this.#active.set(r.id, { abort, work: promise });
    void promise.catch(() => undefined);
  }
  async prepare(request: ArtifactScope & { sourceToken: string; allowMissing: boolean; includedSourceIds?: string[] | undefined }) {
    const { sourceToken, allowMissing, includedSourceIds, ...scope } = request;
    const c = await this.#context(scope);
    if (this.#courses.has(`${c.account}/${scope.courseId}`)) fail('이 과목에서 진행 중인 생성을 먼저 마쳐 주세요.');
    const r: Record = { id: randomUUID(), scope, account: c.account, createdAt: new Date().toISOString(), phase: 'generating', error: '', files: [], paths: {} };
    const engine = this.#o.engine(); this.#engines.set(r.id, engine); this.#save(r);
    this.#start(r, async signal => {
      try {
        this.#assert(c.account, signal);
        let sources = await this.#o.sources(scope, c.manifest); this.#assert(c.account, signal);
        if (digest(JSON.stringify(sources)) !== sourceToken) fail('입력 자료가 바뀌었습니다. 다시 읽고 검토 범위를 확인해 주세요.');
        if (includedSourceIds) {
          const selected = new Set(includedSourceIds), available = new Set(sources.filter(s => s.status === 'available').map(s => s.id));
          if (selected.size !== includedSourceIds.length || [...selected].some(id => !available.has(id))) fail('선택한 입력이 읽을 수 있는 자료와 다릅니다.');
          if (sources.some(s => scope.kind === 'slides' && s.assignmentId === scope.assignmentId && s.status === 'available' && !selected.has(s.id))) fail('선택한 과제 안내를 제외할 수 없습니다.');
          sources = sources.map(s => { if (s.status === 'missing' || selected.has(s.id)) return s; const { text: _text, ...metadata } = s; return { ...metadata, status: 'missing', reason: '이번 생성 입력에서 사용자가 명시적으로 제외했습니다.' }; });
        }
        if (!allowMissing && sources.some(s => s.status === 'missing')) fail('누락·제외 범위를 확인한 뒤 부분 생성을 명시적으로 선택해 주세요.');
        const prepared = await engine.prepare({ ...scope, accountId: c.account, courseTitle: c.manifest.course.title, sources }, { signal, allowMissing });
        this.#assert(c.account, signal);
        r.directory = prepared.directory; this.#directory(r);
        r.engineId = prepared.id; r.plan = ArtifactPlan.parse(prepared.plan); r.reviewToken = prepared.reviewToken; r.phase = 'needs_review'; this.#save(r);
      } catch (e) { r.phase = signal.aborted ? 'cancelled' : 'failed'; r.error = signal.aborted ? '생성을 취소했습니다. 이전 결과는 보존했습니다.' : explanation(e); this.#save(r); }
    });
    return this.#public(r);
  }
  #directory(r: Record) {
    if (!r.directory || !isAbsolute(r.directory)) fail('보존 결과 폴더가 없습니다.');
    const configuredRoot = this.outputRoot;
    if (lstatSync(this.#o.root).isSymbolicLink() || lstatSync(configuredRoot).isSymbolicLink()) fail('결과 폴더 경계가 바뀌었습니다.');
    const root = realpathSync(configuredRoot), expected = join(root, digest(r.account), digest(r.scope.courseId));
    const path = realpathSync(r.directory);
    if (!inside(expected, path) || path === expected) fail('이 계정·과목의 출력 폴더가 아닙니다.');
    let current = root;
    for (const part of relative(root, r.directory).split('/')) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) fail('출력 폴더에 링크를 사용할 수 없습니다.'); }
    return path;
  }
  async #file(r: Record, file: string, signal?: AbortSignal) {
    const root = this.#directory(r), path = join(root, file);
    if (!inside(root, path) || path === root) fail('출력 파일 경계가 바뀌었습니다.');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.size <= 32 || stat.size > 1_000_000_000) fail('출력 파일이 올바르지 않습니다.');
      if (!inside(root, realpathSync(path))) fail('출력 파일 경계가 바뀌었습니다.');
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) { this.#assert(r.account, signal); hash.update(chunk); }
      return { path, sha256: hash.digest('hex') };
    } finally { await handle.close(); }
  }
  async export(courseId: string, id: string, reviewToken: string) {
    const r = await this.#owned(courseId, id), engine = this.#engines.get(id);
    if (r.phase !== 'needs_review' || !engine || !r.engineId || r.reviewToken !== reviewToken) fail('현재 계획을 다시 검토한 뒤 출력을 선택해 주세요. 중단된 요청은 자동 재실행하지 않습니다.');
    if (this.#courses.has(`${r.account}/${courseId}`)) fail('진행 중인 작업을 먼저 마쳐 주세요.');
    r.phase = 'exporting'; r.error = ''; this.#save(r);
    this.#start(r, async signal => {
      let started = false;
      try {
        this.#assert(r.account, signal);
        await this.#o.beforeExport(r.scope.kind, signal); this.#assert(r.account, signal);
        started = true;
        const result = await engine.export(r.engineId!, reviewToken, { signal }); this.#assert(r.account, signal);
        if (realpathSync(result.directory) !== this.#directory(r)) fail('출력 결과 폴더가 바뀌었습니다.');
        const expected = r.scope.kind === 'video' ? ['explanation.mp4'] : ['draft.pptx', 'pdf/draft.pdf'];
        if (result.files.length !== expected.length || !expected.every(file => result.files.some(path => relative(result.directory, path) === file))) fail('필수 출력 파일이 일치하지 않습니다.');
        for (const file of expected) { const info = await this.#file(r, file, signal); const kind = file.split('.').at(-1) as FileKind; r.paths[kind] = { relative: file, sha256: info.sha256 }; }
        this.#assert(r.account, signal); r.files = expected.map(file => file.split('.').at(-1) as FileKind); r.phase = 'completed'; this.#save(r);
      } catch (e) { r.phase = signal.aborted ? 'cancelled' : started ? 'failed' : 'needs_review'; r.error = signal.aborted ? '출력을 취소했습니다. 이미 발생한 API 비용은 취소되지 않을 수 있습니다.' : explanation(e); this.#save(r); }
    });
    return this.#public(r);
  }
  async cancel(courseId: string, id: string) { await this.#owned(courseId, id); this.#active.get(id)?.abort.abort(); return {}; }
  async show(courseId: string, id: string, file: FileKind, how: 'open' | 'reveal') {
    const r = await this.#owned(courseId, id), saved = r.paths[file];
    if (r.phase !== 'completed' || !r.files.includes(file) || !saved) fail('완료된 출력 파일이 아닙니다.');
    const checked = await this.#file(r, saved.relative); if (checked.sha256 !== saved.sha256) fail('보존된 출력 파일이 변경됐습니다. 원본을 덮어쓰지 않았습니다.');
    this.#assert(r.account); await this.#o.show(checked.path, how); return {};
  }
  async stopAll() { this.#stopped = true; for (const task of this.#active.values()) task.abort.abort(); await Promise.allSettled([...this.#active.values()].map(task => task.work)); }
}
