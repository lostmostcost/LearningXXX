import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type { ArtifactScope, CollectionManifest, IpcResponse } from '@learningxxx/contracts';
import { ArtifactWorkflows } from '../src/artifact-workflows.ts';
import type { AssignmentSource } from '../src/assignment-workspaces.ts';

const courseId = '11111111-1111-4111-8111-111111111111', weekId = '22222222-2222-4222-8222-222222222222', assignmentId = '33333333-3333-4333-8333-333333333333';
const scope: ArtifactScope = { courseId, kind: 'slides', assignmentId };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'artifact-host-')));
  let account = 'synthetic-account', preparations = 0, exports = 0, blocked = false, shown = '', unsafe = false;
  let wait: ((signal: AbortSignal) => Promise<void>) | undefined;
  let sources: AssignmentSource[] = [
    { id: 'm', title: '합성 자료', weekId, kind: 'material', status: 'available', text: '합성 원문' },
    { id: 'a', title: '합성 안내', assignmentId, kind: 'assignment', status: 'available', text: '합성 과제 안내' },
  ];
  const manifest = { course: { id: courseId, accountKey: account, title: '합성 과목' }, weeks: [{ id: weekId }], items: [{ resource: { id: assignmentId, sourceId: '123', kind: 'assignment' }, body: '합성 안내' }] } as unknown as CollectionManifest;
  const options = {
    root, accountKey: () => account, manifest: async (id: string) => id === courseId ? manifest : undefined,
    sources: async () => structuredClone(sources),
    engine: () => {
      let directory = '', kind: ArtifactScope['kind'] = 'slides';
      return {
        prepare: async (input: unknown, { signal }: { signal: AbortSignal; allowMissing: boolean }) => {
          preparations++; if (wait) await wait(signal);
          kind = (input as ArtifactScope).kind;
          directory = unsafe ? join(root, 'external') : join(root, 'outputs', hash(account), hash(courseId), `run-${randomUUID()}`);
          await mkdir(directory, { recursive: true });
          return { id: randomUUID(), directory, reviewToken: 'a'.repeat(64), plan: {
            title: '합성 계획', reviewedSourceIds: ['m', 'a'], requirements: [], openQuestions: [],
            slides: kind === 'slides' ? [{ title: '합성 장', bullets: ['합성 내용'], sourceIds: ['m'] }] : [],
            scenes: kind === 'video' ? [{ title: '합성 장면', bullets: ['합성 내용'], narration: '합성 대본', sourceIds: ['m'] }] : [],
          } };
        },
        export: async () => {
          exports++;
          if (kind === 'slides') {
            await mkdir(join(directory, 'pdf'));
            await writeFile(join(directory, 'draft.pptx'), 'PK' + 'synthetic-state-test'.repeat(4));
            await writeFile(join(directory, 'pdf/draft.pdf'), '%PDF-synthetic state-test only'.repeat(4));
          } else await writeFile(join(directory, 'explanation.mp4'), 'synthetic-state-test'.repeat(4));
          return { directory, files: kind === 'slides' ? [join(directory, 'draft.pptx'), join(directory, 'pdf/draft.pdf')] : [join(directory, 'explanation.mp4')] };
        },
      };
    },
    beforeExport: async () => { if (blocked) throw Object.assign(new Error('runtime'), { appError: { message: '출력 도구가 준비되지 않았습니다.' } }); },
    show: async (path: string) => { shown = path; },
  };
  const service = new ArtifactWorkflows(options);
  return { root, options, service, sources: () => sources, setSources: (value: AssignmentSource[]) => { sources = value; }, setAccount: (value: string) => { account = value; }, setWait: (fn: typeof wait) => { wait = fn; }, setBlocked: (value: boolean) => { blocked = value; }, setUnsafe: () => { unsafe = true; }, preparations: () => preparations, exports: () => exports, shown: () => shown, done: async () => { await service.stopAll(); await rm(root, { recursive: true, force: true }); } };
}
async function phase(t: Awaited<ReturnType<typeof setup>>, id: string, expected: string) {
  for (let i = 0; i < 100; i++) { const job = await t.service.state(courseId, id); if (job.phase === expected) return job; await pause(5); }
  assert.fail(`expected ${expected}, got ${(await t.service.state(courseId, id)).phase}`);
}
async function prepare(t: Awaited<ReturnType<typeof setup>>, target = scope, extra = {}) {
  const input = await t.service.inputs(target);
  return t.service.prepare({ ...target, sourceToken: input.token, allowMissing: false, ...extra });
}

