#!/usr/bin/env node
/** Text UI driver. One process owns one hidden renderer; JSONL in, JSONL out. */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareAgentProfile } from '../src/agent-profile.ts';
const require = createRequire(import.meta.url);
const host = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Usage: node apps/desktop/host/scripts/app-control.mjs [--mode fixture|local] [--flow debug|assist] [--profile /private/test-profile] [--out /private/evidence]
Builds the host and UI locally, then reads JSONL commands from stdin.
Each successful command returns a fresh snapshot. Use only its current control IDs.
Commands: snapshot, click(target), focus(target), fill(target,text), select(target,value), selectText(target,text), scroll(target,dy), key(key,shift?), wait(ms<=5000), resize(width,height), render(name), stop.
Example: {"op":"snapshot"}\n{"op":"render","name":"home"}\n{"op":"stop"}
Fixture: synthetic data, production renderer, no network/credentials/CLI. Local: real services in a dedicated test profile, never the normal user's profile. --profile can reuse a profile created by this tool. Native dialog flows stop with NATIVE_REQUIRED.
No state setters, raw IPC, selectors, script execution or permission auto-approval.`);
  console.log('Default flow debug follows visible user steps. Explicit flow assist adds catalog and navigate(courseId?,resourceId?,section?,tab?) navigation shortcuts. Assist evidence is not user-journey verification. Confirmation/native boundaries remain.');
  process.exit(0);
}
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--mode', '--flow', '--profile', '--out'].includes(args[i]) || !args[i + 1] || options.has(args[i])) throw new Error('Invalid or duplicate option; use --help');
  options.set(args[i], args[i + 1]);
}
const mode = options.get('--mode') ?? 'fixture';
if (!['fixture', 'local'].includes(mode)) throw new Error('Invalid mode');
const flow = options.get('--flow') ?? 'debug';
if (!['debug', 'assist'].includes(flow)) throw new Error('Invalid flow');
const temporary = mkdtempSync(join(tmpdir(), 'learningxxx-agent-'));
const profile = resolve(options.get('--profile') ?? join(temporary, 'profile'));
prepareAgentProfile(profile);
const out = resolve(options.get('--out') ?? join(temporary, 'evidence'));
try { mkdirSync(out, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
const stat = lstatSync(out);
if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('--out must be an owned private directory (0700)');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
// Worktree-local tools, no dependency installation, no network or root-manifest changes.
const esbuild = require('esbuild');
const vite = join(host, '../ui/node_modules/vite/bin/vite.js');
const build = spawnSync(process.execPath, [vite, 'build'], { cwd: join(host, '../ui'), env, stdio: ['ignore', 'ignore', 'inherit'] });
if (build.status !== 0) process.exit(build.status ?? 1);
await esbuild.build({ entryPoints: [join(host, 'src/main.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['@anthropic-ai/claude-agent-sdk', 'electron', 'pdfjs-dist'], outfile: join(host, 'dist/main.cjs') });
const child = spawn(require('electron'), [host, `--agent-stdio=${mode}`, `--agent-flow=${flow}`, `--agent-profile=${realpathSync(profile)}`, `--agent-output=${realpathSync(out)}`], { env, stdio: ['pipe', 'pipe', 'inherit'] });
const startup = setTimeout(() => { console.error('Agent startup timed out; no commands will be replayed'); child.kill('SIGTERM'); }, 20_000);
let pending = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  pending += chunk;
  const lines = pending.split('\n'); pending = lines.pop();
  for (const line of lines) {
    const prefix = '@@learningxxx-agent@@';
    if (line.startsWith(prefix)) {
      const response = line.slice(prefix.length);
      if (JSON.parse(response).ready) clearTimeout(startup);
      process.stdout.write(response + '\n');
    }
    else if (line.trim()) process.stderr.write(line + '\n');
  }
});
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {}); // EPIPE after an explicit stop is expected.
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
const stop = () => child.kill('SIGTERM');
process.on('SIGINT', stop); process.on('SIGTERM', stop);
child.on('close', code => {
  clearTimeout(startup);
  process.stdin.unpipe(child.stdin); process.stdin.pause();
  // Evidence and explicit profiles remain. Only the disposable empty-profile location is ours.
  if (!options.has('--profile')) rmSync(join(temporary, 'profile'), { recursive: true, force: true });
  process.exit(code ?? 1);
});
