import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk/core';
import type { Session } from '@learningxxx/contracts';
import { ConversationService, type ConversationOptions } from '../src/conversation-service.ts';
class FakeQuery {
  stopped = false; wake?: (() => void) | undefined; frames: SDKMessage[] = []; changes: unknown[] = []; rejects = false;
  async *[Symbol.asyncIterator]() { while (!this.stopped) { const f = this.frames.shift(); if (f) yield f; else await new Promise<void>(r => this.wake = r); } }
  emit(frame: unknown) { this.frames.push(frame as SDKMessage); this.wake?.(); }
  async initializationResult() { return { commands: [{ name: 'compact', description: 'Compact', argumentHint: '' }], models: [{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['low', 'high'] }, { value: 'haiku', displayName: 'Haiku', supportedEffortLevels: ['low'] }] }; }
  async applyFlagSettings(change: unknown) { this.changes.push(change); if (this.rejects) throw new Error('vendor rejected'); }
  async setPermissionMode(mode: string) { this.changes.push({ mode }); }
  async interrupt(options: unknown) { this.changes.push(options); return { still_queued: [], cancelled: [] }; }
  close() { this.stopped = true; this.wake?.(); }
}
function setup(t: { after: (f: () => void | Promise<void>) => void }, prepareCourse?: ConversationOptions['prepareCourse']) {
  const root = mkdtempSync(join(tmpdir(), 'rich-service-')), id = randomUUID(); const q = new FakeQuery(); let options: Options; let created = 0;
  const session = { appSessionId: id, engine: 'chat', mode: 'independent', status: 'idle' } as Session;
  const service = new ConversationService({ ...(prepareCourse ? { prepareCourse } : {}), root, getSession: () => session, rename() {}, nativeActive: () => false, prepare: async () => '/official/claude', createQuery: ((args: { options: Options }) => { options = args.options; return (++created === 1 ? q : new FakeQuery()) as unknown as Query; }) as never });
  t.after(async () => { await service.stopAll(); rmSync(root, { recursive: true, force: true }); });
  return { id, q, service, options: () => options, created: () => created };
}
const tick = () => new Promise(r => setTimeout(r, 5));
test('model, effort and plan use live controls; failed or unsupported changes are not displayed as applied', async t => {
  const f = setup(t); await f.service.open(f.id);
  await f.service.configure(f.id, { model: 'sonnet', effort: 'high', mode: 'plan' });
  assert.deepEqual(f.q.changes, [{ model: 'sonnet', effortLevel: null }, { effortLevel: 'high' }, { mode: 'plan' }]);
  assert.equal(f.service.state(f.id).mode, 'plan');
  await assert.rejects(f.service.configure(f.id, { effort: 'max' }));
  assert.equal(f.service.state(f.id).effort, 'high');
  f.q.rejects = true; await assert.rejects(f.service.configure(f.id, { model: 'haiku' }));
  assert.equal(f.service.state(f.id).model, 'sonnet');
  assert.equal(f.options().permissionMode, 'default');
  assert.equal(f.options().pathToClaudeCodeExecutable, '/official/claude');
});
test('streamed text is not doubled by the final assistant frame; unknown slash commands never become model prompts', async t => {
  const f = setup(t); await f.service.open(f.id); await assert.rejects(f.service.send(f.id, '/unsupported', randomUUID()));
  assert.equal(f.service.state(f.id).messages.length, 0);
  const requestId = randomUUID(); await f.service.send(f.id, 'hello', requestId); await f.service.send(f.id, 'hello', requestId);
  f.q.emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '**Hello**' } } });
  f.q.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '**Hello**' }] } });
  f.q.emit({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 2 } });
  await tick(); const state = f.service.state(f.id);
  assert.equal(state.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(state.messages.find(m => m.role === 'assistant')?.text, '**Hello**');
  assert.equal(state.busy, false);
});
test('permission requests are explicit, abortable and cannot be answered from another request', async t => {
  const f = setup(t); await f.service.open(f.id); const abort = new AbortController();
  const promise = f.options().canUseTool!('Edit', { file_path: '/fixture/note' }, { signal: abort.signal, toolUseID: 'tool-1', requestId: 'req-1' });
  await tick(); assert.equal(f.service.state(f.id).permissions.length, 1);
  assert.throws(() => f.service.answer(f.id, 'wrong-id', true));
  abort.abort(); assert.equal((await promise)?.behavior, 'deny');
  assert.equal(f.service.state(f.id).permissions.length, 0);
});
test('interrupt requests cancellation of queued input too; closing denies pending permissions and reaps the query', async t => {
  const f = setup(t); await f.service.open(f.id);
  await f.service.interrupt(f.id); assert.deepEqual(f.q.changes.at(-1), { cancelQueued: true });
  const p = f.options().canUseTool!('Bash', { command: 'fixture' }, { signal: new AbortController().signal, toolUseID: 'tool-2', requestId: 'req-2' });
  await tick(); await f.service.close(f.id); assert.equal((await p)?.behavior, 'deny'); assert.ok(f.q.stopped);
});

