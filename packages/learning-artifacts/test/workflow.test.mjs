import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactWorkflow } from '../src/workflow.mjs';
import { input, plan, source } from './fixture.mjs';
import { hash } from '../src/model.mjs';
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workflow: new ArtifactWorkflow({ root, accountId: () => 'a', generate: async () => JSON.stringify(plan('document')), ...options }) };
}
const pdf = async ({ directory }) => { const file = join(directory, 'draft.pdf'); await writeFile(file, '%PDF-1.7\n' + 'synthetic'.repeat(10)); return file; };
test('two-stage document export preserves sources and requires exact review', async (t) => {
  let printed = 0;
  const { workflow } = await fixture(t, { documentPdf: async (x) => { printed++; return pdf(x); } });
  const prepared = await workflow.prepare(input('document')); assert.equal(printed, 0);
  await assert.rejects(workflow.export(prepared.id, 'wrong'), { code: 'REVIEW_REQUIRED' });
  const result = await workflow.export(prepared.id, prepared.reviewToken); assert.equal(printed, 1); assert.equal(result.files.length, 1);
  const saved = await readFile(join(prepared.directory, 'sources.json'), 'utf8'); assert.ok(!saved.includes('합성 강의:'));
  await assert.rejects(workflow.export(prepared.id, prepared.reviewToken), { code: 'REVIEW_REQUIRED' });
  assert.equal((await workflow.inspect(prepared.directory)).state, 'completed');
});
test('account switch after Claude prevents later output or API work', async (t) => {
  let account = 'a', calls = 0;
  const { workflow } = await fixture(t, { accountId: () => account, generate: async () => { account = 'b'; return plan(); }, narrate: async () => { calls++; } });
  await assert.rejects(workflow.prepare(input()), { code: 'ACCOUNT_CHANGED' }); assert.equal(calls, 0);
});
test('missing material is explicitly accepted; absent instructions cannot be bypassed', async (t) => {
  const { workflow } = await fixture(t); const x = input('document'); x.sources.push(source('missing', { status: 'missing', reason: '암호 PDF' }));
  await assert.rejects(workflow.prepare(x), { code: 'MISSING_SOURCES' });
  const review = await workflow.prepare(x, { allowMissing: true }); assert.equal(review.sources.at(-1).reason, '암호 PDF');
  x.sources[1].status = 'missing'; x.sources[1].reason = '과제 미수집'; await assert.rejects(workflow.prepare(x, { allowMissing: true }), { code: 'MISSING_INSTRUCTIONS' });
});
test('parallel prepare and duplicate export never start a second operation', async (t) => {
  let finish; const waiting = new Promise((r) => { finish = r; });
  const { workflow } = await fixture(t, { generate: async () => { await waiting; return plan('document'); }, documentPdf: pdf });
  const first = workflow.prepare(input('document')); await assert.rejects(workflow.prepare(input('document')), { code: 'ALREADY_RUNNING' }); finish();
  const review = await first, one = workflow.export(review.id, review.reviewToken);
  await assert.rejects(workflow.export(review.id, review.reviewToken), { code: 'REVIEW_REQUIRED' }); await one;
});
test('cancel after narration does not probe/render or reissue paid request', async (t) => {
  const abort = new AbortController(); let narrated = 0, probed = 0;
  const { workflow } = await fixture(t, { generate: async () => plan(), narrate: async () => { narrated++; abort.abort(); return { bytes: Buffer.alloc(40) }; }, media: { duration: async () => { probed++; return 1; }, render: async () => assert.fail('must not render') } });
  const r = await workflow.prepare(input()); await assert.rejects(workflow.export(r.id, r.reviewToken, { signal: abort.signal }));
  assert.equal(narrated, 1); assert.equal(probed, 0); assert.equal((await workflow.inspect(r.directory)).state, 'cancelled');
  await assert.rejects(workflow.export(r.id, r.reviewToken), { code: 'REVIEW_REQUIRED' });
});
test('rejects symlink account folder and external converter outputs', async (t) => {
  const { workflow, root } = await fixture(t); const outside = join(root, 'outside'); await mkdir(outside); await symlink(outside, join(root, hash('a')));
  await assert.rejects(workflow.prepare(input('document')), { code: 'SCOPE_CHANGED' });
  const b = await fixture(t, { documentPdf: async () => { const p = join(root, 'external.pdf'); await writeFile(p, '%PDF-'+ 'x'.repeat(40)); return p; } });
  const r = await b.workflow.prepare(input('document')); await assert.rejects(b.workflow.export(r.id, r.reviewToken), { code: 'SCOPE_CHANGED' });
});
test('restart marks in-flight/review states interrupted without retrying', async (t) => {
  const { root, workflow } = await fixture(t); const r = await workflow.prepare(input('document'));
  const restored = new ArtifactWorkflow({ root, accountId: () => 'a', generate: async () => assert.fail('must not resume') });
  assert.equal((await restored.inspect(r.directory)).state, 'interrupted'); await assert.rejects(restored.export(r.id, r.reviewToken), { code: 'REVIEW_REQUIRED' });
});
