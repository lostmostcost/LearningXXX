// Opt-in real local PDF smoke: uses synthetic inputs and the configured Chrome only.
// node packages/learning-artifacts/test/smoke-document.mjs /absolute/chrome /absolute/output-root
import { ArtifactWorkflow } from '../src/workflow.mjs';
import { createDocumentPdfPrinter } from '../src/runtime.mjs';
import { input, plan } from './fixture.mjs';
const [chrome, root] = process.argv.slice(2);
const workflow = new ArtifactWorkflow({ root, accountId: () => 'a', generate: async () => plan('document'), documentPdf: createDocumentPdfPrinter({ chrome }) });
const reviewed = await workflow.prepare(input('document'));
const result = await workflow.export(reviewed.id, reviewed.reviewToken);
console.log(JSON.stringify({ state: (await workflow.inspect(result.directory)).state, files: result.files }));