test('a local command can end without a result frame and engine permission-mode changes remain visible', async t => {
 const f = setup(t); await f.service.open(f.id); await f.service.send(f.id,'/compact',randomUUID());
 f.q.emit({type:'system',subtype:'local_command_output',content:'Compacted'});
 f.q.emit({type:'system',subtype:'status',status:null,permissionMode:'plan'});
 f.q.emit({type:'system',subtype:'session_state_changed',state:'idle'});
 await tick(); assert.equal(f.service.state(f.id).busy,false);assert.equal(f.service.state(f.id).mode,'plan');
 assert.equal(f.service.state(f.id).messages.at(-1)?.text,'Compacted');
});
test('API authentication unexpectedly selected by the engine fails closed; no further prompts are sent', async t => {
 const f=setup(t);await f.service.open(f.id);f.q.emit({type:'system',subtype:'init',apiKeySource:'user',model:'test',permissionMode:'default'});await tick();
 assert.equal(f.service.state(f.id).connected,false);assert.match(f.service.state(f.id).error,/구독/);assert.ok(f.q.stopped);
 await assert.rejects(f.service.send(f.id,'hello',randomUUID()));await assert.rejects(f.service.configure(f.id,{model:'sonnet'}));
});
test('busy handoff cannot open a second engine; a detached connection is released', async t => {
 const f=setup(t);await f.service.open(f.id);await f.service.send(f.id,'work',randomUUID());await assert.rejects(f.service.detach(f.id));assert.equal(f.service.active(f.id),true);
 f.q.emit({type:'system',subtype:'session_state_changed',state:'idle'});await tick();await f.service.detach(f.id);assert.equal(f.service.active(f.id),false);assert.ok(f.q.stopped);
});
test('AskUserQuestion answers are returned only for the explicit active request',async t=>{
 const f=setup(t);await f.service.open(f.id);const promise=f.options().canUseTool!('AskUserQuestion',{questions:[{question:'Which?'}]},{signal:new AbortController().signal,toolUseID:'question',requestId:'request'});await tick();
 const p=f.service.state(f.id).permissions[0]!;f.service.answer(f.id,p.id,true,{'Which?':'A'});assert.deepEqual(await promise,{behavior:'allow',updatedInput:{questions:[{question:'Which?'}],answers:{'Which?':'A'}}});
 assert.equal(f.service.state(f.id).permissions.length,0);assert.throws(()=>f.service.answer(f.id,p.id,true));
});
test('shutdown closes a transport still waiting for initialization instead of waiting forever',async t=>{
 const f=setup(t);let rejectInit:(reason:Error)=>void=()=>{};
 f.q.initializationResult=()=>new Promise<never>((_,reject)=>{rejectInit=reject;});
 const close=f.q.close.bind(f.q);f.q.close=()=>{close();rejectInit(new Error('closed'));};
 const opening=f.service.open(f.id);const rejected=assert.rejects(opening);await tick();await f.service.stopAll();await rejected;assert.ok(f.q.stopped);assert.equal(f.service.active(f.id),false);
});
test('simultaneous reconnects reserve one replacement before awaiting the disconnected entry',async t=>{
 const f=setup(t);await f.service.open(f.id);f.q.close();await tick();
 const [a,b]=await Promise.all([f.service.open(f.id),f.service.open(f.id)]);
 assert.equal(f.created(),2);assert.equal(a.connected,true);assert.equal(b.connected,true);
});
test('the eighth session can reconnect without counting its own reservation twice',async t=>{
 const root=mkdtempSync(join(tmpdir(),'chat-cap-')), ids=Array.from({length:9},()=>randomUUID()), queries:FakeQuery[]=[];
 const service=new ConversationService({root,getSession:id=>({appSessionId:id,engine:'chat',mode:'independent',status:'idle'} as Session),rename(){},nativeActive:()=>false,prepare:async()=>'/official/claude',createQuery:(()=>{const q=new FakeQuery();queries.push(q);return q as unknown as Query;}) as never});
 t.after(async()=>{await service.stopAll();rmSync(root,{recursive:true,force:true});});
 await Promise.all(ids.slice(0,8).map(id=>service.open(id)));await assert.rejects(service.open(ids[8]!));
 queries[7]!.close();await tick();await service.open(ids[7]!);assert.equal(queries.length,9);
});
test('course identity is appended on startup and refreshed on every real prompt after compact',async t=>{
 let revision=1,calls=0;
 const f=setup(t,async()=>({brief:`COURSE_BOUND_REV_${revision}`,revision,readDirectory:'/fixture/course-versions'}));await f.service.open(f.id);
 assert.deepEqual(f.options().additionalDirectories,['/fixture/course-versions']);assert.equal((f.options().systemPrompt as {append:string}).append,'COURSE_BOUND_REV_1');
 const hook=f.options().hooks!.UserPromptSubmit![0]!.hooks[0]!;
 await f.service.send(f.id,'/compact',randomUUID());f.q.emit({type:'system',subtype:'session_state_changed',state:'idle'});await tick();revision=2;
 await f.service.send(f.id,'4주차 강의 요약해줘',randomUUID());const result=await hook({hook_event_name:'UserPromptSubmit'} as never,undefined,{signal:new AbortController().signal});
 assert.equal((result as {hookSpecificOutput:{additionalContext:string}}).hookSpecificOutput.additionalContext,'COURSE_BOUND_REV_2');
 assert.equal(f.service.state(f.id).messages.at(-1)?.text,'4주차 강의 요약해줘');
});
test('a failed course refresh does not enqueue or record the question; the same request can be retried',async t=>{
 let blocked=false;const f=setup(t,async()=>{if(blocked)throw new Error('account changed');return undefined;});await f.service.open(f.id);blocked=true;const uuid=randomUUID();
 await assert.rejects(f.service.send(f.id,'4주차 강의 요약해줘',uuid));assert.equal(f.service.state(f.id).busy,false);assert.equal(f.service.state(f.id).messages.length,0);
 blocked=false;await f.service.send(f.id,'4주차 강의 요약해줘',uuid);assert.equal(f.service.state(f.id).messages.length,1);
});

