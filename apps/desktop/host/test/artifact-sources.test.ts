import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CollectionManifest } from '@learningxxx/contracts';
import { artifactSources } from '../src/artifact-sources.ts';

test('weekly video reads every selected-week/common page and note without reading another week', async () => {
  const manifest = { items: [
    { resource: { id: 'r1', kind: 'file', title: '1주', weekId: 'w1' }, assets: [{ id: 'a1', originalName: 'first.pdf', mediaType: 'application/pdf' }] },
    { resource: { id: 'r2', kind: 'file', title: '2주', weekId: 'w2' }, assets: [{ id: 'a2', originalName: 'second.pdf', mediaType: 'application/pdf' }] },
    { resource: { id: 'common', kind: 'notice', title: '공통 공지' }, assets: [], body: '<p>전체 과목 공지</p>' },
  ] } as unknown as CollectionManifest;
  const options = { asset: async (id: string) => { assert.equal(id, 'a1'); return new Uint8Array([1]); }, pdf: async () => ['첫 쪽', '마지막 쪽'], notes: [{ kind: 'transcript' as const, weekId: 'w1', title: '1주 전사', text: '전사 전체' }, { kind: 'memo' as const, weekId: 'w2', title: '2주 메모', text: '다른 주' }], summary: '누적 과목 요약' };
  const sources = await artifactSources({ courseId: 'c', kind: 'video', weekId: 'w1' }, manifest, options);
  assert.ok(sources.some(s => s.text === '마지막 쪽'));
  assert.ok(sources.some(s => s.text === '전사 전체'));
  assert.ok(sources.some(s => s.text === '전체 과목 공지' && s.weekId === 'w1' && s.title.startsWith('[과목 공통]')));
  assert.ok(sources.some(s => s.text === '누적 과목 요약' && s.kind === 'course'));
  assert.ok(!sources.some(s => s.weekId === 'w2'));
});
