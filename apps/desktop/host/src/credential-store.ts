import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** OS-backed encryption; on macOS Electron's safeStorage keeps the key in the login Keychain. */
export interface SecretCipher {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface Secrets {
  schoolId?: string;
  schoolPassword?: string;
  canvasToken?: string;
  /** Set when the school rejected the saved password; cleared only by saving it again (account-lockout guard). */
  schoolRejected?: boolean;
}

/** What the renderer may learn: whether something is saved, never the values. */
export interface CredentialStatus {
  school: boolean;
  schoolRejected: boolean;
  canvasToken: boolean;
  available: boolean;
}

/**
 * Sign-in details saved on this Mac only (WBS-040). The file holds one
 * encrypted blob, readable only through the Keychain key of this user account.
 * Values never leave the host process except toward the school's own servers.
 */
export class CredentialStore {
  readonly #file: string;
  readonly #cipher: SecretCipher;

  constructor(file: string, cipher: SecretCipher) {
    this.#file = file;
    this.#cipher = cipher;
  }

  read(): Secrets {
    if (!this.#cipher.available()) return {};
    try {
      return JSON.parse(this.#cipher.decrypt(readFileSync(this.#file))) as Secrets;
    } catch {
      return {}; // missing, or encrypted under another account's key
    }
  }

  status(): CredentialStatus {
    const s = this.read();
    return { school: !!(s.schoolId && s.schoolPassword), schoolRejected: !!s.schoolRejected, canvasToken: !!s.canvasToken, available: this.#cipher.available() };
  }

  saveSchool(schoolId: string, schoolPassword: string): void {
    this.#write({ ...this.read(), schoolId, schoolPassword, schoolRejected: false });
  }

  saveCanvasToken(canvasToken: string): void {
    this.#write({ ...this.read(), canvasToken });
  }

  markSchoolRejected(): void {
    const s = this.read();
    if (s.schoolId) this.#write({ ...s, schoolRejected: true });
  }

  clear(which: "school" | "canvasToken"): void {
    const next = this.read();
    if (which === "school") {
      delete next.schoolId;
      delete next.schoolPassword;
      delete next.schoolRejected;
    } else {
      delete next.canvasToken;
    }
    if (!next.schoolId && !next.canvasToken) rmSync(this.#file, { force: true });
    else this.#write(next);
  }

  #write(secrets: Secrets): void {
    if (!this.#cipher.available()) {
      throw Object.assign(new Error("encryption unavailable"), {
        appError: { code: "INTERNAL", message: "이 Mac에서 안전한 저장소(키체인)를 쓸 수 없어 저장하지 않았습니다.", retryable: false },
      });
    }
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    const temp = `${this.#file}.${randomUUID()}.part`;
    writeFileSync(temp, this.#cipher.encrypt(JSON.stringify(secrets)), { mode: 0o600 });
    renameSync(temp, this.#file);
  }
}
