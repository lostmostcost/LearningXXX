import { collectionError } from "./errors.ts";

/** The LMS from WBS-003: 2026-2 논리회로, course 95899. */
export const KHU_CANVAS_BASE_URL = "https://khcanvas.khu.ac.kr";

const MAX_PAGES = 50;
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
