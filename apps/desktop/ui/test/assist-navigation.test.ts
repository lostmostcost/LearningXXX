import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAssistNavigation } from '../src/assist-navigation.ts';

test('renderer assist boundary accepts navigation intents and rejects action/state payloads', () => {
  assert.deepEqual(parseAssistNavigation({ op: 'catalog' }), { op: 'catalog' });
  assert.deepEqual(parseAssistNavigation({ op: 'navigate', section: 'tasks', tab: 'chat' }), { op: 'navigate', section: 'tasks', tab: 'chat' });
  for (const value of [null, [], { op: 'send' }, { op: 'navigate' }, { op: 'navigate', section: ['home'] }, { op: 'navigate', tab: ['chat'] }, { op: 'navigate', state: {} }, { op: 'catalog', courseId: 'x' }, { op: 'navigate', section: 'home', tab: 'chat' }, { op: 'navigate', resourceId: 'x' }, { op: 'navigate', tab: 'submit' }]) assert.throws(() => parseAssistNavigation(value));
});
