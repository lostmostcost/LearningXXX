import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentLines, parseAgentCommand } from '../src/agent-protocol.ts';

test('agent language is closed and requires explicit user operations', () => {
  for (const c of [{ op: 'eval', code: 'x' }, { op: 'click', selector: 'button' }, { op: 'snapshot', state: {} }, { op: '__proto__' }, { op: 'key', key: 'A' }, { op: 'click' }, { op: 'fill', target: 'a', text: 2 }, { op: 'resize', width: 0, height: 800 }, { op: 'render', name: '../private' }, { op: 'wait', ms: Infinity }]) assert.throws(() => parseAgentCommand(c));
  assert.deepEqual(parseAgentCommand({ op: 'click', target: 'revision:1' }), { op: 'click', target: 'revision:1' });
  assert.deepEqual(parseAgentCommand({ op: 'key', key: 'Tab', shift: true }), { op: 'key', key: 'Tab', shift: true });
});

test('JSONL handles split chunks, blank lines, final line and bounded input', () => {
  const lines = new AgentLines();
  assert.deepEqual(lines.push('{"op":'), []);
  assert.deepEqual(lines.push('"snapshot"}\n\n{"op":"stop"}'), ['{"op":"snapshot"}']);
  assert.deepEqual(lines.end(), ['{"op":"stop"}']);
  assert.throws(() => new AgentLines().push('x'.repeat(100_001)), /COMMAND_TOO_LARGE/);
  assert.throws(() => new AgentLines().push('x'.repeat(100_001) + '\n'), /COMMAND_TOO_LARGE/);
});

test('debug refuses shortcuts; assist permits navigation only, without mutation or confirmation bypass', () => {
  assert.throws(() => parseAgentCommand({ op: 'catalog' }), /ASSIST_ONLY/);
  assert.throws(() => parseAgentCommand({ op: 'navigate', section: 'home' }), /ASSIST_ONLY/);
  assert.equal(parseAgentCommand({ op: 'navigate', section: 'info' }, 'assist').section, 'info');
  assert.equal(parseAgentCommand({ op: 'catalog' }, 'assist').op, 'catalog');
  for (const c of [{ op: 'navigate', section: ['home'] }, { op: 'navigate', tab: ['chat'] }, { op: 'navigate', section: 'submit' }, { op: 'navigate', confirm: true }, { op: 'navigate' }, { op: 'navigate', section: 'home', tab: 'chat' }, { op: 'navigate', courseId: '../private' }, { op: 'submit', planId: 'x' }]) assert.throws(() => parseAgentCommand(c, 'assist'));
});
