import { ArtifactError, requireThat } from './model.mjs';

async function limitedBody(response, limit) {
  requireThat(response.body, 'INVALID_AUDIO', 'Empty provider response');
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      requireThat(length <= limit, 'RESPONSE_TOO_LARGE', 'Provider response exceeds size limit');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return Buffer.concat(chunks);
}
function hostedAudioUrl(raw) {
  let url; try { url = new URL(raw); } catch { throw new ArtifactError('INVALID_AUDIO', 'Invalid audio URL'); }
  // No arbitrary URL fetch, redirects, credentials, loopback or private-service destinations.
  requireThat(url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && /(?:^|\.)(?:heygen\.ai|heygen\.com)$/.test(url.hostname), 'INVALID_AUDIO', 'Audio must be hosted on a HeyGen HTTPS domain');
  return url;
}
/** Direct HeyGen v3 API, the provider used by official HyperFrames audio helpers.
 * Only an explicitly configured key is used. Does not inspect any credential files,
 * inherit Claude credentials, auto-select another provider, retry, or log API bodies.
 */
export function createHeygenNarrator({ apiKey, voiceId, language = 'ko', fetchImpl = fetch, timeoutMs = 120_000 }) {
  requireThat(typeof apiKey === 'function', 'VOICE_AUTH_REQUIRED', 'Host credential provider required');
  requireThat(typeof voiceId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(voiceId), 'VOICE_REQUIRED', 'Select a HeyGen Starfish voice');
  requireThat(/^[a-z]{2}(?:-[A-Za-z]{2,8})?$/.test(language), 'INVALID_INPUT', 'Invalid narration language');
  requireThat(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600_000, 'INVALID_INPUT', 'Invalid TTS timeout');
  return async ({ text, signal, assertCurrent }) => {
    signal.throwIfAborted();
    const key = await apiKey();
    signal.throwIfAborted();
    requireThat(typeof key === 'string' && key.trim() && !/[\r\n]/.test(key), 'VOICE_AUTH_REQUIRED', 'Configure a separate HeyGen TTS API credential');
    requireThat(typeof text === 'string' && text.trim() && text.length <= 2000, 'INVALID_INPUT', 'Invalid narration script');
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    try {
      assertCurrent?.();
      const response = await fetchImpl('https://api.heygen.com/v3/voices/speech', {
        method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
        body: JSON.stringify({ text, voice_id: voiceId, language, speed: 1 }),
      });
      requireThat(response.ok, `VOICE_HTTP_${response.status}`, `HeyGen TTS request failed (HTTP ${response.status}); no automatic retry`);
      let payload;
      try { payload = JSON.parse((await limitedBody(response, 1_000_000)).toString('utf8')); } catch (e) { if (e instanceof ArtifactError) throw e; throw new ArtifactError('INVALID_AUDIO', 'Malformed HeyGen response'); }
      const inner = payload?.data ?? payload;
      requireThat(inner && typeof inner.audio_url === 'string', 'INVALID_AUDIO', 'HeyGen returned no audio URL');
      const url = hostedAudioUrl(inner.audio_url);
      requestSignal.throwIfAborted();
      // Credentials are never sent to the audio CDN.
      const audio = await fetchImpl(url, { redirect: 'error', signal: requestSignal });
      requireThat(audio.ok, 'AUDIO_DOWNLOAD_FAILED', `HeyGen audio download failed (HTTP ${audio.status})`);
      const bytes = await limitedBody(audio, 32_000_000);
      requireThat(bytes.length > 32 && (/^audio\//i.test(audio.headers.get('content-type') ?? '') || /application\/octet-stream/i.test(audio.headers.get('content-type') ?? '')), 'INVALID_AUDIO', 'Expected audio bytes');
      requestSignal.throwIfAborted();
      return { bytes, provider: 'heygen', voiceId, language };
    } catch (e) {
      if (signal.aborted) signal.throwIfAborted();
      if (requestSignal.aborted) throw new ArtifactError('VOICE_TIMEOUT', 'TTS timed out; billing outcome may be unknown. Retry only explicitly.');
      if (e instanceof ArtifactError) throw e;
      throw new ArtifactError('VOICE_NETWORK', 'HeyGen request interrupted; billing outcome may be unknown. No automatic retry.');
    }
  };
}
