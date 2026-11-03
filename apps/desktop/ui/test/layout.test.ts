import assert from "node:assert/strict";
import { test } from "node:test";
import { isNarrow, NARROW_WIDTH, nextPanel, visiblePanels } from "../src/layout.ts";

test("wide windows show all panels", () => {
  assert.deepEqual(visiblePanels(false, "chat"), ["library", "viewer", "chat"]);
});

test("narrow windows switch between materials and chat", () => {
  assert.deepEqual(visiblePanels(true, "materials"), ["library", "viewer"]);
  assert.deepEqual(visiblePanels(true, "chat"), ["chat"]);
});

test("the narrow boundary is exact", () => {
  assert.equal(isNarrow(NARROW_WIDTH - 1), true);
  assert.equal(isNarrow(NARROW_WIDTH), false);
});

test("F6 cycles forward and wraps", () => {
  const all = visiblePanels(false, "materials");
  assert.equal(nextPanel(undefined, all), "library");
  assert.equal(nextPanel("library", all), "viewer");
  assert.equal(nextPanel("chat", all), "library");
});

test("Shift+F6 cycles backward and wraps", () => {
  const all = visiblePanels(false, "materials");
  assert.equal(nextPanel("library", all, true), "chat");
});

test("focus on a hidden panel returns to the first visible one", () => {
  assert.equal(nextPanel("chat", visiblePanels(true, "materials")), "library");
});

test("WBS-068: the edge course list closes only once the pointer is past the list and the rail", async () => {
  const { edgeClosesAt, EDGE_DRAWER_WIDTH, RAIL_WIDTH } = await import("../src/layout.ts");
  assert.equal(edgeClosesAt(0), false);
  assert.equal(edgeClosesAt(EDGE_DRAWER_WIDTH + RAIL_WIDTH), false, "on the pushed rail it stays open");
  assert.equal(edgeClosesAt(EDGE_DRAWER_WIDTH + RAIL_WIDTH + 40), true);
});
