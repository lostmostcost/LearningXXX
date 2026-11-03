// Host provides the exact read-only bootstrap path. Never evaluate terminal input.
const { readFileSync } = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (input.length > 1_000_000) process.exit(1); });
process.stdin.on('end', () => {
  try {
    if (JSON.parse(input).hook_event_name !== 'UserPromptSubmit') return;
    const context = readFileSync(process.argv[2], 'utf8');
    if (context.length > 20_000) throw new Error('Oversized context');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
  } catch { process.stderr.write('과목 자료 연결을 읽지 못했습니다. 채팅 화면으로 돌아와 다시 연결하세요.\n'); process.exitCode = 2; }
});
