const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const lines = (s, width) => { const chars = Array.from(s); return Array.from({ length: Math.ceil(chars.length / width) }, (_, i) => chars.slice(i * width, (i + 1) * width).join('')); };
/** Called only with validateDiagram output. No model-provided markup, links or scripts. */
export function diagramSvg(diagram) {
  const height = Math.max(...diagram.nodes.map(n => n.y + 100 + n.attributes.length * 18)) + 20;
  const byId = new Map(diagram.nodes.map(n => [n.id, n]));
  const edge = diagram.edges.map(e => {
    const a = byId.get(e.from), b = byId.get(e.to);
    const ax = a.x + 130, ay = a.y + 40, bx = b.x + 130, by = b.y + 40;
    return `<g><line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#64748b" stroke-width="2"/>${lines(e.label, 16).map((s, i) => `<text x="${(ax + bx) / 2}" y="${(ay + by) / 2 - 8 + i * 17}" text-anchor="middle" font-size="15" fill="#172033" paint-order="stroke" stroke="white" stroke-width="5">${escape(s)}</text>`).join('')}</g>`;
  }).join('');
  const nodes = diagram.nodes.map(n => `<g transform="translate(${n.x},${n.y})">${n.kind === 'relationship'
    ? '<polygon points="130,0 260,40 130,80 0,40" fill="#fff8df" stroke="#172033" stroke-width="2"/>'
    : `<rect width="260" height="${80 + n.attributes.length * 18}" rx="5" fill="#f2f6fc" stroke="#172033" stroke-width="2"/>`}
    ${lines(n.label, 12).map((s, i, all) => `<text x="130" y="${all.length === 1 ? 43 : 32 + i * 22}" text-anchor="middle" font-size="18" font-weight="bold" fill="#172033">${escape(s)}</text>`).join('')}
    ${n.attributes.map((a, i) => `<text x="14" y="${79 + i * 18}" font-size="13" fill="#172033">${escape(a)}</text>`).join('')}</g>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="초안 개념도" viewBox="0 0 1000 ${height}" style="display:block;width:100%;max-height:240mm">${edge}${nodes}</svg>`;
}
