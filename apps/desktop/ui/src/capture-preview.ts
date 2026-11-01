/** A preview is local renderer data only; no file path or remote URL is exposed. */
export function capturePreview(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return `data:image/png;base64,${btoa(chunks.join(""))}`;
}
