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
const click = async (name, context) => command({ op: 'click', target: find(name, context).id });
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
      assert(snapshot.text.includes('불 대수 기초')); assert(snapshot.controls.some(c => c.name === '메모' && c.selected === 'true'));
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
    await click('대화 시작');
    await until(s => s.controls.some(c => c.name === 'Claude에게 메시지' && !c.disabled));
    assert.equal(find('메시지 전송').disabled, true);
    await command({ op: 'fill', target: find('Claude에게 메시지').id, text: '진리표를 설명해 주세요 · CLI 합성 검증' });
    assert.equal(find('메시지 전송').disabled, false);
    await click('메시지 전송');
    await until(s => s.text.includes('실제 Claude 응답이 아닙니다'));
    checks.push('Conversation created, React input updated, synthetic response observed');
    const rendered = await command({ op: 'render', name: 'pdf-chat' });
    assert.equal(rendered.evidence.flow, flow);
    if (flow === 'debug') { assert.equal(rendered.evidence.shortcutsUsed, 0); assert.equal(rendered.evidence.evidenceUse, 'user-journey-verification'); }
    const png = readFileSync(join(output, 'pdf-chat.png')); assert(png.length > 10_000);
    assert.match(readFileSync(join(output, 'pdf-chat.json'), 'utf8'), /"mode": "fixture"/);
    await command({ op: 'resize', width: 700, height: 600 });
    await click('자료', '화면 전환');
    assert(!snapshot.controls.some(c => c.name === 'Claude에게 메시지'));
    await click('채팅', '화면 전환');
    assert(snapshot.controls.some(c => c.name === 'Claude에게 메시지'));
    await command({ op: 'key', key: 'F6' });
    await command({ op: 'render', name: 'narrow-chat' });
    checks.push('Narrow materials/chat navigation and F6; background PNG with metadata');
  } else {
    assert(!snapshot.text.includes('합성 데이터'));
    assert(snapshot.text.includes('NATIVE_REQUIRED'));
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
