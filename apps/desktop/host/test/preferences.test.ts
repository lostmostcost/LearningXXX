import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_AUTOMATION } from "@learningxxx/contracts";
import { Preferences } from "../src/preferences.ts";

const temp = () => mkdtempSync(join(tmpdir(), "prefs-"));

describe("WBS-100 theme preference", () => {
  it("files written before the theme existed follow the system and keep their other settings", () => {
    const dir = temp();
    try {
      const file = join(dir, "preferences.json");
      writeFileSync(file, JSON.stringify({ language: "ja", automation: { ...DEFAULT_AUTOMATION, transcribe: false } }));
      const value = new Preferences(file).get();
      assert.equal(value.theme, "system");
      assert.equal(value.language, "ja");
      assert.equal(value.automation.transcribe, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a chosen theme is saved, survives a restart and is untouched by other changes", () => {
    const dir = temp();
    try {
      const file = join(dir, "preferences.json");
      const prefs = new Preferences(file);
      const seen: string[] = [];
      prefs.onChange((v) => seen.push(v.theme));
      assert.equal(prefs.set({ theme: "dark" }).theme, "dark");
      assert.equal(prefs.set({ language: "en" }).theme, "dark");
      assert.equal(prefs.set({ automation: { transcribe: false } }).theme, "dark");
      assert.deepEqual(seen, ["dark", "dark", "dark"]);
      const reopened = new Preferences(file).get();
      assert.equal(reopened.theme, "dark");
      assert.equal(reopened.language, "en");
      assert.equal(new Preferences(file).set({ theme: "light" }).language, "en");
      assert.equal(JSON.parse(readFileSync(file, "utf8")).theme, "light");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("an unknown stored theme falls back to the system instead of failing", () => {
    const dir = temp();
    try {
      const file = join(dir, "preferences.json");
      writeFileSync(file, JSON.stringify({ language: "ko", theme: "sepia" }));
      assert.equal(new Preferences(file).get().theme, "system");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
