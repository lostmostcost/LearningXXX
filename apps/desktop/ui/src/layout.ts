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

/**
 * WBS-068: the course list that slides in from the screen's left edge pushes
 * the icon rail aside (drawer then rail); it closes once the pointer moves
 * past both, with a little slack.
 */
export const EDGE_DRAWER_WIDTH = 240;
export const RAIL_WIDTH = 58;
export const EDGE_OPEN_DELAY_MS = 120;
export const edgeClosesAt = (x: number): boolean => x > EDGE_DRAWER_WIDTH + RAIL_WIDTH + 12;
