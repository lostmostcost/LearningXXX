// Local development launcher, not a standalone distribution package.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('Build this launcher on macOS.');
const host = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(host, '../../..');
const require = createRequire(import.meta.url);
const source = process.argv[2] ? resolve(process.argv[2]) : join(dirname(require.resolve('electron/package.json')), 'dist/Electron.app');
const main = join(host, 'dist/main.cjs');
const icon = join(root, 'assets/branding/yolo-univ.icns');
if (![source, main, icon, join(host, '../ui/dist/index.html')].every(existsSync)) throw new Error('Build host/UI and install Electron before packaging.');
// A moved worktree can have valid bundles but broken pnpm links. Check the
// dependencies from the main bundle's location, before publishing a launcher.
const runtime = createRequire(main);
const dependencies = ['@anthropic-ai/claude-agent-sdk/core', 'pdfjs-dist/legacy/build/pdf.mjs'];
for (const dependency of dependencies) runtime.resolve(dependency);
const output = join(host, 'build');
mkdirSync(output, { recursive: true });
const destination = join(output, 'YOLO UNIV.app');
if (existsSync(destination)) throw new Error('YOLO UNIV.app already exists; move the previous launcher aside before rebuilding.');
const temporary = mkdtempSync(join(output, '.yolo-build-'));
try {
  const bundle = join(temporary, 'YOLO UNIV.app');
  cpSync(source, bundle, { recursive: true, verbatimSymlinks: true });
  const resources = join(bundle, 'Contents/Resources');
  cpSync(icon, join(resources, 'yolo-univ.icns'));
  const appRoot = join(resources, 'app');
  mkdirSync(appRoot);
  // Keep the internal name used by userData, cookie encryption and Safe Storage.
  const { name, version } = JSON.parse(readFileSync(join(host, 'package.json'), 'utf8'));
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name, version, main: 'launcher.cjs' }));
  writeFileSync(join(appRoot, 'launcher.cjs'), `const { app, dialog } = require('electron');
const load = require('node:module').createRequire(${JSON.stringify(main)});
try {
  for (const dependency of ${JSON.stringify(dependencies)}) load.resolve(dependency);
  load(${JSON.stringify(main)});
} catch (error) {
  dialog.showErrorBox('YOLO UNIV 시작 실패', '개발 소스 폴더에서 pnpm install --frozen-lockfile 후 host/UI를 다시 빌드해 주세요.\\n\\n' + String(error.message));
  app.exit(1);
}\n`);
  const plist = join(bundle, 'Contents/Info.plist');
  for (const [key, value] of Object.entries({ CFBundleDisplayName: 'YOLO UNIV', CFBundleName: 'YOLO UNIV', CFBundleIconFile: 'yolo-univ.icns' })) {
    try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { stdio: 'ignore' }); }
    catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string`, plist]); }
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  }
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
  renameSync(bundle, destination);
  console.log(destination);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