function resumeSetup(t: { after: (f: () => void | Promise<void>) => void }, sessions: NonNullable<ConversationOptions['sessions']>) {
  const root = mkdtempSync(join(tmpdir(), 'wbs060-')), id = randomUUID(); let options: Options | undefined; const queries: FakeQuery[] = [];
  const session = { appSessionId: id, engine: 'chat', mode: 'independent', status: 'idle' } as Session;
  const service = new ConversationService({ root, getSession: () => session, rename() {}, nativeActive: () => false, prepare: async () => '/official/claude', sessions,
    createQuery: ((args: { options: Options }) => { options = args.options; const q = new FakeQuery(); queries.push(q); return q as unknown as Query; }) as never });
  t.after(async () => { await service.stopAll(); rmSync(root, { recursive: true, force: true }); });
  return { root, id, service, cwd: join(root, id), options: () => options!, queries };
}
const sid = () => randomUUID();
const noSessions = { info: async () => undefined, list: async () => [], messages: async () => [] };

test('WBS-060: every prompt saves the session record, so the conversation reopens with its own session', async t => {
  const f = resumeSetup(t, noSessions);
  await f.service.open(f.id);
  const id = sid();
  const hook = f.options().hooks!.UserPromptSubmit![0]!.hooks[0]!;
  await hook({ hook_event_name: 'UserPromptSubmit', session_id: id, transcript_path: `/x/${id}.jsonl`, cwd: f.cwd, prompt: 'hi' } as never, undefined, { signal: new AbortController().signal });
  assert.deepEqual(JSON.parse(readFileSync(join(f.cwd, '.learningxxx-session.json'), 'utf8')), { sessionId: id, transcriptPath: `/x/${id}.jsonl` });
  await hook({ hook_event_name: 'UserPromptSubmit', session_id: 'not-a-uuid', transcript_path: '/x', cwd: f.cwd, prompt: 'hi' } as never, undefined, { signal: new AbortController().signal });
  assert.equal(JSON.parse(readFileSync(join(f.cwd, '.learningxxx-session.json'), 'utf8')).sessionId, id, 'a bad id never replaces the record');
});

