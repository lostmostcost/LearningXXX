import Markdown from 'react-markdown';
import { markdownOptions } from './markdown.ts';
export function MarkdownAnswer({ text }: { text: string }) {
  return <div className="markdown-answer"><Markdown {...markdownOptions}>{text}</Markdown></div>;
}
