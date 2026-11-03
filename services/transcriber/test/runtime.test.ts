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
test('first preparation loads the lazy aligner before marking a cold cache ready', () => {
  const script = fileURLToPath(new URL('../python/runtime.py', import.meta.url));
  const result = execFileSync('python3', ['-I', '-c', `
import importlib.metadata, json, runpy, sys, tempfile, types
from pathlib import Path
with tempfile.TemporaryDirectory() as temp:
    root=Path(temp)
    def store(repo):
        folder=root/repo.split('/')[-1]; folder.mkdir(exist_ok=True)
        (folder/'config.json').write_text('{}'); (folder/'model.safetensors').write_bytes(b'synthetic')
        return folder
    def snapshot(repo, **kwargs):
        folder=root/repo.split('/')[-1]
        if not folder.exists(): raise FileNotFoundError('cold cache')
        return folder
    calls=[]
    class LazyAligner:
        def __init__(self, repo): self.repo=repo
        def align(self, audio, text, language): calls.append(text); store(self.repo)
    sys.modules['huggingface_hub']=types.SimpleNamespace(snapshot_download=snapshot)
    sys.modules['mlx_qwen3_asr']=types.SimpleNamespace(load_model=store, ForcedAligner=LazyAligner)
    sys.modules['numpy']=types.SimpleNamespace(zeros=lambda n, **kw: [], float32='float32')
    importlib.metadata.version=lambda name: '0.4.4'
    module=runpy.run_path(sys.argv[1])
    sys.argv=['runtime.py','--home',temp,'--model','Qwen/Qwen3-ASR-1.7B','--prepare']
    assert module['main']() == 0
    assert calls == ['테스트']
`, script], { encoding: 'utf8' });
  assert.equal(JSON.parse(result).ready, true);
});
