import { requireThat } from './model.mjs';
export const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const xml = (s) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${s}`;

/** No Markdown/raw HTML execution, remote fonts, images, scripts, or links. Print locally via host. */
export function documentHtml(plan, snapshot) {
  const refs = (ids) => ids.map((id) => snapshot.sources.find((s) => s.id === id)?.title ?? id).map(escape).join(' · ');
  const missing = snapshot.sources.filter((s) => s.status === 'missing');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escape(plan.title)}</title><style>
  @page{size:A4;margin:22mm}body{font:11pt/1.7 'Noto Sans CJK KR','Apple SD Gothic Neo',sans-serif;color:#172033}h1{font-size:26pt;line-height:1.3}h2{font-size:17pt;break-after:avoid}p,li{overflow-wrap:anywhere;white-space:pre-wrap}p{orphans:3;widows:3}.source{font-size:9pt;color:#526174}.label{color:#8b2635}li{margin:8px 0}section{margin:24px 0}
  </style></head><body><p class="label">검토용 과제 초안 · 제출 전 직접 확인</p><h1>${escape(plan.title)}</h1><p>${escape(snapshot.courseTitle)}</p>
  <h2>요구사항 확인</h2><ul>${plan.requirements.map((r) => `<li>${escape(r.text)}<div class="source">${refs(r.sourceIds)}</div></li>`).join('')}</ul>
  ${plan.sections.map((s) => `<section><h2>${escape(s.title)}</h2>${s.paragraphs.map((p) => `<p>${escape(p)}</p>`).join('')}<p class="source">근거: ${refs(s.sourceIds)}</p></section>`).join('')}
  <h2>직접 확인할 점</h2><ul>${plan.openQuestions.map((q) => `<li>${escape(q)}</li>`).join('') || '<li>모델이 확인 항목을 보고하지 않았습니다. 요구사항·사실·인용을 직접 확인하세요.</li>'}</ul>
  <h2>자료 검토 범위</h2><ul>${snapshot.sources.map((s) => `<li>${escape(s.title)} — ${s.status === 'available' ? `검토 입력 제공 (${escape(s.id)})` : `누락: ${escape(s.reason)}`}</li>`).join('')}</ul>
  ${missing.length ? '<p class="label">누락 자료가 있어 전체 자료 검토가 완료된 초안이 아닙니다.</p>' : ''}</body></html>`;
}

// OOXML uses a ZIP container. STORE records need no compression dependency.
// CRC-32 and central-directory offsets are computed from UTF-8 bytes, not JS character counts.
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function zip(files) {
  const local = [], central = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const n = Buffer.from(name), data = Buffer.from(content), crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(0x21, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    local.push(h, n, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n); offset += h.length + n.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const NS = 'http://schemas.openxmlformats.org';
const drawing = `${NS}/drawingml/2006/main`, presentation = `${NS}/presentationml/2006/main`, rel = `${NS}/officeDocument/2006/relationships`;
const relationship = (items) => xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${rel}/${type}" Target="${target}"/>`).join('')}</Relationships>`);
const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
function box(id, name, lines, x, y, w, h, size, color = '18243A') {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="t"><a:normAutofit/></a:bodyPr><a:lstStyle/>${lines.map((line) => `<a:p><a:pPr><a:spcAft><a:spcPts val="1200"/></a:spcAft></a:pPr><a:r><a:rPr lang="ko-KR" sz="${size}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Noto Sans CJK KR"/><a:ea typeface="Noto Sans CJK KR"/></a:rPr><a:t xml:space="preserve">${escape(line)}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
}

/** Editable 16:9 PowerPoint. Real PPTX conversion to PDF is a separate required host step. */
export function presentationPptx(plan, snapshot) {
  requireThat(plan.slides.length > 0 && plan.slides.length <= 60, 'INVALID_PLAN', 'Slides required');
  const missing = snapshot.sources.filter((s) => s.status === 'missing');
  const appendix = [];
  const addPages = (title, lines) => {
    const chunks = lines.flatMap((line) => { const chars = Array.from(line); return Array.from({ length: Math.ceil(chars.length / 120) }, (_, i) => chars.slice(i * 120, (i + 1) * 120).join('')); });
    for (let i = 0; i < chunks.length; i += 5) appendix.push({ title, bullets: chunks.slice(i, i + 5), sourceIds: [] });
  };
  // Required review metadata is visible in the deck, never silently omitted.
  addPages('과제 요구사항 확인', plan.requirements.map((r) => r.text));
  addPages('직접 확인할 점', plan.openQuestions);
  addPages('누락 자료', missing.map((s) => `${s.title}: ${s.reason}`));
  addPages('검토 입력 자료', snapshot.sources.filter((s) => s.status === 'available').map((s) => `[S${snapshot.sources.indexOf(s) + 1}] ${s.title} (${s.id})`));
  const slides = [...plan.slides, ...appendix];
  const sourceLabels = new Map(snapshot.sources.map((s, i) => [s.id, `S${i + 1}`]));
  const contentTypes = [['/ppt/presentation.xml', 'presentationml.presentation.main+xml'], ['/ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster+xml'], ['/ppt/slideLayouts/slideLayout1.xml', 'presentationml.slideLayout+xml'], ...slides.map((_, i) => [`/ppt/slides/slide${i + 1}.xml`, 'presentationml.slide+xml'])];
  const files = {
    '[Content_Types].xml': xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${contentTypes.map(([p, type]) => `<Override PartName="${p}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`).join('')}</Types>`),
    '_rels/.rels': relationship([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': xml(`<p:presentation xmlns:p="${presentation}" xmlns:a="${drawing}" xmlns:r="${rel}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': relationship([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ...slides.map((_, i) => [`rId${i + 2}`, 'slide', `slides/slide${i + 1}.xml`])]),
    'ppt/slideMasters/slideMaster1.xml': xml(`<p:sldMaster xmlns:p="${presentation}" xmlns:a="${drawing}" xmlns:r="${rel}"><p:cSld><p:spTree>${group}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles/></p:sldMaster>`),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': relationship([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': xml(`<p:sldLayout xmlns:p="${presentation}" xmlns:a="${drawing}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': relationship([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
  };
  slides.forEach((s, i) => {
    // Long appendix entries wrap/autofit; no cropping or data truncation.
    files[`ppt/slides/slide${i + 1}.xml`] = xml(`<p:sld xmlns:p="${presentation}" xmlns:a="${drawing}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F6F8FC"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${group}${box(2, 'Title', [s.title], 600000, 400000, 10900000, 1000000, 3000)}${box(3, 'Content', s.bullets.map((b) => `• ${b}`), 650000, 1600000, 10900000, 4100000, 2200)}${box(4, 'Source', [`검토용 초안 · ${i + 1}/${slides.length}`, `근거: ${s.sourceIds.slice(0, 12).map((id) => sourceLabels.get(id)).join(', ')}${s.sourceIds.length > 12 ? ' 외 (plan.json 참조)' : ''}`], 650000, 6000000, 10900000, 600000, 1000, '526174')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = relationship([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]);
  });
  return zip(files);
}
