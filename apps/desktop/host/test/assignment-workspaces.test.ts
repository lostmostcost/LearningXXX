import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type { CollectionManifest, Session } from '@learningxxx/contracts';
import { AssignmentWorkspaces, type AssignmentSource } from '../src/assignment-workspaces.ts';

const courseId = '11111111-1111-4111-8111-111111111111';
const a = '22222222-2222-4222-8222-222222222222', b = '33333333-3333-4333-8333-333333333333';
const scope = { courseId, assignmentId: a };
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'assignment-test-'));
  let account: string | undefined = 'acct_synthetic', html = '<html><body>원래 초안</body></html>', calls = 0, busy = false;
  const sessions = new Map<string, Session>();
  const manifest = { course: { id: courseId, accountKey: account, title: '합성 과목' }, items: [a, b].map(id => ({ resource: { id, kind: 'assignment', title: `과제 ${id}` }, body: '합성 안내' })) } as unknown as CollectionManifest;
  let sources: AssignmentSource[] = [{ id: 'week-1', title: '1주 자료', kind: 'material', status: 'available', text: '첫 주 내용' }, { id: 'week-10', title: '10주 자료', kind: 'material', status: 'available', text: '열 번째 주 내용' }, { id: 'instructions', title: '과제 안내', kind: 'assignment', status: 'available', text: '합성 안내', assignmentId: a }];
  let generate = async (_signal: AbortSignal): Promise<string> => html;
  let generatedSources: AssignmentSource[] = [];
  let print = async (_html: string): Promise<Uint8Array> => Buffer.from('%PDF-1.7 synthetic state-test only');
  const options = {
    root: join(dir, 'records'), sessionsRoot: join(dir, 'sessions'), accountKey: () => account,
    manifest: async () => manifest,
    createSession: (cid: string, title: string) => { const id = randomUUID(); const s = { appSessionId: id, mode: 'course', engine: 'chat', courseId: cid, title } as Session; sessions.set(id, s); return s; },
    getSession: (id: string) => sessions.get(id)!, busy: () => busy,
    sources: async () => structuredClone(sources),
    generate: async (input: { sources: AssignmentSource[] }, signal: AbortSignal, guard: () => void) => { calls++; generatedSources = input.sources; guard(); return generate(signal); },
    print: (value: string) => print(value), show: async () => {},
  };
  const service = new AssignmentWorkspaces(options);
  return { dir, options, service, sessions, generatedSources: () => generatedSources, setAccount: (v: string | undefined) => { account = v; }, setSources: (s: AssignmentSource[]) => { sources = s; }, sources: () => sources, setGenerate: (v: typeof generate) => { generate = v; }, setPrint: (v: typeof print) => { print = v; }, setBusy: (v: boolean) => { busy = v; }, calls: () => calls, working: (id: string) => join(dir, 'sessions', id, 'outputs/assignment-draft.html'), done: () => rm(dir, { recursive: true, force: true }) };
}
test('assignment sessions are stable and separate; all weeks, immutable versions and restart survive', async () => {
  const t = await setup(); try {
    const first = await t.service.open(scope), same = await t.service.open(scope), other = await t.service.open({ courseId, assignmentId: b });
    assert.equal(first.sessionId, same.sessionId); assert.notEqual(first.sessionId, other.sessionId);
    assert.match((await t.service.context(first.sessionId))!, /모든 주차/);
    assert.equal(first.sources.length, 3);
    const made = await t.service.generate({ ...scope, sourceToken: first.sourceToken, allowMissing: false });
    assert.match(await t.service.preview({ ...scope, revision: made.revision! }), /원래 초안/); assert.equal(made.versions.length, 1);
    await writeFile(t.working(first.sessionId), '<html><body>채팅 수정</body></html>');
    await t.service.state(scope); await pause(450);
    const edited = await t.service.state(scope); assert.match(await t.service.preview({ ...scope, revision: edited.revision! }), /채팅 수정/); assert.equal(edited.versions.length, 2);
    const restarted = new AssignmentWorkspaces(t.options);
    const restored = await restarted.open(scope); assert.equal(restored.sessionId, first.sessionId); assert.equal(restored.versions.length, 2);
    assert.match((await restarted.context(first.sessionId))!, /과제 전용/);
  } finally { await t.done(); }
});
test('printing an old pinned version cannot overwrite a newer chat version', async () => {
  const t = await setup(); try {
    const opened = await t.service.open(scope), made = await t.service.generate({ ...scope, sourceToken: opened.sourceToken, allowMissing: false });
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>(r => { started = r; });
    t.setPrint(async html => { assert.match(html, /원래 초안/); started(); await new Promise<void>(r => { release = r; }); return Buffer.from('%PDF-1.7 fixture'); });
    const exporting = t.service.export({ ...scope, revision: made.revision! }); await ready;
    await writeFile(t.working(opened.sessionId), '<html>새 판</html>'); await t.service.state(scope); await pause(450); await t.service.state(scope);
    release(); const result = await exporting;
    assert.equal(result.versions.length, 2); assert.equal(result.versions[0]!.pdf, true); assert.match(await t.service.preview({ ...scope, revision: result.revision! }), /새 판/);
  } finally { await t.done(); }
});
test('reset preserves a last unpolled edit and PDF publication can recover after an interrupted index write', async () => {
  const t = await setup(); try {
    const opened = await t.service.open(scope);
    await t.service.generate({ ...scope, sourceToken: opened.sourceToken, allowMissing: false });
    await writeFile(t.working(opened.sessionId), '<html>마지막 수정</html>');
    const reset = await t.service.open({ ...scope, reset: true });
    assert.notEqual(reset.sessionId, opened.sessionId);
    assert.equal(reset.versions.length, 2);
    assert.match(await readFile(t.working(reset.sessionId), 'utf8'), /마지막 수정/);
    const { readdir } = await import('node:fs/promises');
    const folder = (await readdir(t.options.root)).find(n => !n.endsWith('.json'))!;
    await writeFile(join(t.options.root, folder, `${reset.revision}.pdf`), '%PDF-orphan from interrupted publication');
    const exported = await t.service.export({ ...scope, revision: reset.revision! });
    assert.equal(exported.versions.at(-1)!.pdf, true);
    assert.match(await readFile(join(t.options.root, folder, `${reset.revision}.pdf`), 'utf8'), /synthetic state-test/);
  } finally { await t.done(); }
});
test('missing/stale sources and concurrent chat are refused before a model call', async () => {
  const t = await setup(); try {
    const opened = await t.service.open(scope);
    t.setSources([...t.sources(), { id: 'missing', title: '못 읽는 파일', kind: 'material', status: 'missing', reason: '지원 안 함' }]);
    await assert.rejects(t.service.generate({ ...scope, sourceToken: opened.sourceToken, allowMissing: true }), /바뀌었/);
    const refreshed = await t.service.open(scope);
    await assert.rejects(t.service.generate({ ...scope, sourceToken: refreshed.sourceToken, allowMissing: false }), /누락/);
    t.setBusy(true); await assert.rejects(t.service.generate({ ...scope, sourceToken: refreshed.sourceToken, allowMissing: true }), /진행 중/);
    assert.equal(t.calls(), 0);
  } finally { await t.done(); }
});
test('account changes and cancellation preserve the original; generation blocks chat sends', async () => {
  const t = await setup(); try {
    const opened = await t.service.open(scope); await t.service.generate({ ...scope, sourceToken: opened.sourceToken, allowMissing: false });
    let started!: () => void; const ready = new Promise<void>(r => { started = r; });
    t.setGenerate(async signal => { started(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); });
    const request = t.service.generate({ ...scope, sourceToken: opened.sourceToken, allowMissing: false }); await ready;
    assert.throws(() => t.service.beforeSend(opened.sessionId), /만드는 중/);
    const failed = assert.rejects(request); await t.service.cancel(scope); await failed;
    assert.match(await t.service.preview({ ...scope, revision: (await t.service.state(scope)).revision! }), /원래 초안/);
    t.setAccount('acct_other'); await assert.rejects(t.service.state(scope), /계정/); assert.throws(() => t.service.beforeSend(opened.sessionId), /계정/);
  } finally { await t.done(); }
});
test('explicit source selection keeps instructions and reports excluded content without sending its text', async () => {
  const t = await setup(); try {
    const opened = await t.service.open(scope);
    assert.ok(opened.sources.find(s => s.required)?.characters);
    await assert.rejects(t.service.generate({ ...scope, sourceToken: opened.sourceToken, allowMissing: true, includedSourceIds: ['week-1'] }), /안내/);
    const selected = { ...scope, sourceToken: opened.sourceToken, includedSourceIds: ['instructions', 'week-10'] };
    await assert.rejects(t.service.generate({ ...selected, allowMissing: false }), /누락/);
    assert.equal(t.calls(), 0);
    await t.service.generate({ ...selected, allowMissing: true });
    const excluded = t.generatedSources().find(s => s.id === 'week-1')!;
    assert.equal(excluded.status, 'missing'); assert.equal(excluded.text, undefined); assert.match(excluded.reason!, /제외/);
    assert.equal(t.generatedSources().find(s => s.id === 'week-10')?.text, '열 번째 주 내용');
    await assert.rejects(t.service.generate({ ...selected, allowMissing: true, includedSourceIds: ['unknown'] }), /선택한 자료/);
  } finally { await t.done(); }
});
test('working symlinks and changed immutable snapshots are never read as previews', async () => {
  const t = await setup(); try {
    const opened = await t.service.open(scope), made = await t.service.generate({ ...scope, sourceToken: opened.sourceToken, allowMissing: false });
    const external = join(t.dir, 'external.html'); await writeFile(external, 'private canary');
    await unlink(t.working(opened.sessionId)); await symlink(external, t.working(opened.sessionId));
    await assert.rejects(t.service.state(scope), /심볼릭 링크/);
    await unlink(t.working(opened.sessionId)); await writeFile(t.working(opened.sessionId), '<html><body>원래 초안</body></html>');
    const { readdir } = await import('node:fs/promises'); const folder = (await readdir(t.options.root)).find(n => !n.endsWith('.json'))!;
    await writeFile(join(t.options.root, folder, `${made.revision}.html`), 'tampered');
    await assert.rejects(t.service.state(scope), /변경됐/);
    assert.equal(await readFile(external, 'utf8'), 'private canary');
  } finally { await t.done(); }
});
