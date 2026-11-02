import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandSuggestions, parseCommand } from '../src/commands.ts';
test('command suggestions filter prefixes, never prose or paths', () => {
  assert.ok(commandSuggestions('/').length > 5);
  assert.deepEqual(commandSuggestions('/ren').map(c => c.name), ['/rename']);
  assert.equal(commandSuggestions('설명 /help').length, 0);
  assert.equal(commandSuggestions('/Users/course.pdf').length, 0);
});
test('keeps command arguments and distinguishes unsupported terminal controls', () => {
  assert.deepEqual(parseCommand('/rename 논리 회로 복습'), { name: '/rename', args: '논리 회로 복습' });
  assert.equal(parseCommand('/Users/course.pdf'), undefined);
  assert.equal(commandSuggestions('/compact')[0]?.supported, false);
});
