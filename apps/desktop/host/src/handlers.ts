import type { FileService } from "./file-service.ts";
import type { LibraryService } from "./library-service.ts";
import type { Handlers } from "./router.ts";
import type { SessionService } from "./session-service.ts";

export function createHandlers(sessions: SessionService, library: LibraryService, files: FileService): Handlers {
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
    "files.chooseFolder": async (request) => ({ session: await files.chooseFolder(request) }),
    "files.removeFolder": async (request) => ({ session: files.removeFolder(request) }),
    "files.changes": async ({ runId }) => {
      const changes = sessions.history?.changes(runId);
      return changes ? { changes } : {};
    },
    "files.sessionChanges": async ({ appSessionId }) => ({ records: sessions.changesFor(appSessionId) }),
    "files.restore": (request) => files.restore(request),
    "files.trash": (request) => files.trash(request),
  };
}
