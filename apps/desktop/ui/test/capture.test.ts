import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { capturePreview } from "../src/capture-preview.ts";
import { emptyDraft, freeze, sendBlock } from "../src/composer.ts";

test("captures and files are frozen into their own contract lists", () => {
  const file = randomUUID(), shot = randomUUID();
  const sent = freeze({ ...emptyDraft(), attachments: [
    { id: file, name: "a.pdf", status: "ready", kind: "file" },
    { id: shot, name: "화면 캡처.png", status: "ready", kind: "capture" },
  ] }, randomUUID());
  assert.deepEqual(sent.attachmentIds, [file]);
  assert.deepEqual(sent.captureIds, [shot]);
});

test("an unconfirmed capture blocks sending; a selection in progress too", () => {
  const session = { appSessionId: randomUUID() } as never;
  assert.equal(sendBlock({ ...emptyDraft(), attachments: [{ id: randomUUID(), name: "x", status: "unconfirmed", kind: "capture" }] }, session, false), "unconfirmed_attachment");
  assert.equal(sendBlock({ ...emptyDraft(), attachments: [{ id: randomUUID(), name: "x", status: "preparing", kind: "capture" }] }, session, false), "preparing");
});

test("the preview is an inline PNG data URL built from the bytes, never a path", () => {
  const bytes = Uint8Array.from([137, 80, 78, 71, 1, 2, 3]);
  const url = capturePreview(bytes);
  assert.ok(url.startsWith("data:image/png;base64,"));
  assert.deepEqual(Uint8Array.from(atob(url.slice(22)), (c) => c.charCodeAt(0)), bytes);
  assert.ok(capturePreview(new Uint8Array(200_000)).length > 200_000, "large captures are chunked, not truncated");
});
