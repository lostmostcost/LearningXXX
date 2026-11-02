import { createElement } from 'react';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Answer text is untrusted. No raw HTML, embedded media, local URLs or remote image requests. */
export function markdownUrl(url: string): string {
  try { return new URL(url).protocol === 'https:' ? url : ''; } catch { return ''; }
}
export const markdownComponents: Components = {
  a: ({ href, children }) => href ? createElement('a', { href, target: '_blank', rel: 'noopener noreferrer' }, children) : createElement('span', null, children),
  img: ({ alt }) => createElement('span', { className: 'markdown-image' }, `[이미지${alt ? `: ${alt}` : ''}]`),
  table: ({ children }) => createElement('div', { className: 'markdown-table' }, createElement('table', null, children)),
};
export const markdownOptions = { remarkPlugins: [remarkGfm], skipHtml: true, urlTransform: markdownUrl, components: markdownComponents };
