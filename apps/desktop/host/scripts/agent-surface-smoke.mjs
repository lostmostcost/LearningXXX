/** Isolated DOM contract checks, distinct from real-app user journey evidence. */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url), dir = mkdtempSync(join(tmpdir(), 'agent-dom-check-'));
const html = `<button id="background">Background</button><button disabled>Disabled</button><button hidden>Hidden</button>
<input aria-label="Secret" type="password" value="never-export-this"><input aria-label="Editable">
<select aria-label="Options"><option value="a">A</option><option disabled value="b">B</option></select>
<span id="context">Conversation one</span><button style="position:absolute;top:3000px">Offscreen</button>
<dialog><button>Inside modal</button></dialog>`;
const exercise = `async () => {
  const checks = [], check = (ok, why) => { if (!ok) throw new Error(why); checks.push(why); };
  const api = globalThis.surface, find = (s, name) => s.controls.find(c => c.name === name);
  const fails = (f, code) => { try { f(); return false; } catch(e) { return e.message.includes(code); } };
  let s = api.snapshot();
  check(!find(s, 'Hidden') && !find(s, 'Offscreen'), 'hidden and offscreen controls absent');
  check(!('value' in find(s, 'Secret')) && !JSON.stringify(s).includes('never-export-this'), 'password absent from serialized snapshot');
  check(fails(() => api.act({op:'click',target:find(s,'Disabled').id}), 'DISABLED'), 'disabled action refused');
  const old = find(s, 'Background').id;
  document.getElementById('context').textContent = 'Conversation two'; await Promise.resolve();
  check(fails(() => api.act({op:'click',target:old}), 'STALE_TARGET'), 'surrounding context mutation invalidates reused button');
  s = api.snapshot();
  check(fails(() => api.act({op:'select',target:find(s,'Options').id,value:'b'}), 'OPTION_UNAVAILABLE'), 'disabled select option refused');
  document.querySelector('dialog').showModal(); await Promise.resolve(); s = api.snapshot();
  check(!find(s, 'Background') && !!find(s, 'Inside modal'), 'modal blocks background controls');
  document.querySelector('dialog').close(); await Promise.resolve();
  document.querySelector('input[aria-label="Editable"]').addEventListener('input', e => document.getElementById('context').textContent = e.target.value);
  s = api.snapshot(); api.act({op:'fill',target:find(s,'Editable').id,text:'typed text'});
  check(document.getElementById('context').textContent === 'typed text', 'input event reaches caller');
  document.querySelector('input[aria-label="Editable"]').maxLength=3; await Promise.resolve(); s=api.snapshot();
  check(fails(() => api.act({op:'fill',target:find(s,'Editable').id,text:'1234'}), 'INVALID_TEXT'), 'typing cannot bypass input maximum length');
  const cover = document.createElement('div'); cover.style.cssText='position:fixed;inset:0;z-index:999;background:white'; document.body.append(cover); await Promise.resolve();
  check(!api.snapshot().controls.length, 'covered controls absent');
  return checks;
}`;
const entry = `import { app, BrowserWindow } from 'electron';
import { installAgentSurface } from ${JSON.stringify(fileURLToPath(new URL('../src/agent-surface.ts', import.meta.url)))};
app.setPath('userData', ${JSON.stringify(dir)});
app.whenReady().then(async () => { app.dock?.hide();
const window = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
await window.loadFile(${JSON.stringify(join(dir, 'index.html'))});
await window.webContents.executeJavaScript('globalThis.surface = ('+installAgentSurface.toString()+')(); true');
const checks = await window.webContents.executeJavaScript('('+${JSON.stringify(exercise)}+')()');
console.log(JSON.stringify({ok:true,checks})); app.quit();
}).catch(e => { console.error(e.message); app.exit(1); });`;
try {
  writeFileSync(join(dir, 'index.html'), html);
  await require('esbuild').build({ stdin: { contents: entry, resolveDir: fileURLToPath(new URL('..', import.meta.url)), sourcefile: 'agent-surface-contract.js' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(dir, 'main.cjs') });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(require('electron'), [join(dir, 'main.cjs')], { env, encoding: 'utf8', timeout: 20_000 });
  process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
