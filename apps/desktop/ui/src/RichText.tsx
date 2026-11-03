import { Fragment, type ReactNode } from "react";
import { parseRichText, type RichNode } from "./rich-text.ts";

function render(nodes: readonly RichNode[]): ReactNode[] {
  return nodes.map((node, i) => {
    if (node.type === "text") return <Fragment key={i}>{node.text}</Fragment>;
    const children = render(node.children);
    switch (node.tag) {
      case "br": return <br key={i} />;
      case "hr": return <hr key={i} />;
      // https only (rich-text.ts); target=_blank goes to the host, which opens the default browser.
      case "a": return node.href ? <a key={i} href={node.href} target="_blank" rel="noreferrer">{children}</a> : <span key={i}>{children}</span>;
      // Headings inside a body stay below the viewer's own title.
      case "h1": case "h2": case "h3": return <h4 key={i}>{children}</h4>;
      case "h4": case "h5": case "h6": return <h5 key={i}>{children}</h5>;
      default: { const Tag = node.tag; return <Tag key={i}>{children}</Tag>; }
    }
  });
}

/** WBS-067: an LMS body, rebuilt from allowed elements and text only (never inserted as HTML). */
export function RichText({ html }: { html: string }) {
  return <div className="rich-text">{render(parseRichText(html))}</div>;
}
