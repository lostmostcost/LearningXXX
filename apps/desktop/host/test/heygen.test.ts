import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CredentialService } from "../src/credential-service.ts";
import { CredentialStore, type SecretCipher } from "../src/credential-store.ts";
import { heygenPreview, listHeygenVoices, type HeygenCheck } from "../src/heygen-voices.ts";

const cipher: SecretCipher = { available: () => true, encrypt: (p) => Buffer.from(Buffer.from(p).map((b) => b ^ 0x5a)), decrypt: (d) => Buffer.from(d.map((b) => b ^ 0x5a)).toString() };

test("WBS-092: voices are listed with the key header, Starfish only, Korean first, across pages", async () => {
  const seen: { url: string; key: string | null }[] = [];
  const fake = (async (input: URL, init: RequestInit) => {
    seen.push({ url: String(input), key: new Headers(init.headers).get("x-api-key") });
    const page2 = String(input).includes("token=p2");
    const data = page2 ? [{ voice_id: "ko_1", name: "지수", language: "Korean", gender: "female", preview_audio_url: "https://resource.heygen.ai/a.mp3" }]
      : [{ voice_id: "en_1", name: "Ann", language: "English", gender: "female" }, { voice_id: "bad id!", name: "x", language: "Korean", gender: "male" }];
    return new Response(JSON.stringify({ data, has_more: !page2, next_token: page2 ? null : "p2" }));
  }) as unknown as typeof fetch;
  const r = await listHeygenVoices("secret-key-1", fake);
  assert.ok(r.ok);
  assert.deepEqual(r.voices.map((v) => v.voiceId), ["ko_1", "en_1"], "Korean first, malformed ids dropped");
  assert.ok(seen.every((s) => s.key === "secret-key-1" && s.url.startsWith("https://api.heygen.com/v3/voices?") && s.url.includes("engine=starfish")));
  const rejected = await listHeygenVoices("wrong", (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch);
  assert.deepEqual(rejected, { ok: false, reason: "rejected" });
  const down = await listHeygenVoices("k-12345678", (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
  assert.deepEqual(down, { ok: false, reason: "failed" });
});

test("WBS-092: a key is saved only when HeyGen accepts it, a voice only from its list, and status never shows the key", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "wbs092-")), "credentials.bin");
  let answer: HeygenCheck = { ok: false, reason: "rejected" };
  const svc = new CredentialService({ store: new CredentialStore(file, cipher), login: async () => "failed", signedIn: async () => false, checkCanvasToken: async () => "ok", heygenVoices: async () => answer });
  await assert.rejects(svc.saveHeygenKey({ key: "wrong-key-123" }), /받지 않았습니다/);
  assert.equal(svc.status().heygen, false);
  answer = { ok: true, voices: [{ voiceId: "ko_1", name: "지수", language: "Korean", gender: "female" }] };
  const saved = await svc.saveHeygenKey({ key: "good-key-123" });
  assert.equal(saved.status.heygen, true);
  assert.ok(!JSON.stringify(saved).includes("good-key-123"));
  assert.ok(!readFileSync(file).toString().includes("good-key-123"), "encrypted on disk");
  await assert.rejects(svc.setHeygenVoice({ voiceId: "other" }), /쓸 수 있는 음성이 아닙니다/);
  assert.equal((await svc.setHeygenVoice({ voiceId: "ko_1" })).heygenVoiceId, "ko_1");
  assert.deepEqual(svc.heygen(), { key: "good-key-123", voiceId: "ko_1" });
  assert.equal((await svc.saveHeygenKey({ key: "new-key-456" })).status.heygenVoiceId, undefined, "key replacement clears the previous voice");
  assert.equal(svc.clear({ which: "heygen" }).heygen, false);
  assert.equal(svc.heygen(), undefined);
});

