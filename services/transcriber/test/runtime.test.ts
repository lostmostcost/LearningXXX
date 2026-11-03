import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
test('runtime readiness accepts complete inference artifacts without repository documentation, and rejects missing weight shards', () => {
  const script = fileURLToPath(new URL('../python/runtime.py', import.meta.url));
  const result = execFileSync('python3', ['-I', '-c', `
import json, runpy, sys, tempfile, types
from pathlib import Path
with tempfile.TemporaryDirectory() as temp:
    folder=Path(temp)
    (folder/'config.json').write_text('{}')
    (folder/'model.safetensors.index.json').write_text(json.dumps({'weight_map': {'layer': 'weights.safetensors'}}))
    (folder/'weights.safetensors').write_bytes(b'synthetic weights')
    def snapshot(repo, **kwargs):
        assert kwargs['local_files_only'] is True
        assert not any(__import__('fnmatch').fnmatch('README.md', p) for p in kwargs['allow_patterns'])
        return temp
    sys.modules['huggingface_hub']=types.SimpleNamespace(snapshot_download=snapshot)
    check=runpy.run_path(sys.argv[1])['cached_model']
    assert check('synthetic') == folder
    (folder/'weights.safetensors').unlink()
    try: check('synthetic')
    except FileNotFoundError: pass
    else: raise AssertionError('missing shard accepted')
print('ok')
`, script], { encoding: 'utf8' });
  assert.equal(result.trim(), 'ok');
});
