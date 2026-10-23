/**
 * Jax Nova — local voice provider (free, open source, on your own machine).
 *
 * Voicebox (jamiepine/voicebox, MIT — http://127.0.0.1:17493) and
 * VoiceStudio (debpalash/VoiceStudio, AGPL-3.0 — http://127.0.0.1:3900)
 * both answer the OpenAI speech API:
 *
 *   POST /v1/audio/speech          { model, voice, input, response_format }
 *   POST /v1/audio/transcriptions  multipart file + model         (VoiceStudio)
 *
 * so TTS is one code path. They differ only in their native surfaces, used
 * here for listing/cloning voices (and Voicebox transcription):
 *
 *   Voicebox     GET/POST /profiles, POST /profiles/{id}/samples (file +
 *                reference_text), POST /transcribe (Whisper)
 *   VoiceStudio  GET /v1/audio/voices, POST /profiles (name + ref_audio +
 *                ref_text, kind=clone)
 *
 * Any other OpenAI-compatible speech server (Speaches, LocalAI, …) works
 * for TTS/STT as kind=openai; cloning has no OpenAI-standard API, so
 * profiles for those are created in their own apps.
 *
 * Everything runs against config.localVoice, read at call time.
 */
import { config } from './config.js';

const cfg = () => config.localVoice;
const kind = () => cfg().kind || 'openai';
export const localKind = kind;

/** Origin of the voice app, tolerating a pasted OpenAI-style …/v1 base URL. */
function base() {
  return String(cfg().url || '').replace(/\/+$/, '').replace(/\/v1$/, '');
}
const api = (p) => `${base()}/v1${p}`;
const native = (p) => `${base()}${p}`;

function appName() {
  return kind() === 'voicebox' ? 'Voicebox' : kind() === 'voicestudio' ? 'VoiceStudio' : 'the local voice server';
}

function headers(extra = {}) {
  const h = { ...extra };
  // VoiceStudio honours a Bearer key on keyed/remote backends; loopback and
  // Voicebox don't need one (Voicebox ignores Authorization entirely).
  if (cfg().key) h.authorization = `Bearer ${cfg().key}`;
  // Lets the user pin a default voice for Jax in Voicebox → Settings → MCP.
  if (kind() === 'voicebox') h['x-voicebox-client-id'] = 'jax-nova';
  return h;
}

async function lfetch(url, init = {}, timeoutMs = cfg().timeoutMs) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(Math.max(1000, timeoutMs || 180000)) });
  } catch (err) {
    const why = err?.name === 'TimeoutError' ? `timed out after ${Math.round((timeoutMs || 180000) / 1000)}s` : err?.cause?.code || err.message;
    throw new Error(`${appName()} unreachable at ${base()} — is the app running? (${why})`);
  }
}

const HINTS = {
  model_not_downloaded: 'download the engine’s model in the voice app first (Voicebox → Models)',
  model_not_found: 'check JAX_LOCAL_VOICE_MODEL against GET /v1/models on the voice server',
  voice_not_found: 'that voice profile does not exist in the voice app — pick one in CONFIG or clone one below',
  voice_required: 'no default voice resolved — pin one with JAX_LOCAL_VOICE_ID or pick one in CONFIG',
  engine_not_compatible: 'that engine cannot speak this profile type — try the profile’s own engine (model=tts-1)',
};

async function fail(res, what) {
  let msg = '';
  let code = '';
  try {
    const data = await res.clone().json();
    msg = data?.error?.message || data?.detail || data?.error || '';
    code = data?.error?.code || '';
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
  } catch {
    msg = (await res.text().catch(() => '')).slice(0, 240);
  }
  const hint = HINTS[code] ? ` — ${HINTS[code]}` : '';
  throw new Error(`${appName()} ${what} ${res.status}: ${String(msg).slice(0, 240)}${hint}`);
}

/* --------------------------------------------------------------------- tts */

export async function localTTS(text, { voiceId, model } = {}) {
  const voice = voiceId || cfg().voiceId || (kind() === 'voicestudio' ? 'default' : undefined);
  const body = { model: model || cfg().model || 'tts-1', input: text, response_format: 'mp3' };
  // Voicebox resolves an omitted voice via client binding → default profile
  if (voice) body.voice = voice;
  const res = await lfetch(api('/audio/speech'), {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json', accept: 'audio/mpeg, audio/wav, */*' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) await fail(res, 'TTS');
  return {
    audio: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || 'audio/mpeg',
  };
}

/* --------------------------------------------------------------------- stt */

async function transcribeVoicebox(buffer, filename, mimetype) {
  const form = new FormData();
  // Voicebox's /transcribe has taken the upload as `audio` (README) and as
  // `file` (generated clients) across versions — send both; FastAPI ignores
  // the extra field either way.
  form.append('audio', new Blob([buffer], { type: mimetype }), filename);
  form.append('file', new Blob([buffer], { type: mimetype }), filename);
  const model = cfg().sttModel && cfg().sttModel !== 'whisper-1' ? cfg().sttModel : 'turbo';
  form.append('model', model);
  const res = await lfetch(native('/transcribe'), { method: 'POST', headers: headers(), body: form });
  if (!res.ok) await fail(res, 'transcription');
  const data = await res.json().catch(() => ({}));
  return String(data.text || '').trim();
}

export async function localSTT(buffer, filename = 'speech.webm', mimetype = 'audio/webm') {
  // Voicebox's OpenAI surface is TTS-only; its Whisper lives on /transcribe
  if (kind() === 'voicebox') return transcribeVoicebox(buffer, filename, mimetype);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }), filename);
  form.append('model', cfg().sttModel || 'whisper-1');
  const res = await lfetch(api('/audio/transcriptions'), { method: 'POST', headers: headers(), body: form });
  if (!res.ok) await fail(res, 'transcription');
  const data = await res.json().catch(() => ({}));
  return String(data.text || '').trim();
}