test('plan review is required; a runtime preflight failure never exports and completed file hashes survive restart', async () => {
  const t = await setup(); try {
    const job = await prepare(t), reviewed = await phase(t, job.id, 'needs_review');
    assert.equal(t.exports(), 0);
    await assert.rejects(t.service.export(courseId, job.id, 'b'.repeat(64)), /계획을 다시 검토/);
    t.setBlocked(true); await t.service.export(courseId, job.id, reviewed.reviewToken!); await phase(t, job.id, 'needs_review'); assert.equal(t.exports(), 0);
    t.setBlocked(false); await t.service.export(courseId, job.id, reviewed.reviewToken!); const completed = await phase(t, job.id, 'completed');
    assert.deepEqual(completed.files, ['pptx', 'pdf']); assert.equal(t.exports(), 1);
    const restarted = new ArtifactWorkflows(t.options);
    assert.equal((await restarted.state(courseId, job.id)).phase, 'completed');
    await restarted.show(courseId, job.id, 'pdf', 'open'); assert.match(t.shown(), /draft.pdf$/);
    await writeFile(t.shown(), '%PDF-tampered'.repeat(10));
    await assert.rejects(restarted.show(courseId, job.id, 'pdf', 'open'), /변경됐습니다/);
    t.setAccount('other'); await assert.rejects(restarted.state(courseId, job.id), /현재 계정/);
  } finally { await t.done(); }
});

test('duplicate course requests and cancellation cannot start duplicate generation or export', async () => {
  const t = await setup(); try {
    let started!: () => void; const ready = new Promise<void>(r => { started = r; });
    t.setWait(signal => { started(); return new Promise((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); });
    const job = await prepare(t); await ready;
    await assert.rejects(prepare(t), /진행 중/);
    await t.service.cancel(courseId, job.id); await phase(t, job.id, 'cancelled');
    assert.equal(t.preparations(), 1); assert.equal(t.exports(), 0);
  } finally { await t.done(); }
});

test('stale input, missing consent and excluded instructions fail before the model', async () => {
  const t = await setup(); try {
    const input = await t.service.inputs(scope);
    t.setSources([...t.sources(), { id: 'x', kind: 'material', title: '누락', status: 'missing', reason: '합성' }]);
    const stale = await t.service.prepare({ ...scope, sourceToken: input.token, allowMissing: true }); await phase(t, stale.id, 'failed');
    const missing = await prepare(t); await phase(t, missing.id, 'failed');
    const excluded = await prepare(t, scope, { includedSourceIds: ['m'], allowMissing: true }); await phase(t, excluded.id, 'failed');
    assert.equal(t.preparations(), 0);
    await assert.rejects(t.service.inputs({ courseId, kind: 'video', weekId: assignmentId }), /주차/);
  } finally { await t.done(); }
});

test('restart marks a reviewed plan interrupted without requesting a model or paid retry', async () => {
  const t = await setup(); try {
    const job = await prepare(t); await phase(t, job.id, 'needs_review');
    const restarted = new ArtifactWorkflows(t.options), state = await restarted.state(courseId, job.id);
    assert.equal(state.phase, 'interrupted'); assert.equal(state.reviewToken, undefined); assert.ok(state.plan);
    await assert.rejects(restarted.export(courseId, job.id, 'a'.repeat(64)), /중단된 요청/);
    assert.equal(t.preparations(), 1); assert.equal(t.exports(), 0);
  } finally { await t.done(); }
});

test('an engine cannot publish a plan directory outside its account/course output boundary', async () => {
  const t = await setup(); try {
    t.setUnsafe(); const job = await prepare(t); const failed = await phase(t, job.id, 'failed');
    assert.deepEqual(failed.files, []); assert.equal(t.exports(), 0);
    assert.ok(!(JSON.stringify(failed).includes(t.root)), 'renderer receives no output paths');
  } finally { await t.done(); }
});

test('account changes abort an in-flight model request and do not publish its plan', async () => {
  const t = await setup(); try {
    let started!: () => void; const ready = new Promise<void>(r => { started = r; });
    t.setWait(signal => { started(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); });
    const job = await prepare(t); await ready; t.setAccount('other');
    for (let i = 0; i < 100; i++) { const record = JSON.parse(await readFile(join(t.root, 'index', `${job.id}.json`), 'utf8')); if (record.phase === 'cancelled') break; await pause(5); }
    t.setAccount('synthetic-account'); const cancelled: IpcResponse<'artifacts.state'> = await t.service.state(courseId, job.id);
    assert.equal(cancelled.phase, 'cancelled'); assert.equal(cancelled.plan, undefined); assert.equal(t.exports(), 0);
  } finally { await t.done(); }
});

test('shutdown while scope resolution is pending cannot start a model after stop returns', async () => {
  const t = await setup(); try {
    const input = await t.service.inputs(scope), manifest = await t.options.manifest(courseId);
    let release!: () => void;
    const delayed = new ArtifactWorkflows({ ...t.options, manifest: () => new Promise(r => { release = () => r(manifest); }) });
    const request = delayed.prepare({ ...scope, sourceToken: input.token, allowMissing: false });
    const rejected = assert.rejects(request, /앱 종료/);
    await delayed.stopAll(); release(); await rejected;
    assert.equal(t.preparations(), 0);
  } finally { await t.done(); }
});
