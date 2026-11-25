/** Navigation intents for an explicitly enabled assistant session, never debug evidence. */
export type AssistNavigation = { op: 'catalog' } | { op: 'navigate'; courseId?: string; resourceId?: string; section?: 'home' | 'book' | 'info' | 'tasks' | 'notice' | 'media'; tab?: 'chat' | 'memo' | 'recording' | 'transcripts' };
export const ASSIST_NAVIGATION_EVENT = 'learningxxx:assist-navigation';

export function parseAssistNavigation(value: unknown): AssistNavigation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_NAVIGATION');
  const v = value as Record<string, unknown>;
  const allowed = v.op === 'catalog' ? ['op'] : v.op === 'navigate' ? ['op', 'courseId', 'resourceId', 'section', 'tab'] : [];
  if (!allowed.length || Object.keys(v).some(k => !allowed.includes(k))) throw new Error('INVALID_NAVIGATION');
  for (const k of ['courseId', 'resourceId']) if (v[k] !== undefined && (typeof v[k] !== 'string' || !/^[0-9a-f-]{36}$/i.test(v[k] as string))) throw new Error('INVALID_NAVIGATION');
  if (v.section !== undefined && (typeof v.section !== 'string' || !['home', 'book', 'info', 'tasks', 'notice', 'media'].includes(v.section))) throw new Error('INVALID_NAVIGATION');
  if (v.tab !== undefined && (typeof v.tab !== 'string' || !['chat', 'memo', 'recording', 'transcripts'].includes(v.tab))) throw new Error('INVALID_NAVIGATION');
  if (v.op === 'navigate' && !v.courseId && !v.resourceId && !v.section && !v.tab) throw new Error('INVALID_NAVIGATION');
  if (v.resourceId && v.section && v.section !== 'book' || v.section === 'home' && (v.resourceId || v.courseId || v.tab)) throw new Error('INVALID_NAVIGATION');
  return v as AssistNavigation;
}

/** No listener is installed in ordinary or debug launches. No host/permission/action API. */
export function onAssistNavigation(handler: (request: AssistNavigation) => Promise<unknown>): () => void {
  if (new URLSearchParams(window.location.search).get('agentFlow') !== 'assist') return () => {};
  let alive = true;
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ request: unknown; handled: boolean; complete: (value: unknown) => void }>).detail;
    if (!detail || typeof detail.complete !== 'function') return;
    detail.handled = true;
    Promise.resolve().then(() => handler(parseAssistNavigation(detail.request))).then(
      value => detail.complete(alive ? { ok: true, value } : { ok: false, error: 'NAVIGATION_CHANGED' }),
      () => detail.complete({ ok: false, error: 'NAVIGATION_UNAVAILABLE: inspect catalog and current screen' }),
    );
  };
  window.addEventListener(ASSIST_NAVIGATION_EVENT, listener);
  return () => { alive = false; window.removeEventListener(ASSIST_NAVIGATION_EVENT, listener); };
}
