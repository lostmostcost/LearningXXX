// SessionStart only: save the CLI's actual session ID and history location after /clear or /resume.
// No transcript contents, credentials or prompt text is retained or printed.
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (input.length > 1024 * 1024) process.exit(1); });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    if (event.hook_event_name !== 'SessionStart' || !/^[0-9a-f-]{36}$/i.test(event.session_id)) process.exit(1);
    const target = process.argv[2];
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ sessionId: event.session_id, ...(typeof event.transcript_path === 'string' && event.transcript_path.endsWith(`/${event.session_id}.jsonl`) ? { transcriptPath: event.transcript_path } : {}) }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  } catch { process.exitCode = 1; }
});
