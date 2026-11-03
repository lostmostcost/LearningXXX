import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeEntities, parseRichText, richTextPlain, safeHref, type RichNode } from "../src/rich-text.ts";

const tags = (nodes: RichNode[]): string[] => nodes.flatMap((n) => (n.type === "text" ? [] : [n.tag, ...tags(n.children)]));

test("keeps structure and text, decodes entities", () => {
  const nodes = parseRichText("<p>과제 <strong>마감</strong> &amp; 제출&nbsp;안내</p><ul><li>하나<li>둘</ul>");
  assert.deepEqual(tags(nodes), ["p", "strong", "ul", "li", "li"]);
  assert.equal(richTextPlain(nodes), "과제 마감 & 제출 안내하나둘".replace(/\s+/g, " "));
  assert.equal(decodeEntities("&#x1F600;&#65;&lt;&bogus;"), "😀A<&bogus;");
});

test("scripts, styles, frames and handlers never survive; their content is dropped", () => {
  const nodes = parseRichText(`<p onclick="alert(1)" style="color:red">보임</p><script>alert('x')</script><style>p{}</style><iframe src="https://evil.example"></iframe><svg><script>x</script></svg>끝`);
  assert.deepEqual(tags(nodes), ["p"]);
  assert.equal(richTextPlain(nodes), "보임끝");
  assert.equal(JSON.stringify(nodes).includes("alert"), false);
  assert.equal(JSON.stringify(nodes).includes("onclick"), false);
});

test("links keep only https targets; images become their alt text", () => {
  const nodes = parseRichText(`<a href="https://khcanvas.khu.ac.kr/x?a=1&amp;b=2">LMS</a><a href="javascript:alert(1)">나쁨</a><a href="/courses/1">상대</a><img src="https://x/y.png" alt="도표"><img src=x onerror=alert(1)>`);
  const links = nodes.filter((n) => n.type === "element" && n.tag === "a");
  assert.deepEqual(links.map((n) => (n.type === "element" ? n.href ?? null : null)), ["https://khcanvas.khu.ac.kr/x?a=1&b=2", null, null]);
  assert.equal(richTextPlain(nodes), "LMS나쁨상대[이미지: 도표][이미지]");
  assert.equal(safeHref(" data:text/html,<b>"), undefined);
  assert.equal(safeHref("http://plain.example"), undefined);
});

test("broken or tricky markup still gives text only", () => {
  assert.equal(richTextPlain(parseRichText("<p>열린 <b>태그")), "열린 태그");
  // A broken tag around a script leaves only escaped text, never an element.
  assert.deepEqual(parseRichText("<!-- 숨김 --><scr<script>ipt>alert(1)</script>"), [{ type: "text", text: "ipt>alert(1)" }]);
  const nodes = parseRichText("<div><p>a</div>b</p>c");
  assert.equal(richTextPlain(nodes), "abc");
  assert.deepEqual(parseRichText("<SCRIPT >secret</SCRIPT >y"), [{ type: "text", text: "y" }]);
});
