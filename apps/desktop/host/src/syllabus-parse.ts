import { inflateRawSync } from "node:zlib";
import type { SyllabusBlock, SyllabusDoc } from "@learningxxx/contracts";

/**
 * WBS-107: turns a syllabus (an HTML page, a .docx file or PDF page text)
 * into sections of generic blocks — label/value fields, tables, text —
 * without AI and without knowing any course. Highlights (instructor and
 * contact, grading, weekly plan, books) are then picked by label and column
 * names that syllabus forms commonly use, so an unknown form still shows its
 * full content, only with fewer highlights.
 */

type Section = { heading: string; blocks: SyllabusBlock[] };
/** One cell as written: text, whether it is a header cell, and its spans. */
export type RawCell = { text: string; th: boolean; colspan: number; rowspan: number };
/** Rows of one table; `group` numbers the thead/tbody/tfoot a row is in (a row span stops at its group's end). */
export type RawRow = RawCell[] & { group?: number };

const MAX_TEXT = 4_000;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", copy: "©", times: "×" };
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
    }
    return NAMED[code.toLowerCase()] ?? whole;
  });
}
/** Spaces collapsed inside each line; empty lines dropped. */
export const tidy = (text: string): string => text.split("\n").map((l) => l.replace(/[\s ​]+/g, " ").trim()).filter(Boolean).join("\n").slice(0, MAX_TEXT);
const flat = (text: string) => text.replace(/\s*\n\s*/g, " ").trim();
const span = (attrs: string, name: string) => {
  const m = new RegExp(`${name}\\s*=\\s*["']?(\\d{1,3})`, "i").exec(attrs);
  return Math.min(Math.max(m ? Number(m[1]) : 1, 1), 50);
};

// ---------- HTML ----------

/** Removes what is never content: comments, scripts, styles, the document head, form controls. */
function stripHtml(html: string): string {
  return html.slice(0, 2_000_000)
    .replace(/<!--[\s\S]*?(-->|$)/g, "").replace(/<![^>]*>|<\?[^>]*>/g, "")
    .replace(/<(script|style|head|noscript|template|svg|button|select|textarea)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(header|footer|nav)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (block) => /<h1\b/i.test(block) ? block.replace(/[\s\S]*?(<h1\b[\s\S]*?<\/h1\s*>)[\s\S]*/i, "$1") : "");
}

export function parseSyllabusHtml(html: string): SyllabusDoc {
  const source = stripHtml(html);
  const title = tidy(decodeEntities((/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(source)?.[1] ?? /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/<[^>]+>/g, " ")));
  const sections: Section[] = [{ heading: "", blocks: [] }];
  const current = () => sections[sections.length - 1]!;
  let text = "";
  const flushText = () => { const t = tidy(text); text = ""; if (t) current().blocks.push(...textBlocks(t)); };
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let at = 0;
  // Table state (nested tables are read as text of the outer cell).
  let rows: RawRow[] | undefined; let cell: RawCell | undefined; let depth = 0; let heading: string | undefined; let group = 0;
  for (let m = tagRe.exec(source); m; m = tagRe.exec(source)) {
    const chunk = decodeEntities(source.slice(at, m.index));
    at = tagRe.lastIndex;
    if (cell) cell.text += chunk; else if (heading !== undefined) heading += chunk; else if (!rows) text += chunk;
    const name = m[1]!.toLowerCase(); const closing = m[0][1] === "/";
    const breakLine = () => { if (cell) cell.text += "\n"; else if (heading !== undefined) heading += " "; else if (!rows) text += "\n"; };
    if (name === "table") {
      if (closing) { depth = Math.max(0, depth - 1); if (depth === 0 && rows) { if (cell) cell = undefined; current().blocks.push(...tableBlocks(rows)); rows = undefined; } }
      else if (++depth === 1) { flushText(); rows = []; } else breakLine();
      continue;
    }
    if (rows && depth === 1) {
      if (name === "thead" || name === "tbody" || name === "tfoot") { group++; cell = undefined; continue; }
      if (name === "tr" && !closing) { cell = undefined; rows.push(Object.assign([], { group })); continue; }
      if ((name === "td" || name === "th") && !closing) {
        if (!rows.length) rows.push(Object.assign([], { group }));
        cell = { text: "", th: name === "th", colspan: span(m[2]!, "colspan"), rowspan: span(m[2]!, "rowspan") };
        rows[rows.length - 1]!.push(cell); continue;
      }
      if ((name === "td" || name === "th" || name === "tr") && closing) { cell = undefined; continue; }
    }
    if (/^h[1-6]$/.test(name) && !rows) {
      if (!closing) { flushText(); heading = ""; }
      else if (heading !== undefined) {
        const h = tidy(heading); heading = undefined;
        if (h && h !== title) sections.push({ heading: h, blocks: [] });
      }
      continue;
    }
    if (["br", "p", "div", "li", "tr", "dd", "dt", "h1", "h2", "h3", "h4", "h5", "h6"].includes(name)) breakLine();
  }
  if (cell) cell.text += decodeEntities(source.slice(at)); else if (!rows) text += decodeEntities(source.slice(at).replace(/<[^>]*$/, ""));
  if (rows) current().blocks.push(...tableBlocks(rows));
  flushText();
  return finish(title, sections);
}

