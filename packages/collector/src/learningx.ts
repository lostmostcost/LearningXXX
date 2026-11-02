import { collectionError } from "./errors.ts";
import { KHU_CANVAS_BASE_URL } from "./canvas-client.ts";

/** Where KHU keeps the bytes of LearningX lecture materials. */
export const KHU_COMMONS_BASE_URL = "https://commons.khu.ac.kr";

/**
 * The leading bytes a genuine file of each archived type starts with. Commons
 * answers a refused download with an HTML error page, so size alone proves nothing.
 */
const MAGIC: Record<string, readonly string[]> = {
  pdf: ["%PDF"],
  zip: ["PK\x03\x04", "PK\x05\x06"],
  docx: ["PK\x03\x04"],
  pptx: ["PK\x03\x04"],
  xlsx: ["PK\x03\x04"],
  hwpx: ["PK\x03\x04"],
  doc: ["\xd0\xcf\x11\xe0"],
  ppt: ["\xd0\xcf\x11\xe0"],
  xls: ["\xd0\xcf\x11\xe0"],
  hwp: ["\xd0\xcf\x11\xe0"],
  png: ["\x89PNG"],
  jpg: ["\xff\xd8\xff"],
  jpeg: ["\xff\xd8\xff"],
  gif: ["GIF8"],
};
export const LEARNINGX_FILE_TYPES: ReadonlySet<string> = new Set(Object.keys(MAGIC));

/** A lecture file is a few MB; this only stops a runaway response from filling memory. */
const MAX_BYTES = 512 * 1024 * 1024;

export interface LearningXClientOptions {
  canvasBaseUrl?: string;
  commonsBaseUrl?: string;
  /**
   * The LearningX bearer token (the `xn_api_token` the school sign-in sets),
   * read at call time so nothing here keeps it. Undefined means signed out.
   */
  getToken: () => Promise<string | undefined>;
  /** Must carry the sign-in session's cookies; Commons downloads rely on them. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Read-only access to LearningX, the KHU tool that holds weekly lecture
 * materials, and to Commons, which serves their bytes. The token goes only to
 * the LearningX API; Commons sees the session cookies and a Referer, nothing more.
 */
export class LearningXClient {
  readonly #canvas: string;
  readonly #commons: string;
  readonly #getToken: () => Promise<string | undefined>;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: LearningXClientOptions) {
    const canvas = new URL(options.canvasBaseUrl ?? KHU_CANVAS_BASE_URL);
    const commons = new URL(options.commonsBaseUrl ?? KHU_COMMONS_BASE_URL);
    if (canvas.protocol !== "https:" || commons.protocol !== "https:") throw new Error("LearningX URLs must use https");
    this.#canvas = canvas.origin;
    this.#commons = commons.origin;
    this.#getToken = options.getToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** Weekly modules with each item's content data embedded (one call per course). */
  async modules(sourceCourseId: string): Promise<unknown[]> {
    if (!/^\d+$/.test(sourceCourseId)) throw new Error("sourceCourseId must be numeric");
    const token = await this.#getToken();
    if (!token) throw collectionError("AUTH_REQUIRED", "강의 자료를 받으려면 학교 로그인이 필요합니다. 열린 로그인 창에서 로그인한 뒤 다시 실행하세요.");
    const response = await this.#send(`${this.#canvas}/learningx/api/v1/courses/${sourceCourseId}/modules`, {
      redirect: "manual",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw collectionError("AUTH_REQUIRED", "강의 자료 로그인이 만료되었습니다. 다시 로그인한 뒤 수집을 실행하세요.", { httpStatus: response.status });
    }
    const body = await this.#json(response);
    if (!Array.isArray(body)) throw collectionError("SOURCE_CHANGED", "강의 자료 목록 형식이 예상과 다릅니다.");
    return body;
  }

  /**
   * Downloads one Commons content: metadata gives the download URL, the
   * viewer page opens the Commons session, and the file is fetched with that
   * page as Referer. Bytes are checked against the file type before return.
   */
  async download(contentId: string, extension: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; extension: string }> {
    if (!/^[\w-]{1,64}$/.test(contentId)) throw collectionError("SOURCE_CHANGED", "강의 자료 식별자가 예상과 다릅니다.");
    const meta = await this.#json(await this.#send(`${this.#commons}/CommonsCore2/v2/contents/${contentId}`, { headers: { Accept: "application/json" } }));
    const result = (meta as { result?: { download_url?: unknown; extension?: unknown } } | null)?.result;
    if (typeof result?.download_url !== "string") throw collectionError("SOURCE_CHANGED", "강의 자료의 다운로드 주소를 받지 못했습니다.");
    const url = new URL(result.download_url, this.#commons);
    if (url.origin !== this.#commons) throw collectionError("SOURCE_CHANGED", "강의 자료가 다른 주소로 안내되어 받지 않았습니다.");
    const ext = (typeof result.extension === "string" && result.extension ? result.extension : extension).toLowerCase();

    const viewer = `${this.#commons}/em/${contentId}`;
    const opened = await this.#send(viewer, { headers: { Referer: `${this.#canvas}/` } });
    await opened.body?.cancel();
    const response = await this.#send(url.href, { headers: { Referer: viewer } });
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel();
      throw collectionError("DOWNLOAD_FAILED", "강의 자료 파일을 받지 못했습니다.", { retryable: response.status >= 500, httpStatus: response.status });
    }
    const declared = Number(response.headers.get("content-length"));
    if (declared > MAX_BYTES) {
      await response.body.cancel();
      throw collectionError("DOWNLOAD_FAILED", "강의 자료 파일이 너무 큽니다.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!validPayload(bytes, ext)) throw collectionError("DOWNLOAD_FAILED", "받은 내용이 강의 자료 파일이 아니어서 저장하지 않았습니다.", { retryable: true });
    return { bytes, extension: ext };
  }

  async #send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, { method: "GET", ...init });
    } catch {
      throw collectionError("DOWNLOAD_FAILED", "강의 자료 서버에 연결하지 못했습니다.", { retryable: true });
    }
  }

  async #json(response: Response): Promise<unknown> {
    const text = await response.text().catch(() => "");
    if (response.status === 429) throw collectionError("RATE_LIMITED", "강의 자료 요청이 많아 잠시 제한되었습니다.", { retryable: true, httpStatus: 429 });
    if (response.status >= 500) throw collectionError("DOWNLOAD_FAILED", "강의 자료 서버가 일시적으로 응답하지 못했습니다.", { retryable: true, httpStatus: response.status });
    if (response.status !== 200) throw collectionError("SOURCE_CHANGED", "강의 자료를 찾을 수 없거나 접근할 수 없습니다.", { httpStatus: response.status });
    try {
      return JSON.parse(text);
    } catch {
      throw collectionError("SOURCE_CHANGED", "강의 자료 응답을 읽지 못했습니다.");
    }
  }
}

export function validPayload(bytes: Uint8Array, extension: string): boolean {
  if (bytes.length === 0) return false;
  const head = Buffer.from(bytes.subarray(0, 64)).toString("latin1");
  if (/^\s*<(!doctype|html|head|\?xml)/i.test(head.replace(/^\xef\xbb\xbf/, ""))) return false;
  const magics = MAGIC[extension];
  return magics === undefined || magics.some((m) => head.startsWith(m));
}
