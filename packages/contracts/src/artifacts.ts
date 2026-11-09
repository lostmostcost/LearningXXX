import { z } from 'zod';
import { Id, UtcTimestamp } from './common.ts';

export const ArtifactKind = z.enum(['video', 'slides']);
export const ArtifactScope = z.object({ courseId: Id, kind: ArtifactKind, weekId: Id.optional(), assignmentId: Id.optional() });
export type ArtifactScope = z.infer<typeof ArtifactScope>;
export const checkArtifactScope = (s: ArtifactScope, ctx: z.RefinementCtx) => {
  if (s.kind === 'video' ? !s.weekId || !!s.assignmentId : !s.assignmentId || !!s.weekId) ctx.addIssue({ code: 'custom', message: 'Video requires one week; slides require one assignment.' });
};
const Refs = z.array(z.string().max(300)).max(2000);
export const ArtifactPlan = z.object({
  title: z.string().max(100), reviewedSourceIds: Refs,
  requirements: z.array(z.object({ text: z.string().max(1000), sourceIds: Refs })).max(60),
  openQuestions: z.array(z.string().max(1000)).max(30),
  slides: z.array(z.object({ title: z.string().max(100), bullets: z.array(z.string().max(650)).max(6), sourceIds: Refs })).max(60),
  scenes: z.array(z.object({ title: z.string().max(100), bullets: z.array(z.string().max(400)).max(5), narration: z.string().max(2000), sourceIds: Refs })).max(30),
});
export type ArtifactPlan = z.infer<typeof ArtifactPlan>;
export const ArtifactInput = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/),
  sources: z.array(z.object({ id: z.string(), title: z.string(), status: z.enum(['available', 'missing']), reason: z.string().optional(), characters: z.number().int().nonnegative(), required: z.boolean() })),
});
export const ArtifactFile = z.enum(['pptx', 'pdf', 'mp4']);
export const ArtifactJob = z.object({
  id: Id, scope: ArtifactScope, createdAt: UtcTimestamp,
  phase: z.enum(['generating', 'needs_review', 'exporting', 'completed', 'failed', 'cancelled', 'interrupted']), error: z.string(),
  plan: ArtifactPlan.optional(), reviewToken: z.string().regex(/^[0-9a-f]{64}$/).optional(), files: z.array(ArtifactFile).max(2),
});
export type ArtifactJob = z.infer<typeof ArtifactJob>;
export const ArtifactRuntime = z.object({ video: z.boolean(), pptx: z.boolean(), preparing: z.boolean(), message: z.string() });
