import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDiagram } from '../src/model.mjs';
import { diagramSvg } from '../src/diagrams.mjs';
test('diagram data rejects cross references, duplicate nodes and coordinates; labels stay text', () => {
  const raw = { nodes: [{ id: 'a', label: '<script>bad</script>', attributes: ['x & y'] }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b', label: '1:N' }] };
  const svg = diagramSvg(validateDiagram(raw));
  assert.match(svg, /&lt;script&gt;/); assert.doesNotMatch(svg, /<script>/); assert.match(svg, /1:N/);
  assert.throws(() => validateDiagram({ ...raw, edges: [{ from: 'a', to: 'outside', label: 'x' }] }));
  assert.throws(() => validateDiagram({ ...raw, nodes: [raw.nodes[0], raw.nodes[0]] }));
  assert.throws(() => validateDiagram({ ...raw, nodes: [{ ...raw.nodes[0], x: -1 }] }));
});
