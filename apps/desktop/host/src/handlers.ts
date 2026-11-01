import type { LibraryService } from "./library-service.ts";
import type { Handlers } from "./router.ts";
import type { SessionService } from "./session-service.ts";

export function createHandlers(sessions: SessionService, library: LibraryService): Handlers {
  return {
    "collection.run": (request) => library.run(request),
    "collection.status": () => library.status(),
    "library.courses": async () => ({ courses: await library.courses() }),
    "library.manifest": async ({ courseId }) => {
      const manifest = await library.manifest(courseId);
      return manifest ? { manifest } : {};
    },
    "library.asset": (request) => library.asset(request),
    "session.create": async (request) => ({ session: sessions.create(request) }),
    "session.list": async (request) => ({ sessions: sessions.list(request) }),
    "session.rename": async (request) => ({ session: sessions.rename(request) }),
    "session.archive": async (request) => ({ session: sessions.archive(request) }),
    "run.start": async (request) => ({ run: await sessions.startRun(request) }),
    "run.cancel": async (request) => ({ run: sessions.cancel(request) }),
  };
}
