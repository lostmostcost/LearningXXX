import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { snapshot, generationPrompt, validatePlan, ArtifactError, requireThat, hash, deepFreeze } from './model.mjs';
import { documentHtml, presentationPptx } from './documents.mjs';
import { videoComposition } from './video.mjs';
import { assertFile } from './runtime.mjs';

async function atomic(directory, name, data) {
  const tmp = join(directory, `.${randomUUID()}.tmp`);
  await writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
  await rename(tmp, join(directory, name));
}
async function privateChild(parent, name) {
  const path = join(parent, name); await mkdir(path, { mode: 0o700 }).catch((e) => { if (e.code !== 'EEXIST') throw e; });
  const info = await lstat(path); requireThat(info.isDirectory() && !info.isSymbolicLink(), 'SCOPE_CHANGED', 'Output directory boundary changed'); return path;
}
/**
 * Dependency-injected local workflow. `generate` must be wired to the existing official
 * subscription CLI runner, never a direct model API. Renderer and TTS have no source access.
 * The host owns account/course verification, source extraction, permissions and opening files.
 */
export class ArtifactWorkflow {
  #o; #jobs = new Map(); #active = new Set();
  constructor(options) {
    requireThat(isAbsolute(options.root) && typeof options.accountId === 'function' && typeof options.generate === 'function', 'INVALID_INPUT', 'Host root/account/generation runner required');
    this.#o = options;
  }
  #check(account, signal) { signal.throwIfAborted(); requireThat(this.#o.accountId() === account, 'ACCOUNT_CHANGED', 'Account changed; artifact operation stopped'); }
  async #state(job, state, code) {
    const status = { id: job.id, state, kind: job.snapshot.kind, accountId: job.snapshot.accountId, courseId: job.snapshot.courseId, fingerprint: job.snapshot.fingerprint, updatedAt: new Date().toISOString(), ...(code ? { code } : {}) };
    await atomic(job.directory, 'status.json', JSON.stringify(status)); job.state = state;
  }
  /** Phase 1 does not call TTS/render or claim that an output file is ready. */
  async prepare(input, { signal = new AbortController().signal, allowMissing = false } = {}) {
    const s = snapshot(input), lock = hash(`${s.accountId}\n${s.courseId}`);
    this.#check(s.accountId, signal);
    requireThat(!this.#active.has(lock), 'ALREADY_RUNNING', 'An artifact plan is already being generated for this course');
    requireThat(allowMissing || !s.sources.some((x) => x.status === 'missing'), 'MISSING_SOURCES', 'Review and explicitly accept missing sources before generating a partial draft');
    this.#active.add(lock);
    let job;
    try {
      const root = await realpath(this.#o.root), account = await privateChild(root, hash(s.accountId)), course = await privateChild(account, hash(s.courseId));
      this.#check(s.accountId, signal);
      const directory = await mkdtemp(join(course, 'run-')), id = randomUUID();
      job = { id, directory, snapshot: s, state: 'generating' };
      this.#jobs.set(id, job); await this.#state(job, 'generating');
      // Persist provenance/coverage without copying original lecture bodies into outputs.
      const sources = s.sources.map(({ text: _text, ...metadata }) => metadata);
      await atomic(directory, 'sources.json', JSON.stringify({ ...s, sources }));
      this.#check(s.accountId, signal);
      const raw = await this.#o.generate({ prompt: generationPrompt(s), signal, assertCurrent: () => this.#check(s.accountId, signal) });
      this.#check(s.accountId, signal);
      job.plan = validatePlan(raw, s);
      job.reviewToken = hash(JSON.stringify([id, s.fingerprint, job.plan]));
      await atomic(directory, 'plan.json', JSON.stringify(job.plan));
      this.#check(s.accountId, signal);
      await this.#state(job, 'needs_review');
      this.#check(s.accountId, signal);
      return deepFreeze({ id, reviewToken: job.reviewToken, plan: job.plan, sources, directory });
    } catch (e) {
      if (job) await this.#state(job, signal.aborted ? 'cancelled' : 'failed', e instanceof ArtifactError ? e.code : 'GENERATION_FAILED').catch(() => undefined);
      throw e;
    } finally { this.#active.delete(lock); }
  }
  /** Phase 2 explicitly accepts exactly the reviewed plan. Each id exports at most once.
   * Failures retain plan/audio for diagnosis, but cannot trigger a paid retry. New prepare is explicit.
   */
  async export(id, reviewToken, { signal = new AbortController().signal } = {}) {
    const job = this.#jobs.get(id);
    requireThat(job && job.state === 'needs_review' && job.reviewToken === reviewToken, 'REVIEW_REQUIRED', 'Prepare and review this exact plan before exporting');
    this.#check(job.snapshot.accountId, signal);
    // Synchronous state transition rejects duplicate clicks before the first await.
    job.state = 'exporting';
    try {
      await this.#state(job, 'exporting');
      const { directory, plan, snapshot: s } = job;
      this.#check(s.accountId, signal);
      const files = [];
      if (s.kind === 'document') {
        requireThat(typeof this.#o.documentPdf === 'function', 'PDF_RUNTIME_REQUIRED', 'Configure local document PDF printing');
        await atomic(directory, 'draft.html', documentHtml(plan, s));
        this.#check(s.accountId, signal);
        files.push(await this.#o.documentPdf({ html: join(directory, 'draft.html'), directory, signal }));
      } else if (s.kind === 'slides') {
        requireThat(typeof this.#o.pptxPdf === 'function', 'PDF_RUNTIME_REQUIRED', 'Configure actual PPTX-to-PDF conversion');
        const pptx = presentationPptx(plan, s), path = join(directory, 'draft.pptx');
        await atomic(directory, 'draft.pptx', pptx);
        this.#check(s.accountId, signal);
        files.push(path);
        files.push(await this.#o.pptxPdf({ path, directory, signal }));
        // The PDF must be converted from this very PPTX, without the converter replacing it.
        const actual = await realpath(path), rel = relative(await realpath(directory), actual), info = await lstat(path);
        requireThat(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && info.isFile() && info.size === pptx.length, 'INVALID_OUTPUT', 'Converted PPTX boundary or size changed');
        requireThat(hash(await readFile(path)) === hash(pptx), 'INVALID_OUTPUT', 'Converter changed the original PPTX');
      } else {
        requireThat(typeof this.#o.narrate === 'function' && this.#o.media, 'VIDEO_RUNTIME_REQUIRED', 'Configure HeyGen narration, FFprobe and HyperFrames');
        const audioDir = await privateChild(directory, 'audio'), clips = [];
        for (let i = 0; i < plan.scenes.length; i++) {
          this.#check(s.accountId, signal);
          const audio = await this.#o.narrate({ text: plan.scenes[i].narration, signal, assertCurrent: () => this.#check(s.accountId, signal) });
          this.#check(s.accountId, signal);
          requireThat(Buffer.isBuffer(audio.bytes) && audio.bytes.length > 32 && audio.bytes.length <= 32_000_000, 'INVALID_AUDIO', 'Invalid narration bytes');
          const file = join(audioDir, `scene-${i + 1}.mp3`);
          await atomic(audioDir, `scene-${i + 1}.mp3`, audio.bytes);
          this.#check(s.accountId, signal);
          clips.push({ duration: await this.#o.media.duration({ path: file, signal }) });
        }
        const composition = videoComposition(plan, clips);
        await atomic(directory, 'index.html', composition.html);
        await atomic(directory, 'timing.json', JSON.stringify(composition.timeline));
        this.#check(s.accountId, signal);
        files.push(await this.#o.media.render({ directory, duration: composition.duration, signal }));
      }
      this.#check(s.accountId, signal);
      // A broken converter cannot publish a private/external file as this job's result.
      requireThat(s.kind === 'video' ? files.length === 1 && files[0].endsWith('.mp4') : files.at(-1).endsWith('.pdf'), 'INVALID_OUTPUT', 'Expected final MP4/PDF output');
      for (const file of files) {
        const actual = await realpath(file), rel = relative(await realpath(directory), actual);
        requireThat(rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel), 'SCOPE_CHANGED', 'Output escaped the job directory');
        await assertFile(file, file.endsWith('.pdf') ? '%PDF-' : undefined);
      }
      this.#check(s.accountId, signal);
      await atomic(directory, 'result.json', JSON.stringify({ files: files.map((f) => relative(directory, f)), fingerprint: s.fingerprint }));
      this.#check(s.accountId, signal);
      await this.#state(job, 'completed');
      this.#check(s.accountId, signal);
      return { id, directory, files };
    } catch (e) {
      await this.#state(job, signal.aborted ? 'cancelled' : 'failed', e instanceof ArtifactError ? e.code : 'EXPORT_FAILED').catch(() => undefined);
      throw e;
    }
  }
  /** Restart inspection is read-only. Never resumes model/API work or reads another account's directory. */
  async inspect(directory) {
    const root = await realpath(this.#o.root), accountId = this.#o.accountId();
    requireThat(typeof accountId === 'string', 'ACCOUNT_CHANGED', 'Current account required');
    const accountRoot = join(root, hash(accountId)), actual = await realpath(directory), rel = relative(accountRoot, actual);
    requireThat(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'SCOPE_CHANGED', 'Job is outside current account');
    const status = JSON.parse(await readFile(join(actual, 'status.json'), 'utf8'));
    requireThat(status.accountId === accountId && this.#o.accountId() === accountId, 'ACCOUNT_CHANGED', 'Account changed');
    return { ...status, state: ['generating', 'exporting', 'needs_review'].includes(status.state) ? 'interrupted' : status.state };
  }
}
