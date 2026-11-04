import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AutomationSettings, DEFAULT_AUTOMATION, PreferredLanguage, ThemePreference } from "@learningxxx/contracts";
import { z } from "zod";

// WBS-100: files written before the theme existed (or with an unknown value) follow the system.
const Stored = z.object({ language: PreferredLanguage.catch("ko"), automation: AutomationSettings.catch(DEFAULT_AUTOMATION).default(DEFAULT_AUTOMATION), theme: ThemePreference.catch("system").default("system") });
type Stored = z.infer<typeof Stored>;
const DEFAULTS: Stored = { language: "ko", automation: DEFAULT_AUTOMATION, theme: "system" };

/** WBS-071/083/100: this Mac's app preferences (preferred language, automation, theme), one small JSON file. */
export class Preferences {
  readonly #file: string;
  #value: Stored;
  readonly #listeners = new Set<(value: Stored) => void>();

  constructor(file: string) {
    this.#file = file;
    let raw: unknown = {};
    try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { /* first run or unreadable: defaults */ }
    this.#value = Stored.catch(DEFAULTS).parse(raw);
  }

  get(): Stored { return structuredClone(this.#value); }

  /** Changes only what is given. */
  set(next: { language?: PreferredLanguage | undefined; automation?: { [K in keyof AutomationSettings]?: boolean | undefined } | undefined; theme?: ThemePreference | undefined }): Stored {
    this.#value = Stored.parse({ language: next.language ?? this.#value.language, theme: next.theme ?? this.#value.theme, automation: { ...this.#value.automation, ...Object.fromEntries(Object.entries(next.automation ?? {}).filter(([, v]) => v !== undefined)) } });
    mkdirSync(dirname(this.#file), { recursive: true });
    writeFileSync(`${this.#file}.tmp`, JSON.stringify(this.#value));
    renameSync(`${this.#file}.tmp`, this.#file);
    for (const listener of this.#listeners) listener(this.get());
    return this.get();
  }

  onChange(listener: (value: Stored) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
}
