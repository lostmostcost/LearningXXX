import { AppError } from "@learningxxx/contracts";
import type { CredentialStatus, ErrorCode, IpcRequest } from "@learningxxx/contracts";
import type { CredentialStore } from "./credential-store.ts";
import type { SchoolLoginResult } from "./school-login.ts";

export interface CredentialServiceOptions {
  store: CredentialStore;
  /** One school sign-in attempt in the LMS session. */
  login: (schoolId: string, password: string) => Promise<SchoolLoginResult>;
  /** True while the LMS session still holds a usable LearningX token. */
  signedIn: () => Promise<boolean>;
  /** Asks Canvas whether this access token works. */
  checkCanvasToken: (token: string) => Promise<"ok" | "rejected" | "failed">;
}

function fail(code: ErrorCode, message: string, retryable = false): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable }) });
}

/**
 * Saved sign-in (WBS-040): details are checked with the school before they
 * are kept, and a lapsed session is renewed before a collection run. A
 * password the school refused is never tried again until the user saves it anew.
 */
export class CredentialService {
  readonly #o: CredentialServiceOptions;
  /**
   * One school sign-in at a time. All of them share the LMS session's cookies,
   * so two at once overwrite each other's CSRF cookie and the school answers
   * one with a login error — read as a refused password, which turned saved
   * sign-in off (WBS-062: the launch collection, learning status and the
   * dashboard all check the sign-in together).
   */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: CredentialServiceOptions) {
    this.#o = options;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.#queue.then(work);
    this.#queue = turn.catch(() => undefined);
    return turn;
  }

  status(): CredentialStatus {
    return this.#o.store.status();
  }

  async saveSchool({ schoolId, password }: IpcRequest<"credentials.saveSchool">): Promise<CredentialStatus> {
    if (!this.#o.store.status().available) fail("INTERNAL", "이 Mac에서 안전한 저장소(키체인)를 쓸 수 없어 저장하지 않았습니다.");
    const result = await this.#serial(() => this.#o.login(schoolId, password));
    if (result === "rejected") fail("AUTH_REQUIRED", "학교가 아이디 또는 비밀번호를 거부했습니다. 저장하지 않았습니다. 여러 번 틀리면 계정이 잠길 수 있으니 확인 후 다시 입력하세요.");
    if (result === "failed") fail("DOWNLOAD_FAILED", "학교 로그인 서버와 연결하지 못해 확인하지 못했습니다. 저장하지 않았습니다. 잠시 뒤 다시 시도하세요.", true);
    this.#o.store.saveSchool(schoolId, password);
    return this.status();
  }

  async saveCanvasToken({ token }: IpcRequest<"credentials.saveCanvasToken">): Promise<CredentialStatus> {
    if (!this.#o.store.status().available) fail("INTERNAL", "이 Mac에서 안전한 저장소(키체인)를 쓸 수 없어 저장하지 않았습니다.");
    const result = await this.#o.checkCanvasToken(token);
    if (result === "rejected") fail("AUTH_REQUIRED", "Canvas가 이 액세스 토큰을 받지 않았습니다. 저장하지 않았습니다. 이캠퍼스 설정에서 새 토큰을 발급해 붙여 넣으세요.");
    if (result === "failed") fail("DOWNLOAD_FAILED", "Canvas에 연결하지 못해 토큰을 확인하지 못했습니다. 저장하지 않았습니다.", true);
    this.#o.store.saveCanvasToken(token);
    return this.status();
  }

  clear({ which }: IpcRequest<"credentials.clear">): CredentialStatus {
    this.#o.store.clear(which);
    return this.status();
  }

  /** The saved Canvas token, read when a request is made; undefined when none is saved. */
  canvasToken(): string | undefined {
    return this.#o.store.read().canvasToken;
  }

  /**
   * Before a run: if the session lapsed and a password is saved, sign in once.
   * Any failure falls through to the normal path, where the LMS answers
   * AUTH_REQUIRED and the login window opens.
   */
  async ensureSignedIn(): Promise<void> {
    if (await this.#o.signedIn()) return;
    // Waits for a sign-in already under way, then looks again before trying.
    await this.#serial(async () => {
      const { schoolId, schoolPassword, schoolRejected } = this.#o.store.read();
      if (!schoolId || !schoolPassword || schoolRejected) return;
      if (await this.#o.signedIn()) return;
      if ((await this.#o.login(schoolId, schoolPassword)) === "rejected") this.#o.store.markSchoolRejected();
    });
  }

  /**
   * WBS-056: the LMS web pages asked for the school sign-in although the
   * LearningX token is still there (the web session ended when the app quit).
   * Signs in once with the saved details, by default the same way as
   * ensureSignedIn or through `login` (an LMS page's own window); false when
   * none are saved, they were rejected before, or this attempt did not succeed.
   */
  async signInAgain(login: CredentialServiceOptions["login"] = this.#o.login): Promise<boolean> {
    return this.#serial(async () => {
      const { schoolId, schoolPassword, schoolRejected } = this.#o.store.read();
      if (!schoolId || !schoolPassword || schoolRejected) return false;
      const result = await login(schoolId, schoolPassword);
      if (result === "rejected") this.#o.store.markSchoolRejected();
      return result === "signed_in";
    });
  }
}
