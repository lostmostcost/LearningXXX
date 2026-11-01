import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { collectionError } from "./errors.ts";

export interface StoredAsset {
  sha256: string;
  bytes: number;
  /** Relative to the store root; content-addressed so identical files share one original. */
  storageKey: string;
}

/**
 * Where downloaded originals go. The collector only streams and checks; the
 * host owns the data root and may supply its own store (SPEC-001 구현 경계).
 */
export interface AssetStore {
  put(body: ReadableStream<Uint8Array>, meta: { expectedBytes?: number | undefined; extension: string }): Promise<StoredAsset>;
  /** True only if the stored original exists and still hashes to `sha256`. */
  verify(storageKey: string, sha256: string): Promise<boolean>;
}

const hashFile = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
};

const safeExtension = (ext: string) => (/^[a-z0-9]{1,8}$/.test(ext) ? `.${ext}` : "");

/**
 * Content-addressed store under `root`: download to `tmp/*.part` while hashing,
 * check the size, then rename into `originals/<aa>/<sha256><ext>`. A partial
 * or failed download never replaces a good original.
 */
export function createDirectoryStore(root: string): AssetStore {
  return {
    async put(body, { expectedBytes, extension }) {
      const temp = join(root, "tmp", `${randomUUID()}.part`);
      await mkdir(dirname(temp), { recursive: true });
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        await pipeline(
          Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>),
          async function* (source: AsyncIterable<Uint8Array>) {
            for await (const chunk of source) {
              hash.update(chunk);
              bytes += chunk.length;
              yield chunk;
            }
          },
          createWriteStream(temp),
        );
      } catch {
        await rm(temp, { force: true });
        throw collectionError("DOWNLOAD_FAILED", "파일을 받는 중 중단되었습니다.", { retryable: true });
      }
      if (expectedBytes !== undefined && bytes !== expectedBytes) {
        await rm(temp, { force: true });
        throw collectionError("DOWNLOAD_FAILED", "받은 파일 크기가 LMS 정보와 달라 저장하지 않았습니다.", { retryable: true });
      }
      const sha256 = hash.digest("hex");
      const storageKey = `originals/${sha256.slice(0, 2)}/${sha256}${safeExtension(extension)}`;
      const target = join(root, storageKey);
      if (await this.verify(storageKey, sha256)) {
        await rm(temp, { force: true });
        return { sha256, bytes, storageKey };
      }
      await mkdir(dirname(target), { recursive: true });
      await rename(temp, target);
      // Read back what landed on disk; a mismatch means the write itself was damaged.
      if ((await hashFile(target)) !== sha256) {
        await rm(target, { force: true });
        throw collectionError("CHECKSUM_MISMATCH", "저장한 파일의 해시가 받은 내용과 달라 버렸습니다.", { retryable: true });
      }
      return { sha256, bytes, storageKey };
    },

    async verify(storageKey, sha256) {
      const path = join(root, storageKey);
      try {
        if (!(await stat(path)).isFile()) return false;
        return (await hashFile(path)) === sha256;
      } catch {
        return false;
      }
    },
  };
}
