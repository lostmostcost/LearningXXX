/** Explicit local converter check: synthetic plan, no Claude, no HeyGen. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ArtifactRuntimes } from '../src/artifact-runtime.ts';

const host = resolve(dirname(fileURLToPath(import.meta.url)), '..'), engine = resolve(host, '../../../packages/learning-artifacts');
const root = resolve(process.argv[2] ?? '/private/tmp/artifact-local-smoke'); await mkdir(root, { recursive: true });
const runtime = new ArtifactRuntimes(engine, host);
const module = await import(pathToFileURL(join(engine, 'src/workflow.mjs')).href) as { ArtifactWorkflow: new (options: unknown) => {
  prepare(input: unknown): Promise<{ id: string; directory: string; reviewToken: string }>;
  export(id: string, token: string): Promise<{ files: string[] }>;
} };
const fixture = await import(pathToFileURL(join(engine, 'test/fixture.mjs')).href) as { input(kind: string): unknown; plan(kind: string): unknown };
await runtime.preflight('slides', new AbortController().signal);
const workflow = new module.ArtifactWorkflow({ root, accountId: () => 'a', generate: async () => fixture.plan('slides'), pptxPdf: (input: Parameters<ArtifactRuntimes['pptxPdf']>[0]) => runtime.pptxPdf(input) });
const reviewed = await workflow.prepare(fixture.input('slides'));
const result = await workflow.export(reviewed.id, reviewed.reviewToken);
assert.equal(result.files.length, 2);
const source = await readFile(result.files[0]!); assert.equal(source.subarray(0, 2).toString(), 'PK');
const pdf = await readFile(result.files[1]!); assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
await writeFile(join(root, 'report.json'), JSON.stringify({ synthetic: true, modelCalls: 0, voiceCalls: 0, pptxPreserved: true, files: result.files }));
console.log('PASS: actual editable PPTX converted to PDF, original preserved; no model or TTS');
