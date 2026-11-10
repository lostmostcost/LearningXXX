import assert from 'node:assert/strict';
import { test } from 'node:test';
import { screenContextLabel, screenViewing } from '../src/screen-context.ts';

test('home and non-resource screens never inherit the previous PDF page', () => {
  const previous = { courseId: 'course', courseTitle: '과목', week: '1주차', resource: { title: 'old.pdf', page: 3 } };
  assert.equal(screenViewing({ ...previous, section: 'home' }), undefined);
  assert.equal(screenContextLabel({ ...previous, section: 'home' }), '대시보드');
  assert.deepEqual(screenViewing({ ...previous, section: 'media' }), { title: '녹음·전사' });
  assert.deepEqual(screenViewing({ ...previous, section: 'info' }), { title: '강의 정보' });
  assert.deepEqual(screenViewing({ ...previous, section: 'book' }), { week: '1주차', title: 'old.pdf', page: 3 });
});
