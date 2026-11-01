import { TextSelection } from "@learningxxx/contracts";
import type { ComposerDraft } from "@learningxxx/contracts";

export type SelectionIntent = Exclude<ComposerDraft["intent"], "chat">;
export type SelectedText = NonNullable<ComposerDraft["selection"]>;
export interface SelectionRequest {
  id: string;
  selection: SelectedText;
  intent: SelectionIntent;
  /** The visible target when the user clicked the PDF action; never inferred from the course. */
  targetSessionId?: string;
}
export interface PageLocation { id: string; assetId: string; page: number }

export const INTENT_LABEL = {
  chat: "자유 질문", translate_en_ko: "영어 → 한국어", translate_ko_en: "한국어 → 영어", explain_simply: "쉬운 설명",
} as const;

/** Only a range entirely within this page's text layer is an explicit PDF selection. */
export function selectedText(
  selection: Pick<Selection, "isCollapsed" | "anchorNode" | "focusNode" | "toString"> | null,
  layer: Pick<Node, "contains">,
  assetId: string,
  page: number,
): SelectedText | undefined {
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode
      || !layer.contains(selection.anchorNode) || !layer.contains(selection.focusNode)) return undefined;
  const parsed = TextSelection.safeParse({ assetId, page, text: selection.toString().trim() });
  return parsed.success ? parsed.data : undefined;
}
