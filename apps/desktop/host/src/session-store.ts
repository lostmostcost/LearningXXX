import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Run, Session } from "@learningxxx/contracts";
import { z } from "zod";

const StoredState = z.object({ sessions: z.array(Session), runs: z.array(Run) });
export type StoredState = z.infer<typeof StoredState>;

/** Session and run records. The CLI keeps conversation history itself (SPEC-002). */
export class SessionStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  load(): StoredState {
    if (!existsSync(this.#path)) return { sessions: [], runs: [] };
    try {
      return StoredState.parse(JSON.parse(readFileSync(this.#path, "utf8")));
    } catch {
      // Keep the unreadable file for recovery instead of overwriting it.
      renameSync(this.#path, `${this.#path}.corrupt-${Date.now()}`);
      return { sessions: [], runs: [] };
    }
  }

  /** Temp file then rename, so a crash leaves the previous state intact. */
  save(state: StoredState): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state)}\n`);
    renameSync(temp, this.#path);
  }
}
