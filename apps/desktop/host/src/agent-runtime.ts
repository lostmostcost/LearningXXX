import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, session } from 'electron';
import { AgentLines, parseAgentCommand } from './agent-protocol.ts';
import type { AgentFlow } from './agent-protocol.ts';
import { installAgentSurface } from './agent-surface.ts';
import { WEB_PREFERENCES } from './window-options.ts';

export const AGENT_PREFIX = '@@learningxxx-agent@@';
const SURFACE = 'globalThis.__learningxxxAgentSurface';
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Explicit developer mode only; regular launches get no command listener. */
export function agentMode(argv = process.argv): 'fixture' | 'local' | undefined {
  const value = argv.find(a => a.startsWith('--agent-stdio='))?.slice('--agent-stdio='.length);
  if (value !== undefined && value !== 'fixture' && value !== 'local') throw new Error('Invalid agent mode');
  return value;
}
export function agentFlow(argv = process.argv): AgentFlow {
  const value = argv.find(a => a.startsWith('--agent-flow='))?.slice('--agent-flow='.length) ?? 'debug';
  if (value !== 'debug' && value !== 'assist') throw new Error('Invalid agent flow');
  return value;
}

/** Fixture renderer uses the production UI bundle and no preload, host services, credentials or network. */
export async function startFixtureAgent(uiEntry: string, output: string, flow: AgentFlow = 'debug'): Promise<void> {
  const isolated = session.fromPartition(`agent-fixture-${process.pid}`);
  isolated.setPermissionRequestHandler((_web, _permission, answer) => answer(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, answer) => answer({ cancel: !/^(file:|blob:|data:|about:)/.test(details.url) }));
  const window = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, show: false,
    webPreferences: { ...WEB_PREFERENCES, session: isolated, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', e => e.preventDefault());
  await window.loadFile(uiEntry, { search: flow === 'assist' ? 'fixture&agentFlow=assist' : 'fixture' });
  await attachAgent(window, output, 'fixture', flow);
}

/** Stdio is inherited only by the child started by our CLI. No socket/HTTP/CDP port. */
export async function attachAgent(window: BrowserWindow, output: string, mode: 'fixture' | 'local', flow: AgentFlow = 'debug'): Promise<void> {
  const stat = lstatSync(output);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Agent output must be a private owned directory');
  const out = realpathSync(output), web = window.webContents;
  // loadFile's promise is awaited by both callers before attaching.
  // Electron intentionally replaces thrown renderer exceptions with a generic error.
  // Carry our closed error codes as plain data, without exporting exception objects.
  const run = async (code: string, userGesture = false): Promise<unknown> => {
    const result = await web.executeJavaScript(`(async () => { try { return { ok: true, value: await (${code}) }; } catch (error) { return { ok: false, error: String(error?.message ?? 'DOM_COMMAND_FAILED') }; } })()`, userGesture) as { ok: boolean; value?: unknown; error?: string };
    if (!result.ok) throw new Error(result.error ?? 'DOM_COMMAND_FAILED');
    return result.value;
  };
  await run(`(${SURFACE} = (${installAgentSurface.toString()})(), true)`);
  await pause(150);
  const snapshot = () => run(`${SURFACE}.snapshot()`);
  const send = (value: unknown) => process.stdout.write(AGENT_PREFIX + JSON.stringify(value) + '\n');
  const uiHtmlSha256 = createHash('sha256').update(readFileSync(fileURLToPath(new URL(web.getURL())))).digest('hex');
  const settle = async () => { await pause(80); await run('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))'); };
  let closed = false, seq = 0, pending = 0, shortcutsUsed = 0;
  let chain = Promise.resolve();
  const finish = () => { if (!closed) { closed = true; process.stdin.pause(); app.quit(); } };
  const consume = (line: string) => {
    if (closed) return;
    pending++;
    if (pending > 100) { send({ ok: false, error: 'TOO_MANY_PENDING_COMMANDS' }); finish(); return; }
    chain = chain.then(async () => {
      if (closed) return;
      const id = ++seq;
      const timeout = setTimeout(() => { send({ id, ok: false, error: 'COMMAND_TIMEOUT', recovery: 'Session terminated; inspect persisted state before restarting. No automatic replay.' }); finish(); }, 15_000);
      try {
        const c = parseAgentCommand(JSON.parse(line), flow);
        if (c.op === 'stop') { send({ id, ok: true, flow, shortcutsUsed, stopped: true }); finish(); return; }
        let evidence: unknown, navigation: unknown;
        if (c.op === 'catalog' || c.op === 'navigate') {
          if (c.op === 'navigate') shortcutsUsed++;
          const result = await run(`new Promise(resolve => {
            const detail = { request: ${JSON.stringify(c)}, handled: false, complete: resolve };
            window.dispatchEvent(new CustomEvent('learningxxx:assist-navigation', { detail }));
            if (!detail.handled) resolve({ ok: false, error: 'ASSIST_UNAVAILABLE' });
          })`) as { ok: boolean; value?: unknown; error?: string };
          if (!result.ok) throw new Error(result.error ?? 'NAVIGATION_UNAVAILABLE');
          navigation = result.value;
        } else if (c.op === 'key') {
          await run(`${SURFACE}.keyboard(${JSON.stringify(c.key)})`);
          const modifiers: ('shift')[] = c.shift ? ['shift'] : [];
          web.sendInputEvent({ type: 'keyDown', keyCode: c.key!, modifiers });
          web.sendInputEvent({ type: 'keyUp', keyCode: c.key!, modifiers });
        } else if (c.op === 'resize') {
          await run(`${SURFACE}.invalidate()`); window.setContentSize(c.width!, c.height!);
        } else if (c.op === 'wait') await pause(c.ms!);
        else if (c.op !== 'snapshot' && c.op !== 'render') await run(`${SURFACE}.act(${JSON.stringify(c)})`, true);
        await settle();
        if (closed) return;
        const state = await snapshot();
        if (c.op === 'render') {
          const image = (await web.capturePage()).toPNG();
          const path = join(out, `${c.name}.png`);
          // Refuse overwrites and symlinks. Each piece of evidence has an explicit unique name.
          writeFileSync(path, image, { flag: 'wx', mode: 0o600 });
          evidence = { image: path, sha256: createHash('sha256').update(image).digest('hex'), uiHtmlSha256, mode, flow, shortcutsUsed,
            evidenceUse: flow === 'debug' ? 'user-journey-verification' : 'assisted-operation-not-debug-evidence',
            pixels: { width: image.readUInt32BE(16), height: image.readUInt32BE(20) },
            generatedAt: new Date().toISOString(), viewport: window.getContentSize(), snapshot: state,
            fidelity: 'Production React/CSS renderer content; excludes native window chrome and OS dialogs. Fixture service results are synthetic.' };
          try { writeFileSync(join(out, `${c.name}.json`), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
          catch { throw new Error('EVIDENCE_METADATA_FAILED: PNG exists; choose a new evidence name'); }
        }
        if (!closed) send({ id, ok: true, mode, flow, shortcutsUsed, snapshot: state, ...(navigation ? { navigation } : {}), ...(evidence ? { evidence } : {}) });
      } catch (error) {
        const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
        // No raw exception objects/paths/credentials. DOM errors are closed, short error codes.
        if (!closed) send({ id, ok: false, flow, shortcutsUsed, error: message.match(/(?:ASSIST_ONLY|ASSIST_UNAVAILABLE|NAVIGATION_UNAVAILABLE|STALE_TARGET|DISABLED|NATIVE_REQUIRED|NOT_EDITABLE|NOT_SELECT|OPTION_UNAVAILABLE|FOCUS_REQUIRED|TEXT_UNAVAILABLE|TEXT_NOT_VISIBLE|INVALID_[A-Z]+|UNKNOWN_OPERATION|EVIDENCE_METADATA_FAILED)[^\n]*/)?.[0]?.slice(0, 160) ?? 'COMMAND_FAILED', recovery: 'Read snapshot and inspect state before retrying; no action is automatically replayed.' });
      } finally { clearTimeout(timeout); pending--; }
    });
  };
  const lines = new AgentLines();
  // Publish readiness before attaching the flowing stdin listener, including piped scripts.
  send({ ready: true, mode, flow, shortcutsUsed, navigationShortcuts: flow === 'assist' ? ['catalog', 'navigate'] : [],
    evidenceUse: flow === 'debug' ? 'user-journey-verification' : 'assisted-operation-not-debug-evidence', snapshot: await snapshot(), output: resolve(out) });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    try { lines.push(chunk).forEach(consume); }
    catch { send({ ok: false, error: 'COMMAND_TOO_LARGE' }); finish(); }
  });
  process.stdin.on('end', () => {
    if (closed) return;
    lines.end().forEach(consume); void chain.finally(finish);
  });
  process.stdin.on('error', finish);
  window.on('closed', finish);
  process.stdin.resume();
}