test("WBS-092: clearing HeyGen while key validation is pending cannot resurrect the key", async () => {
  const store = new CredentialStore(join(mkdtempSync(join(tmpdir(), 'wbs092-race-')), 'credentials.bin'), cipher);
  let release!: (answer: HeygenCheck) => void;
  const svc = new CredentialService({ store, login: async () => 'failed', signedIn: async () => false, checkCanvasToken: async () => 'ok', heygenVoices: () => new Promise(r => { release = r; }) });
  const saving = svc.saveHeygenKey({ key: 'synthetic-key' });
  svc.clear({ which: 'heygen' });
  const rejected = assert.rejects(saving, /설정이 바뀌었습니다/);
  release({ ok: true, voices: [] }); await rejected;
  assert.equal(svc.heygen(), undefined);
});

test("WBS-092: voice validation for an old key cannot select a voice for its replacement", async () => {
  const store = new CredentialStore(join(mkdtempSync(join(tmpdir(), 'wbs092-voice-race-')), 'credentials.bin'), cipher);
  let slow = false, release!: (answer: HeygenCheck) => void;
  const voices = [{ voiceId: 'old_voice', name: '합성', language: 'Korean', gender: 'female' }];
  const svc = new CredentialService({ store, login: async () => 'failed', signedIn: async () => false, checkCanvasToken: async () => 'ok', heygenVoices: key => slow && key === 'old-key-123' ? new Promise(r => { release = r; }) : Promise.resolve({ ok: true, voices }) });
  await svc.saveHeygenKey({ key: 'old-key-123' }); slow = true;
  const choosing = svc.setHeygenVoice({ voiceId: 'old_voice' });
  const rejected = assert.rejects(choosing, /설정이 바뀌었습니다/);
  await svc.saveHeygenKey({ key: 'new-key-456' });
  release({ ok: true, voices }); await rejected;
  assert.deepEqual(svc.heygen(), { key: 'new-key-456' });
});

test("WBS-092: a voice sample is fetched only from HeyGen HTTPS hosts", async () => {
  const ok = (async () => new Response(new Uint8Array(100), { headers: { "content-type": "audio/mpeg" } })) as unknown as typeof fetch;
  assert.equal((await heygenPreview("https://resource.heygen.ai/a.mp3", ok))?.mediaType, "audio/mpeg");
  assert.equal(await heygenPreview("https://evil.example/a.mp3", ok), undefined);
  assert.equal(await heygenPreview("http://resource.heygen.ai/a.mp3", ok), undefined);
  assert.equal(await heygenPreview("https://resource.heygen.ai/a.html", (async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch), undefined);
});

test('WBS-092: malformed voice lists fail closed and duplicate voices are coalesced', async () => {
  assert.deepEqual(await listHeygenVoices('synthetic', (async () => new Response('{}')) as typeof fetch), { ok: false, reason: 'failed' });
  const result = await listHeygenVoices('synthetic', (async () => new Response(JSON.stringify({ data: [{ voice_id: 'same', language: 'Konkani' }, { voice_id: 'same', language: 'Korean' }, { voice_id: 'ko', language: 'ko-KR' }] }))) as typeof fetch);
  assert.ok(result.ok); assert.deepEqual(result.voices.map(v => v.voiceId), ['ko', 'same']);
  const repeated = await listHeygenVoices('synthetic', (async () => new Response(JSON.stringify({ data: [], has_more: true, next_token: 'same' }))) as typeof fetch);
  assert.deepEqual(repeated, { ok: false, reason: 'failed' });
});

test('WBS-092: chunked preview bodies stop at the limit and streams are cancelled', async () => {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(3 * 1024 ** 2)); }, cancel() { cancelled = true; } });
  const result = await heygenPreview('https://resource.heygen.ai/a.mp3', (async () => new Response(body, { headers: { 'content-type': 'audio/mpeg' } })) as typeof fetch);
  assert.equal(result, undefined); assert.equal(cancelled, true); assert.ok(pulls <= 3);
  assert.equal(await heygenPreview('https://resource.heygen.ai:444/a.mp3'), undefined);
  assert.equal(await heygenPreview('https://name:secret@resource.heygen.ai/a.mp3'), undefined);
});
