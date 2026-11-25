import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCliRunner } from '../src/cli-runner.ts';
import { createClaudeTextRunner } from '../src/readable-note.ts';

test('text runner authenticates every request, reuses compatibility, and invalidates changed runtime behavior', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-text-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, '.local/bin'), cache = join(root, 'cache'); mkdirSync(bin, { recursive: true });
  const cli = join(bin, 'claude');
  writeFileSync(cli, `#!${process.execPath}\n` + readFileSync(join(import.meta.dirname, '../../../../packages/cli-adapter/test/fake-claude.mjs'), 'utf8')); chmodSync(cli, 0o755);
  const env = { HOME: root, PATH: '/usr/bin:/bin', FAKE_SCENARIO: 'text_ok', FAKE_VERSION: '2.1.322' };
  const run = createClaudeTextRunner(createCliRunner(env, root, cache), join(root, 'runs'));
  assert((await run({ prompt: 'Synthetic text', what: 'test', signal: new AbortController().signal })).includes('Synthetic note'));
  assert.equal(readdirSync(cache).length, 1);
  env.FAKE_SCENARIO = 'logged_out';
  await assert.rejects(run({ prompt: 'Synthetic text', what: 'test', signal: new AbortController().signal }), (error: unknown) => (error as { appError: { code: string } }).appError.code === 'CLI_AUTH_REQUIRED');
  assert.equal(readdirSync(cache).length, 1, 'Login state is checked separately from binary compatibility');
  env.FAKE_SCENARIO = 'auth_status_error';
  await assert.rejects(run({ prompt: 'Synthetic text', what: 'test', signal: new AbortController().signal }), (error: unknown) => (error as { appError: { code: string } }).appError.code === 'CLI_AUTH_REQUIRED');
  env.FAKE_SCENARIO = 'extra_tool';
  await assert.rejects(run({ prompt: 'Synthetic text', what: 'test', signal: new AbortController().signal }), (error: unknown) => (error as { appError: { code: string } }).appError.code === 'ISOLATION_VIOLATION');
  assert.equal(readdirSync(cache).length, 0, 'A runtime policy violation revokes stored evidence');
  env.FAKE_SCENARIO = 'text_ok';
  assert((await run({ prompt: 'Synthetic text', what: 'test', signal: new AbortController().signal })).includes('Synthetic note'));
  env.FAKE_SCENARIO = 'outside_denied';
  await assert.rejects(run({ prompt: 'Synthetic text', what: 'test', signal: new AbortController().signal }), (error: unknown) => (error as { appError: { code: string } }).appError.code === 'ISOLATION_VIOLATION');
  assert.equal(readdirSync(cache).length, 0, 'A tool event after init also revokes the evidence');
});

test('cancelled text request does not start work or create a scratch directory', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-text-cancel-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let started = false;
  const run = createClaudeTextRunner(async () => { started = true; throw new Error('Must not run'); }, join(root, randomUUID()));
  await assert.rejects(run({ prompt: 'synthetic', what: 'test', signal: AbortSignal.abort() }));
  assert.equal(started, false); assert.equal(readdirSync(root).length, 0);
});

test('cancellation during scratch preparation reaches the CLI runner and cleans its directory', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-text-preparing-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const abort = new AbortController(); let receivedAbort = false;
  const run = createClaudeTextRunner(async (_request, signal) => {
    receivedAbort = signal.aborted;
    return { ok: false, error: { code: 'RUN_INTERRUPTED', message: 'cancelled', retryable: true } };
  }, join(root, 'runs'));
  const result = run({ prompt: 'synthetic', what: 'test', signal: abort.signal });
  abort.abort();
  await assert.rejects(result); assert.equal(receivedAbort, true);
  assert.deepEqual(readdirSync(join(root, 'runs')), []);
});