// ---------- tables ----------

const MARK = /^[○●◎OoVv✓✔√■☑]$/;
const PERCENT = /^\d{1,3}(\.\d+)?\s*%$/;

/**
 * Lays the cells on a grid (row and column spans) and reads the table:
 * a row with only header cells names the columns below it; a data row under
 * such names becomes a table row, or, when it only ticks columns (○ / %),
 * a field listing the ticked names; rows without column names become
 * label/value fields (header cell, then its value cells).
 */
export function tableBlocks(rawRows: readonly RawRow[]): SyllabusBlock[] {
  type Placed = { cell: RawCell; row: number; col: number };
  const grid: (Placed | undefined)[][] = [];
  rawRows.slice(0, 400).forEach((cells, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of cells) {
      while (grid[r]![c]) c++;
      const placed = { cell, row: r, col: c };
      for (let dr = 0; dr < cell.rowspan && r + dr < rawRows.length && (rawRows[r + dr]!.group ?? 0) === (cells.group ?? 0); dr++) for (let dc = 0; dc < cell.colspan && c + dc < 60; dc++) (grid[r + dr] ??= [])[c + dc] = placed;
      c += cell.colspan;
    }
  });
  const out: SyllabusBlock[] = [];
  const fields: { label: string; value: string }[] = [];
  let head: string[] | undefined; let table: string[][] = []; let tableHead: string[] = [];
  const addField = (label: string, value: string) => {
    if (!value) return;
    const same = fields.find((f) => f.label === label);
    if (!same) { fields.push({ label, value }); return; }
    if (same.value.split(/\n| · /).includes(value)) return;
    same.value += !same.value.includes("\n") && !value.includes("\n") && value.length < 40 ? ` · ${value}` : `\n${value}`;
  };
  const flushTable = () => {
    if (table.length) {
      const keep = tableHead.map((_, j) => table.some((row) => row[j]));
      const rows = table.map((row) => row.filter((_, j) => keep[j]));
      const names = tableHead.filter((_, j) => keep[j]);
      if (names.length) out.push({ type: "table", head: names, rows });
    }
    table = [];
  };
  const flushFields = () => { if (fields.length) out.push({ type: "fields", fields: fields.splice(0) }); };
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const placed = [...new Set(row.filter((p): p is Placed => !!p))];
    const own = placed.filter((p) => p.row === r);
    if (!own.length) continue;
    const text = (p: Placed) => tidy(p.cell.text);
    if (!placed.some((p) => !p.cell.th)) {
      // Header row: names for the columns below it (spanned rows from above are row labels, not names).
      const names = row.map((p, j) => p && p.row === r && p.col === j ? flat(text(p)) : "");
      if (names.filter(Boolean).length >= 2) { flushTable(); head = names; tableHead = names.filter((_, j) => names[j]); continue; }
      const only = own.map(text).filter(Boolean).join(" ");
      if (only) { flushTable(); flushFields(); out.push({ type: "text", text: only }); }
      continue;
    }
    if (head) {
      const labelParts: string[] = []; const values: { col: number; value: string }[] = []; let wide: string | undefined;
      for (const p of placed.toSorted((a, b) => a.col - b.col)) {
        const value = text(p);
        const columns = head.slice(p.col, p.col + p.cell.colspan).filter(Boolean).length;
        if (p.cell.th && (p.row !== r || p.cell.rowspan > 1 || !head[p.col])) { if (value) labelParts.push(flat(value)); continue; }
        if (!p.cell.th && columns >= 2 && columns >= head.filter(Boolean).length / 2) { wide = value; continue; }
        if (p.row === r) values.push({ col: p.col, value });
      }
      const label = labelParts.join(" ");
      if (wide !== undefined) { addField(label, wide); continue; }
      const filled = values.filter((v) => v.value);
      if (!filled.length) continue;
      if (filled.every((v) => MARK.test(v.value) || PERCENT.test(v.value))) {
        const ticked = filled.filter((v) => MARK.test(v.value) || parseFloat(v.value) > 0).map((v) => MARK.test(v.value) ? head![v.col]! : `${head![v.col]} ${v.value}`).filter(Boolean);
        for (const t of ticked) addField(label, flat(t));
        continue;
      }
      table.push(tableHead.map((name) => values.find((v) => head![v.col] === name)?.value ?? ""));
      continue;
    }
    let label = "";
    for (let j = 0; j < row.length; j++) {
      const p = row[j];
      if (!p || p.col !== j) continue;
      if (p.cell.th) { label = flat(text(p)); continue; }
      if (p.row === r) addField(label, text(p));
    }
  }
  flushTable(); flushFields();
  // A table of two columns where the first are labels reads better as fields.
  return out.map((b) => b.type === "table" && b.head.length === 2 && b.rows.every((row) => (row[0] ?? "").length <= 30) && b.rows.length <= 30 && !b.head.some((h) => /비율|배점|%/.test(h))
    ? { type: "fields" as const, fields: [{ label: b.head[0]!, value: b.head[1]! }, ...b.rows.map((row) => ({ label: row[0] ?? "", value: row[1] ?? "" }))].filter((f) => f.value) }
    : b);
}

