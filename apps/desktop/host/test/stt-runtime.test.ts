import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SttRuntimeService } from '../src/stt-runtime.ts';
const tick = () => new Promise(r => setTimeout(r, 10));
const base = { root: '/synthetic', source: '/synthetic', model: 'Qwen/Qwen3-ASR-1.7B', supported: true };
test('missing runtime blocks transcription; setup is single-flight and resumes only after verified readiness', async () => {
  let ready = false, installs = 0, resumed = 0, finish!: () => void;
  const runtime = new SttRuntimeService({ ...base, probe: async () => ready, install: async (_, stage) => { installs++; stage('models'); await new Promise<void>(r => { finish = r; }); ready = true; }, onReady: async () => { resumed++; } });
  await assert.rejects(runtime.requireReady(), /엔진 준비/);
  await Promise.all([runtime.prepare(), runtime.prepare()]); assert.equal(installs, 1);
  assert.equal((await runtime.status(true)).state, 'installing');
  finish(); await tick(); assert.equal((await runtime.status()).state, 'ready'); assert.equal(resumed, 1);
  await runtime.requireReady(); await runtime.stop(); await assert.rejects(runtime.prepare(), /closing/);
});
test('failed validation never declares ready or resumes jobs; cancellation can be retried', async () => {
  let resumed = 0;
  const invalid = new SttRuntimeService({ ...base, probe: async () => false, install: async () => {}, onReady: async () => { resumed++; } });
  await invalid.prepare(); await tick(); assert.equal((await invalid.status()).state, 'failed'); assert.equal(resumed, 0);
  const cancelled = new SttRuntimeService({ ...base, probe: async () => false, install: async signal => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  await cancelled.prepare(); assert.equal((await cancelled.cancel()).state, 'failed');
  assert.equal((await cancelled.prepare()).state, 'installing'); await cancelled.stop(); await invalid.stop();
});
test('shutdown during a probe cannot launch an installer; unsupported systems cannot install', async () => {
  let finish!: (value: boolean) => void, installs = 0;
  const runtime = new SttRuntimeService({ ...base, probe: () => new Promise(r => { finish = r; }), install: async () => { installs++; } });
  const preparing = runtime.prepare(); await runtime.stop(); finish(false); await assert.rejects(preparing, /closing/); assert.equal(installs, 0);
  const unsupported = new SttRuntimeService({ ...base, supported: false, install: async () => { installs++; } });
  assert.equal((await unsupported.prepare()).state, 'unsupported'); assert.equal(installs, 0);
});
test('repair cannot mutate the runtime while transcription holds it', async () => {
  let finish!: () => void, installs = 0;
  const runtime = new SttRuntimeService({ ...base, probe: async () => true, install: async () => { installs++; } });
  const running = runtime.run(() => new Promise<void>(r => { finish = r; })); await tick();
  await assert.rejects(runtime.prepare(), /전사가 끝난 뒤/); assert.equal(installs, 0);
  finish(); await running; await runtime.prepare(); await tick(); assert.equal(installs, 1); await runtime.stop();
});
test('cancelling the real installer terminates a shell and its TERM-resistant descendant', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const source = await mkdtemp(join(tmpdir(), 'wbs053-installer-'));
  try {
    await writeFile(join(source, 'setup.sh'), 'trap "" TERM\nsleep 60 &\necho started > "$1/started"\nwait\n');
    const runtime = new SttRuntimeService({ ...base, root: source, source, probe: async () => false });
    await runtime.prepare();
    for (let i = 0; i < 100; i++) { if (await readFile(join(source, 'started'), 'utf8').catch(() => '') === 'started\n') break; await tick(); }
    assert.equal(await readFile(join(source, 'started'), 'utf8'), 'started\n');
    assert.equal((await runtime.cancel()).state, 'failed'); await runtime.stop();
  } finally { await rm(source, { recursive: true, force: true }); }
});
