import type { CollectionManifest } from '@learningxxx/contracts';
import type { AssignmentSource } from './assignment-workspaces.ts';
import type { WeekNote } from './week-notes.ts';
import { htmlToText } from './week-notes.ts';

/** All collected weeks, split rather than truncated. PDF visual limitations stay explicit. */
export async function assignmentSources(manifest: CollectionManifest, options: {
  asset(id: string): Promise<Uint8Array>; pdf(bytes: Uint8Array): Promise<string[]>;
  notes: WeekNote[]; summary?: string | undefined;
}): Promise<AssignmentSource[]> {
  const out: AssignmentSource[] = [];
  const add = (source: Omit<AssignmentSource, 'status' | 'text' | 'reason'>, text: string) => {
    if (!text.trim()) { out.push({ ...source, status: 'missing', reason: '읽을 수 있는 텍스트가 없습니다.' }); return; }
    // IDs identify exact complete text parts; a long source is never silently sliced away.
    const chars = Array.from(text);
    for (let start = 0; start < chars.length; start += 60_000) out.push({ ...source, id: `${source.id}:part-${Math.floor(start / 60_000) + 1}`, status: 'available', text: chars.slice(start, start + 60_000).join('') });
  };
  if (options.summary?.trim()) add({ id: 'course-knowledge', title: '과목 정리 (course.md)', kind: 'course' }, options.summary);
  for (const item of [...manifest.items].sort((a, b) => a.resource.id.localeCompare(b.resource.id))) {
    const r = item.resource, week = r.weekId ? { weekId: r.weekId } : {};
    if (r.kind === 'assignment' || r.kind === 'notice') {
      const metadata = item.assignment ? `\n\n[수집된 과제 메타데이터]\n마감: ${item.assignment.dueAt ?? '미정'}\n표시 시간대: ${item.assignment.timezone} (근거: ${item.assignment.timezoneBasis})${item.assignment.submissionUrl ? `\n제출 페이지: ${item.assignment.submissionUrl}` : ''}` : '';
      add({ id: r.id, title: r.title, kind: r.kind, ...week, ...(r.kind === 'assignment' ? { assignmentId: r.id } : {}) }, htmlToText(item.body ?? '') + metadata);
    }
    for (const asset of [...item.assets].sort((a, b) => a.id.localeCompare(b.id))) {
      const base = { id: asset.id, title: `${r.title} · ${asset.originalName}`, kind: 'material' as const, ...week };
      if (asset.mediaType === 'application/pdf') {
        try {
          const pages = await options.pdf(await options.asset(asset.id));
          for (let i = 0; i < pages.length; i++) add({ ...base, id: `${asset.id}:page-${i + 1}`, title: `${base.title} ${i + 1}쪽 (텍스트)` }, pages[i]!);
          // The original remains available to the normal course chat; do not call text extraction a visual review.
          out.push({ ...base, id: `${asset.id}:visual`, title: `${base.title} · 그림/도표`, status: 'missing', reason: '초기 생성에는 PDF 텍스트만 제공됩니다. 그림·도표는 과제 채팅에서 원본을 직접 읽어 확인해야 합니다.' });
        } catch { out.push({ ...base, status: 'missing', reason: 'PDF를 읽지 못했습니다. 원본 상태·암호 여부를 확인해 주세요.' }); }
      } else if (asset.mediaType.startsWith('text/') || /\.(md|txt|csv|json)$/i.test(asset.originalName)) {
        try { add(base, new TextDecoder('utf-8', { fatal: true }).decode(await options.asset(asset.id))); }
        catch { out.push({ ...base, status: 'missing', reason: '텍스트 파일을 읽지 못했습니다.' }); }
      } else out.push({ ...base, status: 'missing', reason: '초기 문서 생성에서 지원하지 않는 텍스트 형식입니다. 과제 채팅에서 원본을 확인해 주세요.' });
    }
  }
  options.notes.forEach((n, i) => add({ id: `note-${i}`, title: n.title, kind: n.kind === 'memo' ? 'memo' : n.kind === 'transcript' ? 'transcript' : n.kind === 'assignment' ? 'notice' : 'course', ...(n.weekId ? { weekId: n.weekId } : {}) }, n.text));
  return out;
}
