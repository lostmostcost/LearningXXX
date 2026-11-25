/** End-to-end public CLI regression: no selectors, injected JS, raw host calls or mouse coordinates. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const output = mkdtempSync(join(tmpdir(), 'learningxxx-agent-smoke-'));
const mode = process.argv.includes('--local') ? 'local' : 'fixture';
const flow = process.argv.includes('--assist') ? 'assist' : 'debug';
const child = spawn(process.execPath, [fileURLToPath(new URL('./app-control.mjs', import.meta.url)), '--mode', mode, '--flow', flow, '--out', output, '--profile', join(output, 'profile')], { stdio: ['pipe', 'pipe', 'inherit'] });
const reader = createInterface({ input: child.stdout });
let pending, snapshot;
const messages = [], buffered = [], checks = [];
const receive = () => new Promise((resolve, reject) => {
  if (buffered.length) return resolve(buffered.shift());
  const timer = setTimeout(() => { pending = undefined; reject(new Error('CLI response timeout')); }, 20_000);
  pending = message => { clearTimeout(timer); pending = undefined; resolve(message); };
});
reader.on('line', line => {
  const message = JSON.parse(line); messages.push(message);
  if (pending) pending(message); else buffered.push(message);
});
const exit = new Promise(resolve => child.once('close', code => resolve(code)));
const command = async (value, expected = true) => {
  child.stdin.write(JSON.stringify(value) + '\n');
  const result = await receive();
  assert.equal(result.ok, expected, JSON.stringify(result));
  if (result.snapshot) snapshot = result.snapshot;
  return result;
};
const find = (name, context) => {
  const values = snapshot.controls.filter(c => (typeof name === 'string' ? c.name === name : name.test(c.name)) && (!context || c.context === context));
  assert.equal(values.length, 1, `Expected one ${name}; got ${values.length}. Controls: ${snapshot.controls.map(c => c.name).join(', ')}`);
  return values[0];
};
const click = async (name, context) => {
  // Observe after asynchronous PDF/polling updates, then choose the visible control.
  // A rejected action still fails the run; this helper never replays it.
  await command({ op: 'snapshot' });
  return command({ op: 'click', target: find(name, context).id });
};
const scrollMedia = async dy => {
  await command({ op: 'snapshot' });
  const panel = snapshot.controls.find(c => c.role === 'section' && c.name === '녹음·전사');
  assert(panel, 'The visible media screen is the scroll target');
  await command({ op: 'scroll', target: panel.id, dy });
};
const until = async (predicate) => {
  for (let i = 0; i < 30; i++) { if (predicate(snapshot)) return; await command({ op: 'wait', ms: 100 }); }
  throw new Error('Expected UI state did not arrive: ' + snapshot.text);
};
try {
  const ready = await receive(); assert.equal(ready.ready, true); assert.equal(ready.mode, mode); assert.equal(ready.flow, flow); snapshot = ready.snapshot;
  await command({ op: 'eval', code: 'window.host.invoke' }, false);
  checks.push('Arbitrary script rejected');
  await command({ op: 'snapshot' });
  const obsolete = snapshot.controls[0].id;
  await command({ op: 'snapshot' });
  const stale = await command({ op: 'click', target: obsolete }, false); assert.match(stale.error, /STALE_TARGET/);
  checks.push('Old snapshot target rejected');
  await command({ op: 'snapshot' });
  if (flow === 'debug') {
    const shortcut = await command({ op: 'navigate', section: 'home' }, false); assert.match(shortcut.error, /ASSIST_ONLY/);
    checks.push('Debug refuses navigation shortcuts');
    await command({ op: 'snapshot' });
  }
  if (mode === 'fixture') {
    if (flow === 'assist') {
      const catalog = (await command({ op: 'catalog' })).navigation;
      const unavailable = await command({ op: 'navigate', courseId: '00000000-0000-4000-8000-000000000000' }, false);
      assert.match(unavailable.error, /NAVIGATION_UNAVAILABLE/);
      await command({ op: 'snapshot' });
      const resource = catalog.resources.find(r => r.title.startsWith('불 대수'));
      const result = await command({ op: 'navigate', courseId: catalog.courses[0].id, resourceId: resource.id, tab: 'memo' });
      assert.equal(result.shortcutsUsed, 2, 'failed navigation attempts remain marked too');
      assert(snapshot.text.includes('불 대수 기초')); assert(snapshot.controls.some(c => c.name === '메모 닫기'));
      const evidence = await command({ op: 'render', name: 'assist-navigation' }); assert.equal(evidence.evidence.flow, 'assist'); assert.equal(evidence.evidence.shortcutsUsed, 2);
      await command({ op: 'navigate', tab: 'chat' });
      await command({ op: 'navigate', section: 'home' });
      checks.push('Assist opens course/material/tool without menu steps and labels shortcut evidence');
    }
    assert(!snapshot.controls.some(c => c.context === '과목 선택'));
    await click('과목 선택 열기');
    await until(s => s.controls.some(c => c.context === '과목 선택' && c.name.startsWith('합성 과목')));
    await click('합성 과목 (디지털 논리 예제)', '과목 선택');
    await command({ op: 'wait', ms: 300 });
    assert(!snapshot.controls.some(c => c.context === '과목 선택'));
    checks.push('Closed drawer unavailable; course opened through drawer');
    await click(/주차 ⌄$/);
    await until(s => s.controls.some(c => c.name === '1주차'));
    await click('1주차');
    await until(s => s.controls.some(c => c.name.startsWith('동영상 강의 합성 1차시')));
    assert(!snapshot.controls.some(c => /녹음본|합성.*녹음|주차를 확인할 녹음/.test(c.name)));
    await click('기타 자료');
    assert(!snapshot.controls.some(c => /녹음본|합성.*녹음|주차를 확인할 녹음/.test(c.name)));
    await click('1주차');
    checks.push('Materials week and other-material menus contain no saved recordings; PDFs and online lectures remain');
    await click(/^불 대수 기초 \(텍스트 PDF\)/);
    await until(s => !s.text.includes('LMS 열람 기록 중') && s.controls.some(c => c.selectableText && c.ready));
    assert.equal(find('이전 쪽').disabled, true);
    const disabled = await command({ op: 'click', target: find('이전 쪽').id }, false); assert.match(disabled.error, /DISABLED/);
    await command({ op: 'snapshot' });
    await until(s => s.controls.some(c => c.selectableText && c.ready));
    const layer = snapshot.controls.find(c => c.selectableText);
    const phrase = layer.selectableText.trim().slice(0, 15);
    await command({ op: 'selectText', target: layer.id, text: phrase });
    assert.equal(find('쉽게 설명').disabled, false);
    checks.push('Real pdf.js text selected; disabled page boundary respected');
    await click('다음 쪽');
    await until(s => s.controls.some(c => c.selectableText && c.ready && c.page === '2'));
    if (snapshot.controls.some(c => c.name === '메모 닫기')) await click('메모 닫기');
    if (snapshot.controls.some(c => c.name === '채팅 열기')) await click('채팅 열기');
    await click('대화 시작');
    await until(s => s.controls.some(c => c.name === 'Claude에게 메시지' && !c.disabled));
    assert.equal(find('메시지 전송').disabled, true);
    await command({ op: 'fill', target: find('Claude에게 메시지').id, text: '진리표를 설명해 주세요 · CLI 합성 검증' });
    assert.equal(find('메시지 전송').disabled, false);
    await click('메시지 전송');
    await click('채팅 닫기');
    await click('대시보드');
    await command({ op: 'wait', ms: 200 });
    await click('채팅 열기');
    await until(s => s.text.includes('실제 Claude 응답이 아닙니다'));
    checks.push('Conversation created, React input updated; response retained across close and Home navigation');
    await click('강의 자료');
    await until(s => s.controls.some(c => c.selectableText && c.ready && c.page === '2'));
    checks.push('Home navigation retains the hidden PDF viewer and current page');
    const rendered = await command({ op: 'render', name: 'pdf-chat' });
    assert.equal(rendered.evidence.flow, flow);
    if (flow === 'debug') { assert.equal(rendered.evidence.shortcutsUsed, 0); assert.equal(rendered.evidence.evidenceUse, 'user-journey-verification'); }
    const png = readFileSync(join(output, 'pdf-chat.png')); assert(png.length > 10_000);
    assert.match(readFileSync(join(output, 'pdf-chat.json'), 'utf8'), /"mode": "fixture"/);
    if (process.argv.includes('--layout')) {
      await command({ op: 'fill', target: find('Claude에게 메시지').id, text: '닫아도 유지할 채팅 초안' });
      await click('채팅 닫기');
      assert(!snapshot.controls.some(c => c.name === 'Claude에게 메시지'));
      for (const [name, label] of [['대시보드','대시보드'], ['강의 정보','강의 정보'], ['과제','과제'], ['공지','공지'], ['녹음·전사','녹음·전사'], ['강의 자료','강의 자료']]) {
        await click(name);
        await click('채팅 열기');
        assert.equal(find('Claude에게 메시지').value, '닫아도 유지할 채팅 초안');
        assert(snapshot.text.replace(/\s+/g, ' ').includes(`현재 화면 · ${label}`), snapshot.text);
        await click('채팅 닫기');
      }
      checks.push('Global chat on all six screens; draft and conversation retained; screen context follows navigation');
      await click('메모 열기');
      await until(s => s.controls.some(c => c.name === '메모' && !c.disabled));
      await command({ op: 'fill', target: find('메모').id, text: '레이아웃 검증 메모 · 주차별 자동 저장' });
      await until(s => s.text.includes('저장됨'));
      await click('1주차 변경');
      const otherWeek = find('메모 주차').options.find(o => o.value && o.name !== '1주차');
      assert(otherWeek);
      await command({ op: 'select', target: find('메모 주차').id, value: otherWeek.value });
      await until(s => s.controls.some(c => c.name === '메모' && !c.disabled && c.value === ''));
      await command({ op: 'fill', target: find('메모').id, text: '다른 주차의 별도 메모' });
      await click(`${otherWeek.name} 변경`);
      const firstWeek = find('메모 주차').options.find(o => o.name === '1주차');
      await command({ op: 'select', target: find('메모 주차').id, value: firstWeek.value });
      await until(s => s.controls.some(c => c.name === '메모' && !c.disabled && c.value === '레이아웃 검증 메모 · 주차별 자동 저장'));
      await click('채팅 열기');
      assert(snapshot.controls.some(c => c.name === '메모'));
      assert.equal(find('Claude에게 메시지').value, '닫아도 유지할 채팅 초안');
      await command({ op: 'focus', target: find('학습 도구 너비 조절').id });
      await command({ op: 'key', key: 'Left' });
      await command({ op: 'render', name: 'layout-both-tools' });
      await click('채팅 패널 닫기');
      assert(snapshot.controls.some(c => c.name === '메모'));
      await click('메모 패널 닫기');
      await click('녹음·전사');
      await until(s => s.controls.some(c => c.name === '녹음·전사 원본 선택' && c.options?.length > 1));
      assert(snapshot.controls.some(c => c.name === '녹음 시작'));
      const first = find('녹음·전사 주차').options.find(o => o.name.startsWith('1주차 ('));
      const second = find('녹음·전사 주차').options.find(o => o.name.startsWith('2주차 ('));
      const empty = find('녹음·전사 주차').options.find(o => o.name.startsWith('3주차 ('));
      assert(first && second && empty);
      await command({ op: 'select', target: find('녹음·전사 주차').id, value: first.value });
      assert(find('녹음·전사 원본 선택').options.filter(o => o.value).every(o => o.name.startsWith('1주차 ·')));
      const firstSource = find('녹음·전사 원본 선택').options.find(o => o.name.includes('합성 1주차 녹음'));
      assert(firstSource);
      await command({ op: 'select', target: find('녹음·전사 원본 선택').id, value: firstSource.value });
      await until(s => s.text.includes('1주차 녹음의 전사 예제입니다.'));
      await command({ op: 'select', target: find('녹음·전사 주차').id, value: second.value });
      assert.equal(find('녹음·전사 원본 선택').value, '');
      assert(!snapshot.text.includes('1주차 녹음의 전사 예제입니다.'));
      const secondSource = find('녹음·전사 원본 선택').options.find(o => /합성 2주차.*녹음/.test(o.name));
      assert(secondSource);
      await command({ op: 'select', target: find('녹음·전사 원본 선택').id, value: secondSource.value });
      await until(s => s.text.includes('2주차 (보강) 녹음의 전사 예제입니다.'));
      await command({ op: 'render', name: 'media-week-2' });
      await command({ op: 'select', target: find('녹음·전사 주차').id, value: empty.value });
      assert.equal(find('녹음·전사 원본 선택').options.length, 1);
      assert(snapshot.text.includes('저장한 원본이 없습니다'));
      assert(!snapshot.text.includes('2주차 (보강) 녹음의 전사 예제입니다.'));
      await command({ op: 'select', target: find('녹음·전사 주차').id, value: 'unfiled' });
      const original = find('녹음·전사 원본 선택').options.find(o => o.name.includes('합성 강의 녹음'));
      assert(original, 'An unfiled original remains available');
      await command({ op: 'select', target: find('녹음·전사 원본 선택').id, value: original.value });
      await scrollMedia(350);
      await until(s => s.text.includes('논리 회로의 입력과 출력을 살펴봅니다.'));
      await scrollMedia(-350);
      await command({ op: 'select', target: find('이 녹음 주차').id, value: first.value });
      await click('이 주차로 옮기기');
      await until(s => s.controls.some(c => c.name === '녹음·전사 주차' && c.value === first.value));
      assert.equal(find('녹음·전사 원본 선택').value, original.value);
      await scrollMedia(350);
      assert(snapshot.text.includes('논리 회로의 입력과 출력을 살펴봅니다.'));
      await click('전사 도구 · 수정·번역·정리');
      await click('Claude Code(구독)로 읽기 쉬운 정리본 만들기');
      await until(s => s.text.includes('정리본을 만들었습니다.'));
      await click('앱 정리본(Claude)');
      await until(s => s.text.includes('합성 UI 예제 문서입니다.'));
      await command({ op: 'render', name: 'readable-note-created' });
      await click('앱 정리본(Claude)');
      await click('전사 도구 · 수정·번역·정리');
      checks.push('Visible transcript tools generate and open a readable note through the same public UI flow');
      await scrollMedia(-350);
      checks.push('Media week filters, empty and unfiled weeks, transcript reset and reassignment follow the selected original');
      await command({ op: 'render', name: 'layout-media' });
      await click('메모 열기');
      assert.equal(find('메모').value, '레이아웃 검증 메모 · 주차별 자동 저장');
      assert.equal(find('쪽 추가').disabled, true, 'Media must not expose the previous PDF page');
      await click('메모 닫기');
      checks.push('Independent memo toggles, autosave, week separation, retained text; combined recording/transcript page and original selection');
      if (flow === 'assist') {
        await command({ op: 'navigate', section: 'home' });
        await command({ op: 'navigate', tab: 'chat' });
        assert(snapshot.text.replace(/\s+/g, ' ').includes('현재 화면 · 대시보드'));
        await command({ op: 'navigate', section: 'media', tab: 'chat' });
        assert(snapshot.text.replace(/\s+/g, ' ').includes('현재 화면 · 녹음·전사'));
        await click('채팅 닫기');
        checks.push('Assist supports the new media screen without bypassing sends or native permission');
      }
      await click('강의 자료');
      await click('채팅 열기');
    }
    await command({ op: 'resize', width: 700, height: 600 });
    await click('채팅 닫기');
    assert(!snapshot.controls.some(c => c.name === 'Claude에게 메시지'));
    await until(s => s.controls.some(c => c.selectableText && c.ready));
    await click('채팅 열기');
    assert(snapshot.controls.some(c => c.name === 'Claude에게 메시지'));
    await command({ op: 'key', key: 'F6' });
    await command({ op: 'render', name: 'narrow-chat' });
    checks.push('Narrow global tool toggle restores material; F6; background PNG with metadata');
    if (process.argv.includes('--layout')) {
      await click('채팅 닫기');
      await click('녹음·전사');
      assert(snapshot.controls.some(c => c.name === '녹음 시작'));
      await command({ op: 'render', name: 'layout-narrow-media' });
      await scrollMedia(500);
      await until(s => s.controls.some(c => c.name === '녹음·전사 주차'));
      const narrowWeek = find('녹음·전사 주차').options.find(o => o.name.startsWith('2주차 ('));
      await command({ op: 'select', target: find('녹음·전사 주차').id, value: narrowWeek.value });
      const narrowSource = find('녹음·전사 원본 선택').options.find(o => /합성 2주차.*녹음/.test(o.name));
      await command({ op: 'select', target: find('녹음·전사 원본 선택').id, value: narrowSource.value });
      await command({ op: 'render', name: 'media-narrow-week-picker' });
      await scrollMedia(350);
      await until(s => s.text.includes('2주차 (보강) 녹음의 전사 예제입니다.'));
      checks.push('Narrow media page uses a single scrollable column; week/source selectors and transcript remain reachable');
    }
  } else {
    assert(!snapshot.text.includes('합성 데이터'));
    assert(snapshot.text.includes('NATIVE_REQUIRED'));
    await click('채팅 열기');
    assert(snapshot.text.replace(/\s+/g, ' ').includes('현재 화면 · 대시보드'));
    await click('채팅 닫기');
    if (flow === 'assist') {
      await command({ op: 'navigate', section: 'media', tab: 'chat' });
      assert(snapshot.text.includes('과목을 선택한 뒤 녹음·전사를 확인하세요.'));
      await click('채팅 닫기');
      await command({ op: 'navigate', section: 'home' });
      await command({ op: 'navigate', tab: 'chat' });
      assert(snapshot.text.replace(/\s+/g, ' ').includes('현재 화면 · 대시보드'));
      await click('채팅 닫기');
      checks.push('Global tools and assist navigation work without a selected course; tool-only intent preserves Home');
    }
    await click('설정');
    assert(!snapshot.controls.some(c => c.name === '대시보드'));
    await click(/^학교 로그인/);
    await until(s => s.controls.some(c => c.name === '화면 테마'));
    await command({ op: 'select', target: find('화면 테마').id, value: 'dark' });
    assert.equal(find('화면 테마').value, 'dark');
    await command({ op: 'render', name: 'local-settings' });
    checks.push('Real preload/router/preferences in fresh private profile; theme changed through settings');
  }
  await command({ op: 'stop' }); assert.equal(await exit, 0);
  if (mode === 'local') {
    const restarted = spawn(process.execPath, [fileURLToPath(new URL('./app-control.mjs', import.meta.url)), '--mode', 'local', '--out', output, '--profile', join(output, 'profile')], { stdio: ['pipe', 'pipe', 'inherit'] });
    const restartedExit = new Promise(resolve => restarted.once('close', resolve));
    const lines = createInterface({ input: restarted.stdout });
    const timer = setTimeout(() => restarted.kill('SIGTERM'), 20_000);
    try {
      for await (const line of lines) {
        const response = JSON.parse(line);
        if (response.ready) {
          assert(response.snapshot.controls.some(c => c.name === '라이트 모드로 전환'), 'Saved dark theme must survive the process restart');
          restarted.stdin.end('{"op":"stop"}\n');
        }
      }
      assert.equal(await restartedExit, 0);
      checks.push('Explicit test profile restarted; saved theme observed through visible toggle');
    } finally { clearTimeout(timer); restarted.kill('SIGTERM'); }
  }
  writeFileSync(join(output, 'trace.json'), JSON.stringify({ mode, flow, checks, messages }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, mode, flow, checks, output }));
} catch (error) {
  child.kill('SIGTERM');
  writeFileSync(join(output, 'failed-trace.json'), JSON.stringify(messages, null, 2), { mode: 0o600 });
  console.error(error.message + '\nEvidence: ' + output); process.exitCode = 1;
}
