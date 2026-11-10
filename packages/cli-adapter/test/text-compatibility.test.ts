import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { createTextCompatibility, startRun, TEXT_COMPAT_POLICY } from '../src/index.ts';

const SOURCE = readFileSync(join(import.meta.dirname, 'fake-claude.mjs'), 'utf8');
function fixture(t: TestContext, scenario = 'text_ok') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'text-compat-test-'))), cli = join(root, 'claude');
  writeFileSync(cli, `#!${process.execPath}\n${SOURCE}`); chmodSync(cli, 0o755);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = join(root, 'cache'), record = join(root, 'calls.jsonl');
  const env: NodeJS.ProcessEnv = { HOME: root, PATH: '/usr/bin:/bin', FAKE_SCENARIO: scenario, FAKE_VERSION: '2.1.322', FAKE_RECORD: record };
  return { root, cli, cache, env, calls: () => existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 20)); }
  assert.fail('Expected process/cleanup state did not arrive');
}

test('a new CLI version is tested once, bound to its binary and policy, and reused after checker restart', async t => {
  const f = fixture(t), checker = createTextCompatibility(f.cache);
  const first = await checker.check(f.cli, '2.1.322', f.env);
  assert(first.ok); assert.equal(first.cached, false); assert.equal(f.calls().length, 1);
  assert.equal(await checker.unchanged(first.identity), true);
  const second = await createTextCompatibility(f.cache).check(f.cli, '2.1.322', f.env);
  assert(second.ok); assert.equal(second.cached, true); assert.equal(f.calls().length, 1);
  const file = join(f.cache, readdirSync(f.cache)[0]!);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.policy, TEXT_COMPAT_POLICY); assert.equal(saved.version, '2.1.322');
  assert(!readFileSync(file, 'utf8').includes('COMPAT-OK-'));
  assert.equal(statSync(file).mode & 0o077, 0);
  const work = join(f.root, randomUUID()); mkdirSync(work);
  const outcome = await startRun({ runId: randomUUID(), appSessionId: randomUUID(), cliSessionId: randomUUID(), workspacePath: work, mode: 'independent', profile: 'text', resume: false, prompt: 'Synthetic text task' }, { cliPath: second.identity.path, env: f.env, textProof: second.proof });
  assert(outcome.ok);
  const events = []; for await (const e of outcome.events) events.push(e);
  assert.equal(events.at(-1)?.type, 'run.completed'); assert.equal(f.calls().length, 2);
});

test('same version with replaced bytes, changed version or changed policy evidence is checked again', async t => {
  const f = fixture(t), checker = createTextCompatibility(f.cache);
  const first = await checker.check(f.cli, '2.1.322', f.env); assert(first.ok);
  writeFileSync(f.cli, `#!${process.execPath}\n${SOURCE}\n// replaced binary\n`); chmodSync(f.cli, 0o755);
  assert.equal(await checker.unchanged(first.identity), false);
  const second = await checker.check(f.cli, '2.1.322', f.env); assert(second.ok); assert.equal(second.cached, false);
  const record = join(f.cache, `${second.identity.key}.json`), saved = JSON.parse(readFileSync(record, 'utf8'));
  writeFileSync(record, JSON.stringify({ ...saved, policy: 'old-policy' }));
  const third = await checker.check(f.cli, '2.1.322', f.env); assert(third.ok); assert.equal(third.cached, false);
  const fourth = await checker.check(f.cli, '2.1.323', { ...f.env, FAKE_VERSION: '2.1.323' }); assert(fourth.ok); assert.equal(fourth.cached, false);
  assert.equal(f.calls().length, 4);
});

