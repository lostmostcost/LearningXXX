import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PreferredLanguage } from "@learningxxx/contracts";
import { z } from "zod";

const Stored = z.object({ language: PreferredLanguage.catch("ko") });
type Stored = z.infer<typeof Stored>;

/** WBS-071: this Mac's app preferences (now just the preferred language), one small JSON file. */
export class Preferences {
  readonly #file: string;
  #value: Stored;

  constructor(file: string) {
    this.#file = file;
    let raw: unknown = {};
    try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { /* first run or unreadable: defaults */ }
    this.#value = Stored.catch({ language: "ko" }).parse(raw);
  }

  get(): Stored { return { ...this.#value }; }

  set(next: Stored): Stored {
    this.#value = Stored.parse(next);
    mkdirSync(dirname(this.#file), { recursive: true });
    writeFileSync(`${this.#file}.tmp`, JSON.stringify(this.#value));
    renameSync(`${this.#file}.tmp`, this.#file);
    return this.get();
  }
}
