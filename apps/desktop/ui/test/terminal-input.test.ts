import assert from 'node:assert/strict';
import { test } from 'node:test';
import { terminalInputChunks } from '../src/terminal-input.ts';
test('long Unicode paste preserves codepoints and bracketed paste framing across IPC chunks', () => {
  const input = '\x1b[200~' + '가'.repeat(15993) + '🧑‍💻'.repeat(7000) + '\n/compact\n\x1b[201~';
  const chunks = terminalInputChunks(input);
  assert.equal(chunks.join(''), input);
  for (const chunk of chunks) { assert.ok(chunk.length <= 16000); assert.equal(Buffer.from(chunk).toString(), chunk); }
});