/* ------------------------------------------------------------------ voices */

function normalizeCategory(raw) {
  const c = String(raw || '').toLowerCase();
  if (c === 'cloned' || c === 'clone') return 'cloned';
  if (c === 'professional') return 'professional';
  if (c === 'preset') return 'preset';
  if (c === 'design' || c === 'designed' || c === 'generated') return 'generated';
  return c || null;
}

function mapVoices(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((v) => {
      const id = v?.id ?? v?.profile_id ?? v?.voice_id ?? v?.name;
      if (id === undefined || id === null || id === '') return null;
      return {
        id: String(id),
        name: String(v?.name ?? v?.label ?? id),
        category: normalizeCategory(v?.voice_type ?? v?.kind ?? v?.category),
        labels: v?.language ? { language: v.language } : v?.labels || undefined,
        preview: null,
      };
    })
    .filter(Boolean);
}

async function getJson(url) {
  const res = await lfetch(url, { headers: headers({ accept: 'application/json' }) }, 10_000);
  if (!res.ok) await fail(res, 'request');
  return res.json().catch(() => ({}));
}

const asList = (data) =>
  Array.isArray(data) ? data : data?.profiles || data?.voices || data?.data || [];

export async function localVoices() {
  if (kind() === 'voicebox') {
    return mapVoices(asList(await getJson(native('/profiles'))));
  }
  if (kind() === 'voicestudio') {
    const fromV1 = mapVoices(asList(await getJson(api('/audio/voices')).catch(() => [])));
    if (fromV1.length) return fromV1;
    return mapVoices(asList(await getJson(native('/profiles'))));
  }
  // generic OpenAI speech servers address voices as models (e.g. Speaches)
  const data = await getJson(api('/models'));
  return mapVoices(asList(data).map((m) => ({ id: m.id, name: m.id, category: 'model' })));
}

/* ------------------------------------------------------------------- clone */

const idOf = (data) => data?.id ?? data?.profile_id ?? data?.profile?.id ?? data?.data?.id ?? null;

async function cloneVoicebox(buffer, { name, filename, mimetype, referenceText, language }) {
  // Cloning engines need the sample's verbatim transcript; Whisper it locally
  // when the user didn't type one (same as the Voicebox UI does).
  const refText = referenceText || (await transcribeVoicebox(buffer, filename, mimetype));
  if (!refText) throw new Error('could not transcribe the sample — type its transcript into the clone form and retry');

  const created = await lfetch(native('/profiles'), {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ name, language: language || 'en', description: 'Cloned from Jax Nova' }),
  });
  if (!created.ok) await fail(created, 'profile creation');
  const profileId = idOf(await created.json().catch(() => ({})));
  if (!profileId) throw new Error('Voicebox created the profile but returned no id');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }), filename);
  form.append('reference_text', refText);
  const sampled = await lfetch(native(`/profiles/${encodeURIComponent(profileId)}/samples`), {
    method: 'POST',
    headers: headers(),
    body: form,
  });
  if (!sampled.ok) {
    // don't leave an empty profile behind
    await lfetch(native(`/profiles/${encodeURIComponent(profileId)}`), { method: 'DELETE', headers: headers() }, 10_000).catch(() => {});
    await fail(sampled, 'sample upload');
  }
  return { voice_id: String(profileId), requires_verification: false };
}

async function cloneVoiceStudio(buffer, { name, filename, mimetype, referenceText }) {
  const form = new FormData();
  form.append('name', name);
  form.append('ref_audio', new Blob([buffer], { type: mimetype }), filename);
  form.append('ref_text', referenceText || '');
  form.append('kind', 'clone');
  const res = await lfetch(native('/profiles'), { method: 'POST', headers: headers(), body: form });
  if (!res.ok) await fail(res, 'profile creation');
  const data = await res.json().catch(() => ({}));
  let id = idOf(data);
  if (!id) {
    // fall back to finding the profile we just made, by name
    const list = mapVoices(asList(await getJson(native('/profiles')).catch(() => [])));
    id = list.filter((v) => v.name === name).at(-1)?.id || null;
  }
  if (!id) throw new Error('VoiceStudio created the profile but returned no id — select it in the voice list');
  return { voice_id: String(id), requires_verification: false };
}

export async function localCloneVoice(buffer, opts = {}) {
  if (kind() === 'voicebox') return cloneVoicebox(buffer, opts);
  if (kind() === 'voicestudio') return cloneVoiceStudio(buffer, opts);
  throw new Error(
    'this local voice server has no clone API Jax can call — create the voice in Voicebox/VoiceStudio, then pick it in CONFIG',
  );
}
