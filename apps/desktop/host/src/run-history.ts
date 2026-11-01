import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { RunChanges } from "@learningxxx/contracts";
import type { FileChange } from "@learningxxx/contracts";

/** Above this a workspace is compared but not copied, and the summary says so. */
export const MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024;

type Scan = Record<string, string>;

interface Baseline {
  runId: string;
  appSessionId: string;
  workspace: string;
  externals: string[];
  files: Scan;
  externalFiles: Scan[];
  snapshotKept: boolean;
}

/** Regular files only: a symlink is never followed out of the folder being read. */
function walk(root: string, visit: (path: string, bytes: number, mtimeMs: number) => void): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else if (entry.isFile()) {
      const { size, mtimeMs } = lstatSync(path);
      visit(path, size, mtimeMs);
    }
  }
}

const relativeKey = (root: string, path: string) => relative(root, path).split(sep).join("/");

function scanHashed(root: string): { files: Scan; bytes: number } {
  const files: Scan = {};
  let bytes = 0;
  walk(root, (path, size) => {
    bytes += size;
    files[relativeKey(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
  });
  return { files, bytes };
}

/** External folders can be large and are not ours, so they get size and time only. */
function scanLight(root: string): Scan {
  const files: Scan = {};
  if (!existsSync(root)) return files;
  walk(root, (path, size, mtimeMs) => {
    files[relativeKey(root, path)] = `${size}:${mtimeMs}`;
  });
  return files;
}

function diff(before: Scan, after: Scan, restorable: boolean, prefix = ""): FileChange[] {
  const changes: FileChange[] = [];
  for (const key of Object.keys(after).sort()) {
    if (before[key] === undefined) changes.push({ key: prefix + key, change: "created", restorable });
    else if (before[key] !== after[key]) changes.push({ key: prefix + key, change: "modified", restorable });
  }
  for (const key of Object.keys(before).sort()) {
    if (after[key] === undefined) changes.push({ key: prefix + key, change: "deleted", restorable });
  }
  return changes;
}

/**
 * Keeps a copy of a session workspace before each run and records what the run
 * changed. Each run is therefore one recoverable version. Lives outside the
 * workspace, so the CLI cannot read or alter its own history.
 */
export class RunHistory {
  readonly #root: string;
  readonly #now: () => string;

  constructor(root: string, now: () => string) {
    this.#root = root;
    this.#now = now;
  }

  #dir(runId: string): string {
    return join(this.#root, runId);
  }

  begin(runId: string, appSessionId: string, workspace: string, externals: string[]): void {
    const dir = this.#dir(runId);
    mkdirSync(join(dir, "before"), { recursive: true });
    const { files, bytes } = scanHashed(workspace);
    const snapshotKept = bytes <= MAX_SNAPSHOT_BYTES;
    if (snapshotKept) {
      for (const key of Object.keys(files)) {
        const target = join(dir, "before", key);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(workspace, key), target);
      }
    }
    const baseline: Baseline = {
      runId, appSessionId, workspace, externals, files, externalFiles: externals.map(scanLight), snapshotKept,
    };
    writeFileSync(join(dir, "baseline.json"), JSON.stringify(baseline));
  }

  /** Safe to call after a crash: it only reads folders and the stored baseline. */
  finish(runId: string): RunChanges | undefined {
    const path = join(this.#dir(runId), "baseline.json");
    if (!existsSync(path)) return undefined;
    const base = JSON.parse(readFileSync(path, "utf8")) as Baseline;
    const changes = RunChanges.parse({
      runId,
      appSessionId: base.appSessionId,
      recordedAt: this.#now(),
      snapshotKept: base.snapshotKept,
      externalFolders: base.externals,
      changes: [
        ...diff(base.files, scanHashed(base.workspace).files, base.snapshotKept),
        ...base.externals.flatMap((root, i) => diff(base.externalFiles[i] ?? {}, scanLight(root), false, `external-${i}/`)),
      ],
    });
    writeFileSync(join(this.#dir(runId), "changes.json"), JSON.stringify(changes));
    return changes;
  }

  changes(runId: string): RunChanges | undefined {
    const path = join(this.#dir(runId), "changes.json");
    return existsSync(path) ? RunChanges.parse(JSON.parse(readFileSync(path, "utf8"))) : undefined;
  }

  workspaceOf(runId: string): string | undefined {
    const path = join(this.#dir(runId), "baseline.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Baseline).workspace : undefined;
  }

  beforeCopy(runId: string, key: string): string {
    return join(this.#dir(runId), "before", key);
  }
}
