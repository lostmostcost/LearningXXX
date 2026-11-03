/** WBS-087: "820 KB", "1.4 GB" for storage sizes. */
export function sizeText(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

interface Item { bytes: number; transcribed: boolean; removedAt?: string | undefined }

/** Totals over every course: what is kept, what could be freed now, how many were already deleted. */
export function storageSummary(courses: readonly { items: readonly Item[] }[]): { keptBytes: number; removableBytes: number; removedCount: number } {
  const items = courses.flatMap((c) => c.items);
  return {
    keptBytes: items.filter((i) => !i.removedAt).reduce((a, i) => a + i.bytes, 0),
    removableBytes: items.filter((i) => !i.removedAt && i.transcribed).reduce((a, i) => a + i.bytes, 0),
    removedCount: items.filter((i) => i.removedAt).length,
  };
}
