/** Explicit macOS/Electron integration check. Synthetic content only; no model or LMS. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import { printAssignment } from '../src/assignment-printer.ts';
import { pdfPageTexts } from '../src/pdf-text.ts';

const dir = resolve(process.argv[2] ?? '/private/tmp/assignment-print-smoke');
// Keep Electron alive while pdf.js validates after the hidden print window closes.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  let requests = 0;
  const server = createServer((_req, response) => { requests++; response.end('must never be requested'); });
  try {
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><style>
      @page{size:A4;margin:20mm}body{font:14pt 'Apple SD Gothic Neo',sans-serif;color:#172033}
      svg{display:block;width:100%}h1{font-size:25pt}p{line-height:1.7}
      </style><h1>합성 과제 출력 검사</h1><p>한글과 숫자 123, 관계 및 카디널리티를 확인합니다.</p>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 220"><line x1="200" y1="100" x2="500" y2="100" stroke="#172033" stroke-width="2"/><text x="315" y="80">1 : N</text><rect x="20" y="40" width="200" height="120" fill="#f2f6fc" stroke="#172033"/><text x="80" y="100">합성 회사</text><rect x="480" y="40" width="200" height="120" fill="#fff8df" stroke="#172033"/><text x="535" y="100">합성 부서</text></svg>
      <p>외부 자원과 스크립트는 실행되지 않아야 합니다.</p>
      <img src="http://127.0.0.1:${port}/private-canary"><script>document.body.textContent='SCRIPT_EXECUTED_CANARY'</script></html>`;
    const pdf = await printAssignment(html, new AbortController().signal);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'synthetic.pdf'), pdf);
    const pages = await pdfPageTexts(new Uint8Array(pdf));
    assert.equal(pages.length, 1);
    assert.match(pages.join('\n'), /합성 과제 출력 검사/);
    assert.match(pages.join('\n'), /합성 회사/);
    assert.doesNotMatch(pages.join('\n'), /SCRIPT_EXECUTED_CANARY/);
    assert.equal(requests, 0);
    writeFileSync(join(dir, 'report.json'), JSON.stringify({ pages: pages.length, korean: true, svgText: true, remoteRequests: requests, scriptExecuted: false }));
    console.log('PASS: one-page Korean/SVG PDF, no remote request or script execution');
  } finally { server.close(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