test('WBS-060: a saved session is resumed when Claude Code still has it, even without the transcript path', async t => {
  const id = sid(); const asked: string[] = [];
  const f = resumeSetup(t, { info: async (s, dir) => { asked.push(`${s}@${dir}`); return s === id ? { sessionId: s } : undefined; }, list: async () => [],
    messages: async () => [{ uuid: sid(), type: 'user', parent_tool_use_id: null, message: { role: 'user', content: '이전 질문' } }, { uuid: sid(), type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '이전 답' }] } }] });
  mkdirSync(f.cwd, { recursive: true });
  writeFileSync(join(f.cwd, '.learningxxx-session.json'), JSON.stringify({ sessionId: id }));
  const state = await f.service.open(f.id);
  assert.equal(f.options().resume, id);
  assert.deepEqual(state.messages.map((m) => [m.role, m.text]), [['user', '이전 질문'], ['assistant', '이전 답']]);
  assert.ok(asked[0]!.startsWith(`${id}@`));
});

test('WBS-060: a conversation that never saved a record is recovered from its own folder only, and remembered', async t => {
  const mine = sid(), older = sid(), other = sid();
  let cwd = '';
  const f = resumeSetup(t, { info: async () => undefined, list: async (dir) => { cwd = dir; return [{ sessionId: older, lastModified: 1, cwd: dir }, { sessionId: other, lastModified: 9, cwd: '/somewhere/else' }, { sessionId: mine, lastModified: 5, cwd: dir }]; }, messages: async () => [] });
  mkdirSync(f.cwd, { recursive: true });
  writeFileSync(join(f.cwd, '.chat-ui.json'), JSON.stringify({ messages: [{ id: sid(), role: 'user', text: '예전 대화', tools: [] }], busy: false, connected: false, error: '', model: '', effort: 'default', mode: 'default', models: [], commands: [], permissions: [], totalCost: 0, tokens: 0, sessionId: '' }));
  await f.service.open(f.id);
  assert.equal(f.options().resume, mine, "the newest session of this folder, never another folder's");
  assert.equal(JSON.parse(readFileSync(join(f.cwd, '.learningxxx-session.json'), 'utf8')).sessionId, mine);
  assert.ok(cwd.endsWith(f.id));
});

test('WBS-060: with no session anywhere, an old conversation still says it cannot resume', async t => {
  const f = resumeSetup(t, noSessions);
  mkdirSync(f.cwd, { recursive: true });
  writeFileSync(join(f.cwd, '.chat-ui.json'), JSON.stringify({ messages: [{ id: sid(), role: 'user', text: '예전 대화', tools: [] }], busy: false, connected: false, error: '', model: '', effort: 'default', mode: 'default', models: [], commands: [], permissions: [], totalCost: 0, tokens: 0, sessionId: '' }));
  await assert.rejects(f.service.open(f.id), /원본 이력이 없어/);
});
