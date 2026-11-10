/** UI-only screen identity. This is not an instruction to attach content or switch conversations. */
export interface ScreenContext {
  section: 'home' | 'book' | 'info' | 'tasks' | 'notice' | 'media';
  courseId?: string | undefined;
  courseTitle?: string | undefined;
  week?: string | undefined;
  resource?: { title: string; page?: number | undefined } | undefined;
}
const LABELS = { home: '대시보드', book: '강의 자료', info: '강의 정보', tasks: '과제', notice: '공지', media: '녹음·전사' };
export function screenContextLabel(context: ScreenContext): string {
  if (context.section === 'home') return LABELS.home;
  const resource = ['book', 'tasks', 'notice'].includes(context.section) ? context.resource : undefined;
  return [LABELS[context.section], context.courseTitle, ['book', 'tasks', 'notice'].includes(context.section) ? context.week : undefined, resource?.title,
    resource?.page ? `${resource.page}쪽` : undefined].filter(Boolean).join(' · ');
}

/** Preserve the existing transport contract; never send stale PDF data for another screen. */
export function screenViewing(context: ScreenContext): { week?: string; title?: string; page?: number } | undefined {
  if (context.section === 'home' || !context.courseId) return undefined;
  const resourceScreen = ['book', 'tasks', 'notice'].includes(context.section);
  return { ...(resourceScreen && context.week ? { week: context.week } : {}), title: resourceScreen ? context.resource?.title ?? LABELS[context.section] : LABELS[context.section],
    ...(resourceScreen && context.resource?.page ? { page: context.resource.page } : {}) };
}
