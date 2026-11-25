/** Real official subscription CLI, synthetic input only. No application profile or course files. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTextCompatibility, locateCli, probeCli, TEXT_COMPAT_POLICY } from '@learningxxx/cli-adapter';
import { createCliRunner } from '../src/cli-runner.ts';
import { createReadableRunner } from '../src/readable-note.ts';

const root = mkdtempSync(join(tmpdir(), 'learningxxx-text-compat-smoke-'));
const signal = AbortSignal.timeout(120_000), located = locateCli(process.env, homedir());
assert(located.ok, 'Official CLI must be installed');
const auth = await probeCli(located.path, process.env, undefined, signal);
if (!auth.ok) throw new Error(`${auth.error.code}: ${auth.error.message}`);
const cache = join(root, 'compatibility');
const first = await createTextCompatibility(cache).check(located.path, auth.probe.version, process.env, signal);
if (!first.ok) throw new Error(`${first.error.code}: ${first.error.message}`);
assert.equal(first.cached, false);
const next = await createTextCompatibility(cache).check(located.path, auth.probe.version, process.env, signal);
assert(next.ok); assert.equal(next.cached, true, 'A fresh checker must reuse the saved evidence');
const run = createReadableRunner(createCliRunner(process.env, homedir(), cache), join(root, 'readable-runs'));
const note = await run({ title: '합성 논리 회로 호환성 확인', text: '[00:00] AND 회로는 두 입력이 모두 1일 때 1을 출력합니다.\n[00:10] 진리표로 네 가지 입력 조합을 확인합니다.', signal });
assert(note.includes('AND') && note.includes('[00:00]'), 'A real readable note must preserve the supplied term and timestamp');
const report = { ok: true, version: auth.probe.version, policy: TEXT_COMPAT_POLICY, firstCached: first.cached, restartCached: next.cached, noteCharacters: note.length, termAndTimestampPreserved: true, syntheticOnly: true, root };
writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report));
