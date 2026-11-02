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
