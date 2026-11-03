import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Session } from '@learningxxx/contracts';
import { NativeTerminalService, type Pty, type SpawnPty, type TerminalOptions } from '../src/native-terminal.ts';
class FakePty implements Pty {
  pid = 99999999; writes: string[] = []; sizes: number[][] = []; killed = false;
  data?: (data: string) => void; exit?: (event: { exitCode: number }) => void;
  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]); }
  kill() { this.killed = true; this.exit?.({ exitCode: 0 }); }
  onData(callback: (data: string) => void) { this.data = callback; return { dispose() {} }; }
  onExit(callback: (event: { exitCode: number }) => void) { this.exit = callback; return { dispose() {} }; }
}
function setup(t: { after: (f: () => void) => void }, spawn?: SpawnPty, extra: Partial<TerminalOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-service-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const id = randomUUID();
  let session = Session.parse({ appSessionId: id, mode: 'independent', engine: 'native', workspaceKey: `native-sessions/${id}`, title: 'fixture', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), status: 'idle' });
  const pty = new FakePty(), launches: { args: string[]; cwd: string }[] = [];
  const service = new NativeTerminalService({ ...extra, root, getSession: sid => { assert.equal(sid, id); return session; }, prepare: async () => ({ path: '/official/claude', env: { HOME: '/fixture' } }), spawn: spawn ?? (async (_file, args, options) => { launches.push({ args, cwd: options.cwd }); return pty; }), stopGroup: p => p.kill() });
  return { root, id, pty, service, launches, setSession: (patch: Partial<Session>) => { session = { ...session, ...patch }; } };
}
test('one live CLI per app session, raw slash bytes and resized geometry reach it', async t => {
  const f = setup(t); const request = { appSessionId: f.id, cols: 80, rows: 24 };
  const [a, b] = await Promise.all([f.service.open(request), f.service.open(request)]);
  assert.equal(a.terminalId, b.terminalId); assert.equal(f.launches.length, 1);
  assert.deepEqual(f.launches[0]!.args, ['--permission-mode', 'default']); // interactive, not -p and not application slash emulation
  await f.service.write({ terminalId: a.terminalId, data: '/compact\t\x1b[B\r' });
  assert.equal(f.pty.writes[0], '/compact\t\x1b[B\r');
  f.service.resize({ terminalId: a.terminalId, cols: 120, rows: 40 }); assert.deepEqual(f.pty.sizes, [[120, 40]]);
  assert.ok(f.service.isActive(f.id));
});
test('replay is bounded, detects missing output and never persists terminal text', async t => {
  const f = setup(t); const { terminalId } = await f.service.open({ appSessionId: f.id, cols: 80, rows: 24 });
  f.pty.data!('one'); f.pty.data!('x'.repeat(512001));
  const result = f.service.read({ terminalId, after: 0 });
  assert.equal(result.gap, true); assert.equal(result.chunks.length, 1); assert.equal(result.chunks[0]!.data.length, 512000);
});
test('stop, exit and reconnect use the CLI history without reusing a dead PTY', async t => {
  const f = setup(t); const { terminalId } = await f.service.open({ appSessionId: f.id, cols: 80, rows: 24 });
  f.service.close({ terminalId }); assert.ok(f.pty.killed); assert.equal(f.service.read({ terminalId, after: 0 }).state, 'exited');
  await assert.rejects(f.service.write({ terminalId, data: '/help' }));
  await f.service.open({ appSessionId: f.id, cols: 80, rows: 24 }); assert.deepEqual(f.launches[1]!.args, ['--continue', '--permission-mode', 'default']);
});
test('actual SessionStart ID wins over directory continuation after /clear or /resume', async t => {
  const f = setup(t), nativeId = randomUUID(); mkdirSync(join(f.root, f.id));
  const transcriptPath = join(f.root, `${nativeId}.jsonl`); writeFileSync(transcriptPath, 'synthetic');
  writeFileSync(join(f.root, f.id, '.learningxxx-session.json'), JSON.stringify({ sessionId: nativeId, transcriptPath }));
  await f.service.open({ appSessionId: f.id, cols: 80, rows: 24 }); assert.deepEqual(f.launches[0]!.args, ['--resume', nativeId, '--permission-mode', 'default']);
});
test('empty /clear sessions do not resume an older conversation', async t => {
  const f = setup(t); mkdirSync(join(f.root, f.id));
  writeFileSync(join(f.root, f.id, '.learningxxx-started'), 'yes');
  writeFileSync(join(f.root, f.id, '.learningxxx-session.json'), JSON.stringify({ sessionId: randomUUID() }));
  await f.service.open({ appSessionId: f.id, cols: 80, rows: 24 });
  assert.deepEqual(f.launches[0]!.args, ['--permission-mode', 'default']);
});
test('archiving while auth preparation is pending prevents launch; shutdown cannot reopen', async t => {
  const f = setup(t); f.setSession({ archivedAt: new Date().toISOString() });
  await assert.rejects(f.service.open({ appSessionId: f.id, cols: 80, rows: 24 }));
  assert.equal(f.launches.length, 0); f.setSession({ archivedAt: undefined }); f.service.stopAll();
  await assert.rejects(f.service.open({ appSessionId: f.id, cols: 80, rows: 24 }));
});
test('symlink session directories cannot escape the host-owned root', async t => {
  const f = setup(t); const outside = mkdtempSync(join(tmpdir(), 'native-outside-')); t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(f.root, f.id));
  await assert.rejects(f.service.open({ appSessionId: f.id, cols: 80, rows: 24 })); assert.equal(f.launches.length, 0);
});
test('SessionStart recorder saves only a UUID, never raw payload or transcript', t => {
  const f = setup(t), target = join(f.root, 'session.json'), nativeId = randomUUID();
  execFileSync(process.execPath, [fileURLToPath(new URL('../src/native-session-hook.cjs', import.meta.url)), target], { input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: nativeId, transcript_path: '/private/fixture', extra: 'not-saved' }) });
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { sessionId: nativeId });
});
test('course terminal uses bound context and refreshes before submission without altering slash bytes',async t=>{
 let calls=0,blocked=false;const f=setup(t,undefined,{hookPath:'/fixture/session.cjs',courseHookPath:'/fixture/course.cjs',prepareCourse:async()=>{calls++;if(blocked)throw new Error('account changed');return{brief:'BOUND_COURSE',revision:calls,readDirectory:'/fixture/versions'};}});
 const {terminalId}=await f.service.open({appSessionId:f.id,cols:80,rows:24});const args=f.launches[0]!.args;assert.ok(args.includes('BOUND_COURSE'));assert.ok(args.includes('/fixture/versions'));assert.match(args.at(-1)!,/UserPromptSubmit/);
 await f.service.write({terminalId,data:'/model'});assert.equal(calls,1);await f.service.write({terminalId,data:'\r'});assert.equal(calls,2);assert.deepEqual(f.pty.writes,['/model','\r']);
 blocked=true;await assert.rejects(f.service.write({terminalId,data:'\r'}));assert.equal(f.pty.writes.length,2);
});
test('course hook returns only the bound bootstrap and fails closed if it cannot read it',t=>{
 const f=setup(t),path=join(f.root,'BOOTSTRAP.md');writeFileSync(path,'BOUND_COURSE');const hook=fileURLToPath(new URL('../src/native-course-hook.cjs',import.meta.url));
 const result=execFileSync(process.execPath,[hook,path],{input:JSON.stringify({hook_event_name:'UserPromptSubmit'})}).toString();assert.equal(JSON.parse(result).hookSpecificOutput.additionalContext,'BOUND_COURSE');
 assert.throws(()=>execFileSync(process.execPath,[hook,path+'-missing'],{input:JSON.stringify({hook_event_name:'UserPromptSubmit'}),stdio:['pipe','pipe','pipe']}));
});
test('asynchronous course refresh preserves ordering of concurrent terminal input',async t=>{
 let release:()=>void=()=>{};let calls=0;const f=setup(t,undefined,{prepareCourse:async()=>{if(++calls>1)await new Promise<void>(r=>release=r);return undefined;}});
 const {terminalId}=await f.service.open({appSessionId:f.id,cols:80,rows:24});const first=f.service.write({terminalId,data:'\r'}),second=f.service.write({terminalId,data:'next'});await new Promise(r=>setTimeout(r,5));assert.deepEqual(f.pty.writes,[]);release();await Promise.all([first,second]);assert.deepEqual(f.pty.writes,['\r','next']);
});
test('shutdown during course preparation never launches a replacement CLI',async t=>{
 let release:()=>void=()=>{};const f=setup(t,undefined,{prepareCourse:()=>new Promise<undefined>(r=>release=()=>r(undefined))});
 const opening=f.service.open({appSessionId:f.id,cols:80,rows:24}),rejected=assert.rejects(opening);await new Promise(r=>setTimeout(r,5));const closing=f.service.stopAll();release();await rejected;await closing;assert.equal(f.launches.length,0);
});
