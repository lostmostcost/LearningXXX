import { createHash, randomUUID } from "node:crypto";
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { AppError, Attachment, Id, PreparedAttachment } from "@learningxxx/contracts";
import type { ErrorCode, Session } from "@learningxxx/contracts";
import { z } from "zod";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const TYPES: Record<string, string> = { ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const Stored = z.object({ attachment: PreparedAttachment, accountKey: z.string().nullable(), extension: z.string() });
type Stored = z.infer<typeof Stored>;
export interface AttachmentServiceOptions {
  dataRoot: string;
  getSession: (id: string) => Session;
  accountKey: () => string | undefined;
  chooseLocal: () => Promise<string | undefined>;
  capture?: () => Promise<Uint8Array | undefined>;
  readAsset: (courseId: string, assetId: string) => Promise<{ bytes: Uint8Array; mediaType: string; name: string; accountKey: string | undefined }>;
}
function fail(code: ErrorCode, message: string): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable: false }) });
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Explicit user inputs only. Originals are never granted to the CLI. */
export class AttachmentService {
  readonly #o: AttachmentServiceOptions;
  readonly #root: string;
  #capturing = false;
  constructor(options: AttachmentServiceOptions) {
    this.#o = options;
    this.#root = join(options.dataRoot, "attachments");
    mkdirSync(join(this.#root, "staged"), { recursive: true });
    mkdirSync(join(this.#root, "runs"), { recursive: true });
    for (const id of readdirSync(join(this.#root, "staged"))) {
      if (!Id.safeParse(id).success) continue;
      try {
        const stored = Stored.safeParse(JSON.parse(readFileSync(this.#record(id), "utf8")));
        if (stored.success && stored.data.attachment.provenance === "capture" && !stored.data.attachment.confirmed) {
          rmSync(this.#stage(id), { recursive: true, force: true });
        }
      } catch { /* A partial cache is never delivered; leave it for explicit recovery. */ }
    }
    // No run is resumed automatically after an app restart. Drop only our temporary copies.
    for (const id of readdirSync(join(this.#root, "runs"))) if (Id.safeParse(id).success) this.releaseRun(id);
  }
  #stage(id: string) { return join(this.#root, "staged", Id.parse(id)); }
  #record(id: string) { return join(this.#stage(id), "record.json"); }
  #source(record: Stored) { return join(this.#stage(record.attachment.id), `input${record.extension}`); }
  #read(appSessionId: string, id: string): Stored {
    this.#o.getSession(appSessionId);
    if (!Id.safeParse(id).success || !existsSync(this.#record(id))) fail("INVALID_REQUEST", "첨부를 다시 선택해 주세요.");
    const record = Stored.parse(JSON.parse(readFileSync(this.#record(id), "utf8")));
    if (record.attachment.appSessionId !== appSessionId || record.accountKey !== (this.#o.accountKey() ?? null)) {
      fail("SCOPE_VIOLATION", "다른 세션이나 계정의 첨부는 사용할 수 없습니다.");
    }
    const path = this.#source(record);
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || hash(readFileSync(path)) !== record.attachment.contentHash) {
      fail("CHECKSUM_MISMATCH", "준비한 첨부가 바뀌었습니다. 다시 선택해 주세요.");
    }
    return record;
  }
  #prepare(appSessionId: string, name: string, bytes: Uint8Array, provenance: PreparedAttachment["provenance"], sourceAssetId?: string): PreparedAttachment {
    const session = this.#o.getSession(appSessionId);
    if (session.archivedAt) fail("INVALID_REQUEST", "보관된 세션에는 첨부할 수 없습니다.");
    name = basename(name).slice(0, 255);
    const extension = extname(name).toLowerCase();
    const mediaType = TYPES[extension];
    if (!mediaType) fail("UNSUPPORTED_FORMAT", "PDF, 텍스트, PNG/JPEG/WebP 파일을 선택하세요.");
    if (bytes.length > MAX_ATTACHMENT_BYTES) fail("INVALID_REQUEST", "첨부는 파일당 20MB까지 지원합니다.");
    const attachment = PreparedAttachment.parse({ id: randomUUID(), appSessionId, name, mediaType, bytes: bytes.length, contentHash: hash(bytes), provenance, ...(sourceAssetId ? { sourceAssetId } : {}), confirmed: false });
    const record: Stored = { attachment, accountKey: this.#o.accountKey() ?? null, extension };
    mkdirSync(this.#stage(attachment.id), { mode: 0o700 });
    writeFileSync(this.#source(record), bytes, { mode: 0o400 });
    writeFileSync(this.#record(attachment.id), JSON.stringify(record));
    return attachment;
  }
  async chooseLocal({ appSessionId }: { appSessionId: string }) {
    this.#o.getSession(appSessionId);
    const accountKey = this.#o.accountKey();
    const path = await this.#o.chooseLocal();
    if (!path) return undefined;
    if (accountKey !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다. 다시 선택하세요.");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("SCOPE_VIOLATION", "일반 파일을 선택하세요.");
    if (stat.size > MAX_ATTACHMENT_BYTES) fail("INVALID_REQUEST", "첨부는 파일당 20MB까지 지원합니다.");
    return this.#prepare(appSessionId, basename(path), readFileSync(path), "local_file");
  }
  async prepareAsset({ appSessionId, courseId, assetId }: { appSessionId: string; courseId: string; assetId: string }) {
    this.#o.getSession(appSessionId);
    const source = await this.#o.readAsset(courseId, assetId);
    if (source.accountKey !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다. 다시 선택하세요.");
    return this.#prepare(appSessionId, source.name, source.bytes, "course_asset", assetId);
  }
  async capture({ appSessionId }: { appSessionId: string }) {
    this.#o.getSession(appSessionId);
    if (this.#capturing) fail("RUN_ALREADY_ACTIVE", "진행 중인 영역 선택을 끝내거나 취소하세요.");
    if (!this.#o.capture) fail("CAPTURE_FAILED", "화면 캡처를 사용할 수 없습니다.");
    this.#capturing = true;
    const accountKey = this.#o.accountKey();
    try {
      const bytes = await this.#o.capture();
      if (!bytes) return undefined;
      if (accountKey !== this.#o.accountKey()) fail("SCOPE_VIOLATION", "계정이 바뀌었습니다. 다시 캡처하세요.");
      const attachment = this.#prepare(appSessionId, "화면 캡처.png", bytes, "capture");
      // A fresh copy: the contract carries a plain ArrayBuffer, and nothing else rides along over IPC.
      return { attachment, preview: new Uint8Array(bytes) };
    } finally { this.#capturing = false; }
  }
  confirm({ appSessionId, attachmentId }: { appSessionId: string; attachmentId: string }) {
    const record = this.#read(appSessionId, attachmentId);
    record.attachment.confirmed = true;
    writeFileSync(this.#record(attachmentId), JSON.stringify(record));
    return record.attachment;
  }
  remove({ appSessionId, attachmentId }: { appSessionId: string; attachmentId: string }) {
    this.#read(appSessionId, attachmentId);
    // This deletes only the app's staged copy, never the selected original.
    rmSync(this.#stage(attachmentId), { recursive: true });
    return { removed: true };
  }
  forRun(appSessionId: string, runId: string, attachmentIds: readonly string[], captureIds: readonly string[] = []) {
    const ids = [...attachmentIds, ...captureIds];
    if (ids.length > 8 || new Set(ids).size !== ids.length) fail("INVALID_REQUEST", "첨부는 중복 없이 8개까지 보낼 수 있습니다.");
    const records = ids.map((id) => this.#read(appSessionId, id));
    if (records.some((r, i) => (r.attachment.provenance === "capture") !== (i >= attachmentIds.length))) fail("INVALID_REQUEST", "첨부와 캡처 종류가 맞지 않습니다.");
    if (records.some((r) => !r.attachment.confirmed)) fail("INVALID_REQUEST", "첨부할 파일을 먼저 확인하세요.");
    if (!records.length) return { dirs: [] as string[], prompt: "" };
    const dir = join(this.#root, "runs", Id.parse(runId));
    mkdirSync(dir, { recursive: true });
    try {
      const attachments = records.map((record) => {
        const key = `attachments/runs/${runId}/${record.attachment.id}${record.extension}`;
        const target = join(this.#o.dataRoot, key);
        copyFileSync(this.#source(record), target);
        chmodSync(target, 0o400);
        return Attachment.parse({ id: record.attachment.id, runId, sourceAssetId: record.attachment.sourceAssetId, userConfirmed: true, contentHash: record.attachment.contentHash, localKey: key, provenance: record.attachment.provenance });
      });
      // CLI's file tools cannot replace files or create neighbours in this directory.
      chmodSync(dir, 0o500);
      mkdirSync(join(this.#root, "manifests"), { recursive: true });
      writeFileSync(join(this.#root, "manifests", `${runId}.json`), JSON.stringify(attachments));
      return { dirs: [dir], prompt: `사용자가 명시적으로 확인한 읽기 전용 첨부:\n${attachments.map((a, i) => `${JSON.stringify(records[i]!.attachment.name)}: ${JSON.stringify(join(this.#o.dataRoot, a.localKey))}`).join("\n")}` };
    } catch (error) { this.releaseRun(runId); throw error; }
  }
  /** Native CLI history can refer to these copies after the app restarts. */
  forNative(appSessionId: string, attachmentId: string) {
    const record = this.#read(appSessionId, attachmentId);
    if (!record.attachment.confirmed) fail('INVALID_REQUEST', '첨부를 먼저 확인하세요.');
    const dir = join(this.#o.dataRoot, 'native-attachments', Id.parse(appSessionId));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const inside = relative(realpathSync(this.#o.dataRoot), realpathSync(dir));
    if (inside.startsWith('..') || isAbsolute(inside)) fail('SCOPE_VIOLATION', '첨부 폴더가 앱 경계를 벗어났습니다.');
    const target = join(dir, `${record.attachment.id}${record.extension}`);
    if (existsSync(target)) {
      if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink() || hash(readFileSync(target)) !== record.attachment.contentHash) fail('CHECKSUM_MISMATCH', '전달 복사본이 바뀌었습니다. 다시 준비하세요.');
    } else { copyFileSync(this.#source(record), target, constants.COPYFILE_EXCL); chmodSync(target, 0o400); }
    return { text: `사용자가 확인한 첨부 ${JSON.stringify(record.attachment.name)}: ${JSON.stringify(target)}` };
  }
  releaseRun(runId: string) {
    const dir = join(this.#root, "runs", Id.parse(runId));
    if (existsSync(dir)) { chmodSync(dir, 0o700); rmSync(dir, { recursive: true }); }
  }
}
