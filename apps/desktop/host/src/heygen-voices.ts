/**
 * WBS-092: the HeyGen voices that can read the weekly explanation video's
 * script (Starfish engine, the one HeyGen's text-to-speech uses), also used to
 * check a key before it is saved. The key goes only to api.heygen.com, in the
 * x-api-key header; it is never logged or shown again.
 */

export interface HeygenVoice { voiceId: string; name: string; language: string; gender: string; preview?: string | undefined }
export type HeygenCheck = { ok: true; voices: HeygenVoice[] } | { ok: false; reason: "rejected" | "failed" };

const API = "https://api.heygen.com/v3/voices";
const PAGES = 5;

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Korean Starfish voices first, then the rest of the Starfish library (up to a few pages). */
export async function listHeygenVoices(key: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<HeygenCheck> {
  if (!key.trim() || /[\r\n]/.test(key)) return { ok: false, reason: "rejected" };
  const voices: HeygenVoice[] = [];
  let token: string | undefined;
  try {
    for (let page = 0; page < PAGES; page++) {
      const url = new URL(API);
      url.searchParams.set("engine", "starfish");
      url.searchParams.set("limit", "100");
      if (token) url.searchParams.set("token", token);
      const response = await fetchImpl(url, { headers: { "x-api-key": key, Accept: "application/json" }, redirect: "error", signal: signal ?? AbortSignal.timeout(20_000) });
      if (response.status === 401 || response.status === 403) return { ok: false, reason: "rejected" };
      if (!response.ok) return { ok: false, reason: "failed" };
      const body = (await response.json()) as Json;
      for (const v of Array.isArray(body.data) ? body.data : []) {
        const item = (v ?? {}) as Json;
        const voiceId = str(item.voice_id);
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(voiceId)) continue;
        const preview = str(item.preview_audio_url);
        voices.push({ voiceId, name: str(item.name).slice(0, 100) || voiceId, language: str(item.language).slice(0, 40), gender: str(item.gender).slice(0, 20), ...(preview.startsWith("https://") ? { preview } : {}) });
      }
      token = body.has_more === true && typeof body.next_token === "string" ? body.next_token : undefined;
      if (!token) break;
    }
  } catch { return { ok: false, reason: "failed" }; }
  const korean = (v: HeygenVoice) => /korean|ko/i.test(v.language);
  return { ok: true, voices: [...voices.filter(korean), ...voices.filter((v) => !korean(v))] };
}

/** A voice's sample, fetched by the host (the app page only plays local blobs): HeyGen HTTPS hosts only, at most 5 MB. */
export async function heygenPreview(url: string, fetchImpl: typeof fetch = fetch): Promise<{ bytes: Uint8Array<ArrayBuffer>; mediaType: string } | undefined> {
  let target: URL;
  try { target = new URL(url); } catch { return undefined; }
  if (target.protocol !== "https:" || !/(?:^|\.)(?:heygen\.ai|heygen\.com)$/.test(target.hostname)) return undefined;
  const response = await fetchImpl(target, { redirect: "error", signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
  if (!response?.ok) return undefined;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const mediaType = response.headers.get("content-type")?.split(";")[0] ?? "audio/mpeg";
  return bytes.byteLength <= 5 * 1024 ** 2 && /^audio\//.test(mediaType) ? { bytes, mediaType } : undefined;
}