/** Lines "항목 : 내용" become fields; other lines stay text. */
export function textBlocks(text: string): SyllabusBlock[] {
  const out: SyllabusBlock[] = [];
  for (const line of text.split("\n")) {
    const m = /^([^:：\n]{1,20}?)\s*[:：]\s*(\S.*)$/.exec(line);
    const last = out[out.length - 1];
    if (m && !/^https?$/i.test(m[1]!.trim())) {
      const field = { label: m[1]!.trim(), value: m[2]!.trim() };
      if (last?.type === "fields") last.fields.push(field); else out.push({ type: "fields", fields: [field] });
    } else if (last?.type === "text") last.text += `\n${line}`;
    else out.push({ type: "text", text: line });
  }
  return out;
}

// ---------- highlights ----------

const FACT = /교강사|교수|담당|강사|instructor|professor|연락처|전화|휴대|e-?mail|이메일|사무실|연구실|office|강의\s*시간|수업\s*시간|강의실|장소|room|면담|상담|학점|credit|이수\s*구분|학수\s*번호|홈페이지|수업\s*방법|수업\s*운영/i;
const HIDDEN = /로그인\s*하세요|로그인\s*후|login/i;
const squash = (s: string) => s.replace(/\s+/g, "");

function finish(title: string, raw: Section[]): SyllabusDoc {
  const sections = raw.filter((s) => s.blocks.length).map((s) => ({ heading: s.heading || (raw.length > 1 ? "기본" : "내용"), blocks: s.blocks }));
  const facts: SyllabusDoc["facts"] = [];
  const grading: SyllabusDoc["grading"] = [];
  const weeks: SyllabusDoc["weeks"] = [];
  const books: string[] = [];
  for (const section of sections) for (const block of section.blocks) {
    if (block.type === "fields") {
      for (const f of block.fields) if (FACT.test(squash(f.label)) && facts.length < 16 && !facts.some((x) => x.label === f.label)) facts.push(HIDDEN.test(f.value) && f.value.length < 40 ? { label: f.label, value: "학교 로그인 후 공개", hidden: true } : { label: f.label, value: f.value });
      continue;
    }
    if (block.type === "text") { weeks.push(...weekLines(block.text)); continue; }
    const head = block.head.map(squash);
    const share = head.findIndex((h) => /비율|배점|비중|점수|%|weight|percent|point/i.test(h));
    const topic = head.findIndex((h) => /주제|내용|topic|content/i.test(h));
    const bookTitle = head.findIndex((h) => /서명|교재명|도서명|^title$|book/i.test(h));
    if (share > 0 && !grading.length) {
      for (const row of block.rows) {
        const item = flat(row[0] ?? ""); const value = flat(row[share] ?? "");
        if (!item || !value || /^(총|합계|계|total)/i.test(squash(item))) continue;
        const weight = /(\d{1,3}(?:\.\d+)?)/.exec(value);
        if (weight && Number(weight[1]) === 0 && !row.some((c, j) => j !== 0 && j !== share && c)) continue;
        const note = row.filter((c, j) => j !== 0 && j !== share && c).map(flat).join(" · ");
        grading.push({ item, share: value, weight: weight ? Number(weight[1]) : null, ...(note ? { note } : {}) });
      }
    } else if (topic >= 0 && !weeks.length) {
      const date = head.findIndex((h) => /날짜|일자|기간|일시|date/i.test(h));
      for (const row of block.rows) {
        const t = row[topic] ?? ""; if (!t) continue;
        const note = row.filter((c, j) => j !== 0 && j !== topic && j !== date && c).join(" · ");
        weeks.push({ label: flat(topic === 0 ? "" : row[0] ?? ""), ...(date >= 0 && date !== topic && row[date] ? { date: flat(row[date]!) } : {}), topic: t, ...(note ? { note } : {}) });
      }
    } else if (bookTitle >= 0) {
      for (const row of block.rows) if (row[bookTitle]) books.push(row.filter(Boolean).map(flat).join(" · "));
    }
  }
  for (const f of sections.flatMap((s) => s.blocks).flatMap((b) => b.type === "fields" ? b.fields : [])) {
    if (/교재|textbook/i.test(squash(f.label)) && !books.length) books.push(flat(f.value));
  }
  return { title, sections, facts, grading, weeks: weeks.slice(0, 40), books: books.slice(0, 20) };
}

