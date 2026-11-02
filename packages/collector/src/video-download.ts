import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { MediaAsset, Id } from "@learningxxx/contracts";
import { CollectionError, collectionError } from "./errors.ts";
import { stableId } from "./discovery.ts";
import { httpsOrigin } from "./video-source.ts";
import type { VideoSource } from "./video-source.ts";

export interface VideoDownloadInput {
  /** Private per-Mac/account root supplied by the host, not an LMS filename. */
  root: string;
  courseId: string;
  resourceId: string;
  sourceId: string;
  title: string;
  /** Resolve again on every attempt; authenticates with the user's own session. */
  resolveSource: (signal?: AbortSignal) => Promise<VideoSource>;
  fetch: typeof globalThis.fetch;
  /** Explicit trusted origins; never expand this list from a server response. */
  allowedOrigins: readonly string[];
  signal?: AbortSignal;
  /** Default 20 GiB; checked while streaming even without Content-Length. */
  maxBytes?: number;
  /** Total attempts, 1..3. Never resumes a partial object from an expiring URL. */
  attempts?: number;
  retryDelayMs?: number;
  /** Hard timeout per attempt, including metadata and the response body. */
  timeoutMs?: number;
  onProgress?: (receivedBytes: number, totalBytes?: number) => void;
}

const fail = (message = "영상 파일이 완전하지 않아 원본으로 저장하지 않았습니다.") => collectionError("DOWNLOAD_INCOMPLETE", message, { retryable: true });
const cancelled = () => collectionError("RUN_INTERRUPTED", "영상 다운로드를 취소했습니다. 완료된 원본은 그대로 남습니다.");

async function read(handle: FileHandle, offset: number, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let done = 0;
  while (done < size) {
    const result = await handle.read(buffer, done, size - done, offset + done);
    if (!result.bytesRead) throw fail();
    done += result.bytesRead;
  }
  return buffer;
}

/** Structural MP4 completion check. Does not claim to decode every frame. */
export async function validateMp4(handle: FileHandle, bytes: number): Promise<void> {
  let offset = 0;
  let ftyp = false, moov = false, mdat = false, video = false, samples = false;
  let sampleBytes = 0;
  const mediaRanges: { start: number; end: number }[] = [];
  const chunkOffsets: number[] = [];
  // Bound box count/metadata size so hostile headers cannot exhaust memory/CPU.
  let boxes = 0;
  while (offset < bytes) {
    if (++boxes > 100_000 || bytes - offset < 8) throw fail();
    let head = await read(handle, offset, 8);
    const type = head.toString("ascii", 4, 8);
    let size = head.readUInt32BE(0), header = 8;
    if (size === 1) {
      head = await read(handle, offset, 16);
      const large = head.readBigUInt64BE(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw fail();
      size = Number(large); header = 16;
    }
    // Size=0 extends to EOF and cannot prove a transfer wasn't cut short.
    if (size < header || size > bytes - offset) throw fail();
    if (type === "ftyp") {
      if (offset !== 0 || size < header + 8 || size > 4096) throw fail();
      ftyp = true;
    }
    if (type === "mdat" && size > header) {
      mdat = true;
      mediaRanges.push({ start: offset + header, end: offset + size });
    }
    if (type === "moof") throw collectionError("UNSUPPORTED_FORMAT", "분할 스트리밍 영상은 직접 MP4 원본 다운로드로 처리하지 않습니다.");
    if (type === "moov") {
      if (moov || size > 32 * 1024 * 1024) throw fail();
      moov = true;
      const data = await read(handle, offset + header, size - header);
      const walk = (start: number, end: number, depth: number) => {
        if (depth > 10) throw fail();
        let pos = start;
        while (pos < end) {
          if (++boxes > 100_000 || end - pos < 8) throw fail();
          const n = data.readUInt32BE(pos);
          const name = data.toString("ascii", pos + 4, pos + 8);
          if (n < 8 || n > end - pos) throw fail();
          if (name === "pssh" || name === "sinf") throw collectionError("UNSUPPORTED_FORMAT", "암호화된 영상은 다운로드하지 않습니다.");
          if (name === "hdlr" && n >= 20 && data.toString("ascii", pos + 16, pos + 20) === "vide") video = true;
          if (name === "stsz") {
            if (n < 20) throw fail();
            const count = data.readUInt32BE(pos + 16);
            const fixedSize = data.readUInt32BE(pos + 12);
            if (count === 0 || (fixedSize === 0 && 20 + count * 4 !== n)) throw fail();
            let total = fixedSize * count;
            if (fixedSize === 0) for (let i = 0; i < count; i++) total += data.readUInt32BE(pos + 20 + i * 4);
            sampleBytes += total;
            if (!Number.isSafeInteger(sampleBytes) || sampleBytes > bytes) throw fail();
            samples = true;
          }
          if (name === "stco" || name === "co64") {
            if (n < 16) throw fail();
            const count = data.readUInt32BE(pos + 12), width = name === "stco" ? 4 : 8;
            if (count === 0 || 16 + count * width !== n || chunkOffsets.length + count > 1_000_000) throw fail();
            for (let i = 0; i < count; i++) {
              const at = pos + 16 + i * width;
              const value = width === 4 ? data.readUInt32BE(at) : Number(data.readBigUInt64BE(at));
              if (!Number.isSafeInteger(value)) throw fail();
              chunkOffsets.push(value);
            }
          }
          if (["trak", "mdia", "minf", "stbl", "udta"].includes(name)) walk(pos + 8, pos + n, depth + 1);
          if (name === "stsd") {
            if (n < 16) throw fail();
            let entry = pos + 16;
            const count = data.readUInt32BE(pos + 12);
            if (count > 1024) throw fail();
            for (let i = 0; i < count; i++) {
              if (entry + 8 > pos + n) throw fail();
              const length = data.readUInt32BE(entry);
              const codec = data.toString("ascii", entry + 4, entry + 8);
              if (length < 8 || length > pos + n - entry) throw fail();
              if (codec === "encv" || codec === "enca") throw collectionError("UNSUPPORTED_FORMAT", "암호화된 영상은 다운로드하지 않습니다.");
              entry += length;
            }
            if (entry !== pos + n) throw fail();
          }
          pos += n;
        }
      };
      walk(0, data.length, 0);
    }
    if (type === "pssh") throw collectionError("UNSUPPORTED_FORMAT", "암호화된 영상은 다운로드하지 않습니다.");
    offset += size;
  }
  if (!ftyp || !moov || !mdat || !video || !samples || sampleBytes < 1 || !chunkOffsets.length) throw fail();
  if (sampleBytes > mediaRanges.reduce((sum, range) => sum + range.end - range.start, 0)) throw fail();
  // Ranges are in file order. Binary lookup keeps malformed large tables bounded.
  for (const chunk of chunkOffsets) {
    let lo = 0, hi = mediaRanges.length - 1, found = false;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1, range = mediaRanges[mid]!;
      if (chunk < range.start) hi = mid - 1;
      else if (chunk >= range.end) lo = mid + 1;
      else { found = true; break; }
    }
    if (!found) throw fail();
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk); }
  finally { await handle.close(); }
  return hash.digest("hex");
}