test('failed protocol, tools, MCP, canary, usage and authentication checks never become successful cache records', async t => {
  for (const scenario of ['extra_tool', 'extra_mcp', 'missing_tools', 'bad_mcp_metadata', 'wrong_session', 'old_version', 'bad_permission', 'null_json', 'unknown_option', 'text_leak', 'text_marker', 'usage_limit', 'auth_expired', 'network_error']) {
    const f = fixture(t, scenario);
    const result = await createTextCompatibility(f.cache).check(f.cli, '2.1.322', f.env);
    assert(!result.ok, scenario); assert.equal(readdirSync(f.cache).length, 0, scenario);
    if (scenario === 'usage_limit') assert.equal(result.error.code, 'USAGE_LIMIT');
    if (scenario === 'auth_expired') assert.equal(result.error.code, 'CLI_AUTH_REQUIRED');
    if (scenario === 'old_version') assert.equal(result.error.retryable, true, 'A version change during preparation can be retried');
    if (scenario === 'network_error') { assert.equal(result.error.code, 'INTERNAL'); assert.equal(result.error.retryable, true); assert(result.error.message.includes('연결')); }
    const call = f.calls()[0]; assert(call); assert(!existsSync(dirname(call.cwd)), 'Probe scratch tree is removed');
  }
});

test('malformed or symlinked cache evidence is rechecked and never overwrites a linked target', async t => {
  const f = fixture(t), checker = createTextCompatibility(f.cache);
  const first = await checker.check(f.cli, '2.1.322', f.env); assert(first.ok);
  const file = join(f.cache, `${first.identity.key}.json`);
  writeFileSync(file, '{broken');
  const second = await checker.check(f.cli, '2.1.322', f.env); assert(second.ok); assert.equal(second.cached, false);
  const target = join(f.root, 'external-evidence'), contents = readFileSync(file, 'utf8'); writeFileSync(target, contents);
  unlinkSync(file); symlinkSync(target, file);
  const third = await checker.check(f.cli, '2.1.322', f.env); assert(third.ok); assert.equal(third.cached, false);
  assert.equal(readFileSync(target, 'utf8'), contents); assert.equal(f.calls().length, 3);
});

test('concurrent checks share one probe; cancelling one waiter does not cancel another', async t => {
  const f = fixture(t, 'text_slow'), checker = createTextCompatibility(f.cache), abort = new AbortController();
  const a = checker.check(f.cli, '2.1.322', f.env, abort.signal), b = checker.check(f.cli, '2.1.322', f.env);
  await until(() => f.calls().length === 1); abort.abort();
  const [one, two] = await Promise.all([a, b]);
  assert(!one.ok); assert.equal(one.error.code, 'RUN_INTERRUPTED'); assert(two.ok);
  assert.equal(f.calls().length, 1); assert.equal(readdirSync(f.cache).length, 1);
});

test('cancelling the last waiter stops the probe and leaves no successful evidence', async t => {
  const f = fixture(t, 'text_slow'), checker = createTextCompatibility(f.cache), abort = new AbortController();
  const result = checker.check(f.cli, '2.1.322', f.env, abort.signal);
  await until(() => f.calls().length === 1); abort.abort();
  const end = await result; assert(!end.ok); assert.equal(end.error.code, 'RUN_INTERRUPTED');
  await until(() => !existsSync(dirname(f.calls()[0].cwd)));
  assert.equal(readdirSync(f.cache).length, 0);
});

test('unsafe cache links and credential environments cannot authorize the text profile', async t => {
  const f = fixture(t), target = join(f.root, 'outside-cache'); mkdirSync(target); symlinkSync(target, f.cache);
  const checker = createTextCompatibility(f.cache);
  const unsafe = await checker.check(f.cli, '2.1.322', f.env); assert(!unsafe.ok); assert.equal(f.calls().length, 0);
  const forbidden = await checker.check(f.cli, '2.1.322', { ...f.env, ANTHROPIC_API_KEY: 'synthetic' });
  assert(!forbidden.ok); assert.equal(forbidden.error.code, 'FORBIDDEN_CREDENTIAL_ENV'); assert.equal(f.calls().length, 0);
});
