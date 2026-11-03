import { createElement } from 'react';
import type { Components, Options } from 'react-markdown';
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
// Only ~~text~~ strikes through: Korean writes ranges as "10~12시" and "[01:00]~[02:00]".
export const markdownOptions = { remarkPlugins: [[remarkGfm, { singleTilde: false }]] as NonNullable<Options['remarkPlugins']>, skipHtml: true, urlTransform: markdownUrl, components: markdownComponents };
