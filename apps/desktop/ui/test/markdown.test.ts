import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { markdownOptions } from '../src/markdown.ts';
const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { ...markdownOptions, children: text }));
test('renders bold, list, fenced code and GFM table as elements', () => {
  const html = render('**굵게**\n\n- 항목\n\n```js\nconst x = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |');
  for (const tag of ['<strong>굵게</strong>', '<ul>', '<pre>', '<table>']) assert.ok(html.includes(tag), tag);
});
test('streaming incomplete Markdown remains readable', () => {
  assert.ok(render('답변 **진행').includes('진행'));
  assert.ok(render('```js\nconst x').includes('const x'));
});
test('untrusted output cannot inject scripts, navigate local files, or request remote images', () => {
  const html = render('<script>alert(1)</script>\n\n[bad](javascript:alert) [file](file:///secret) [web](https://example.org)\n\n![private](https://example.org/tracker.png)');
  for (const forbidden of ['<script', 'href="javascript:', 'file:///secret', '<img', 'tracker.png']) assert.ok(!html.includes(forbidden), forbidden);
  assert.ok(html.includes('href="https://example.org"'));
  assert.ok(html.includes('noopener noreferrer'));
});
