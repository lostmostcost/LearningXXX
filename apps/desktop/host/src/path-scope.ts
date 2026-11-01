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
 * For acting on an entry itself. Walks the key one component at a time from the
 * root and never follows a link, because following any of them, final or parent,
 * lands on some other file, possibly one inside the root. Returns undefined for
 * a link at any level (dangling ones too), a replaced root, or a non-file target.
 * Components that do not exist yet are fine: nothing there can be a link.
 */
export function resolveEntry(root: string, key: string): string | undefined {
  const parts = key.split("/");
  if (isAbsolute(key) || key.includes("\0") || parts.some((p) => p === "" || p === "." || p === "..")) return undefined;
  if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) return undefined;
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) return join(root, ...parts);
    const last = index === parts.length - 1;
    if (last ? !stat.isFile() : !stat.isDirectory()) return undefined;
  }
  return current;
}