/** "1주 9/7 수업 소개" / "Week 2: …" lines of a text plan. */
function weekLines(text: string): SyllabusDoc["weeks"] {
  const out: SyllabusDoc["weeks"] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*((?:제\s*)?\d{1,2}\s*(?:주차|주|차시|회차)|week\s*\d{1,2})\s*[.:)]?\s*((?:\d{1,2}\s*[/.월]\s*\d{1,2}\s*일?)(?:\s*[~-]\s*\d{1,2}\s*[/.월]\s*\d{1,2}\s*일?)?)?\s*(.*)$/i.exec(line);
    if (m) out.push({ label: flat(m[1]!), ...(m[2] ? { date: m[2].replace(/\s+/g, "") } : {}), topic: m[3]!.trim() || "-" });
    else if (out.length && line.trim()) { const last = out[out.length - 1]!; if ((last.note?.length ?? 0) < 400) last.note = last.note ? `${last.note}\n${line.trim()}` : line.trim(); }
  }
  return out.length >= 3 ? out : [];
}

// ---------- docx ----------

const MAX_ENTRY = 8 * 1024 * 1024;

/** Reads one stored or deflated entry of a ZIP file (enough for .docx). */
export function zipEntry(bytes: Uint8Array, name: string): Uint8Array | undefined {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return undefined;
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && at + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) return undefined;
    const method = buf.readUInt16LE(at + 10); const size = buf.readUInt32LE(at + 20); const full = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28); const extra = buf.readUInt16LE(at + 30); const comment = buf.readUInt16LE(at + 32); const local = buf.readUInt32LE(at + 42);
    if (buf.toString("utf8", at + 46, at + 46 + nameLen) === name) {
      if (full > MAX_ENTRY || local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return undefined;
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      try { return method === 0 ? new Uint8Array(data) : method === 8 ? new Uint8Array(inflateRawSync(data, { maxOutputLength: MAX_ENTRY })) : undefined; } catch { return undefined; }
    }
    at += 46 + nameLen + extra + comment;
  }
  return undefined;
}

