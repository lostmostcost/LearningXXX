import assert from "node:assert/strict";
import { test } from "node:test";
import { sizeText, storageSummary } from "../src/storage.ts";

test("WBS-087: sizes and totals count only what is still kept", () => {
  assert.equal(sizeText(820 * 1024), "820 KB");
  assert.equal(sizeText(3.25 * 1024 ** 2), "3.3 MB");
  assert.equal(sizeText(250 * 1024 ** 2), "250 MB");
  assert.equal(sizeText(1.4 * 1024 ** 3), "1.4 GB");
  assert.deepEqual(storageSummary([{ items: [{ bytes: 100, transcribed: true }, { bytes: 50, transcribed: false }] }, { items: [{ bytes: 70, transcribed: true, removedAt: "2026-11-04T00:00:00Z" }] }]), { keptBytes: 150, removableBytes: 100, removedCount: 1 });
});
