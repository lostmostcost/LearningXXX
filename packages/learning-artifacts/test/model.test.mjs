import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, generationPrompt, validatePlan } from '../src/model.mjs';
import { input, plan, source } from './fixture.mjs';
test('video scope excludes other weeks, assignment keeps cumulative materials', () => {
  const x = input(); x.sources.push(source('w2', { weekId: 'w2' }));
  assert.equal(snapshot(x).sources.length, 2);
  assert.equal(snapshot({ ...x, kind: 'document' }).sources.length, 3);
  assert.match(generationPrompt(snapshot(x)), /합성 강의/);
});
test('never silently truncates or substitutes missing instructions', () => {
  const x = input('document'); x.sources[1] = { ...x.sources[1], status: 'missing', reason: '본문 미수집' };
  assert.throws(() => snapshot(x), { code: 'MISSING_INSTRUCTIONS' });
  x.sources[0].text = 'x'.repeat(120001); assert.throws(() => snapshot(x), /length/);
  const y = input(); y.sources.push(source('m')); assert.throws(() => snapshot(y), /Duplicate/);
});
test('coverage and provenance are fail closed', () => {
  const s = snapshot(input()); assert.deepEqual(validatePlan(plan(), s), plan());
  const p = plan(); p.reviewedSourceIds = ['m']; assert.throws(() => validatePlan(p, s), { code: 'INCOMPLETE_REVIEW' });
  p.reviewedSourceIds.push('not-real'); assert.throws(() => validatePlan(p, s), { code: 'INVALID_PROVENANCE' });
  p.reviewedSourceIds = ['m', 'a']; p.scenes[0].sourceIds = ['../../secret']; assert.throws(() => validatePlan(p, s), { code: 'INVALID_PROVENANCE' });
  assert.throws(() => validatePlan('null', s));
});
test('source fingerprint changes with source body or account; missing stays explicit', () => {
  const a = input(), b = input(); b.sources.push(source('missing', { status: 'missing', reason: '암호 PDF' }));
  const s = snapshot(b); assert.equal(s.sources.at(-1).reason, '암호 PDF');
  assert.notEqual(snapshot(a).fingerprint, s.fingerprint); b.accountId = 'other'; assert.notEqual(snapshot(b).fingerprint, s.fingerprint);
});

test('snapshot cannot change after review; course summary alone cannot stand for a week', () => {
  const s = snapshot(input()); assert.throws(() => { s.sources[0].text = 'changed'; }, TypeError);
  const x = input(); x.sources = [source('summary', { kind: 'course', weekId: undefined })];
  assert.throws(() => snapshot(x), { code: 'MISSING_SOURCES' });
});
