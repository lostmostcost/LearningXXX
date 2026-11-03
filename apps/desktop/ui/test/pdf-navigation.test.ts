import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampZoom, pageList, pageScale, wheelZoom } from '../src/pdf-navigation.ts';
test('page fit preserves aspect ratio inside a short viewport; width fit can scroll', () => {
  const size = { width: 600, height: 900 }, bounds = { width: 932, height: 482 };
  assert.equal(pageScale(size, bounds, 'page', 1), .5);
  assert.equal(pageScale(size, bounds, 'width', 1), 1.5);
});
test('pinch respects direction and limits including coarse mouse deltas', () => {
  assert.ok(wheelZoom(1, -10, 0) > 1);
  assert.ok(wheelZoom(1, 10, 0) < 1);
  assert.equal(wheelZoom(4, -100, 0), 4);
  assert.equal(wheelZoom(.1, 100, 0), .1);
  assert.equal(wheelZoom(1, 1, 1), wheelZoom(1, 16, 0));
  assert.equal(clampZoom(0), .1);
});

test("pageList joins runs of pages (WBS-072)", () => {
  assert.equal(pageList([]), "");
  assert.equal(pageList([4]), "4");
  assert.equal(pageList([1, 2, 3, 7, 9, 10]), "1–3, 7, 9–10");
});
