import assert from "node:assert/strict";
import { test } from "node:test";
import { claimLaunchSync } from "../src/launch-sync.ts";

test("the app collects once per start: a reload of the window does not collect again", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  assert.equal(claimLaunchSync(storage), true);
  assert.equal(claimLaunchSync(storage), false, "same window session");
  store.clear(); // the app quit and started again
  assert.equal(claimLaunchSync(storage), true);
  assert.equal(claimLaunchSync({ getItem: () => { throw new Error("blocked"); }, setItem: () => {} }), true, "no storage still collects");
});
