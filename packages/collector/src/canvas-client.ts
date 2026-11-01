import { collectionError } from "./errors.ts";

/** The LMS from WBS-003: 2026-2 논리회로, course 95899. */
export const KHU_CANVAS_BASE_URL = "https://khcanvas.khu.ac.kr";

const MAX_PAGES = 50;
const MAX_REDIRECTS = 3;
/** Canvas prefixes cookie-authenticated JSON with this guard. */
const JSON_GUARD = "while(1);";

export interface CanvasClientOptions {
  baseUrl?: string;
  /** Supplied by the host at call time, so nothing here stores a credential. */
  getAuthHeaders: () => Promise<Record<string, string>>;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

/**
 * Read-only Canvas access. GET is the only method this client can send, and
 * credentials are never sent to another origin: redirects are not followed and
 * cross-origin pagination links are refused.
 */
export class CanvasClient {
  readonly #origin: string;
  readonly #getAuthHeaders: () => Promise<Record<string, string>>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;

  constructor(options: CanvasClientOptions) {
    const base = new URL(options.baseUrl ?? KHU_CANVAS_BASE_URL);
    if (base.protocol !== "https:") throw new Error("LMS base URL must use https");
    this.#origin = base.origin;
    this.#getAuthHeaders = options.getAuthHeaders;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  /** The only origin that ever receives the session. */
  get origin(): string {
    return this.#origin;
  }

  async getObject(path: string): Promise<unknown> {
    return (await this.#get(new URL(path, this.#origin))).body;
  }

  /** Follows rel="next" links in order, one request at a time. */
  async getList(path: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let url: URL | undefined = new URL(path, this.#origin);
    for (let page = 0; url !== undefined; page += 1) {
      if (page === MAX_PAGES) {
        throw collectionError("SOURCE_CHANGED", "LMS 목록의 페이지 수가 예상보다 많습니다.");
      }
      const { body, next } = await this.#get(url);
      if (!Array.isArray(body)) {
        throw collectionError("SOURCE_CHANGED", "LMS 응답 형식이 예상과 다릅니다.");
      }
      items.push(...body);
      url = next;
    }
    return items;
  }

  /**
   * Starts a file download. Same-origin hops carry the session; a hop to
   * another origin (Canvas file storage) is fetched without any credential.
   * A redirect to the LMS login page means the session expired.
   */
  async download(path: string): Promise<{ body: ReadableStream<Uint8Array>; contentType: string | undefined }> {
    let url = new URL(path, this.#origin);
    if (url.origin !== this.#origin) {
      throw collectionError("SOURCE_CHANGED", "LMS가 다른 주소의 파일을 안내해 받지 않았습니다.");
    }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const sameOrigin = url.origin === this.#origin;
      if (url.protocol !== "https:") throw collectionError("SOURCE_CHANGED", "LMS가 https가 아닌 주소로 파일을 안내했습니다.");
      const headers = sameOrigin ? await this.#getAuthHeaders() : {};
      let response: Response;
      try {
        response = await this.#fetch(url, { method: "GET", redirect: "manual", headers });
      } catch {
        throw collectionError("DOWNLOAD_FAILED", "파일을 받는 중 연결이 끊겼습니다.", { retryable: true });
      }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location !== null) {
        const target = new URL(location, url);
        await response.body?.cancel();
        if (target.origin === this.#origin && /^\/login\b/.test(target.pathname)) {
          throw collectionError("AUTH_REQUIRED", "학교 로그인이 만료되었습니다. 다시 로그인한 뒤 수집을 실행하세요.", { httpStatus: response.status });
        }
        url = target;
        continue;
      }
      if (response.status === 200 && response.body !== null) {
        return { body: response.body, contentType: response.headers.get("content-type") ?? undefined };
      }
      await this.#readFailure(response);
      throw collectionError("DOWNLOAD_FAILED", "파일 응답이 비어 있습니다.", { retryable: true });
    }
    throw collectionError("SOURCE_CHANGED", "파일 주소 이동이 너무 많습니다.");
  }

  async #get(url: URL): Promise<{ body: unknown; next: URL | undefined }> {
    if (url.origin !== this.#origin) {
      throw collectionError("SOURCE_CHANGED", "LMS가 다른 주소로 안내해 요청을 중단했습니다.");
    }
    const headers = await this.#getAuthHeaders();
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: { Accept: "application/json", ...headers },
      });
    } catch {
      throw collectionError("DOWNLOAD_FAILED", "LMS에 연결하지 못했습니다.", { retryable: true });
    }
    const text = await this.#readFailure(response);
    return { body: parseBody(text), next: nextLink(response.headers.get("link"), this.#origin) };
  }

  async #readFailure(response: Response): Promise<string> {
    const { status } = response;
    const text = await response.text().catch(() => "");
    if (status === 200) return text;
    // A manual redirect is how an expired session reaches the login page.
    if (status === 401 || (status >= 300 && status < 400) || response.type === "opaqueredirect") {
      throw collectionError("AUTH_REQUIRED", "학교 로그인이 만료되었습니다. 다시 로그인한 뒤 수집을 실행하세요.", { httpStatus: status });
    }
    if (status === 429 || (status === 403 && /rate limit/i.test(text))) {
      const retryAfter = this.#retryAfter(response.headers.get("retry-after"));
      throw collectionError("RATE_LIMITED", "LMS 요청이 많아 잠시 제한되었습니다.", {
        retryable: true,
        httpStatus: status,
        ...(retryAfter === undefined ? {} : { retryAfter }),
      });
    }
    if (status >= 500) {
      throw collectionError("DOWNLOAD_FAILED", "LMS가 일시적으로 응답하지 못했습니다.", { retryable: true, httpStatus: status });
    }
    throw collectionError("SOURCE_CHANGED", "LMS에서 이 항목을 찾을 수 없거나 접근할 수 없습니다.", { httpStatus: status });
  }

  #retryAfter(header: string | null): string | undefined {
    const seconds = Number(header);
    if (header === null || !Number.isFinite(seconds) || seconds < 0) return undefined;
    return new Date(this.#now().getTime() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
}

function parseBody(text: string): unknown {
  const json = text.startsWith(JSON_GUARD) ? text.slice(JSON_GUARD.length) : text;
  try {
    return JSON.parse(json);
  } catch {
    // Also how a login page served with 200 appears; the parser cannot tell them apart.
    throw collectionError("SOURCE_CHANGED", "LMS 응답을 읽지 못했습니다. 로그인 상태를 확인한 뒤 다시 실행하세요.");
  }
}

export function nextLink(header: string | null, origin: string): URL | undefined {
  if (header === null) return undefined;
  for (const part of header.split(",")) {
    const match = /^\s*<([^>]+)>\s*;(.*)$/.exec(part);
    if (match?.[1] !== undefined && /\brel="?next"?/.test(match[2] ?? "")) {
      return new URL(match[1], origin);
    }
  }
  return undefined;
}
