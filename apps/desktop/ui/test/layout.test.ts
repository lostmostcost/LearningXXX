import assert from "node:assert/strict";
import { test } from "node:test";
import { isNarrow, NARROW_WIDTH, nextPanel, toggleWorkspaceTool, workspacePanels } from "../src/layout.ts";

test("wide windows show the current main screen and only enabled tools", () => {
  assert.deepEqual(workspacePanels(1280, false, "tasks", { chat: true, memo: false }), ["library", "viewer", "chat"]);
  assert.deepEqual(workspacePanels(1280, false, "book", { chat: false, memo: false }), ["viewer"]);
});

test('global chat and memo toggle independently and recover the main content when both close', () => {
  let tools = { chat: false, memo: false };
  assert.deepEqual(workspacePanels(1280, true, 'book', tools), ['home']);
  tools = toggleWorkspaceTool(tools, 'chat'); tools = toggleWorkspaceTool(tools, 'memo');
  assert.deepEqual(workspacePanels(1280, true, 'book', tools), ['home', 'chat', 'memo']);
  tools = toggleWorkspaceTool(tools, 'chat');
  assert.deepEqual(workspacePanels(700, false, 'media', tools), ['memo']);
  tools = toggleWorkspaceTool(tools, 'memo');
  assert.deepEqual(workspacePanels(700, false, 'media', tools), ['media']);
  assert.deepEqual(workspacePanels(1280, false, 'tasks', tools), ['library', 'viewer']);
});

test("narrow windows show the enabled global tools or the main screen", () => {
  assert.deepEqual(workspacePanels(700, false, "book", { chat: false, memo: false }), ["viewer"]);
  assert.deepEqual(workspacePanels(700, false, "book", { chat: true, memo: false }), ["chat"]);
});

test("the narrow boundary is exact", () => {
  assert.equal(isNarrow(NARROW_WIDTH - 1), true);
  assert.equal(isNarrow(NARROW_WIDTH), false);
});

test("F6 cycles forward and wraps", () => {
  const all = workspacePanels(1280, false, "tasks", { chat: true, memo: false });
  assert.equal(nextPanel(undefined, all), "library");
  assert.equal(nextPanel("library", all), "viewer");
  assert.equal(nextPanel("chat", all), "library");
});

test("Shift+F6 cycles backward and wraps", () => {
  const all = workspacePanels(1280, false, "tasks", { chat: true, memo: false });
  assert.equal(nextPanel("library", all, true), "chat");
});

test("focus on a hidden panel returns to the first visible one", () => {
  assert.equal(nextPanel("chat", workspacePanels(700, false, "book", { chat: false, memo: false })), "viewer");
});

test("WBS-068: the edge course list closes only once the pointer is past the list and the rail", async () => {
  const { edgeClosesAt, EDGE_DRAWER_WIDTH, RAIL_WIDTH } = await import("../src/layout.ts");
  assert.equal(edgeClosesAt(0), false);
  assert.equal(edgeClosesAt(EDGE_DRAWER_WIDTH + RAIL_WIDTH), false, "on the pushed rail it stays open");
  assert.equal(edgeClosesAt(EDGE_DRAWER_WIDTH + RAIL_WIDTH + 40), true);
});

test("WBS-103: the tools column stays between its minimum and what leaves the middle readable", async () => {
  const { clampToolsWidth, readToolsWidth, TOOLS_MIN_WIDTH, TOOLS_WIDTH_KEY } = await import("../src/layout.ts");
  assert.equal(clampToolsWidth(500, 1400), 500);
  assert.equal(clampToolsWidth(100, 1400), TOOLS_MIN_WIDTH);
  assert.equal(clampToolsWidth(1200, 1400), 960, "never wider than the maximum");
  assert.equal(clampToolsWidth(700, 900), 540, "the middle keeps 360px");
  assert.equal(clampToolsWidth(700, 500), TOOLS_MIN_WIDTH, "a tiny window still shows the controls");
  assert.equal(clampToolsWidth(Number.NaN, 1400), TOOLS_MIN_WIDTH);
  assert.equal(readToolsWidth({ getItem: (k) => (k === TOOLS_WIDTH_KEY ? "420" : null) }), 420);
  assert.equal(readToolsWidth({ getItem: () => "abc" }), undefined);
  assert.equal(readToolsWidth({ getItem: () => null }), undefined);
  assert.equal(readToolsWidth({ getItem: () => { throw new Error("blocked"); } }), undefined);
});
