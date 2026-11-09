#!/usr/bin/env node
// WBS-099: builds the standalone "YOLO UNIV.app" (Apple Silicon) from this checkout.
//
// Unlike apps/desktop/host/scripts/build-brand-app.mjs (a launcher that loads the
// development folder), the result carries its own code and production
// dependencies, so it runs after the source folder is moved or deleted.
//
// Usage (repository root, isolated toolchain on PATH):
//   node infra/release/build-mac-app.mjs
// Output: build/release/{YOLO UNIV.app, YOLO-UNIV-<version>-arm64.dmg, .zip, SHA256SUMS.txt}
//
// The bundle mirrors the repository layout under Contents/Resources/app, so the
// host finds the UI, preload, branding, the WBS-091 engine and the transcriber
// setup exactly as in development (main.ts resolves them from dist/main.cjs).
// It never contains Claude credentials, LMS data or the SDK's bundled Claude
// binary: the app always runs the user's own installed, logged-in Claude Code.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGER_VERSION = '20.3.0';
const PRODUCT = 'YOLO UNIV';
const BUNDLE_ID = 'io.github.lostmostcost.yolouniv';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Apple Silicon Mac에서 빌드하세요.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const host = join(root, 'apps/desktop/host');
const out = join(root, 'build/release');
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

// Keep the internal name: Electron derives userData and the Safe Storage keychain entry from it.
const { name, version } = json(join(host, 'package.json'));
const electronVersion = json(createRequire(join(host, 'package.json')).resolve('electron/package.json')).version;
const artifact = `${PRODUCT.replace(/ /g, '-')}-${version}-arm64`;

console.log(`\n== ${PRODUCT} ${version} (Electron ${electronVersion}) ==`);
run('pnpm', ['--filter', '@learningxxx/desktop-ui', 'build']);
run('pnpm', ['--filter', '@learningxxx/desktop-host', 'build']);

mkdirSync(out, { recursive: true });
for (const old of [`${PRODUCT}.app`, `${artifact}.dmg`, `${artifact}.zip`, 'SHA256SUMS.txt']) rmSync(join(out, old), { recursive: true, force: true });
const work = mkdtempSync(join(out, '.work-'));
try {
  // 1. Production dependencies, exactly as locked (flat, no symlinks).
  const deployed = join(work, 'deploy');
  run('pnpm', ['--filter', '@learningxxx/desktop-host', 'deploy', '--prod', '--config.node-linker=hoisted', deployed]);

  // 2. Stage the app folder in the repository layout.
  const stage = join(work, 'app');
  const copy = (from, to = from, filter = () => true) => cpSync(join(root, from), join(stage, to), { recursive: true, filter: (path) => !/(^|\/)(__pycache__|\.DS_Store)(\/|$)/.test(path) && filter(path) });
  copy('apps/desktop/host/dist/main.cjs');
  copy('apps/desktop/host/src/preload.cjs');
  copy('apps/desktop/ui/dist');
  copy('assets/branding/yolo-univ-icon.png');
  copy('packages/learning-artifacts/src');
  copy('services/transcriber/setup.sh');
  copy('services/transcriber/python');
  const skip = new Set(['.pnpm', '.bin', '.modules.yaml', '@learningxxx']); // workspace packages are bundled into main.cjs
  for (const entry of readdirSync(join(deployed, 'node_modules'))) {
    if (skip.has(entry)) continue;
    cpSync(join(deployed, 'node_modules', entry), join(stage, 'node_modules', entry), {
      recursive: true,
      // Unused: conversations always pass the user's own Claude Code executable to the SDK.
      filter: (path) => !/\/@anthropic-ai\/claude-agent-sdk-[a-z]+-[a-z0-9]+(\/|$)/.test(path),
    });
  }
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify({ name, version, private: true, main: 'apps/desktop/host/dist/main.cjs' }, null, 2)}\n`);

  // 3. Every external module main.cjs loads must resolve from inside the stage.
  const main = join(stage, 'apps/desktop/host/dist/main.cjs');
  const bundled = readFileSync(main, 'utf8');
  const specifiers = new Set([...bundled.matchAll(/\b(?:require|import)\(\s*["']([^"'./][^"']*)["']\s*\)/g)].map((m) => m[1]));
  const load = createRequire(main);
  for (const specifier of specifiers) {
    if (isBuiltin(specifier) || specifier === 'electron') continue;
    load.resolve(specifier);
    console.log(`  resolves: ${specifier}`);
  }
  for (const file of ['apps/desktop/ui/dist/index.html', 'apps/desktop/host/src/preload.cjs', 'packages/learning-artifacts/src/model.mjs', 'services/transcriber/python/transcribe.py']) {
    if (!existsSync(join(stage, file))) throw new Error(`missing in bundle: ${file}`);
  }

  // 4. Package with a pinned @electron/packager kept in build/ (never installed globally).
  const tools = join(out, '.tools');
  const packagerJson = join(tools, 'node_modules/@electron/packager/package.json');
  if (!existsSync(packagerJson) || json(packagerJson).version !== PACKAGER_VERSION) {
    run('npm', ['install', '--prefix', tools, '--no-save', '--no-package-lock', '--no-audit', '--no-fund', `@electron/packager@${PACKAGER_VERSION}`]);
  }
  const entry = json(packagerJson).exports['.'].default; // ESM-only package
  const { packager } = await import(pathToFileURL(join(dirname(packagerJson), entry)).href);
  const [bundle] = await packager({
    dir: stage, out: work, name: PRODUCT, platform: 'darwin', arch: 'arm64', electronVersion,
    appVersion: version, buildVersion: version, appBundleId: BUNDLE_ID, appCategoryType: 'public.app-category.education',
    icon: join(root, 'assets/branding/yolo-univ.icns'), asar: false, prune: false, derefSymlinks: true, overwrite: true,
    appCopyright: 'YOLO UNIV · LearningXXX',
    extendInfo: {
      NSMicrophoneUsageDescription: '대면 강의를 녹음해 자동 전사하려면 마이크가 필요합니다.',
      LSMinimumSystemVersion: '13.0',
    },
  });
  const app = join(bundle, `${PRODUCT}.app`);

  // 5. Ad-hoc signature (no Developer ID): Info.plist changes invalidate Electron's own.
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  run('/usr/bin/ditto', [app, join(out, `${PRODUCT}.app`)]);

  // 6. Distribution files: a drag-to-Applications disk image and a zip.
  const dmgRoot = join(work, 'dmg');
  mkdirSync(dmgRoot);
  run('/usr/bin/ditto', [app, join(dmgRoot, `${PRODUCT}.app`)]);
  symlinkSync('/Applications', join(dmgRoot, 'Applications'));
  run('/usr/bin/hdiutil', ['create', '-quiet', '-volname', `${PRODUCT} ${version}`, '-srcfolder', dmgRoot, '-fs', 'HFS+', '-format', 'UDZO', '-ov', join(out, `${artifact}.dmg`)]);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, join(out, `${artifact}.zip`)]);
  writeFileSync(join(out, 'SHA256SUMS.txt'), execFileSync('/usr/bin/shasum', ['-a', '256', `${artifact}.dmg`, `${artifact}.zip`], { cwd: out, encoding: 'utf8' }));
  console.log(`\n${relative(root, out)}/\n  ${PRODUCT}.app\n  ${artifact}.dmg\n  ${artifact}.zip\n  SHA256SUMS.txt`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