const xmlText = (xml: string) => decodeEntities(xml.replace(/<w:tab\/>/g, " ").replace(/<w:(br|cr)\b[^>]*\/>/g, "\n").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, ""));

/** A Word file: headings start sections, paragraphs are text (or "항목 : 내용" fields), tables are read like HTML tables. */
export function parseDocx(bytes: Uint8Array, fallbackTitle: string): SyllabusDoc | undefined {
  const entry = zipEntry(bytes, "word/document.xml");
  if (!entry) return undefined;
  const xml = Buffer.from(entry).toString("utf8");
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const sections: Section[] = [{ heading: "", blocks: [] }];
  let text = "";
  const flushText = () => { const t = tidy(text); text = ""; if (t) sections[sections.length - 1]!.blocks.push(...textBlocks(t)); };
  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g)) {
    const part = m[0];
    if (part.startsWith("<w:tbl>")) {
      flushText();
      sections[sections.length - 1]!.blocks.push(...tableBlocks(docxRows(part)));
      continue;
    }
    const style = /<w:pStyle w:val="([^"]+)"/.exec(part)?.[1] ?? "";
    const line = tidy(xmlText(part));
    if (/^(heading|title|제목)\s*\d?$/i.test(style) && line && line.length <= 60) { flushText(); sections.push({ heading: flat(line), blocks: [] }); continue; }
    text += `${line}\n`;
  }
  flushText();
  return finish(fallbackTitle, sections);
}

