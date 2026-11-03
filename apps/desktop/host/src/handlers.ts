import type { NativeTerminalService } from "./native-terminal.ts";
import type { AppModifier } from "@learningxxx/app-modifier";
import type { AttachmentService } from "./attachment-service.ts";
import type { CredentialService } from "./credential-service.ts";
import type { FileService } from "./file-service.ts";
import type { LibraryService } from "./library-service.ts";
import type { RecordingService } from "./recording-service.ts";
import type { MediaService } from "./media-service.ts";
import type { Handlers } from "./router.ts";
import type { SessionService } from "./session-service.ts";

export function createHandlers(sessions: SessionService, library: LibraryService, files: FileService, attachments?: AttachmentService, credentials?: CredentialService, modifier?: AppModifier, recordings?: RecordingService, media?: MediaService, terminals?: NativeTerminalService): Handlers {
  const inputs = () => { if (!attachments) throw new Error("Attachment service unavailable"); return attachments; };
  const signIn = () => { if (!credentials) throw new Error("Credential service unavailable"); return credentials; };
  const modify = () => { if (!modifier) throw new Error("App modifier unavailable"); return modifier; };
  const recorder = () => { if (!recordings) throw new Error("Recording service unavailable"); return recordings; };
  const libraryMedia = () => { if (!media) throw new Error("Media service unavailable"); return media; };
  const terminal = () => { if (!terminals) throw new Error('Terminal service unavailable'); return terminals; };
  return {
    "terminal.stage": async ({ appSessionId, attachmentId }) => {
      if (sessions.get(appSessionId).engine !== 'native') throw new Error('Not a native session');
      return inputs().forNative(appSessionId, attachmentId);
    },
    "terminal.open": request => terminal().open(request),
    "terminal.read": async request => terminal().read(request),
    "terminal.write": async request => terminal().write(request),
    "terminal.resize": async request => terminal().resize(request),
    "terminal.close": async request => terminal().close(request),
    "collection.run": (request) => library.run(request),
    "collection.status": () => library.status(),
    "credentials.status": async () => signIn().status(),
    "credentials.saveSchool": (request) => signIn().saveSchool(request),
    "credentials.saveCanvasToken": (request) => signIn().saveCanvasToken(request),
    "credentials.clear": async (request) => signIn().clear(request),
    "library.courses": async () => ({ courses: await library.courses() }),
    "library.manifest": async ({ courseId }) => {
      const manifest = await library.manifest(courseId);
      return manifest ? { manifest } : {};
    },
    "library.asset": (request) => library.asset(request),
    "session.create": async (request) => ({ session: sessions.create(request) }),
    "session.list": async (request) => ({ sessions: sessions.list(request) }),
    "session.rename": async (request) => ({ session: sessions.rename(request) }),
    "session.archive": async (request) => { if (request.archived) terminals?.stopSession(request.appSessionId); return { session: sessions.archive(request) }; },
    "session.transcript": async ({ appSessionId }) => ({ turns: sessions.transcript(appSessionId) }),
    // Escape or closing the selection returns nothing: an empty answer, not an error.
    "captures.start": async (request) => {
      const capture = await inputs().capture(request);
      return capture ? { capture } : {};
    },
    "attachments.chooseLocal": async (request) => ({ attachment: await inputs().chooseLocal(request) }),
    "attachments.prepareAsset": async (request) => ({ attachment: await inputs().prepareAsset(request) }),
    "attachments.confirm": async (request) => ({ attachment: inputs().confirm(request) }),
    "attachments.remove": async (request) => inputs().remove(request),
    "run.start": async (request) => {
      if (sessions.get(request.draft.targetSessionId).engine === 'native' || terminals?.isActive(request.draft.targetSessionId)) throw Object.assign(new Error('Native terminal active'), { appError: { code: 'INVALID_REQUEST', message: '이 세션의 Claude Code를 종료한 뒤 기존 채팅을 실행하세요.', retryable: false } });
      return { run: await sessions.startRun(request) };
    },
    "run.cancel": async (request) => ({ run: sessions.cancel(request) }),
    "files.chooseFolder": async (request) => ({ session: await files.chooseFolder(request) }),
    "files.removeFolder": async (request) => ({ session: files.removeFolder(request) }),
    "files.changes": async ({ runId }) => {
      const changes = sessions.history?.changes(runId);
      return changes ? { changes } : {};
    },
    "files.sessionChanges": async (request) => files.sessionChanges(request),
    "files.restore": (request) => files.restore(request),
    "files.trash": (request) => files.trash(request),
    "recording.start": async (request) => { await media?.authorize(request.courseId); return { recording: await recorder().start(request) }; },
    "recording.chunk": async (request) => {
      try { await media?.authorize(recorder().courseOf(request.recordingId)); }
      catch (error) { await recorder().stopActive("RECORDING_INTERRUPTED"); throw error; }
      return recorder().chunk(request);
    },
    "recording.stop": async (request) => { const result = await recorder().stop(request); await media?.authorize(result.recording.courseId); return result; },
    "recording.list": async (request) => { await media?.authorize(request.courseId); return recorder().list(request); },
    "media.asset": async (request) => {
      if (!media) return recorder().asset(request);
      const asset = recorder().originals().find((a) => a.id === request.assetId);
      if (!asset) throw new Error("원본을 찾지 못했습니다.");
      await media.recover(); return media.asset(asset.courseId, asset.id);
    },
    "media.list": async ({ courseId }) => { await libraryMedia().recover(); return libraryMedia().list(courseId); },
    "media.videos": ({ courseId }) => libraryMedia().videos(courseId),
    "media.download": ({ courseId, sourceId }) => libraryMedia().download(courseId, sourceId),
    "media.cancelDownload": ({ courseId, downloadId }) => libraryMedia().cancelDownload(courseId, downloadId),
    "media.original": ({ courseId, assetId }) => libraryMedia().asset(courseId, assetId),
    "media.open": ({ courseId, assetId }) => libraryMedia().open(courseId, assetId),
    "media.retry": ({ courseId, jobId }) => libraryMedia().retry(courseId, jobId),
    "modify.status": async () => modify().status(),
    "modify.chooseSource": async () => ({ sourceConfigured: await modify().chooseSource() }),
    "modify.start": async (request) => ({ job: await modify().start(request) }),
    "modify.cancel": async ({ jobId }) => ({ job: modify().cancel(jobId) }),
    "modify.verify": async ({ jobId }) => ({ job: await modify().verify(jobId) }),
    "modify.apply": async ({ jobId }) => ({ job: await modify().apply(jobId) }),
    "modify.rollback": async ({ jobId }) => ({ job: await modify().rollback(jobId) }),
    "modify.discard": async ({ jobId }) => ({ job: await modify().discard(jobId) }),
  };
}
