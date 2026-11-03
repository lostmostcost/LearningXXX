import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk/core';
import type { Session } from '@learningxxx/contracts';
import { ConversationService } from '../src/conversation-service.ts';
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
function setup(t: { after: (f: () => void | Promise<void>) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'rich-service-')), id = randomUUID(); const q = new FakeQuery(); let options: Options;
  const session = { appSessionId: id, engine: 'chat', mode: 'independent', status: 'idle' } as Session;
  const service = new ConversationService({ root, getSession: () => session, rename() {}, nativeActive: () => false, prepare: async () => '/official/claude', createQuery: ((args: { options: Options }) => { options = args.options; return q as unknown as Query; }) as never });
  t.after(async () => { await service.stopAll(); rmSync(root, { recursive: true, force: true }); });
  return { id, q, service, options: () => options };
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
