import type { ArtifactScope, CollectionManifest } from '@learningxxx/contracts';
import type { WeekNote } from './week-notes.ts';
import { assignmentSources } from './assignment-sources.ts';

/** A week's originals plus course-wide material; slides retain the cumulative course scope. */
export async function artifactSources(scope: ArtifactScope, manifest: CollectionManifest, options: {
  asset(id: string): Promise<Uint8Array>; pdf(bytes: Uint8Array): Promise<string[]>; notes: WeekNote[]; summary?: string | undefined;
}) {
  if (scope.kind === 'slides') return assignmentSources(manifest, options);
  const weekId = scope.weekId; if (!weekId) throw new Error('Video week required');
  const filtered = { ...manifest, items: manifest.items.filter(i => !i.resource.weekId || i.resource.weekId === weekId) };
  const sources = await assignmentSources(filtered, { ...options, notes: options.notes.filter(n => !n.weekId || n.weekId === weekId) });
  return sources.map(s => {
    if (s.weekId || s.kind === 'course') return s;
    // This is review context for the selected week, not a claim about the original's week.
    return { ...s, weekId, title: `[과목 공통] ${s.title}` };
  });
}
