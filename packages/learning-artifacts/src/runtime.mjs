import { spawn } from 'node:child_process';
import { open, lstat, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ArtifactError, requireThat } from './model.mjs';

/** Host-configured executables only. No shell, no model-supplied args/env/paths. */
export function runProgram(executable, args, { cwd, signal, timeoutMs = 300_000, pathEntries = [] } = {}) {
  requireThat(isAbsolute(executable), 'RUNTIME_REQUIRED', 'Executable must be an absolute host-configured path');
  requireThat(pathEntries.every((p) => typeof p === 'string' && isAbsolute(p) && !p.includes(':')), 'INVALID_INPUT', 'Runtime search paths must be host-configured absolute directories');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'FONTCONFIG_PATH'].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
    env.PATH = [...pathEntries, env.PATH ?? '/usr/bin:/bin'].join(':');
    Object.assign(env, { HYPERFRAMES_NO_TELEMETRY: '1', HYPERFRAMES_NO_UPDATE_CHECK: '1' });
    let stdout = '', stopped = false, timer, killTimer;
    const grouped = process.platform !== 'win32';
    const child = spawn(executable, args, { cwd, env, detached: grouped, stdio: ['ignore', 'pipe', 'ignore'] });
    const kill = (signal) => { try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
    const stop = () => { if (stopped) return; stopped = true; kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 2000); };
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', stop); };
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString()).slice(-32_000); });
    child.once('error', () => { cleanup(); reject(new ArtifactError('RUNTIME_REQUIRED', 'Configured runtime could not start')); });
    child.once('close', (code) => {
      if (stopped) kill('SIGKILL'); // Reap render workers even when their parent exits on TERM.
      cleanup();
      if (signal?.aborted) { reject(signal.reason); return; }
      if (stopped) { reject(new ArtifactError('RUNTIME_TIMEOUT', 'Runtime exceeded time limit')); return; }
      if (code !== 0) { reject(new ArtifactError('RUNTIME_FAILED', `Runtime exited with status ${code}`)); return; }
      resolve(stdout);
    });
    signal?.addEventListener('abort', stop, { once: true });
    timer = setTimeout(stop, timeoutMs);
    if (signal?.aborted) stop();
  });
}
export async function assertFile(file, signature) {
  const info = await lstat(file);
  requireThat(info.isFile() && info.size > 32, 'MISSING_OUTPUT', 'Runtime did not produce a usable file');
  if (signature) {
    const handle = await open(file, 'r');
    try { const bytes = Buffer.alloc(signature.length); await handle.read(bytes, 0, bytes.length, 0); requireThat(bytes.equals(Buffer.from(signature)), 'INVALID_OUTPUT', 'Runtime output has an invalid signature'); } finally { await handle.close(); }
  }
}
export function createMediaRuntime({ hyperframes, ffprobe, node }) {
  const invoke = (args, options) => runProgram(node ?? hyperframes, node ? [hyperframes, ...args] : args, { ...options, pathEntries: [dirname(ffprobe), ...(node ? [dirname(node)] : [])] });
  return {
    async duration({ path, signal }) {
      const text = await runProgram(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path], { signal, timeoutMs: 30_000 });
      const duration = Number(text.trim());
      requireThat(Number.isFinite(duration) && duration > 0 && duration <= 600, 'INVALID_AUDIO', 'Invalid or excessive audio duration');
      return duration;
    },
    async render({ directory, duration, signal }) {
      await invoke(['lint'], { cwd: directory, signal, timeoutMs: 60_000 });
      await invoke(['render', '--output', 'explanation.mp4', '--fps', '30', '--quality', 'standard'], { cwd: directory, signal, timeoutMs: 30 * 60_000 });
      const file = join(directory, 'explanation.mp4'); await assertFile(file);
      const info = JSON.parse(await runProgram(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file], { signal, timeoutMs: 30_000 }));
      requireThat(info.streams?.some((s) => s.codec_type === 'video') && info.streams?.some((s) => s.codec_type === 'audio') && Math.abs(Number(info.format?.duration) - duration) < 0.3, 'INVALID_OUTPUT', 'Rendered video must contain audio/video with expected duration');
      return file;
    },
  };
}
/** A dedicated profile prevents collisions with the user's interactive LibreOffice.
 * Converts the actual PPTX, never reprints a separate HTML representation as its PDF.
 */
export function createPptxPdfConverter({ libreoffice }) {
  return async ({ path, directory, signal }) => {
    requireThat(basename(path) === 'draft.pptx' && dirname(path) === directory, 'INVALID_INPUT', 'Expected generated draft.pptx');
    const out = join(directory, 'pdf'); await mkdir(out, { recursive: false, mode: 0o700 });
    const profile = pathToFileURL(join(directory, 'libreoffice-profile')).href;
    await runProgram(libreoffice, [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', out, path], { cwd: directory, signal });
    const file = join(out, 'draft.pdf'); await assertFile(file, '%PDF-'); return file;
  };
}

/** Local PDF printer for the generated static report. Dedicated browser profile;
 * no remote resources in the report (CSP), no user browser profile or credentials.
 */
export function createDocumentPdfPrinter({ chrome }) {
  return async ({ html, directory, signal }) => {
    requireThat(basename(html) === 'draft.html' && dirname(html) === directory, 'INVALID_INPUT', 'Expected generated draft.html');
    const file = join(directory, 'draft.pdf');
    await runProgram(chrome, ['--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', `--user-data-dir=${join(directory, 'chrome-profile')}`, '--no-pdf-header-footer', `--print-to-pdf=${file}`, pathToFileURL(html).href], { cwd: directory, signal, timeoutMs: 60_000 });
    await assertFile(file, '%PDF-'); return file;
  };
}
