export type Panel = "library" | "viewer" | "chat";
export type NarrowView = "materials" | "chat";

/** Below this width the viewer and chat share one column (SPEC-003). */
export const NARROW_WIDTH = 900;

export const isNarrow = (width: number): boolean => width < NARROW_WIDTH;

export function visiblePanels(narrow: boolean, view: NarrowView): Panel[] {
  if (!narrow) return ["library", "viewer", "chat"];
  return view === "chat" ? ["chat"] : ["library", "viewer"];
}

/** F6 and Shift+F6 cycle focus through the panels now on screen. */
export function nextPanel(current: Panel | undefined, panels: Panel[], backwards = false): Panel {
  const first = panels[0];
  if (first === undefined) throw new Error("no visible panels");
  const index = current === undefined ? -1 : panels.indexOf(current);
  if (index === -1) return first;
  const step = backwards ? panels.length - 1 : 1;
  return panels[(index + step) % panels.length] ?? first;
}