/** Rows of a Word table; the first row names the columns when the table is wider than two columns. */
function docxRows(tbl: string): RawRow[] {
  const rows = [...tbl.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((r) => [...r[0].matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((c) => {
    const props = /<w:tcPr>([\s\S]*?)<\/w:tcPr>/.exec(c[1]!)?.[1] ?? "";
    const merge = /<w:vMerge(?: w:val="(\w+)")?\s*\/>/.exec(props);
    return { text: tidy(xmlText(c[1]!)), colspan: Math.min(Number(/<w:gridSpan w:val="(\d+)"/.exec(props)?.[1] ?? 1), 50), merge: merge ? (merge[1] === "restart" ? "start" : "continue") : undefined };
  }));
  const width = Math.max(0, ...rows.map((r) => r.reduce((n, c) => n + c.colspan, 0)));
  // Vertical merges: a "continue" cell belongs to the cell above that started the merge.
  const out: RawRow[] = []; const open = new Map<number, RawCell>();
  rows.forEach((cells, r) => {
    const row: RawCell[] = []; let col = 0;
    for (const c of cells) {
      if (c.merge === "continue" && open.has(col)) { open.get(col)!.rowspan++; col += c.colspan; continue; }
      const cell: RawCell = { text: c.text, th: (r === 0 && width > 2) || (width === 2 && col === 0), colspan: c.colspan, rowspan: 1 };
      if (c.merge === "start") open.set(col, cell); else open.delete(col);
      row.push(cell); col += c.colspan;
    }
    out.push(row);
  });
  return out;
}

/** PDF page text: lines, with "항목 : 내용" read as fields. */
export function parsePdfText(pages: readonly string[], fallbackTitle: string): SyllabusDoc | undefined {
  const text = tidy(pages.slice(0, 20).join("\n"));
  return text ? finish(fallbackTitle, [{ heading: "", blocks: textBlocks(text) }]) : undefined;
}

/** Plain text of a parsed syllabus, for course.md and the course chat. */
export function syllabusText(doc: SyllabusDoc): string {
  const lines = [doc.title ? `# ${doc.title}` : ""];
  for (const s of doc.sections) {
    lines.push(`## ${s.heading}`);
    for (const b of s.blocks) {
      if (b.type === "text") lines.push(b.text);
      else if (b.type === "fields") lines.push(...b.fields.map((f) => `- ${f.label}: ${f.value.replace(/\n/g, " / ")}`));
      else lines.push(`| ${b.head.join(" | ")} |`, ...b.rows.map((r) => `| ${r.map((c) => c.replace(/\n/g, " / ")).join(" | ")} |`));
    }
  }
  return lines.filter(Boolean).join("\n");
}

// ---------- class times ----------

type Meeting = { day: "월" | "화" | "수" | "목" | "금" | "토" | "일"; start: string; end: string; place?: string };
const TIME_LABEL = /강의\s*시간|수업\s*시간|강의\s*일시|수업\s*일시|class\s*time|schedule/i;
const ROOM_LABEL = /강의실|장소|room|location/i;
const clock = (h: string, m: string) => `${h.padStart(2, "0")}:${m}`;

/**
 * WBS-107: weekly class times from a syllabus's time/room field, e.g.
 * "홍길동 월18:00-19:00 전220, 홍길동 수18:00-19:00 전220" or
 * "월요일 9:00 – 11:45분" with the room in its own field. Only explicit
 * day + start–end times are taken; "온라인" or period numbers give none.
 */
export function syllabusMeetings(doc: SyllabusDoc): Meeting[] {
  const fields = [...doc.facts, ...doc.sections.flatMap((s) => s.blocks).flatMap((b) => b.type === "fields" ? b.fields : [])];
  const timeField = fields.find((f) => TIME_LABEL.test(f.label));
  if (!timeField) return [];
  const roomField = fields.find((f) => ROOM_LABEL.test(f.label) && !TIME_LABEL.test(f.label));
  const room = roomField ? cleanPlace(roomField.value) : undefined;
  const out: Meeting[] = [];
  const re = /([월화수목금토일](?:\s*요일)?(?:\s*[,·/및]\s*[월화수목금토일](?:\s*요일)?)*)\s*\(?\s*(\d{1,2})\s*[:시]\s*(\d{2})\s*분?\s*(?:[-–—~]|부터)\s*(\d{1,2})\s*[:시]\s*(\d{2})\s*분?\)?\s*(?:까지)?([^,\n]*)/g;
  for (const m of timeField.value.matchAll(re)) {
    const start = clock(m[2]!, m[3]!); const end = clock(m[4]!, m[5]!);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || start >= end) continue;
    // The text after the time up to the next day+time (or comma) is the room; a following instructor's name is not.
    const after = cleanPlace(m[6]!.replace(/\s+\S+\s+[월화수목금토일]\s*\d.*$/, ""));
    const place = after || room;
    for (const day of m[1]!.replace(/요일/g, "").match(/[월화수목금토일]/g) as Meeting["day"][]) {
      if (out.some((x) => x.day === day && x.start === start && x.end === end)) continue;
      out.push({ day, start, end, ...(place ? { place } : {}) });
    }
  }
  return out.slice(0, 20);
}

function cleanPlace(text: string): string | undefined {
  const place = text.replace(/[()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return place && !/^(온라인|online|비대면|미정|tba|-)$/i.test(place) ? place : undefined;
}
