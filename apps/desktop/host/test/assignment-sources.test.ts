import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CollectionManifest } from '@learningxxx/contracts';
import { assignmentSources } from '../src/assignment-sources.ts';
test('all weeks/pages/text parts are supplied and missing visual/binary inputs stay explicit', async () => {
  const manifest = { items: [
    { resource: { id: 'a', title: '과제', kind: 'assignment', weekId: 'w10' }, body: '<p>안내</p>', assets: [] },
    { resource: { id: 'b', title: '1주 자료', kind: 'file', weekId: 'w1' }, assets: [{ id: 'pdf', originalName: 'first.pdf', mediaType: 'application/pdf' }] },
    { resource: { id: 'c', title: '10주 자료', kind: 'file', weekId: 'w10' }, assets: [{ id: 'txt', originalName: 'long.txt', mediaType: 'text/plain' }, { id: 'image', originalName: 'diagram.png', mediaType: 'image/png' }] },
  ] } as unknown as CollectionManifest;
  const result = await assignmentSources(manifest, { asset: async id => Buffer.from(id === 'txt' ? 'x'.repeat(120001) : 'pdf'), pdf: async () => ['첫 쪽', '', '마지막 쪽'], notes: [{ kind: 'transcript', title: '다른 주 전사', weekId: 'w3', text: '전사 전체' }] });
  assert.equal(result.find(s => s.assignmentId === 'a')?.text, '안내');
  assert.ok(result.some(s => s.weekId === 'w1' && s.text === '마지막 쪽'));
  assert.equal(result.filter(s => s.id.startsWith('txt:')).map(s => s.text).join('').length, 120001);
  assert.ok(result.some(s => s.id === 'pdf:visual' && s.status === 'missing'));
  assert.ok(result.some(s => s.id === 'image' && s.status === 'missing'));
  assert.ok(result.some(s => s.title === '다른 주 전사' && s.text === '전사 전체'));
  manifest.items[0]!.assignment = { resourceId: 'a', dueAt: '2026-11-09T14:59:00Z', timezone: 'Asia/Seoul', timezoneBasis: 'source_explicit' };
  const withDeadline = await assignmentSources(manifest, { asset: async () => new Uint8Array(), pdf: async () => [], notes: [] });
  assert.match(withDeadline.find(s => s.assignmentId === 'a')!.text!, /2026-11-09T14:59:00Z/);
  assert.match(withDeadline.find(s => s.assignmentId === 'a')!.text!, /Asia\/Seoul/);
});
