import { query, renameSession, type Query, type Options, type SDKUserMessage, type PermissionResult } from '@anthropic-ai/claude-agent-sdk/core';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { childEnv, locateCli, probeCli } from '@learningxxx/cli-adapter';
import { ConversationState, type IpcResponse, type Session } from '@learningxxx/contracts';
import type { CourseBinding } from './course-workspace.ts';

export type ChatState = IpcResponse<'chat.state'>;
export type ChatMessage = ChatState['messages'][number];
export type ChatPermission = ChatState['permissions'][number];
class Inputs {
  items: SDKUserMessage[] = []; wake?: () => void; ended = false;
  push(value: SDKUserMessage) { this.items.push(value); this.wake?.(); }
  close() { this.ended = true; this.wake?.(); }
  async *stream() { while (!this.ended) { const item = this.items.shift(); if (item) yield item; else await new Promise<void>(resolve => { this.wake = resolve; }); } }
}
interface Entry { state: ChatState; q: Query; input: Inputs; cwd: string; course?: CourseBinding | undefined; current?: ChatMessage | undefined; partial: string; replies: Map<string, (answer: PermissionResult) => void>; task: Promise<void>; closed: boolean; updating: boolean }
export interface ConversationOptions {
  root: string; getSession: (id: string) => Session; rename: (id: string, title: string) => void;
  nativeActive: (id: string) => boolean; env?: NodeJS.ProcessEnv;
  prepare?: () => Promise<string>; createQuery?: typeof query;
  prepareCourse?: (id: string, cwd: string) => Promise<CourseBinding | undefined>;
  /** WBS-060: Claude Code's own session store (the SDK by default; tests pass fakes). */
  sessions?: SessionStoreAccess;
}
/** The parts of the SDK's local session store used to find and read a conversation's Claude Code session. */
export interface SessionStoreAccess {
  info: (sessionId: string, dir: string) => Promise<{ sessionId: string } | undefined>;
  list: (dir: string) => Promise<{ sessionId: string; lastModified: number; cwd?: string | undefined }[]>;
  messages: (sessionId: string, dir: string) => Promise<{ uuid: string; type: 'user' | 'assistant' | 'system'; parent_tool_use_id?: string | null; message: unknown }[]>;
}
const sdkSessions = async (): Promise<SessionStoreAccess> => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return {
    info: (sessionId, dir) => sdk.getSessionInfo(sessionId, { dir }),
    list: (dir) => sdk.listSessions({ dir, includeWorktrees: false }),
    messages: (sessionId, dir) => sdk.getSessionMessages(sessionId, { dir }),
  };
};
const UUID = /^[0-9a-f-]{36}$/i;
const sameDir = (a: string, b: string) => { try { return realpathSync(a) === realpathSync(b); } catch { return a === b; } };
const fail: (message: string) => never = (message) => { throw Object.assign(new Error(message), { appError: { code: 'INVALID_REQUEST', message, retryable: false } }); };
export class ConversationService {
  #o: ConversationOptions; #entries = new Map<string, Entry>(); #opening = new Map<string, Promise<ChatState>>(); #stopped = false;
  constructor(options: ConversationOptions) { this.#o = options; }
  active(id: string) { return this.#entries.has(id) || this.#opening.has(id); }
  async #cli() {
    const env = this.#o.env ?? process.env, located = locateCli(env, homedir());
    if (!located.ok) throw Object.assign(new Error(located.error.message), { appError: located.error });
    const probe = await probeCli(located.path, env);
    if (!probe.ok) throw Object.assign(new Error(probe.error.message), { appError: probe.error });
    return located.path;
  }
  async open(id: string) {
    const session = this.#o.getSession(id);
    if (this.#stopped || session.archivedAt || session.engine !== 'chat') fail('사용할 수 없는 대화입니다. 새 대화를 열어주세요.');
    if (this.#o.nativeActive(id)) fail('고급 터미널을 종료한 뒤 채팅으로 돌아오세요.');
    const pending = this.#opening.get(id); if (pending) return pending;
    const existing = this.#entries.get(id); if (existing?.state.connected) return this.state(id);
    // Reserve reconnects before awaiting the old transport too. Otherwise two
    // reconnect clicks can both pass the pending check and start separate CLIs.
    const work = (async () => { if (existing) await this.#closeEntry(id); return this.#start(id); })();
    this.#opening.set(id, work);
    try { return await work; } finally { this.#opening.delete(id); }
  }
  async #start(id: string): Promise<ChatState> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) fail('잘못된 대화 ID입니다.');
    const otherConnections = new Set([...this.#entries.keys(), ...this.#opening.keys()].filter(key => key !== id));
    if (otherConnections.size >= 8) fail('열린 대화가 많습니다. 사용하지 않는 대화를 닫으세요.');
    const executable = await (this.#o.prepare?.() ?? this.#cli());
    if (this.#stopped || this.#o.getSession(id).archivedAt || this.#o.nativeActive(id)) fail('대화 상태가 바뀌었습니다. 다시 연결하세요.');
    mkdirSync(this.#o.root, { recursive: true }); const root = realpathSync(this.#o.root), cwd = join(root, id);
    mkdirSync(cwd, { recursive: true }); const inside = relative(root, realpathSync(cwd));
    if (inside.startsWith('..') || isAbsolute(inside)) fail('대화 폴더 경계를 벗어났습니다.');
    const course = await this.#o.prepareCourse?.(id, cwd);
    let stored: Partial<ChatState> = {}, map: { sessionId?: string; transcriptPath?: string } = {};
    if (existsSync(join(cwd, '.chat-ui.json'))) {
      try { stored = ConversationState.parse(JSON.parse(readFileSync(join(cwd, '.chat-ui.json'), 'utf8'))); }
      catch { fail('대화 표시 기록을 읽지 못했습니다. 원본을 보존했으며 새 대화를 시작할 수 있습니다.'); }
    }
    try { map = JSON.parse(readFileSync(join(cwd, '.learningxxx-session.json'), 'utf8')); } catch { /* fresh */ }
    const sessions = this.#o.sessions ?? (stored.messages?.length || map.sessionId ? await sdkSessions() : undefined);
    // A brand-new conversation (nothing shown, nothing saved) has nothing to look up.
    const resume = stored.messages?.length || map.sessionId ? await this.#resumable(cwd, map, sessions) : undefined;
    const state: ChatState = { messages: Array.isArray(stored.messages) ? stored.messages.slice(-200) : [], busy: false, connected: false, error: '', model: stored.model ?? '', effort: stored.effort ?? 'default', mode: 'default', models: [], commands: [], permissions: [], totalCost: stored.totalCost ?? 0, tokens: stored.tokens ?? 0, sessionId: resume ?? '' };
    if (resume) {
      // Read the engine's current transcript after an advanced-terminal handoff too.
      // This is session resume, not migration of the retired structured engine.
      const messages = await sessions!.messages(resume, cwd);
      state.messages = messages.filter(m => !m.parent_tool_use_id).flatMap(m => {
        const body = m.message as { content?: unknown } | null;
        const blocks = Array.isArray(body?.content) ? body.content : typeof body?.content === 'string' ? [{ type: 'text', text: body.content }] : [];
        const text = blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
        const tools = blocks.filter(b => b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string').map(b => ({ id: b.id as string, name: b.name as string, input: JSON.stringify(b.input ?? {}, null, 2) }));
        return text || tools.length ? [{ id: m.uuid, role: m.type, text, tools }] : [];
      }).slice(-200);
    } else if (state.messages.length) {
      fail('Claude Code 원본 이력이 없어 기존 문맥을 재개할 수 없습니다. 새 대화를 시작하세요.');
    }
    if (this.#stopped || this.#o.getSession(id).archivedAt || this.#o.nativeActive(id)) fail('대화 상태가 바뀌었습니다. 다시 연결하세요.');
    const input = new Inputs(); let entry: Entry;
    const options: Options = {
      cwd, pathToClaudeCodeExecutable: executable, permissionMode: 'default', settingSources: ['user', 'project', 'local'], enableFileCheckpointing: true, extraArgs: { 'replay-user-messages': null },
      systemPrompt: { type: 'preset', preset: 'claude_code', ...(course ? { append: course.startupBrief ?? course.brief } : {}) }, includePartialMessages: true,
      ...(course ? { additionalDirectories: [course.readDirectory] } : {}),
      env: childEnv(this.#o.env ?? process.env), ...(resume ? { resume } : {}), ...(state.model ? { model: state.model } : {}),
      ...(state.effort !== 'default' ? { effort: state.effort as 'low' } : {}),
      canUseTool: async (tool, toolInput, request) => new Promise<PermissionResult>(resolve => {
        if (entry.closed || request.signal.aborted) return resolve({ behavior: 'deny', message: '대화가 중단됐습니다.' });
        const permissionId = randomUUID(), done = (answer: PermissionResult) => { request.signal.removeEventListener('abort', abort); entry.replies.delete(permissionId); state.permissions = state.permissions.filter(p => p.id !== permissionId); resolve(answer); };
        const abort = () => done({ behavior: 'deny', message: '요청이 취소됐습니다.' });
        entry.replies.set(permissionId, done); state.permissions.push({ id: permissionId, tool, input: toolInput }); request.signal.addEventListener('abort', abort, { once: true });
      }),
      // WBS-060: the resume record is written on every prompt (SessionStart is not called for chat
      // runs of current Claude Code), so a conversation always reopens with its own session.
      hooks: { UserPromptSubmit: [{ hooks: [async info => {
        this.#remember(cwd, state, info.session_id, info.transcript_path);
        return entry.course ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: entry.course.brief } } : {};
      }] }], SessionStart: [{ hooks: [async info => {
        if (info.hook_event_name === 'SessionStart') this.#remember(cwd, state, info.session_id, info.transcript_path);
        return {};
      }] }] },
    };
    const q = (this.#o.createQuery ?? query)({ prompt: input.stream(), options });
    entry = { state, q, input, cwd, course, partial: '', replies: new Map(), task: Promise.resolve(), closed: false, updating: false };
    this.#entries.set(id, entry);
    entry.task = this.#consume(id, entry);
    try {
      const initialized = await q.initializationResult();
      state.connected = true; state.models = initialized.models; state.commands = initialized.commands;
      return this.state(id);
    } catch { await this.#closeEntry(id); fail('Claude Code 채팅 연결을 시작하지 못했습니다. 구독 로그인과 CLI 버전을 확인하세요.'); }
  }
  /** Keeps the conversation's Claude Code session id (and transcript file, which the advanced terminal needs). */
  #remember(cwd: string, state: ChatState, sessionId: unknown, transcriptPath: unknown) {
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return;
    state.sessionId = sessionId;
    const path = typeof transcriptPath === 'string' && transcriptPath.endsWith(`/${sessionId}.jsonl`) ? transcriptPath : undefined;
    try { this.#atomic(join(cwd, '.learningxxx-session.json'), { sessionId, ...(path ? { transcriptPath: path } : {}) }); } catch { /* the next prompt writes it again */ }
  }
  /**
   * WBS-060: the session to resume. The saved one when Claude Code still has
   * it; otherwise (conversations whose record was never written) the newest
   * session Claude Code kept for this conversation's own folder, which is then
   * saved. Sessions of other folders are never taken.
   */
  async #resumable(cwd: string, map: { sessionId?: string; transcriptPath?: string }, sessions: SessionStoreAccess | undefined): Promise<string | undefined> {
    if (!sessions) return undefined;
    if (typeof map.sessionId === 'string' && UUID.test(map.sessionId)) {
      if (typeof map.transcriptPath === 'string' && map.transcriptPath.endsWith(`/${map.sessionId}.jsonl`) && existsSync(map.transcriptPath)) return map.sessionId;
      if (await sessions.info(map.sessionId, cwd).catch(() => undefined)) return map.sessionId;
    }
    const own = (await sessions.list(cwd).catch(() => [])).filter((s) => UUID.test(s.sessionId) && (s.cwd === undefined || sameDir(s.cwd, cwd)));
    const latest = own.toSorted((a, b) => b.lastModified - a.lastModified)[0];
    if (!latest) return undefined;
    try { this.#atomic(join(cwd, '.learningxxx-session.json'), { sessionId: latest.sessionId }); } catch { /* resumed anyway */ }
    return latest.sessionId;
  }
  #atomic(path: string, value: unknown) { const temp = `${path}.${randomUUID()}.tmp`; writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); renameSync(temp, path); }
  #save(e: Entry) { this.#atomic(join(e.cwd, '.chat-ui.json'), { ...e.state, messages: e.state.messages.slice(-200), models: [], commands: [], permissions: [], busy: false, error: '' }); }
  #message(e: Entry, role: ChatMessage['role'], text: string) { const m: ChatMessage = { id: randomUUID(), role, text, tools: [] }; e.state.messages.push(m); if (e.state.messages.length > 200) e.state.messages.shift(); return m; }
  #assistant(e: Entry) { return e.current ??= this.#message(e, 'assistant', ''); }
  async #consume(id: string, e: Entry) {
    try {
      for await (const message of e.q) {
        if (e.closed) break;
        if ('session_id' in message && message.session_id) e.state.sessionId = message.session_id;
        if (message.type === 'conversation_reset') { e.state.sessionId = message.new_conversation_id; e.state.messages = []; e.current = undefined; e.partial = ''; this.#save(e); }
        if (message.type === 'system' && message.subtype === 'init') { if (message.apiKeySource !== 'none') { e.state.error = '구독 인증 경로가 아닙니다. 연결을 종료했습니다.'; e.q.close(); break; } e.state.model = message.model; e.state.mode = message.permissionMode; }
        if (message.type === 'system' && message.subtype === 'status' && message.permissionMode) e.state.mode = message.permissionMode;
        if (message.type === 'system' && message.subtype === 'session_state_changed' && message.state === 'idle') { e.state.busy = false; e.current = undefined; e.partial = ''; this.#save(e); }
        if (message.type === 'stream_event' && !message.parent_tool_use_id) {
          const event = message.event;
          if (event.type === 'message_start') { e.partial = ''; if (e.current?.text) e.current.text += '\n\n'; }
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') { const m = this.#assistant(e); m.text += event.delta.text; e.partial += event.delta.text; }
        }
        if (message.type === 'assistant' && !message.parent_tool_use_id) {
          const m = this.#assistant(e);
          const text = message.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          if (!e.partial && text) m.text += text;
          e.partial = '';
          for (const block of message.message.content) if (block.type === 'tool_use' && !m.tools.some(t => t.id === block.id)) m.tools.push({ id: block.id, name: block.name, input: JSON.stringify(block.input, null, 2) });
        }
        if (message.type === 'system' && message.subtype === 'local_command_output') this.#message(e, 'system', message.content);
        if (message.type === 'system' && message.subtype === 'commands_changed') e.state.commands = message.commands;
        if (message.type === 'result') {
          if (message.is_error) e.state.error = message.subtype === 'success' ? message.result : message.errors.join('\n');
          e.state.totalCost = message.total_cost_usd; e.state.tokens = message.usage.input_tokens + message.usage.output_tokens;
          e.state.busy = false; e.current = undefined; e.partial = ''; this.#save(e);
        }
      }
    } catch { if (!e.closed) e.state.error = 'Claude Code 연결이 중단됐습니다. 전송 내용을 확인하고 다시 연결하세요.'; }
    finally { e.state.connected = false; e.state.busy = false; for (const reply of [...e.replies.values()]) reply({ behavior: 'deny', message: '연결 종료' }); if (!e.closed) this.#save(e); }
  }
  #entry(id: string) { this.#o.getSession(id); const e = this.#entries.get(id); if (!e || e.closed) return fail('대화를 다시 연결하세요.'); return e; }
  state(id: string) { const e = this.#entry(id); return structuredClone(e.state); }
  async send(id: string, text: string, requestId: string) {
    const e = this.#entry(id); if (e.state.messages.some(m => m.role === 'user' && m.id === requestId)) return this.state(id);
    if (!e.state.connected) fail('대화를 다시 연결하세요.');
    if (e.state.busy || e.updating) fail('진행 중인 작업이 끝난 뒤 보내세요.');
    const command = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (command && !e.state.commands.some(c => c.name.replace(/^\//, '') === command[1] || c.name === command[1])) fail('이 명령은 채팅 연결에서 제공되지 않습니다. 명령 메뉴 또는 고급 도구에서 사용하세요.');
    e.updating = true;
    try {
      e.course = await this.#o.prepareCourse?.(id, e.cwd);
      if (e.closed || !e.state.connected || this.#stopped || this.#o.nativeActive(id)) fail('연결 상태가 바뀌었습니다. 다시 연결하세요.');
      e.state.error = ''; e.state.busy = true; e.current = undefined; e.partial = '';
      this.#message(e, 'user', text).id = requestId; this.#save(e);
      e.input.push({ type: 'user', uuid: requestId as NonNullable<SDKUserMessage["uuid"]>, session_id: e.state.sessionId, parent_tool_use_id: null, message: { role: 'user', content: text } });
      return this.state(id);
    } finally { e.updating = false; }
  }
  async configure(id: string, change: { model?: string | undefined; effort?: string | undefined; mode?: string | undefined }) {
    const e = this.#entry(id); if (!e.state.connected) fail('대화를 다시 연결하세요.');
    if (e.state.busy || e.updating || e.state.permissions.length) fail('실행 또는 권한 확인이 끝난 뒤 설정을 바꾸세요.');
    e.updating = true;
    try {
      if (change.model !== undefined) {
        const model = e.state.models.find(m => m.value === change.model); if (!model) fail('제공되지 않는 모델입니다.');
        await e.q.applyFlagSettings({ model: model.value, effortLevel: null }); e.state.model = model.value; e.state.effort = 'default';
      }
      if (change.effort !== undefined) {
        const model = e.state.models.find(m => m.value === e.state.model || m.resolvedModel === e.state.model);
        if (change.effort !== 'default' && !model?.supportedEffortLevels?.includes(change.effort)) fail('이 모델에서 지원하지 않는 추론 강도입니다.');
        await e.q.applyFlagSettings({ effortLevel: change.effort === 'default' ? null : change.effort as 'low' }); e.state.effort = change.effort;
      }
      if (change.mode !== undefined) {
        if (!['default', 'plan', 'acceptEdits', 'auto'].includes(change.mode)) fail('지원하지 않는 실행 모드입니다.');
        if (change.mode === 'auto' && !e.state.models.find(m => m.value === e.state.model || m.resolvedModel === e.state.model)?.supportsAutoMode) fail('이 모델은 자동 모드를 지원하지 않습니다.');
        await e.q.setPermissionMode(change.mode as 'default'); e.state.mode = change.mode;
      }
      this.#save(e); return this.state(id);
    } finally { e.updating = false; }
  }
  async rename(id: string, title: string) {
    const e = this.#entry(id); if (e.state.busy || e.updating) fail('작업이 끝난 뒤 이름을 바꾸세요.');
    e.updating = true;
    try { if (e.state.sessionId) await renameSession(e.state.sessionId, title, { dir: e.cwd }); this.#o.rename(id, title); }
    finally { e.updating = false; }
  }
  answer(id: string, permissionId: string, allow: boolean, answers?: Record<string, string>) {
    const e = this.#entry(id), permission = e.state.permissions.find(p => p.id === permissionId), reply = e.replies.get(permissionId);
    if (!permission || !reply) fail('만료되었거나 취소된 확인 요청입니다.');
    reply(allow ? { behavior: 'allow', updatedInput: answers ? { ...permission.input, answers } : permission.input } : { behavior: 'deny', message: '사용자가 거부했습니다.' }); return this.state(id);
  }
  async interrupt(id: string) {
    const e = this.#entry(id); if (e.updating) fail('설정 변경이 끝난 뒤 중지하세요.');
    e.updating = true;
    try {
      e.input.items = []; // Also withdraw input not yet handed to the SDK.
      for (const reply of [...e.replies.values()]) reply({ behavior: 'deny', message: '사용자 취소' });
      // SDK 0.3.301's runtime exposes this public option; its declaration omits it.
      const receipt = await (e.q.interrupt as (options?: { cancelQueued: boolean }) => ReturnType<Query['interrupt']>)({ cancelQueued: true });
      const end = Date.now() + 2000;
      while (e.state.busy && Date.now() < end && !receipt?.still_queued?.length) await new Promise(r => setTimeout(r, 20));
      if (e.state.busy || receipt?.still_queued?.some(uuid => e.state.messages.some(m => m.role === 'user' && m.id === uuid))) {
        e.q.close(); await e.task;
        e.state.error = '중지 후 연결을 종료했습니다. 다시 연결해 이어갈 수 있습니다. 요청은 자동 재전송하지 않습니다.';
      }
      return this.state(id);
    } finally { e.updating = false; }
  }
  async info(id: string, kind: string) {
    const entry = this.#entry(id);
    if (kind === 'usage' || kind === 'cost') {
      // Isolated compatibility adapter: official SDK marks this method experimental.
      try {
        const report = await entry.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
        if (kind === 'cost') return `이번 연결의 엔진 보고 추정 비용: $${report.session.total_cost_usd.toFixed(4)}\n구독의 실제 청구액을 뜻하지 않습니다.`;
        if (!report.rate_limits_available) return '구독 사용량을 조회하지 못했습니다. 고급 도구에서 /usage로 확인하세요.';
        const labels: Record<string, string> = { five_hour: '5시간 한도', seven_day: '주간 한도', seven_day_oauth_apps: '앱 주간 한도', seven_day_opus: 'Opus 주간 한도', seven_day_sonnet: 'Sonnet 주간 한도' };
        const lines: string[] = [];
        for (const [key, label] of Object.entries(labels)) {
          const window = (report.rate_limits as Record<string, unknown>)[key] as { utilization?: number | null; resets_at?: string | null } | undefined;
          if (window) lines.push(`${label}: ${window.utilization == null ? '정보 없음' : window.utilization + '% 사용'}${window.resets_at ? ' · 초기화 ' + new Date(window.resets_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : ''}`);
        }
        return lines.join('\n') || '사용량 정보가 아직 제공되지 않았습니다.';
      } catch { return '엔진이 사용량 정보를 제공하지 못했습니다. 고급 도구에서 /usage 또는 /cost로 확인하세요.'; }
    }
    if (kind === 'mcp') return (await entry.q.mcpServerStatus()).map(server => `${server.name}: ${server.status}`).join('\n') || '연결된 MCP 서버가 없습니다.';
    if (kind === 'skills') return entry.state.commands.map(command => `/${command.name.replace(/^\//, '')} — ${command.description}`).join('\n') || '사용 가능한 스킬·명령이 없습니다.';
    if (kind === 'context') {
      const usage = await entry.q.getContextUsage({ detail: 'summary' });
      return `**${usage.totalTokens.toLocaleString()} / ${usage.rawMaxTokens.toLocaleString()} 토큰 · ${usage.percentage}%**\n\n` + usage.categories.filter(c => c.kind === 'used').map(c => `- ${c.name}: ${c.tokens.toLocaleString()} 토큰`).join('\n');
    }
    return `이번 대화 사용 토큰: ${entry.state.tokens}\nSDK 보고 추정 비용: $${entry.state.totalCost.toFixed(4)} (구독 청구액이 아님)`;
  }
  async rewind(id: string, messageId: string, preview: boolean) {
    const e = this.#entry(id); if (e.state.busy || e.updating) fail('작업이 끝난 뒤 파일 복구를 사용할 수 있습니다.');
    if (!e.state.messages.some(m => m.id === messageId && m.role === 'user')) fail('이 대화의 체크포인트를 선택하세요.');
    e.updating = true;
    try { return await e.q.rewindFiles(messageId, { dryRun: preview }); }
    finally { e.updating = false; }
  }
  async #closeEntry(id: string) { const e = this.#entries.get(id); if (!e) return; e.closed = true; for (const reply of [...e.replies.values()]) reply({ behavior: 'deny', message: '연결 종료' }); e.input.close(); e.q.close(); await e.task; this.#save(e); this.#entries.delete(id); }
  async detach(id: string) {
    this.#o.getSession(id);
    await this.#opening.get(id)?.catch(() => undefined);
    const e = this.#entries.get(id);
    if (e?.state.busy || e?.updating || e?.state.permissions.length) fail('진행 중인 작업을 완료하거나 중지한 뒤 전환하세요.');
    await this.#closeEntry(id);
  }
  async close(id: string) {
    // Closing the transport must unblock initialization before waiting for it.
    await this.#closeEntry(id);
    await this.#opening.get(id)?.catch(() => undefined);
    await this.#closeEntry(id);
  }
  async stopAll() {
    this.#stopped = true;
    await Promise.all([...this.#entries.keys()].map(id => this.#closeEntry(id)));
    await Promise.allSettled([...this.#opening.values()]);
    await Promise.all([...this.#entries.keys()].map(id => this.#closeEntry(id)));
  }
}
