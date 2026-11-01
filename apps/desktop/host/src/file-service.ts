import { copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { AppError } from "@learningxxx/contracts";
import type { ErrorCode, IpcRequest, IpcResponse, Session } from "@learningxxx/contracts";
import { isWithin, resolveEntry } from "./path-scope.ts";
import type { RunHistory } from "./run-history.ts";
import type { SessionService } from "./session-service.ts";

export interface FileServiceOptions {
  dataRoot: string;
  sessions: SessionService;
  history: RunHistory;
  /** System folder picker. Undefined means the user cancelled. */
  chooseFolder: () => Promise<string | undefined>;
  /** Asks the user, showing this absolute path. */
  confirmTrash: (path: string) => Promise<boolean>;
  /** Moves to the macOS Trash. This app has no permanent delete. */
  trash: (path: string) => Promise<void>;
}

function fail(code: ErrorCode, message: string): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable: false }) });
}

/** Host side of SPEC-002 file work. Every path here comes from the host, not the renderer. */
export class FileService {
  readonly #o: FileServiceOptions;

  constructor(options: FileServiceOptions) {
    this.#o = options;
  }

  #idle(appSessionId: string): Session {
    if (this.#o.sessions.isActive(appSessionId)) fail("RUN_ALREADY_ACTIVE", "응답이 끝난 뒤 진행할 수 있습니다.");
    return this.#o.sessions.get(appSessionId);
  }

  #assertGrantable(folder: string): void {
    const real = realpathSync(folder);
    const home = realpathSync(homedir());
    const data = realpathSync(this.#o.dataRoot);
    const tooBroad = real === parse(real).root || real === home || isWithin(real, home);
    if (tooBroad || isWithin(data, real) || isWithin(real, data)) {
      fail("SCOPE_VIOLATION", "이 폴더는 선택할 수 없습니다. 작업에 쓸 하위 폴더를 골라 주세요.");
    }
  }

  async chooseFolder({ appSessionId }: IpcRequest<"files.chooseFolder">): Promise<Session> {
    const session = this.#idle(appSessionId);
    if (session.mode !== "course") fail("SCOPE_VIOLATION", "독립 세션에는 외부 폴더를 줄 수 없습니다.");
    const folder = await this.#o.chooseFolder();
    if (folder === undefined) return session;
    this.#assertGrantable(folder);
    const real = realpathSync(folder);
    const current = session.externalFolders ?? [];
    return current.includes(real) ? session : this.#o.sessions.setExternalFolders(appSessionId, [...current, real]);
  }

  removeFolder({ appSessionId, folder }: IpcRequest<"files.removeFolder">): Session {
    const session = this.#idle(appSessionId);
    const left = (session.externalFolders ?? []).filter((f) => f !== folder);
    return this.#o.sessions.setExternalFolders(appSessionId, left);
  }

  /** `external-<n>/...` is only meaningful against this session's own grants. */
  #resolve(session: Session, key: string): string | undefined {
    const match = /^external-(\d+)\/(.+)$/.exec(key);
    if (match) {
      const root = session.externalFolders?.[Number(match[1])];
      return root === undefined ? undefined : resolveEntry(root, match[2]!);
    }
    return resolveEntry(join(this.#o.dataRoot, session.workspaceKey), key);
  }

  async trash({ appSessionId, key }: IpcRequest<"files.trash">): Promise<IpcResponse<"files.trash">> {
    const session = this.#idle(appSessionId);
    const path = this.#resolve(session, key) ?? fail("SCOPE_VIOLATION", "이 세션의 작업 범위 밖 파일입니다.");
    if (!existsSync(path)) fail("NOT_FOUND", "파일을 찾을 수 없습니다.");
    if (!(await this.#o.confirmTrash(path))) return { trashed: false };
    await this.#o.trash(path);
    return { trashed: true };
  }

  /** Puts files back as they were before a run. Created files go to the Trash, never deleted. */
  async restore({ runId }: IpcRequest<"files.restore">): Promise<IpcResponse<"files.restore">> {
    const record = this.#o.history.changes(runId) ?? fail("NOT_FOUND", "이 실행의 변경 기록이 없습니다.");
    const session = this.#idle(record.appSessionId);
    // An older baseline would also erase what later runs changed.
    if (this.#o.sessions.changesFor(record.appSessionId)[0]?.runId !== runId) {
      fail("INVALID_REQUEST", "가장 최근 실행만 되돌릴 수 있습니다.");
    }
    const restored: string[] = [];
    const skipped: string[] = [];
    for (const { key, change, restorable } of record.changes) {
      const path = this.#resolve(session, key);
      if (!restorable || path === undefined) {
        skipped.push(key);
      } else if (change === "created") {
        if (existsSync(path)) await this.#o.trash(path);
        restored.push(key);
      } else {
        mkdirSync(dirname(path), { recursive: true });
        copyFileSync(this.#o.history.beforeCopy(runId, key), path);
        restored.push(key);
      }
    }
    return { restored, skipped };
  }
}
