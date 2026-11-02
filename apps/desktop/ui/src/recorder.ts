/** The host's recording format (WBS-023): 16 kHz mono, 16-bit little-endian PCM. */
export const SAMPLE_RATE = 16_000;
/** About two seconds per chunk: little lost on a crash, few IPC calls. */
export const CHUNK_BYTES = SAMPLE_RATE * 2 * 2;

/** Float samples (-1..1) to 16-bit little-endian bytes, clipping out-of-range values. */
export function toPcm16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(samples.length * 2));
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return out;
}

/** Collects PCM until a chunk is full; `take` returns everything left (for the last chunk). */
export class ChunkBuffer {
  #parts: Uint8Array[] = [];
  #size = 0;

  push(bytes: Uint8Array): Uint8Array<ArrayBuffer> | undefined {
    this.#parts.push(bytes);
    this.#size += bytes.byteLength;
    return this.#size >= CHUNK_BYTES ? this.take() : undefined;
  }

  take(): Uint8Array<ArrayBuffer> | undefined {
    if (this.#size === 0) return undefined;
    const out = new Uint8Array(new ArrayBuffer(this.#size));
    let offset = 0;
    for (const part of this.#parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    this.#parts = [];
    this.#size = 0;
    return out;
  }
}

/** 1:05:09 or 4:03 */
export function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

export const RECORDING_STATUS = {
  recording: "녹음 중",
  finalized: "저장됨",
  recovered_partial: "앱 종료로 끊김 · 저장된 부분까지 복구됨",
  failed: "실패",
} as const;
