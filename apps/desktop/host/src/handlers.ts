import type { Handlers } from "./router.ts";
import type { SessionService } from "./session-service.ts";

export function createHandlers(sessions: SessionService): Handlers {
  return {
    // Collection and library reads report the empty state until WBS-012.
    "collection.status": async () => ({}),
    "library.manifest": async () => ({}),
    "session.create": async (request) => ({ session: sessions.create(request) }),
    "session.list": async (request) => ({ sessions: sessions.list(request) }),
    "session.rename": async (request) => ({ session: sessions.rename(request) }),
    "session.archive": async (request) => ({ session: sessions.archive(request) }),
    "run.start": async (request) => ({ run: await sessions.startRun(request) }),
    "run.cancel": async (request) => ({ run: sessions.cancel(request) }),
  };
}
