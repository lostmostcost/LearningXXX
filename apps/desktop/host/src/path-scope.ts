import { existsSync, realpathSync } from "node:fs";
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
