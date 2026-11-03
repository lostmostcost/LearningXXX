// Opt-in: synthetic audio only; never invokes paid TTS or Claude.
// node smoke-video.mjs /absolute/node /absolute/hyperframes-cli /absolute/ffprobe /absolute/tone.mp3 /absolute/output-root
import { readFile } from 'node:fs/promises';
import { ArtifactWorkflow } from '../src/workflow.mjs';
import { createMediaRuntime } from '../src/runtime.mjs';
import { input, plan } from './fixture.mjs';
const [node, hyperframes, ffprobe, tone, root] = process.argv.slice(2);
const workflow = new ArtifactWorkflow({ root, accountId: () => 'a', generate: async () => plan(), narrate: async () => ({ bytes: await readFile(tone) }), media: createMediaRuntime({ node, hyperframes, ffprobe }) });
const reviewed = await workflow.prepare(input()); const result = await workflow.export(reviewed.id, reviewed.reviewToken);
console.log(JSON.stringify({ state: (await workflow.inspect(result.directory)).state, files: result.files }));
