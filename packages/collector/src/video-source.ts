import { CollectionError, collectionError } from "./errors.ts";
import { KHU_COMMONS_BASE_URL } from "./learningx.ts";
import { KHU_CANVAS_BASE_URL } from "./canvas-client.ts";

/** An authorized, expiring direct original; never persist this URL or headers. */
export interface VideoSource {
  url: string;
  referer: string;
  expectedBytes?: number;
}

export interface CommonsVideoOptions {
  contentId: string;
  /** Cookie-carrying fetch from the user's signed-in session. */
  fetch: typeof globalThis.fetch;
  commonsBaseUrl?: string;
  canvasBaseUrl?: string;
}

export function httpsOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw collectionError("SOURCE_CHANGED", "영상 주소 형식이 올바르지 않습니다."); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw collectionError("SOURCE_CHANGED", "영상 주소가 안전한 HTTPS 주소가 아닙니다.");
  }
  return url.origin;
}

/** Called for EVERY attempt so expired signed URLs are never reused on retry. */
export function createCommonsVideoResolver(options: CommonsVideoOptions): (signal?: AbortSignal) => Promise<VideoSource> {
  if (!/^[\w-]{1,64}$/.test(options.contentId)) throw collectionError("SOURCE_CHANGED", "영상 식별자가 올바르지 않습니다.");
  const commons = httpsOrigin(options.commonsBaseUrl ?? KHU_COMMONS_BASE_URL);
  const canvas = httpsOrigin(options.canvasBaseUrl ?? KHU_CANVAS_BASE_URL);
  return async (signal) => {
    try {
      const send = async (url: string, headers: Record<string, string>) => {
        let response: Response;
        try { response = await options.fetch(url, { redirect: "manual", headers, ...(signal ? { signal } : {}) }); }
        catch { throw collectionError("DOWNLOAD_FAILED", "영상 서버에 연결하지 못했습니다.", { retryable: true }); }
        if (response.url && httpsOrigin(response.url) !== commons) {
          await response.body?.cancel();
          throw collectionError("SOURCE_CHANGED", "영상 응답이 허용한 서버를 벗어났습니다.");
        }
        // Never follow redirects with the authenticated session. A new login/source is needed.
        if ([401, 403].includes(response.status) || (response.status >= 300 && response.status < 400)) {
          await response.body?.cancel();
          throw collectionError("AUTH_REQUIRED", "영상 접근 권한이나 학교 로그인을 확인한 뒤 다시 실행하세요.");
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          throw collectionError("DOWNLOAD_FAILED", "영상 원본 정보를 받지 못했습니다.", { retryable: response.status >= 500 || response.status === 429 });
        }
        return response;
      };
      const response = await send(`${commons}/CommonsCore2/v2/contents/${options.contentId}`, { Accept: "application/json" });
      // Bound metadata as well as the media stream; an error page is not metadata.
      const reader = response.body?.getReader();
      let text = "";
      if (reader) {
        const decoder = new TextDecoder();
        let bytes = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.length;
            if (bytes > 1024 * 1024) throw collectionError("SOURCE_CHANGED", "영상 원본 정보가 너무 큽니다.");
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw collectionError("SOURCE_CHANGED", "영상 원본 정보를 읽지 못했습니다."); }
      const meta = (data as { result?: { download_url?: unknown; extension?: unknown } } | null)?.result;
      if (typeof meta?.download_url !== "string" || String(meta.extension).toLowerCase() !== "mp4") {
        throw collectionError("UNSUPPORTED_FORMAT", "이 강의는 직접 받을 수 있는 MP4 원본을 제공하지 않습니다. 권한 제한·DRM·스트리밍은 우회하지 않습니다.");
      }
      let url: URL;
      try { url = new URL(meta.download_url, commons); } catch { throw collectionError("SOURCE_CHANGED", "영상 원본 주소가 올바르지 않습니다."); }
      if (httpsOrigin(url.href) !== commons) throw collectionError("SOURCE_CHANGED", "다른 서버로 안내된 영상 주소는 받지 않았습니다.");
      const viewer = `${commons}/em/${options.contentId}`;
      const opened = await send(viewer, { Referer: `${canvas}/` });
      await opened.body?.cancel();
      return { url: url.href, referer: viewer };
    } catch (error) {
      if (error instanceof CollectionError) throw error;
      throw collectionError("DOWNLOAD_FAILED", "영상 원본 정보를 받는 중 연결이 중단되었습니다.", { retryable: true });
    }
  };
}
