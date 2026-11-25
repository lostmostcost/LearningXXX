import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const MARKER = '.learningxxx-agent-profile.json';

/** An explicit test profile may be reused, but an ordinary app profile is never adopted. */
export function assertAgentProfile(path: string): string {
  const stat = lstatSync(path), marker = lstatSync(join(path, MARKER));
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) ||
    !marker.isFile() || marker.isSymbolicLink() || marker.uid !== process.getuid?.() || (marker.mode & 0o077)) throw new Error('Agent profile must be private and owned');
  const value = JSON.parse(readFileSync(join(path, MARKER), 'utf8')) as { schemaVersion?: unknown; purpose?: unknown };
  if (value.schemaVersion !== 1 || value.purpose !== 'learningxxx-agent') throw new Error('Not an agent test profile');
  return realpathSync(path);
}

export function prepareAgentProfile(path: string): string {
  try {
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, MARKER), JSON.stringify({ schemaVersion: 1, purpose: 'learningxxx-agent' }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  return assertAgentProfile(path);
}
