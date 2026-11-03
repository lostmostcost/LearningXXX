/**
 * CR-061 / WBS-062: one collection each time the app starts. The mark lives in
 * this window's session storage, which ends when the app quits, so reloading
 * the window (e.g. after an app change, WBS-031) does not collect again.
 */
const KEY = "learningxxx.launchSync";

export function claimLaunchSync(storage: Pick<Storage, "getItem" | "setItem"> | undefined): boolean {
  try {
    if (!storage) return true;
    if (storage.getItem(KEY)) return false;
    storage.setItem(KEY, "1");
    return true;
  } catch {
    return true; // no storage: collect anyway; at worst a reload collects again
  }
}
