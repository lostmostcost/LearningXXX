import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppError } from "@learningxxx/contracts";
import { MAX_ATTACHMENT_BYTES } from "../src/attachment-service.ts";
import { CAPTURE_ARGS, captureRegion, validateCapture } from "../src/native-capture.ts";

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64"));
const code = (expected: string) => (e: unknown) => AppError.parse((e as { appError: unknown }).appError).code === expected;
const temp = () => mkdtempSync(join(tmpdir(), "wbs037-"));
const base = (tempRoot: string, run: (output: string) => Promise<void>, permission = () => "granted") =>
  ({ platform: "darwin", tempRoot, permission, run });

test("the system tool is always interactive region selection, silent, PNG", () => {
  assert.deepEqual([...CAPTURE_ARGS], ["-i", "-s", "-t", "png", "-x"]);
});

test("a selected region comes back as PNG bytes and the temporary folder is removed", async () => {
  const root = temp();
  let written = "";
  const bytes = await captureRegion(base(root, async (output) => { written = output; writeFileSync(output, PNG); }));
  assert.deepEqual(bytes, PNG);
  assert.ok(written.startsWith(root), "output stays in a host-made folder");
  assert.deepEqual(readdirSync(root), []);
});

test("escape (exit 1, or no file) is a cancel, not an error", async () => {
  const root = temp();
  assert.equal(await captureRegion(base(root, async () => { throw Object.assign(new Error("cancel"), { code: 1 }); })), undefined);
  assert.equal(await captureRegion(base(root, async () => {})), undefined);
  assert.deepEqual(readdirSync(root), []);
});

test("a denied screen-recording permission stops before the tool runs and is not retryable", async () => {
  let ran = false;
  await assert.rejects(captureRegion(base(temp(), async () => { ran = true; }, () => "denied")), code("CAPTURE_PERMISSION_DENIED"));
  assert.equal(ran, false);
  // Permission revoked while selecting: the image is not used.
  await assert.rejects(
    captureRegion(base(temp(), async (output) => writeFileSync(output, PNG), (() => { let n = 0; return () => (n++ === 0 ? "granted" : "denied"); })())),
    code("CAPTURE_PERMISSION_DENIED"),
  );
});

test("tool failures, non-PNG, oversized files and other platforms fail plainly", async () => {
  await assert.rejects(captureRegion(base(temp(), async () => { throw Object.assign(new Error("boom"), { code: 2 }); })), code("CAPTURE_FAILED"));
  await assert.rejects(captureRegion(base(temp(), async (output) => writeFileSync(output, "not an image"))), code("CAPTURE_FAILED"));
  await assert.rejects(captureRegion(base(temp(), async (output) => writeFileSync(output, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)))), code("CAPTURE_FAILED"));
  await assert.rejects(captureRegion({ ...base(temp(), async () => {}), platform: "linux" }), code("CAPTURE_FAILED"));
});

test("PNG validation checks signature, header and size", () => {
  validateCapture(PNG);
  assert.throws(() => validateCapture(PNG.slice(0, 20)), code("CAPTURE_FAILED"));
  const zero = PNG.slice();
  new DataView(zero.buffer).setUint32(16, 0);
  assert.throws(() => validateCapture(zero), code("CAPTURE_FAILED"));
});
