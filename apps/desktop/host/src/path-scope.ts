import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Follows symlinks of the deepest existing ancestor, so a link cannot hide an outside target. */
export function realTarget(path: string): string {
  let head = path;
  const rest: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  return join(realpathSync(head), ...rest);
}

export function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Resolves a relative key inside root, or returns undefined if it would leave it. */
export function resolveScoped(root: string, key: string): string | undefined {
  if (key === "" || isAbsolute(key) || key.includes("\0")) return undefined;
  const realRoot = realpathSync(root);
  const target = realTarget(resolve(realRoot, key));
  return isWithin(realRoot, target) && target !== realRoot ? target : undefined;
}

/**
 * For acting on an entry itself. resolveScoped follows a final symlink to its
 * target, so writing or trashing that result would hit whatever the link points
 * at, even another file inside the root. This returns the entry the key names,
 * and undefined if it is a symlink or anything but a regular file.
 */
export function resolveEntry(root: string, key: string): string | undefined {
  const scoped = resolveScoped(root, key);
  if (scoped === undefined) return undefined;
  const parent = resolveScoped(root, dirname(key)) ?? (dirname(key) === "." ? realpathSync(root) : undefined);
  if (parent === undefined) return undefined;
  const entry = join(parent, basename(key));
  if (!existsSync(entry) && !isDanglingLink(entry)) return entry;
  return lstatSync(entry).isFile() ? entry : undefined;
}

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
