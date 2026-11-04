import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CredentialService } from './credential-service.ts';
import { ArtifactRuntimes } from './artifact-runtime.ts';
import type { ArtifactEngine } from './artifact-workflows.ts';

/** Explicit developer diagnostic: one fixed public sentence, one paid TTS call.
 * Never copies credentials into a file, subprocess, report or model prompt.
 * Uses a synthetic plan, so this does not prove subscription model generation.
 */
export async function runArtifactVoiceSmoke(output: string, credentials: CredentialService, engineRoot: string, hostRoot: string, catalogOnly = false) {
  const root = resolve(output), signal = AbortSignal.timeout(10 * 60_000);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const runtime = new ArtifactRuntimes(engineRoot, hostRoot);
  try {
    const configured = credentials.heygen();
    if (!configured?.voiceId) throw new Error('VOICE_REQUIRED');
    const voices = await credentials.heygenVoices(signal);
    if (catalogOnly) {
      await writeFile(join(root, 'catalog.json'), JSON.stringify({ ttsCalls: 0, voices: voices.voices.length, selectedVoiceAvailable: voices.voices.some(v => v.voiceId === configured.voiceId), koreanVoices: voices.voices.filter(v => /^(?:ko(?:[-_]|$)|korean\b)/i.test(v.language)).map(({ voiceId, name, language }) => ({ voiceId, name, language })) }, null, 2), { mode: 0o600, flag: 'wx' });
      return;
    }
    await runtime.preflight('video', signal);
    if (!voices.voices.some(v => v.voiceId === configured.voiceId)) throw new Error('VOICE_REQUIRED');
    const assertCurrent = () => {
      signal.throwIfAborted();
      const current = credentials.heygen();
      if (current?.key !== configured.key || current.voiceId !== configured.voiceId) throw new Error('VOICE_CHANGED');
    };
    const voice = await import(pathToFileURL(join(engineRoot, 'src/heygen.mjs')).href) as { createHeygenNarrator(options: unknown): (input: { text: string; signal: AbortSignal; assertCurrent: () => void }) => Promise<{ bytes: Buffer }> };
    const module = await import(pathToFileURL(join(engineRoot, 'src/workflow.mjs')).href) as { ArtifactWorkflow: new (options: unknown) => ArtifactEngine };
    const text = '두 입력이 모두 일일 때, 앤드 게이트의 출력은 일입니다.';
    const plan = { title: '한국어 음성 출력 검증', reviewedSourceIds: ['public-example'], requirements: [], openQuestions: [], sections: [], slides: [], scenes: [{ title: 'AND 게이트', bullets: ['입력 두 개가 모두 1이면 출력 1'], narration: text, sourceIds: ['public-example'] }] };
    let calls = 0;
    const narrate = voice.createHeygenNarrator({ apiKey: () => { assertCurrent(); return configured.key; }, voiceId: configured.voiceId, language: 'ko' });
    const workflow = new module.ArtifactWorkflow({ root, accountId: () => 'synthetic-smoke', generate: async () => plan,
      narrate: async (input: { text: string; signal: AbortSignal }) => { if (++calls !== 1) throw new Error('NO_RETRY'); assertCurrent(); const result = await narrate({ ...input, assertCurrent }); assertCurrent(); return result; },
      media: { duration: runtime.duration.bind(runtime), render: runtime.render.bind(runtime) },
    });
    const reviewed = await workflow.prepare({ kind: 'video', accountId: 'synthetic-smoke', courseId: 'public-example', courseTitle: '공개 합성 예제', weekId: 'example-week', sources: [{ id: 'public-example', kind: 'material', weekId: 'example-week', title: 'AND 게이트 정의', status: 'available', text }] }, { signal, allowMissing: false });
    const result = await workflow.export(reviewed.id, reviewed.reviewToken, { signal });
    assertCurrent();
    await writeFile(join(root, 'report.json'), JSON.stringify({ syntheticPlan: true, modelCalls: 0, ttsCalls: calls, provider: 'heygen', engine: 'starfish', language: 'ko', script: text, files: result.files }, null, 2), { mode: 0o600, flag: 'wx' });
  } finally { await runtime.stop(); }
}
