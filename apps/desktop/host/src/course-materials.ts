import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { CollectionManifest } from "@learningxxx/contracts";
import { pageTextFile } from "./pdf-text.ts";

/** One collected file and where it appears in the course's materials folder. */
export interface MaterialEntry {
  assetId: string;
  /** Relative to the materials folder, `/`-separated: `01 1주차/OT.pdf`. */
  path: string;
  sha256: string;
  storageKey: string;
  /** For a PDF: `<path>.txt`, its text page by page, when it could be read. */
  textPath?: string;
}

/** Names people recognise, safe as one path component on macOS. */
function component(name: string, max = 100): string {
  const cleaned = name.replace(/[\u0000-\u001f/\\:]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return (cleaned || "자료").slice(0, max).trim();
}

/**
 * Lays the course out by week, in the LMS order, named after each resource.
 * A resource with several files keeps each file's own name. Same names get a
 * number, so every path is unique.
 */
export function materialLayout(manifest: CollectionManifest): MaterialEntry[] {
  const weeks = manifest.weeks.toSorted((a, b) => a.order - b.order);
  const folder = new Map(weeks.map((w, i) => [w.id, component(`${String(i + 1).padStart(2, "0")} ${w.label}`)]));
  const used = new Set<string>();
  const entries: MaterialEntry[] = [];
  for (const { resource, assets } of manifest.items) {
    const dir = (resource.weekId && folder.get(resource.weekId)) || "00 주차 없음";
    for (const asset of assets) {
      const ext = extname(asset.originalName).toLowerCase();
      const base = assets.length === 1 ? component(resource.title.endsWith(ext) ? resource.title.slice(0, -ext.length) : resource.title) : component(asset.originalName.slice(0, asset.originalName.length - ext.length));
      let path = `${dir}/${base}${ext}`;
      for (let n = 2; used.has(path.normalize("NFC").toLowerCase()); n += 1) path = `${dir}/${base} (${n})${ext}`;
      used.add(path.normalize("NFC").toLowerCase());
      entries.push({ assetId: asset.id, path, sha256: asset.sha256, storageKey: asset.storageKey });
    }
  }
  return entries;
}

const INDEX = ".learningxxx-materials.json";

/**
 * Makes `dir` hold exactly these files, as read-only copies of the verified
 * originals (APFS clones, so no extra space). The AI may read them; the
 * originals in the library are never exposed. Unchanged files are left alone,
 * removed ones are deleted, and a file whose original fails verification is
 * left out rather than shown stale. Each PDF also gets `<name>.pdf.txt` with
 * its text page by page, made once per version. Returns the entries actually
 * present.
 */
export async function syncMaterials(
  dir: string,
  entries: readonly MaterialEntry[],
  source: {
    path: (storageKey: string) => string;
    verify: (storageKey: string, sha256: string) => Promise<boolean>;
    /** Text of each page of a PDF; without it no text files are made. */
    pageTexts?: (bytes: Uint8Array) => Promise<string[]>;
  },
): Promise<MaterialEntry[]> {
  mkdirSync(dir, { recursive: true });
  const indexFile = `${dir}${INDEX}`; // beside the folder, not in it
  let index: Record<string, string> = {};
  try {
    index = JSON.parse(readFileSync(indexFile, "utf8")) as Record<string, string>;
  } catch {
    // First run, or an unreadable index: every file is checked again.
  }
  const present: MaterialEntry[] = [];
  const next: Record<string, string> = {};
  for (const entry of entries) {
    const target = join(dir, ...entry.path.split("/"));
    if (index[entry.path] !== entry.sha256 || !existsSync(target)) {
      rmSync(target, { force: true });
      if (!(await source.verify(entry.storageKey, entry.sha256))) continue;
      mkdirSync(join(target, ".."), { recursive: true });
      copyFileSync(source.path(entry.storageKey), target, constants.COPYFILE_FICLONE);
      chmodSync(target, 0o444);
    }
    next[entry.path] = entry.sha256;
    const textPath = `${entry.path}.txt`;
    const textFile = join(dir, ...textPath.split("/"));
    if (!entry.path.toLowerCase().endsWith(".pdf") || !source.pageTexts) {
      present.push(entry);
      continue;
    }
    if (index[textPath] !== entry.sha256 || !existsSync(textFile)) {
      rmSync(textFile, { force: true });
      try {
        const pages = await source.pageTexts(new Uint8Array(readFileSync(target)));
        writeFileSync(textFile, pageTextFile(entry.path.split("/").pop()!, pages), { mode: 0o444 });
      } catch {
        // An unreadable PDF still shows up; it just has no text file.
        present.push(entry);
        continue;
      }
    }
    next[textPath] = entry.sha256;
    present.push({ ...entry, textPath });
  }
  // Whatever is not in the layout any more goes: deleted at the source, renamed, or written by someone else.
  const keep = new Set(Object.keys(next).map((p) => join(dir, ...p.split("/"))));
  const prune = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (lstatSync(path).isDirectory()) {
        prune(path);
        if (readdirSync(path).length === 0) rmSync(path, { recursive: true });
      } else if (!keep.has(path)) {
        rmSync(path, { force: true });
      }
    }
  };
  prune(dir);
  writeFileSync(indexFile, JSON.stringify(next));
  return present;
}
