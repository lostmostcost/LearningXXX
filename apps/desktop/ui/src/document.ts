import type { Asset } from "@learningxxx/contracts";
import type { Entry } from "./library.ts";

/** A-stage format decision (WBS-003, SPEC-003): PDF only. Others open at the source. */
export const SUPPORTED_MEDIA_TYPES: readonly string[] = ["application/pdf"];

export type ViewTarget =
  | { kind: "pdf"; asset: Asset }
  | { kind: "unsupported"; asset: Asset }
  | { kind: "no_original" }
  | { kind: "notice" }
  | { kind: "assignment" };

/** What the viewer shows for a selected entry. The first supported asset wins. */
export function viewTarget(entry: Entry): ViewTarget {
  if (entry.resource.kind === "notice") return { kind: "notice" };
  if (entry.resource.kind === "assignment") return { kind: "assignment" };
  const supported = entry.assets.find((a) => SUPPORTED_MEDIA_TYPES.includes(a.mediaType));
  if (supported) return { kind: "pdf", asset: supported };
  const first = entry.assets[0];
  return first ? { kind: "unsupported", asset: first } : { kind: "no_original" };
}

export type PdfState =
  | { kind: "loading" }
  | { kind: "ready"; pageCount: number; hasText: boolean }
  | { kind: "encrypted" }
  | { kind: "broken" }
  | { kind: "unavailable" };

/** pdf.js signals a password with PasswordException; anything else that fails to open is broken. */
export const pdfErrorState = (error: unknown): PdfState =>
  (error as { name?: unknown } | null)?.name === "PasswordException" ? { kind: "encrypted" } : { kind: "broken" };

/** Whitespace-only text items (common in scans) do not count as selectable text. */
export const hasSelectableText = (pageTexts: readonly string[]): boolean => pageTexts.some((t) => t.trim() !== "");

export const PDF_MESSAGES = {
  encrypted: "암호가 걸린 PDF입니다. 앱에서 열 수 없으니 원문 열기로 확인하세요.",
  broken: "PDF 파일이 손상되었거나 PDF 형식이 아닙니다. 원문 열기로 다시 받아 보세요.",
  unavailable: "이 자료의 원본을 아직 앱에서 불러올 수 없습니다. 로컬 저장 연결 후 열립니다.",
  noText: "이 PDF에는 선택할 수 있는 텍스트가 없습니다. 스캔본일 수 있으며, 텍스트 선택·번역은 사용할 수 없습니다.",
} as const;

export const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "알 수 없는 형식";
};
