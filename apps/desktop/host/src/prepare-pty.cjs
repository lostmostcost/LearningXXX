// Explicit setup only. pnpm dependency build scripts remain disabled.
const fs = require('node:fs');
const path = require('node:path');
if (process.platform === 'darwin') {
  const root = path.dirname(require.resolve('node-pty/package.json'));
  const candidates = [path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'), path.join(root, 'build/Release/spawn-helper')];
  const helper = candidates.find(p => fs.existsSync(p));
  if (!helper) throw new Error('node-pty Mac helper is missing; reinstall the pinned dependency.');
  fs.chmodSync(helper, 0o755);
}
