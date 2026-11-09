export type AgentFlow = 'debug' | 'assist';
export type AgentCommand = { op: 'snapshot' | 'click' | 'focus' | 'fill' | 'select' | 'selectText' | 'scroll' | 'key' | 'render' | 'resize' | 'wait' | 'stop' | 'catalog' | 'navigate'; target?: string; text?: string; value?: string; key?: string; shift?: boolean; dy?: number; width?: number; height?: number; ms?: number; name?: string; courseId?: string; resourceId?: string; section?: string; tab?: string };
/** Small, closed command language. Never accepts JS, selectors, IPC or state patches. */
export function parseAgentCommand(raw: unknown, flow: AgentFlow = 'debug'): AgentCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_COMMAND');
  const c = raw as Record<string, unknown>;
  const fields: Record<string, string[]> = { snapshot: [], click: ['target'], focus: ['target'], fill: ['target', 'text'], selectText: ['target', 'text'], select: ['target', 'value'], scroll: ['target', 'dy'], key: ['key', 'shift'], render: ['name'], resize: ['width', 'height'], wait: ['ms'], stop: [], catalog: [], navigate: ['courseId', 'resourceId', 'section', 'tab'] };
  if (typeof c.op !== 'string' || !Object.hasOwn(fields, c.op) || Object.keys(c).some(k => k !== 'op' && !fields[c.op as string]!.includes(k))) throw new Error('INVALID_COMMAND');
  if (['catalog', 'navigate'].includes(c.op) && flow !== 'assist') throw new Error('ASSIST_ONLY: debug must follow visible controls');
  const str = (key: string, max: number) => { if (typeof c[key] !== 'string' || (c[key] as string).length > max) throw new Error(`INVALID_${key.toUpperCase()}`); };
  const integer = (key: string, min: number, max: number) => { if (!Number.isInteger(c[key]) || (c[key] as number) < min || (c[key] as number) > max) throw new Error(`INVALID_${key.toUpperCase()}`); };
  if (['click', 'focus', 'fill', 'select', 'selectText', 'scroll'].includes(c.op)) str('target', 100);
  if (c.op === 'fill') str('text', 50_000);
  if (c.op === 'selectText') { str('text', 20_000); if (!(c.text as string).trim()) throw new Error('INVALID_TEXT'); }
  if (c.op === 'select') str('value', 1000);
  if (c.op === 'scroll') integer('dy', -2000, 2000);
  if (c.op === 'wait') integer('ms', 0, 5000);
  if (c.op === 'resize') { integer('width', 640, 2560); integer('height', 480, 1600); }
  if (c.op === 'render' && (typeof c.name !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.name))) throw new Error('INVALID_NAME');
  if (c.op === 'key' && (typeof c.key !== 'string' || !['Tab', 'Enter', 'Escape', 'Space', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'F6'].includes(c.key) || c.shift !== undefined && typeof c.shift !== 'boolean')) throw new Error('INVALID_KEY');
  if (c.op === 'navigate') {
    for (const k of ['courseId', 'resourceId']) if (c[k] !== undefined && (typeof c[k] !== 'string' || !/^[0-9a-f-]{36}$/i.test(c[k] as string))) throw new Error('INVALID_NAVIGATION');
    if (c.section !== undefined && (typeof c.section !== 'string' || !['home', 'book', 'info', 'tasks', 'notice'].includes(c.section))) throw new Error('INVALID_NAVIGATION');
    if (c.tab !== undefined && (typeof c.tab !== 'string' || !['chat', 'memo', 'recording', 'transcripts'].includes(c.tab))) throw new Error('INVALID_NAVIGATION');
    if (!c.courseId && !c.resourceId && !c.section && !c.tab || c.resourceId && c.section && c.section !== 'book' || c.section === 'home' && (c.resourceId || c.courseId || c.tab)) throw new Error('INVALID_NAVIGATION');
  }
  return c as AgentCommand;
}

/** Line decoder stays bounded even when stdin arrives without a newline. */
export class AgentLines {
  #buffer = '';
  push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop()!;
    if (this.#buffer.length > 100_000 || lines.some(l => l.length > 100_000)) throw new Error('COMMAND_TOO_LARGE');
    return lines.filter(l => l.trim());
  }
  end(): string[] { return this.push('\n'); }
}
