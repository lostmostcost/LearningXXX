export type FitMode = 'page' | 'width' | 'manual';
export const clampZoom = (zoom: number) => Math.max(.1, Math.min(4, zoom));
export function pageScale(size: { width: number; height: number }, bounds: { width: number; height: number }, fit: FitMode, zoom: number): number {
  return fit === 'manual' ? clampZoom(zoom) : Math.max(.1, Math.min((bounds.width - 32) / size.width, fit === 'page' ? (bounds.height - 32) / size.height : Infinity));
}
/** Chromium delivers Mac trackpad pinch as a ctrl+wheel event. Ordinary wheel stays native scroll. */
export function wheelZoom(current: number, delta: number, mode: number): number {
  const pixels = delta * (mode === 1 ? 16 : mode === 2 ? 400 : 1);
  return clampZoom(current * Math.exp(-Math.max(-100, Math.min(100, pixels)) * .01));
}

/** WBS-072: "1–3, 7" from [1, 2, 3, 7] (sorted page numbers). */
export function pageList(pages: readonly number[]): string {
  const out: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++;
    out.push(i === j ? `${pages[i]}` : `${pages[i]}–${pages[j]}`);
    i = j;
  }
  return out.join(", ");
}
