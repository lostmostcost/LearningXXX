/** Keep surrogate pairs intact while respecting the host IPC limit during a large paste. */
export function terminalInputChunks(data: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < data.length;) {
    let end = Math.min(start + 16000, data.length);
    const code = data.charCodeAt(end - 1);
    if (end < data.length && code >= 0xd800 && code <= 0xdbff) end--;
    chunks.push(data.slice(start, end)); start = end;
  }
  return chunks;
}
