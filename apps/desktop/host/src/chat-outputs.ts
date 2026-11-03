import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AppError, type ChatOutput } from "@learningxxx/contracts";

/**
 * WBS-081: files a conversation made, so they can be found from the app:
 * everything in the conversation's own folder (where Claude Code works by
 * default) and files its Write/Edit tools wrote anywhere else. The app only
 * opens or shows a file that is in this list when asked; the renderer names
 * a file by an id, never by a path.
 */

/** Text shown inside the app at most; larger files open in their own app. */
export const MAX_PREVIEW_BYTES = 1024 ** 2;
const MAX_FILES = 300;
const MAX_DEPTH = 4;
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const TEXT = new Set(["md", "markdown", "txt", "csv", "tsv", "json", "yaml", "yml", "html", "htm", "xml", "py", "js", "ts", "tsx", "jsx", "java", "c", "cpp", "h", "hpp", "cs", "go", "rs", "rb", "sh", "sql", "css", "tex", "log", "ipynb"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
/** Opened in their own app on request: documents and pictures only, never scripts or programs. */
const OPENABLE = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp", "txt", "md", "markdown", "csv", "tsv", "rtf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "hwp", "hwpx", "key", "pages", "numbers"]);
/** Folders a tool or project fills with files nobody asked for. */
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", ".claude"]);

function fail(code: "NOT_FOUND" | "INVALID_REQUEST", message: string): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable: false }) });
}

const kindOf = (name: string): ChatOutput["kind"] => {
  const ext = extname(name).slice(1).toLowerCase();
  return ext === "pdf" ? "pdf" : TEXT.has(ext) ? "text" : IMAGE.has(ext) ? "image" : "other";
};
const idOf = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 32);
/** "~/Desktop/notes.md" rather than the full home path. */
const shown = (path: string) => { const home = homedir(); return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path; };

/** Paths a conversation's file tools wrote to, from the tool inputs kept with its messages. */
export function writtenPaths(messages: readonly { tools: readonly { name: string; input: string }[] }[], cwd: string): string[] {
  const out = new Set<string>();
  for (const message of messages) for (const tool of message.tools) {
    if (!WRITE_TOOLS.has(tool.name)) continue;
    let input: Record<string, unknown>;
    try { input = JSON.parse(tool.input) as Record<string, unknown>; } catch { continue; }
    const path = input.file_path ?? input.notebook_path;
    if (typeof path === "string" && path.trim() && !path.includes("\0")) out.add(isAbsolute(path) ? resolve(path) : resolve(cwd, path));
  }
  return [...out];
}

interface Found { output: ChatOutput; path: string }

export interface ChatOutputsOptions {
  /** The conversation's working folder and messages; throws when the conversation is unknown. */
  workspace: (appSessionId: string) => { cwd: string; messages: readonly { tools: readonly { name: string; input: string }[] }[] };
  openPath: (path: string) => Promise<string>;
  reveal: (path: string) => void;
}

export class ChatOutputs {
  readonly #o: ChatOutputsOptions;
  constructor(options: ChatOutputsOptions) { this.#o = options; }

  async #find(appSessionId: string): Promise<Found[]> {
    const { cwd, messages } = this.#o.workspace(appSessionId);
    const root = await realpath(cwd).catch(() => undefined);
    const found = new Map<string, Found>();
    const add = async (path: string, where: ChatOutput["where"]) => {
      // Only plain files; a link is never followed to somewhere else.
      const info = await lstat(path).catch(() => undefined);
      if (!info?.isFile() || found.has(path) || found.size >= MAX_FILES) return;
      const name = basename(path);
      found.set(path, { path, output: { id: idOf(path), name, location: where === "folder" && root ? relative(root, path) : shown(path), where, bytes: info.size, modifiedAt: info.mtime.toISOString().replace(/\.\d{3}Z$/, "Z"), kind: kindOf(name), openable: OPENABLE.has(extname(name).slice(1).toLowerCase()) } });
    };
    const walk = async (dir: string, depth: number) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        // App bookkeeping and hidden files (.chat-ui.json …) are not results; `course` is the read-only material link.
        if (entry.name.startsWith(".") || (depth === 0 && entry.name === "course")) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory() && depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) await walk(path, depth + 1);
        else if (entry.isFile()) await add(path, "folder");
      }
    };
    if (root) await walk(root, 0);
    for (const path of writtenPaths(messages, cwd)) {
      const real = await realpath(path).catch(() => undefined);
      if (!real) continue;
      const inside = root && (real === root || real.startsWith(root + sep));
      if (inside && relative(root, real).split(sep).some((part, i) => part.startsWith(".") || (i === 0 && part === "course"))) continue;
      await add(real, inside ? "folder" : "elsewhere");
    }
    return [...found.values()].sort((a, b) => b.output.modifiedAt.localeCompare(a.output.modifiedAt) || a.output.name.localeCompare(b.output.name));
  }

  async list(appSessionId: string): Promise<{ files: ChatOutput[]; folder: string }> {
    const files = await this.#find(appSessionId);
    return { files: files.map((f) => f.output), folder: shown(this.#o.workspace(appSessionId).cwd) };
  }

  async #one(appSessionId: string, id: string): Promise<Found> {
    return (await this.#find(appSessionId)).find((f) => f.output.id === id) ?? fail("NOT_FOUND", "파일을 찾을 수 없습니다. 목록을 새로 고치세요.");
  }

  /** A text file's content for the in-app view. */
  async read(appSessionId: string, id: string): Promise<{ text: string }> {
    const file = await this.#one(appSessionId, id);
    if (file.output.kind !== "text") fail("INVALID_REQUEST", "앱 안에서는 글 파일만 볼 수 있습니다. '열기'로 여세요.");
    const info = await stat(file.path);
    if (info.size > MAX_PREVIEW_BYTES) fail("INVALID_REQUEST", "파일이 커서 앱 안에서 보여 줄 수 없습니다. '열기'로 여세요.");
    const bytes = await readFile(file.path);
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes) };
  }

  /** Opens the file in its default app, or shows it in Finder. */
  async show(appSessionId: string, id: string, how: "open" | "reveal"): Promise<Record<string, never>> {
    const file = await this.#one(appSessionId, id);
    if (how === "reveal") this.#o.reveal(file.path);
    else {
      if (!file.output.openable) fail("INVALID_REQUEST", "이 형식은 앱에서 바로 열지 않습니다(프로그램·스크립트일 수 있음). 'Finder에서 보기'로 확인하세요."); const problem = await this.#o.openPath(file.path); if (problem) fail("INVALID_REQUEST", `열지 못했습니다: ${problem}`); }
    return {};
  }
}
