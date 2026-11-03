import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHeygenNarrator } from '../src/heygen.mjs';
import { videoComposition } from '../src/video.mjs';
import { plan } from './fixture.mjs';
const signal = () => new AbortController().signal;
const configured = (fetchImpl, extra = {}) => createHeygenNarrator({ apiKey: async () => 'test-key', voiceId: 'starfish-test', fetchImpl, ...extra });
test('HeyGen direct API sends only narration and no credentials to CDN', async () => {
  const calls = [];
  const talk = configured(async (url, init) => { calls.push({ url: String(url), init }); return calls.length === 1 ? Response.json({ data: { audio_url: 'https://resource.heygen.ai/audio.mp3' } }) : new Response(Buffer.alloc(40), { headers: { 'content-type': 'audio/mpeg' } }); });
  const output = await talk({ text: '합성 대본', signal: signal() });
  assert.equal(output.bytes.length, 40); assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: '합성 대본', voice_id: 'starfish-test', engine: 'starfish', language: 'ko', speed: 1 });
  assert.equal(calls[1].init.headers, undefined); assert.equal(calls[1].init.redirect, 'error');
});
test('missing credentials and pre-abort make no network call', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; };
  await assert.rejects(configured(fetchImpl, { apiKey: async () => undefined })({ text: 'x', signal: signal() }), { code: 'VOICE_AUTH_REQUIRED' });
  const c = new AbortController(); c.abort(); await assert.rejects(configured(fetchImpl)({ text: 'x', signal: c.signal })); assert.equal(calls, 0);
});
test('auth/rate-limit errors never retry and never expose provider body', async () => {
  for (const status of [401, 402, 429, 500]) {
    let calls = 0; await assert.rejects(configured(async () => { calls++; return new Response('sensitive upstream body', { status }); })({ text: 'x', signal: signal() }), (e) => e.code === `VOICE_HTTP_${status}` && !e.message.includes('sensitive'));
    assert.equal(calls, 1);
  }
});
test('untrusted audio URLs, malformed and oversized responses fail closed', async () => {
  for (const url of ['http://resource.heygen.ai/x', 'https://localhost/x', 'https://resource.heygen.ai.evil.test/x', 'https://u:p@resource.heygen.ai/x']) {
    let calls = 0; await assert.rejects(configured(async () => { calls++; return Response.json({ audio_url: url }); })({ text: 'x', signal: signal() }), { code: 'INVALID_AUDIO' }); assert.equal(calls, 1);
  }
  await assert.rejects(configured(async () => new Response('{'))({ text: 'x', signal: signal() }), { code: 'INVALID_AUDIO' });
  await assert.rejects(configured(async () => new Response('x'.repeat(1_000_001)))({ text: 'x', signal: signal() }), { code: 'RESPONSE_TOO_LARGE' });
});
test('network timeout stops without selecting another provider', async () => {
  const talk = configured(async (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }), { timeoutMs: 5 });
  // Keep the process alive: AbortSignal.timeout intentionally uses an unref timer.
  const keepAlive = setInterval(() => {}, 50);
  try { await assert.rejects(talk({ text: 'x', signal: signal() }), { code: 'VOICE_TIMEOUT' }); } finally { clearInterval(keepAlive); }
});
test('composition uses measured durations and escapes scene text', () => {
  const p = plan(); p.scenes.push({ ...p.scenes[0], title: '<script>bad</script>' });
  const out = videoComposition(p, [{ duration: 2.7 }, { duration: 3.1 }]);
  assert.equal(out.timeline[1].start, 3.0500000000000003); assert.equal(out.duration, 6.5);
  assert.match(out.html, /audio\/scene-2.mp3/); assert.ok(!out.html.includes('<script>'));
  assert.throws(() => videoComposition(p, [{ duration: 3 }]), { code: 'INVALID_AUDIO' });
});

test('account guard is rechecked after asynchronous credential retrieval before billing', async () => {
  let current = true, called = 0;
  const talk = configured(async () => { called++; }, { apiKey: async () => { current = false; return 'test-key'; } });
  await assert.rejects(talk({ text: 'x', signal: signal(), assertCurrent: () => { if (!current) throw Object.assign(new Error('account changed'), { code: 'ACCOUNT_CHANGED' }); } }));
  assert.equal(called, 0);
});
