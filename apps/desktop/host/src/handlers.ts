import type { Handlers } from "./router.ts";

/** Skeleton: reads report the empty state. Feature WBS fill in the rest. */
export const skeletonHandlers: Handlers = {
  "collection.status": async () => ({}),
  "library.manifest": async () => ({}),
  "session.list": async () => ({ sessions: [] }),
};
