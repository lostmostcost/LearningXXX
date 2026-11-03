import type { ConversationService } from "./conversation-service.ts";
import type { AppModifier } from "@learningxxx/app-modifier";
import type { AttachmentService } from "./attachment-service.ts";
import type { CredentialService } from "./credential-service.ts";
import type { FileService } from "./file-service.ts";
import type { LearningStatusService } from "./learning-status.ts";
import type { LibraryService } from "./library-service.ts";
import type { RecordingService } from "./recording-service.ts";
import type { SttRuntimeService } from "./stt-runtime.ts";
import type { MediaService } from "./media-service.ts";
import type { LegacyImporter } from "./legacy-import.ts";
import type { Handlers } from "./router.ts";
import type { SessionService } from "./session-service.ts";

export function createHandlers(sessions: SessionService, library: LibraryService, files: FileService, attachments?: AttachmentService, credentials?: CredentialService, modifier?: AppModifier, recordings?: RecordingService, media?: MediaService, conversations?: ConversationService, stt?: SttRuntimeService, learning?: LearningStatusService, importer?: LegacyImporter): Handlers {
  const inputs = () => { if (!attachments) throw new Error("Attachment service unavailable"); return attachments; };
  const signIn = () => { if (!credentials) throw new Error("Credential service unavailable"); return credentials; };
  const modify = () => { if (!modifier) throw new Error("App modifier unavailable"); return modifier; };
  const recorder = () => { if (!recordings) throw new Error("Recording service unavailable"); return recordings; };
  const libraryMedia = () => { if (!media) throw new Error("Media service unavailable"); return media; };
  const chat = () => { if (!conversations) throw new Error('Conversation service unavailable'); return conversations; };
  const runtime = () => { if (!stt) throw new Error("STT runtime unavailable"); return stt; };
  const importing = () => { if (!importer) throw new Error("Importer unavailable"); return importer; };
  /** WBS-065: a recording is filed only under a week of its own course's collected manifest. */
  const checkWeek = async (courseId: string, weekId: string | undefined) => {
    if (weekId === undefined || (await library.manifest(courseId))?.weeks.some((w) => w.id === weekId)) return;
    throw Object.assign(new Error("unknown week"), { appError: { code: "INVALID_REQUEST", message: "이 과목에 없는 주차입니다. 자료를 다시 수집한 뒤 주차를 골라 주세요.", retryable: false } });
  };
  return {
    "stt.status": ({ refresh }) => runtime().status(refresh),
    "stt.prepare": () => runtime().prepare(),
    "stt.cancel": () => runtime().cancel(),
    'chat.rewind': ({ appSessionId, messageId, preview }) => chat().rewind(appSessionId, messageId, preview),
    'chat.open': ({ appSessionId }) => chat().open(appSessionId),
    'chat.state': async ({ appSessionId }) => chat().state(appSessionId),
    'chat.send': ({ appSessionId, text, requestId }) => chat().send(appSessionId, text, requestId),
    'chat.configure': ({ appSessionId, ...change }) => chat().configure(appSessionId, change),
    'chat.answer': async ({ appSessionId, permissionId, allow, answers }) => chat().answer(appSessionId, permissionId, allow, answers),
    'chat.interrupt': ({ appSessionId }) => chat().interrupt(appSessionId),
    'chat.info': async ({ appSessionId, kind }) => ({ text: await chat().info(appSessionId, kind) }),
    'chat.detach': async ({ appSessionId }) => { await chat().detach(appSessionId); return {}; },
    "terminal.stage": async ({ appSessionId, attachmentId }) => {
      if (!['native', 'chat'].includes(sessions.get(appSessionId).engine ?? '')) throw new Error('Not a native session');
      return inputs().forNative(appSessionId, attachmentId);
    },
    "collection.run": (request) => library.run(request),
    "collection.status": () => library.status(),
    "credentials.status": async () => signIn().status(),
    "credentials.saveSchool": (request) => signIn().saveSchool(request),
    "credentials.saveCanvasToken": (request) => signIn().saveCanvasToken(request),
    "credentials.clear": async (request) => signIn().clear(request),
    "library.courses": async () => ({ courses: await library.courses() }),
    "learning.status": async ({ courseId, refresh }) => {
      const status = await learning?.status(courseId, refresh ?? false);
      return status ? { status } : {};
    },
    "learning.openQuiz": async ({ courseId, moduleItemId, quizId }) => {
      if (!learning) throw Object.assign(new Error("unavailable"), { appError: { code: "NOT_FOUND", message: "LMS 퀴즈 창을 열 수 없습니다.", retryable: false } });
      await learning.openQuiz(courseId, { moduleItemId, quizId });
      return {};
    },
    "learning.watch": async ({ courseId, moduleItemId }) => {
      if (!learning) throw Object.assign(new Error("unavailable"), { appError: { code: "NOT_FOUND", message: "LMS 시청 창을 열 수 없습니다.", retryable: false } });
      await learning.watch(courseId, moduleItemId);
      return {};
    },
    "learning.recordView": async ({ courseId, moduleItemId }) => {
      if (!learning) throw Object.assign(new Error("unavailable"), { appError: { code: "NOT_FOUND", message: "열람 기록을 쓸 수 없습니다.", retryable: false } });
      const status = await learning.recordView(courseId, moduleItemId);
      return status ? { status } : {};
    },
    "library.manifest": async ({ courseId }) => {
      const manifest = await library.manifest(courseId);
      return manifest ? { manifest } : {};
    },
    "library.asset": (request) => library.asset(request),
    "session.create": async (request) => ({ session: sessions.create(request) }),
    "session.list": async (request) => ({ sessions: sessions.list(request) }),
    "session.rename": async (request) => {
      if (conversations?.active(request.appSessionId)) { await conversations.rename(request.appSessionId, request.title); return { session: sessions.get(request.appSessionId) }; }
      return { session: sessions.rename(request) };
    },
    "session.archive": async (request) => {
      if (request.archived) {
        if (conversations?.active(request.appSessionId) && conversations.state(request.appSessionId).busy) throw new Error('진행 중인 작업을 중지한 뒤 보관하세요.');
        await conversations?.close(request.appSessionId);
      }
      return { session: sessions.archive(request) };
    },
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
      if (['native', 'chat'].includes(sessions.get(request.draft.targetSessionId).engine ?? '')) throw Object.assign(new Error('Native terminal active'), { appError: { code: 'INVALID_REQUEST', message: '이 세션의 Claude Code를 종료한 뒤 기존 채팅을 실행하세요.', retryable: false } });
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
    "recording.start": async (request) => { await media?.authorize(request.courseId); await checkWeek(request.courseId, request.weekId); return { recording: await recorder().start(request) }; },
    "recording.assign": async (request) => {
      const courseId = recorder().courseOf(request.recordingId);
      await media?.authorize(courseId); await checkWeek(courseId, request.weekId);
      return { recording: recorder().assign(request) };
    },
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
    "media.importScan": async () => { await libraryMedia().recover(); return importing().scan(); },
    "media.importRun": (request) => importing().run(request),
    "media.importStatus": async () => importing().status(),
    "media.importedDoc": ({ courseId, assetId, doc }) => libraryMedia().importedDoc(courseId, assetId, doc),
    "media.saveCorrection": ({ courseId, assetId, basedOnTranscriptId, texts }) => libraryMedia().saveCorrection(courseId, assetId, basedOnTranscriptId, texts),
    "media.makeReadable": ({ courseId, assetId, transcriptId }) => libraryMedia().makeReadable(courseId, assetId, transcriptId),
    "media.translation": ({ courseId, assetId, transcriptId, language }) => libraryMedia().translation(courseId, assetId, transcriptId, language),
    "media.translate": ({ courseId, assetId, transcriptId, language }) => libraryMedia().translate(courseId, assetId, transcriptId, language),
    // WBS-073: the media queue plus a running import of earlier recordings.
    "media.queue": async () => {
      const queue = await libraryMedia().queue();
      const imp = importer?.status();
      return imp?.running ? { ...queue, items: [...queue.items, { kind: "import" as const, id: "import", title: `기존 녹음 가져오기 ${imp.done}/${imp.total}`, status: "running" as const, ...(imp.total ? { progress: imp.done / imp.total } : {}) }] } : queue;
    },
    "media.findMentions": ({ courseId, assetId, transcriptId }) => libraryMedia().findMentions(courseId, assetId, transcriptId),
    "media.addMentions": ({ courseId, assetId, candidates }) => libraryMedia().addMentions(courseId, assetId, candidates),
    "media.mentions": ({ courseId }) => libraryMedia().mentions(courseId),
    "media.removeMention": ({ courseId, mentionId }) => libraryMedia().removeMention(courseId, mentionId),
    "media.retry": ({ courseId, jobId }) => libraryMedia().retry(courseId, jobId),
    "media.pauseTranscription": () => libraryMedia().pauseTranscription(),
    "media.resumeTranscription": () => libraryMedia().resumeTranscription(),
    "media.cancelTranscription": ({ courseId, jobId }) => libraryMedia().cancelTranscription(courseId, jobId),
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
