/**
 * WBS-067: LMS notice and assignment bodies are HTML written in the LMS
 * editor. They are never inserted as HTML. This turns them into a small tree
 * of allowed elements and plain text, which React renders (and escapes):
 * no scripts, styles, frames, forms, event handlers or inline styles; links
 * only to https pages (opened in the default browser); images become their
 * alt text, since LMS images need the school sign-in.
 */

export type RichNode =
  | { type: "text"; text: string }
  | { type: "element"; tag: AllowedTag; href?: string; children: RichNode[] };

const ALLOWED = ["p", "br", "div", "span", "b", "strong", "i", "em", "u", "s", "sub", "sup", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "hr", "a"] as const;
export type AllowedTag = (typeof ALLOWED)[number];
const isAllowed = (tag: string): tag is AllowedTag => (ALLOWED as readonly string[]).includes(tag);
/** Their content is dropped along with them. */
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "head", "title", "textarea", "select", "button", "form"]);
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "param", "source", "track", "wbr"]);

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", copy: "©", reg: "®", times: "×" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "�";
    }
    return NAMED[code.toLowerCase()] ?? whole;
  });
}

function attribute(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : undefined;
}

/** Only absolute https links survive; everything else (javascript:, data:, relative) is dropped. */
export function safeHref(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch { return undefined; }
}

/** At most this much HTML is read; the rest is cut (a body this long is shown at the source). */
export const MAX_HTML = 300_000;

export function parseRichText(html: string): RichNode[] {
  const source = html.slice(0, MAX_HTML);
  const root: { children: RichNode[] } = { children: [] };
  const stack: { tag: string; node: { children: RichNode[] } }[] = [{ tag: "#root", node: root }];
  const top = () => stack[stack.length - 1]!.node;
  const text = (t: string) => { if (t) top().children.push({ type: "text", text: decodeEntities(t) }); };
  const tagRe = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>?|<\?[^>]*>?|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let at = 0;
  for (let m = tagRe.exec(source); m; m = tagRe.exec(source)) {
    text(source.slice(at, m.index).replace(/</g, ""));
    at = tagRe.lastIndex;
    const name = m[1]?.toLowerCase();
    if (!name) continue; // comment, doctype, processing instruction
    const closing = m[0][1] === "/";
    if (!closing && DROP_WITH_CONTENT.has(name)) {
      // Skip to the matching close tag (or the end) without reading what is inside.
      const end = new RegExp(`</${name}\\s*>`, "ig");
      end.lastIndex = at;
      const close = end.exec(source);
      at = close ? end.lastIndex : source.length;
      tagRe.lastIndex = at;
      continue;
    }
    if (closing) {
      const i = stack.map((s) => s.tag).lastIndexOf(name);
      if (i > 0) stack.length = i;
      continue;
    }
    if (name === "img") {
      const alt = attribute(m[2] ?? "", "alt")?.trim();
      text(alt ? `[이미지: ${alt}]` : "[이미지]");
      continue;
    }
    if (!isAllowed(name)) continue; // unknown wrapper: keep its text, drop the tag
    const href = name === "a" ? safeHref(attribute(m[2] ?? "", "href")) : undefined;
    const node: RichNode = { type: "element", tag: name, ...(href ? { href } : {}), children: [] };
    top().children.push(node);
    if (!VOID.has(name) && !m[0].endsWith("/>")) stack.push({ tag: name, node });
  }
  text(source.slice(at).replace(/</g, ""));
  return root.children;
}

/** Plain text of a body, e.g. for a preview line. */
export function richTextPlain(nodes: readonly RichNode[]): string {
  return nodes.map((n) => (n.type === "text" ? n.text : n.tag === "br" ? "\n" : richTextPlain(n.children))).join("").replace(/\s+/g, " ").trim();
}
