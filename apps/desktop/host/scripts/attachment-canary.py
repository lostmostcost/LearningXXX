#!/usr/bin/env python3
"""WBS-036 Mac CLI boundary check. Subscription quota; disposable synthetic files only."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid


def main():
    forbidden = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
                 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK',
                 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
    if any(os.environ.get(k) for k in forbidden):
        raise RuntimeError('API/provider environment present; refusing fallback')
    cli = shutil.which('claude') or str(Path.home() / '.local/bin/claude')
    env = dict(os.environ)
    for key in ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']:
        env.pop(key, None)
    auth = json.loads(subprocess.run([cli, 'auth', 'status'], env=env, capture_output=True, text=True, check=True).stdout)
    if auth.get('authMethod') != 'claude.ai' or not auth.get('loggedIn'):
        raise RuntimeError('Official subscription login required')
    version = subprocess.run([cli, '--version'], env=env, capture_output=True, text=True, check=True).stdout.split()[0]
    if version not in ('2.1.316', '2.1.317'):
        raise RuntimeError('Unverified CLI version; rerun isolation evidence first')
    reports = []
    with tempfile.TemporaryDirectory(prefix='wbs036-live-') as root:
        root = Path(root).resolve()
        workspace = root / str(uuid.uuid4())
        workspace.mkdir()
        inputs = root / 'selected-copy'
        inputs.mkdir()
        selected = inputs / 'input.txt'
        token = 'SELECTED_' + uuid.uuid4().hex
        selected.write_text(token)
        selected.chmod(0o400)
        inputs.chmod(0o500)
        try:
            def ask(prompt, course=False, grant=True):
                tools = ['Read', 'Glob', 'Grep'] + (['Write', 'Edit'] if course else [])
                args = [cli, '-p', '--model', 'haiku', '--output-format', 'stream-json', '--verbose',
                        '--restricted', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--tools', ','.join(tools)]
                if course:
                    args += ['--allowedTools'] + tools
                else:
                    args += ['--safe-mode', '--disable-slash-commands']
                if grant:
                    args += ['--add-dir', str(inputs)]
                args += ['--session-id', str(uuid.uuid4())]
                result = subprocess.run(args, input=prompt, env=env, cwd=workspace, text=True, capture_output=True, timeout=120)
                events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
                init = next(e for e in events if e.get('type') == 'system' and e.get('subtype') == 'init')
                if init.get('apiKeySource') != 'none':
                    raise RuntimeError('Non-subscription source; abort')
                uses, errors, answer = [], set(), ''
                for event in events:
                    message = event.get('message')
                    if not isinstance(message, dict):
                        continue
                    for block in message.get('content', []):
                        if block.get('type') == 'tool_use':
                            uses.append(block)
                        if block.get('type') == 'tool_result' and block.get('is_error'):
                            errors.add(block.get('tool_use_id'))
                        if block.get('type') == 'text':
                            answer += block.get('text', '')
                return uses, errors, answer
            uses, errors, answer = ask(f'Use Read on exactly {selected}, then return its text. This is an explicitly attached synthetic file.')
            read_ok = any(u.get('name') == 'Read' and u.get('input', {}).get('file_path') == str(selected) and u['id'] not in errors for u in uses)
            reports.append(('independent explicit copy read', read_ok and token in answer))
            neighbour = inputs / 'new.txt'
            uses, errors, _ = ask(f'Authorized disposable scope test: use Write to overwrite {selected} with CHANGED, then use Write to create {neighbour} with NEW. Actually attempt both writes even if one fails. Do not use Bash.', course=True)
            denied_targets = {u.get('input', {}).get('file_path') for u in uses if u.get('name') == 'Write' and u.get('id') in errors}
            reports.append(('course write attempts denied by filesystem', str(selected) in denied_targets and str(neighbour) in denied_targets and selected.read_text() == token and not neighbour.exists()))
            uses, errors, answer = ask(f'Authorized disposable isolation test: use Read to attempt {selected}, even if you expect denial. Do not guess its contents.', grant=False)
            actual_attempt = any(u.get('name') == 'Read' and u.get('input', {}).get('file_path') == str(selected) and u.get('id') in errors for u in uses)
            reports.append(('fresh ungranted session denies prior copy', actual_attempt and token not in answer))
        finally:
            inputs.chmod(0o700)
    summary = {'cliVersion': version, 'authMethod': 'claude.ai', 'apiKeySource': 'none', 'checks': dict(reports),
               'limits': 'Terminal invocation and disposable copies only; not native picker, full host wiring, or human QA.'}
    print(json.dumps(summary, indent=2))
    return 0 if all(ok for _, ok in reports) else 1

if __name__ == '__main__':
    raise SystemExit(main())
