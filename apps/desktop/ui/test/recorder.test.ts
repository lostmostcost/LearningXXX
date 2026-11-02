import assert from "node:assert/strict";
import { test } from "node:test";
import { CHUNK_BYTES, ChunkBuffer, clock, toPcm16 } from "../src/recorder.ts";

test("float samples become clipped 16-bit little-endian PCM", () => {
  const bytes = toPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
  const view = new DataView(bytes.buffer);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => view.getInt16(i * 2, true)), [0, 32767, -32768, 32767, -32768, 16384]);
});

test("chunks are released when full and the rest on take", () => {
  const buffer = new ChunkBuffer();
  assert.equal(buffer.push(new Uint8Array(CHUNK_BYTES - 2)), undefined);
  assert.equal(buffer.push(new Uint8Array(4))!.byteLength, CHUNK_BYTES + 2);
  assert.equal(buffer.take(), undefined);
  buffer.push(new Uint8Array(6));
  assert.equal(buffer.take()!.byteLength, 6);
});

test("elapsed time reads like a clock", () => {
  assert.equal(clock(243_900), "4:03");
  assert.equal(clock(3_909_000), "1:05:09");
});
