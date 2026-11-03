import { CHAT_COMMANDS, parseChatCommand } from '@learningxxx/contracts';
export { parseChatCommand };
export interface CommandItem { name: string; label: string; description: string; action: string; vendorName?: string; available: boolean }
export function commandItems(commands: { name: string; description: string; argumentHint: string }[]): CommandItem[] {
  const clean = commands.map(c => ({ ...c, name: c.name.replace(/^\//, '') }));
  const core: CommandItem[] = CHAT_COMMANDS.map(c => {
    const vendor = clean.find(v => v.name === c.name || c.name === 'review' && v.name === 'code-review');
    return { ...c, available: c.action !== 'sdk' || !!vendor, ...(vendor ? { vendorName: vendor.name } : {}) };
  });
  return [...core, ...clean.filter(c => !core.some(v => v.name === c.name || v.vendorName === c.name)).map(c => ({ name: c.name, label: c.argumentHint, description: c.description, action: 'sdk', vendorName: c.name, available: true }))];
}
export const MODE_LABEL: Record<string, string> = { default: '일반', plan: '계획', acceptEdits: '편집 자동 승인', auto: '자동 판단' };
export function chatMarkdown(messages: { role: string; text: string }[]) { return messages.map(m => `## ${m.role === 'user' ? '나' : m.role === 'assistant' ? 'Claude' : '안내'}\n\n${m.text}`).join('\n\n'); }
