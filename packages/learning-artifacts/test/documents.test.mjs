import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentHtml, presentationPptx } from '../src/documents.mjs';
import { snapshot, validatePlan } from '../src/model.mjs';
import { input, plan } from './fixture.mjs';
test('report escapes hostile source/model text; preserves requirements and questions', () => {
  const s = snapshot(input('document')), raw = plan('document'); raw.sections[0].paragraphs = ['<script>alert("x")</script>']; raw.openQuestions = ['평가 기준 확인'];
  const html = documentHtml(validatePlan(raw, s), s);
  assert.ok(!html.includes('<script>')); assert.match(html, /&lt;script&gt;/); assert.match(html, /평가 기준 확인/); assert.match(html, /요구사항 확인/);
});
test('PPTX is a real ZIP/OOXML package with editable text and escaped values', () => {
  const s = snapshot(input('slides')), raw = plan('slides'); raw.slides[0].bullets = ['A & B < C'];
  const bytes = presentationPptx(validatePlan(raw, s), s);
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.match(bytes.toString(), /ppt\/presentation.xml/); assert.match(bytes.toString(), /A &amp; B &lt; C/); assert.match(bytes.toString(), /과제 요구사항 확인/);
});
