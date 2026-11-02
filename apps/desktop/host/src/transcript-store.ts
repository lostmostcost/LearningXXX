import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChatTurn, Id } from "@learningxxx/contracts";
import { z } from "zod";

/** Older turns are dropped past this many per session; the CLI still has them for resuming. */
export const MAX_TURNS = 200;

/**
 * The chat as it was shown, one file per session (`<root>/<appSessionId>.json`),
 * so a restart does not leave an empty conversation (WBS-020 self-test).
 * Stays on this Mac like the rest of the app data.
 */
export class TranscriptStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  #file(appSessionId: string): string {
    return join(this.#root, `${Id.parse(appSessionId)}.json`);
  }

  read(appSessionId: string): ChatTurn[] {
    const file = this.#file(appSessionId);
    if (!existsSync(file)) return [];
    try {
      const raw = z.array(z.unknown()).parse(JSON.parse(readFileSync(file, "utf8")));
      // One damaged turn must not hide the rest.
      return raw.flatMap((turn) => {
        const parsed = ChatTurn.safeParse(turn);
        return parsed.success && parsed.data.appSessionId === appSessionId ? [parsed.data] : [];
      });
    } catch {
      return [];
    }
  }

  /** Adds the turn, or replaces the one with the same run. */
  put(turn: ChatTurn): void {
    const turns = this.read(turn.appSessionId);
    const index = turns.findIndex((t) => t.runId === turn.runId);
    if (index === -1) turns.push(turn);
    else turns[index] = turn;
    mkdirSync(this.#root, { recursive: true });
    const file = this.#file(turn.appSessionId);
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(turns.slice(-MAX_TURNS)));
    renameSync(temp, file);
  }
}
