/** WBS-086: how much of a page's text goes into a memo with "보고 있는 쪽 추가". */
export const PAGE_QUOTE_CHARS = 600;

/**
 * The block added to a memo for the page being read: a "📄 자료 N쪽" line the
 * AI tidy keeps, then the start of the page's text as a quote.
 */
export function pageQuote(memo: string, title: string, page: number, pageText: string): string {
  const lead = !memo ? "" : memo.endsWith("\n\n") ? "" : memo.endsWith("\n") ? "\n" : "\n\n";
  // Private-use glyphs (slide bullets in symbol fonts) would show as boxes.
  const text = pageText.replace(/[\uE000-\uF8FF]/g, " ").replace(/\s+/g, " ").trim();
  const quote = text ? text.length > PAGE_QUOTE_CHARS ? `${text.slice(0, PAGE_QUOTE_CHARS)}…` : text : "";
  return `${lead}📄 ${title} ${page}쪽\n${quote ? `> ${quote}\n` : ""}`;
}
