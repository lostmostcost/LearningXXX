import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { IpcChannels } from "@learningxxx/contracts";
import { WEB_PREFERENCES, WINDOW_SIZE } from "../src/window-options.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("renderer isolation stays on", () => {
  assert.deepEqual(WEB_PREFERENCES, {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    webviewTag: false,
  });
});

test("preload exposes exactly the contract channels", () => {
  const listed = [...read("../src/preload.cjs").matchAll(/^\s+"([a-z]+\.[a-z]+)",$/gm)].map((m) => m[1]);
  assert.deepEqual(listed.sort(), Object.keys(IpcChannels).sort());
});

test("preload exposes only invoke, and no raw ipcRenderer", () => {
  const preload = read("../src/preload.cjs");
  assert.match(preload, /exposeInMainWorld\("host", \{\s+invoke\(/);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer/);
  assert.doesNotMatch(preload, /child_process|require\("(?!electron)/);
});

test("renderer source cannot reach Node or run commands", () => {
  const dir = new URL("../../ui/src/", import.meta.url);
  for (const name of readdirSync(dir)) {
    assert.doesNotMatch(read(`../../ui/src/${name}`), /from "(electron|node:[a-z_/]+|child_process|fs)"|\bipcRenderer\b|\beval\(|new Function/, name);
  }
});

test("the page refuses remote and inline scripts", () => {
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(read("../../ui/index.html"))?.[1] ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline.*script|unsafe-eval|https?:/);
});

test("the window can shrink to the narrow layout", () => {
  assert.ok(WINDOW_SIZE.minWidth < 900);
});
