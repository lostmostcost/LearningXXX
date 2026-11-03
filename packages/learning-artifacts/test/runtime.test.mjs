import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProgram } from '../src/runtime.mjs';
test('runtime argv is data and sensitive environment is not forwarded', async () => {
  process.env.LEARNINGXXX_ARTIFACT_TEST_SECRET = 'secret';
  const out = await runProgram(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.argv[1],process.env.LEARNINGXXX_ARTIFACT_TEST_SECRET]))', '$(touch sentinel)']);
  assert.deepEqual(JSON.parse(out), ['$(touch sentinel)', null]); delete process.env.LEARNINGXXX_ARTIFACT_TEST_SECRET;
});
test('runtime rejects missing executable and pre-abort', async () => {
  await assert.rejects(runProgram('/not-existing-learningxxx-runtime', []), { code: 'RUNTIME_REQUIRED' });
  const abort = new AbortController(); abort.abort(); assert.throws(() => runProgram(process.execPath, [], { signal: abort.signal }));
});
test('runtime timeouts and explicit cancellation settle and reap the subprocess', async () => {
  await assert.rejects(runProgram(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50 }), { code: 'RUNTIME_TIMEOUT' });
  const abort = new AbortController(); const wait = runProgram(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: abort.signal }); setTimeout(() => abort.abort(), 50); await assert.rejects(wait);
});
