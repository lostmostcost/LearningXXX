import type { FileChange, RunChanges, Session } from "@learningxxx/contracts";

export const CHANGE_LABEL = { created: "새 파일", modified: "수정됨", deleted: "삭제됨" } as const;

/** Keys for granted folders carry an index; people should see the folder name. */
export function displayKey(key: string, folders: readonly string[] = []): string {
  const match = /^external-(\d+)\/(.*)$/.exec(key);
  if (!match) return key;
  const folder = folders[Number(match[1])];
  return `${folder?.split("/").pop() ?? "외부 폴더"}/${match[2]}`;
}

/** A list that arrived late for another session is never shown or acted on. */
export const recordsFor = (records: readonly RunChanges[], appSessionId: string) =>
  records.filter((record) => record.appSessionId === appSessionId);

/** Only a file that still exists can be moved to the Trash. */
export const canTrash = (change: FileChange) => change.change !== "deleted" && change.present !== false;

/** Said next to a file that is gone since the run, e.g. already in the Trash. */
export const goneNote = (change: FileChange) => (change.change !== "deleted" && change.present === false ? "지금 없음(휴지통 등)" : undefined);

export const canGrantFolders = (session: Session) => session.mode === "course";

/** True when pressing restore would change something. */
export const hasRestorable = (record: RunChanges) => record.changes.some((c) => c.restorable);

/** The recovery path, stated plainly: what restore does and what it cannot do. */
export function recoveryNote(record: RunChanges): string {
  if (!record.snapshotKept) return "작업 폴더가 커서 실행 전 사본을 만들지 못했습니다. 이 실행은 되돌릴 수 없습니다.";
  if (record.changes.some((c) => !c.restorable)) return "외부 폴더의 변경은 되돌릴 수 없습니다. 작업 폴더의 변경만 되돌립니다.";
  return "되돌리면 수정·삭제된 파일은 실행 전 내용으로 돌아오고, 새 파일은 휴지통으로 갑니다.";
}

export function restoreSummary({ restored, skipped }: { restored: string[]; skipped: string[] }): string {
  const done = `${restored.length}개를 되돌렸습니다.`;
  return skipped.length ? `${done} ${skipped.length}개는 되돌리지 못했습니다: ${skipped.join(", ")}` : done;
}