async function directory(root: string, parts: string[]): Promise<string> {
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    await mkdir(path, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw collectionError("SCOPE_VIOLATION", "영상 저장 폴더가 다른 경로를 가리켜 중단했습니다.");
  }
  return path;
}

/**
 * Local-only original download. Publish only a fully received, validated file
 * via create-only hard link. No URL/credential is returned, logged or persisted.
 * WBS-027 registers the returned MediaAsset for automatic transcription.
 */
export async function downloadVideo(input: VideoDownloadInput): Promise<MediaAsset> {
  const courseId = Id.parse(input.courseId), resourceId = Id.parse(input.resourceId);
  if (!/^[\w-]{1,64}$/.test(input.sourceId) || !input.title.trim() || input.title.length > 200) throw collectionError("INVALID_REQUEST", "영상 식별자나 제목을 확인하세요.");
  const allowed = new Set(input.allowedOrigins.map(httpsOrigin));
  const maxBytes = input.maxBytes ?? 20 * 1024 ** 3;
  const attempts = input.attempts ?? 3;
  const timeoutMs = input.timeoutMs ?? 30 * 60_000;
  const delay = input.retryDelayMs ?? 1000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isInteger(attempts) || attempts < 1 || attempts > 3 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000 || !Number.isFinite(delay) || delay < 0 || delay > 60_000) throw collectionError("INVALID_REQUEST", "영상 다운로드 제한 설정이 올바르지 않습니다.");
  if (input.signal?.aborted) throw cancelled();
  await mkdir(input.root, { recursive: true, mode: 0o700 });
  const root = await realpath(input.root);
  const tmp = await directory(root, ["video-tmp"]);
  for (let attempt = 1; ; attempt++) {
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(input.signal ? [input.signal] : [])]);
    const temp = join(tmp, `${randomUUID()}.part`);
    let handle: FileHandle | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      signal.throwIfAborted();
      const source = await input.resolveSource(signal);
      if (!allowed.has(httpsOrigin(source.url)) || !allowed.has(httpsOrigin(source.referer))) throw collectionError("SOURCE_CHANGED", "허용하지 않은 서버의 영상은 받지 않았습니다.");
      const response = await input.fetch(source.url, { redirect: "manual", headers: { Referer: source.referer, Accept: "video/mp4", "Accept-Encoding": "identity" }, signal });
      const reject = async (error: CollectionError): Promise<never> => { await response.body?.cancel(); throw error; };
      if (response.url && !allowed.has(httpsOrigin(response.url))) await reject(collectionError("SOURCE_CHANGED", "영상 응답이 허용한 서버를 벗어났습니다."));
      if (response.status === 401 || response.status === 403) await reject(collectionError("DOWNLOAD_FAILED", "영상 주소가 만료되었습니다. 새 주소로 다시 시도합니다.", { retryable: true }));
      if (response.status >= 300 && response.status < 400) await reject(collectionError("AUTH_REQUIRED", "학교 로그인 또는 영상 접근 권한을 확인하세요."));
      if (response.status !== 200 || !response.body) await reject(collectionError("DOWNLOAD_FAILED", "영상 원본을 받지 못했습니다.", { retryable: response.status >= 500 || response.status === 429 }));
      const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (type !== "video/mp4" && type !== "application/octet-stream") await reject(collectionError("UNSUPPORTED_FORMAT", "응답이 MP4 원본이 아닙니다. HTML·스트리밍 목록은 저장하지 않습니다."));
      const encoding = response.headers.get("content-encoding");
      if (encoding && encoding !== "identity") await reject(fail());
      const length = response.headers.get("content-length");
      const declared = length === null ? undefined : Number(length);
      if (declared !== undefined && (!/^\d+$/.test(length!) || !Number.isSafeInteger(declared) || declared < 1 || declared > maxBytes)) await reject(fail("영상 크기가 허용 범위에 없어서 저장하지 않았습니다."));
      if (source.expectedBytes !== undefined && (!Number.isSafeInteger(source.expectedBytes) || source.expectedBytes < 1 || source.expectedBytes > maxBytes)) await reject(collectionError("SOURCE_CHANGED", "영상 원본 크기 정보가 올바르지 않습니다."));
      if (declared !== undefined && source.expectedBytes !== undefined && declared !== source.expectedBytes) await reject(fail());
      handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      reader = response.body!.getReader();
      const hash = createHash("sha256");
      let bytes = 0;
      let prefix = Buffer.alloc(0);
      for (;;) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > maxBytes || (declared !== undefined && bytes > declared) || (source.expectedBytes !== undefined && bytes > source.expectedBytes)) throw fail();
        if (prefix.length < 8) {
          prefix = Buffer.concat([prefix, part.value.subarray(0, 8 - prefix.length)]);
          if (prefix.length === 8 && prefix.toString("ascii", 4, 8) !== "ftyp") throw fail();
        }
        hash.update(part.value);
        let written = 0;
        while (written < part.value.length) {
          const result = await handle.write(part.value, written, part.value.length - written);
          if (!result.bytesWritten) throw fail();
          written += result.bytesWritten;
        }
        // Observers cannot invalidate a successfully received original.
        try { input.onProgress?.(bytes, declared ?? source.expectedBytes); } catch { /* UI observer */ }
      }
      signal.throwIfAborted();
      if ((declared !== undefined && bytes !== declared) || (source.expectedBytes !== undefined && bytes !== source.expectedBytes)) throw fail();
      await validateMp4(handle, bytes);
      await handle.sync();
      await handle.close(); handle = undefined;
      const sha256 = hash.digest("hex");
      const parent = await directory(root, ["video-originals", sha256.slice(0, 2)]);
      const storageKey = `video-originals/${sha256.slice(0, 2)}/${sha256}.mp4`;
      const target = join(parent, `${sha256}.mp4`);
      signal.throwIfAborted();
      try { await link(temp, target); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes || await hashFile(target) !== sha256) throw collectionError("CHECKSUM_MISMATCH", "기존 영상 원본의 무결성을 확인하지 못했습니다. 덮어쓰지 않았습니다.");
      return MediaAsset.parse({ schemaVersion: 1, id: stableId("video-original", courseId, resourceId, input.sourceId, sha256), courseId, role: "original", source: { type: "lms_video", resourceId, sourceId: input.sourceId }, title: input.title, mediaType: "video/mp4", bytes, sha256, storageKey, createdAt: new Date().toISOString() });
    } catch (error) {
      if (input.signal?.aborted) throw cancelled();
      const code = (error as NodeJS.ErrnoException)?.code;
      const safe = error instanceof CollectionError ? error : code === "ENOSPC" ? collectionError("DISK_FULL", "디스크 공간이 부족합니다. 기존 영상 원본은 보존했습니다.") : collectionError("DOWNLOAD_FAILED", "영상을 받는 중 연결이나 저장이 중단되었습니다.", { retryable: true });
      if (attempt >= attempts || !safe.appError.retryable) throw safe;
    } finally {
      await reader?.cancel().catch(() => {}); reader?.releaseLock();
      await handle?.close().catch(() => {});
      await rm(temp, { force: true });
    }
    // Abortable backoff; cancellation must not wait for the next attempt.
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(cancelled()); };
      const timer = setTimeout(() => { input.signal?.removeEventListener("abort", onAbort); resolve(); }, delay * attempt);
      if (input.signal?.aborted) onAbort(); else input.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
