import assert from "node:assert/strict";
import { test } from "node:test";
import { ThemePreference } from "@learningxxx/contracts";
import { THEME_LABELS, toggledTheme, toggleLabel } from "../src/theme.ts";

test("WBS-100: the top-bar switch picks the opposite of what is on screen, as an explicit choice", () => {
  assert.equal(toggledTheme(true), "light");
  assert.equal(toggledTheme(false), "dark");
  assert.equal(toggleLabel(true), "라이트 모드로 전환");
  assert.equal(toggleLabel(false), "다크 모드로 전환");
});

test("WBS-100: every theme the contract allows has a settings label", () => {
  assert.deepEqual(Object.keys(THEME_LABELS).sort(), [...ThemePreference.options].sort());
  assert.equal(THEME_LABELS.system, "시스템 설정 따르기");
});
