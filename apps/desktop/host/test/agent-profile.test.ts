import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertAgentProfile, prepareAgentProfile } from '../src/agent-profile.ts';

test('agent creates/reuses dedicated profiles and refuses ordinary or linked profiles', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-profile-test-'));
  try {
    const profile = join(root, 'test');
    assert.equal(prepareAgentProfile(profile), prepareAgentProfile(profile));
    const ordinary = join(root, 'ordinary'); mkdirSync(ordinary, { mode: 0o700 });
    writeFileSync(join(ordinary, 'preferences.json'), 'private data');
    assert.throws(() => prepareAgentProfile(ordinary));
    symlinkSync(profile, join(root, 'linked')); assert.throws(() => prepareAgentProfile(join(root, 'linked')));
    chmodSync(profile, 0o755); assert.throws(() => assertAgentProfile(profile)); chmodSync(profile, 0o700);
    writeFileSync(join(profile, '.learningxxx-agent-profile.json'), '{"schemaVersion":2}'); assert.throws(() => assertAgentProfile(profile));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
