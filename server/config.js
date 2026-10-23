/**
 * Jax Nova — configuration
 * Reads .env from the project root (tiny parser, no dependencies),
 * then exposes a normalised config object.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvFile();

const env = (k, d = '') => (process.env[k] ?? d).trim();
const bool = (k, d = false) => {
  const v = env(k, String(d)).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

const elevenKey = env('ELEVENLABS_API_KEY') || env('ELEVEN_LABS_API_KEY');
const anthropicKey = env('ANTHROPIC_API_KEY');
const openaiKey = env('OPENAI_API_KEY');

/**
 * Local voice server: any OpenAI-compatible speech endpoint running on the
 * user's own machine/LAN — Voicebox (http://127.0.0.1:17493), VoiceStudio
 * (http://127.0.0.1:3900), Speaches, LocalAI… Both named apps answer
 * POST /v1/audio/speech, so one integration drives either, for free.
 * The "kind" only changes voice listing / clone creation / STT route shape,
 * where the two apps' native APIs differ; auto-detects from the default ports.
 */
const localVoiceUrl = env('JAX_LOCAL_VOICE_URL');
function pickLocalKind(url) {
  const forced = env('JAX_LOCAL_VOICE_KIND', 'auto').toLowerCase();
  if (['voicebox', 'voicestudio', 'openai'].includes(forced)) return forced;
  try {
    const u = new URL(url);
    if (u.port === '17493') return 'voicebox';
    if (u.port === '3900') return 'voicestudio';
  } catch {
    /* unparseable URL — the first request will fail loudly enough */
  }
  return 'openai';
}

/** Voice provider: JAX_VOICE_PROVIDER wins, else local → elevenlabs → browser. */
function pickVoiceProvider() {
  const hasLocal = Boolean(localVoiceUrl);
  const hasEleven = Boolean(elevenKey);
  const forced = env('JAX_VOICE_PROVIDER', 'auto').toLowerCase();
  if (forced === 'browser') return 'browser';
  if (forced === 'local' && hasLocal) return 'local';
  if (forced === 'elevenlabs' && hasEleven) return 'elevenlabs';
  return hasLocal ? 'local' : hasEleven ? 'elevenlabs' : 'browser';
}

/**
 * Brain selection:
 *   auto        → Claude if a key/CLI exists, else the free keyless brain
 *   claude      → Anthropic API  |  claude-cli → local `claude` binary
 *   openai      → any OpenAI-compatible endpoint
 *   free        → keyless Pollinations text model
 */
function pickBrain() {
  const forced = env('JAX_BRAIN', 'auto').toLowerCase();
  if (forced !== 'auto') return forced;
  // WRESTLE_AI_URL alone is not enough to hijack the brain — opt in explicitly
  // with JAX_BRAIN=wrestle. 'auto' keeps the local Claude/OpenAI/keyless chain.
  if (anthropicKey) return 'claude';
  if (openaiKey) return 'openai';
  if (bool('JAX_USE_CLAUDE_CLI', false)) return 'claude-cli';
  return 'free';
}

// Generated media lives outside the image when JAX_DATA_DIR is set, so a
// Railway volume (mounted at /data) survives redeploys.
const dataDir = env('JAX_DATA_DIR') || path.join(ROOT, 'public', 'generated');

export const config = {
  port: Number(env('PORT', '8787')),
  host: env('HOST', '0.0.0.0'),
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  generatedDir: dataDir,
  dataDir,

  // Set JAX_ACCESS_CODE on any public deployment: it gates /api/* behind a
  // code + HttpOnly session cookie so strangers can't spend your API credits.
  accessCode: env('JAX_ACCESS_CODE', ''),
  // Requests per minute per IP for expensive endpoints (0 disables the limiter).
  rateLimit: Number(env('JAX_RATE_LIMIT', '40')),
  trustProxy: bool('JAX_TRUST_PROXY', true),
  deployed: Boolean(env('RAILWAY_ENVIRONMENT', '') || env('RAILWAY_PROJECT_ID', '') || env('RENDER', '')),

  eleven: {
    key: elevenKey,
    voiceId: env('ELEVENLABS_VOICE_ID'),
    model: env('ELEVENLABS_MODEL', 'eleven_turbo_v2_5'),
    sttModel: env('ELEVENLABS_STT_MODEL', 'scribe_v2'),
  },

  // Free, local voice (Voicebox / VoiceStudio / any OpenAI-compatible speech
  // server). The Jax *server* must be able to reach this URL — run Jax on the
  // same machine as the voice app, or point this at a LAN/Tailscale host. A
  // Jax on Railway cannot reach your laptop's 127.0.0.1.
  localVoice: {
    url: localVoiceUrl,
    kind: localVoiceUrl ? pickLocalKind(localVoiceUrl) : '',
    // Bearer key for a keyed remote backend (VoiceStudio's OMNIVOICE_API_KEY).
    // Loopback needs none; Voicebox ignores the header entirely.
    key: env('JAX_LOCAL_VOICE_KEY'),
    model: env('JAX_LOCAL_VOICE_MODEL', 'tts-1'),
    sttModel: env('JAX_LOCAL_VOICE_STT_MODEL', 'whisper-1'),
    // Profile name or id to pin as the main voice (blank = the app's default)
    voiceId: env('JAX_LOCAL_VOICE_ID'),
    // First generation may load a multi-GB model — be patient by default.
    timeoutMs: Number(env('JAX_LOCAL_VOICE_TIMEOUT_MS', '180000')),
  },
  voiceProvider: pickVoiceProvider(),

  brain: {
    provider: pickBrain(),
    anthropicKey,
    anthropicModel: env('ANTHROPIC_MODEL', 'claude-sonnet-4-5-20250929'),
    openaiKey,
    openaiBase: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    openaiModel: env('OPENAI_MODEL', 'gpt-4o-mini'),
    freeModel: env('JAX_FREE_MODEL', 'openai'),
    claudeCli: env('CLAUDE_CLI_PATH', 'claude'),
    maxToolRounds: Number(env('JAX_MAX_TOOL_ROUNDS', '4')),
  },

  // Wrestle-ai bridge (CyberFights/Wrestle-ai → POST /wrestling_chat)
  wrestle: {
    url: env('WRESTLE_AI_URL', 'https://wrestle-ai-production.up.railway.app'),
    userId: env('WRESTLE_USER_ID', 'jax-nova'),
    // true → always send our persona as system_p; false → use Wrestle-ai's built-in JAX_PROMPT
    sendPersona: bool('WRESTLE_SEND_PERSONA', true),
    // null → omit the field and let the server default apply
    humanize: env('WRESTLE_HUMANIZE', '') === '' ? null : bool('WRESTLE_HUMANIZE', true),
    timeoutMs: Number(env('WRESTLE_TIMEOUT_MS', '45000')),
  },

  assistant: {
    name: env('JAX_NAME', 'Jax Nova'),
    wakeWord: env('JAX_WAKE_WORD', 'hey jax'),
    location: env('JAX_LOCATION', 'Richmond Hill, Ontario'),
    units: env('JAX_UNITS', 'metric'),
    ownerName: env('JAX_OWNER', ''),
  },

  features: {
    imageGen: bool('JAX_IMAGE_GEN', true),
    videoGen: bool('JAX_VIDEO_GEN', true),
    webSearch: bool('JAX_WEB_SEARCH', true),
    // Cloning spends a voice slot on the owner's ElevenLabs account, so a
    // shared deployment can switch it off while keeping TTS/STT available.
    voiceClone: bool('JAX_VOICE_CLONE', true),
  },
};

/** Minimal, safe payload for a locked deployment. */
export function lockedCapabilities() {
  return {
    locked: true,
    name: config.assistant.name,
    wakeWord: config.assistant.wakeWord,
    requiresCode: Boolean(config.accessCode),
  };
}

/** Public capability report — safe to send to the browser (no secrets). */
export function capabilities() {
  return {
    name: config.assistant.name,
    wakeWord: config.assistant.wakeWord,
    location: config.assistant.location,
    units: config.assistant.units,
    ownerName: config.assistant.ownerName,
    voice: (() => {
      const provider = config.voiceProvider;
      const local = provider === 'local';
      const eleven = provider === 'elevenlabs';
      const kind = local ? config.localVoice.kind : null;
      return {
        provider,
        label: local
          ? kind === 'voicebox'
            ? 'Voicebox (local)'
            : kind === 'voicestudio'
              ? 'VoiceStudio (local)'
              : 'Local voice server'
          : eleven
            ? 'ElevenLabs'
            : 'Browser',
        // the browser talks to /api/tts whenever a server-side voice exists
        server: provider !== 'browser',
        elevenlabs: Boolean(config.eleven.key),
        local,
        localKind: kind,
        model: local ? config.localVoice.model : eleven ? config.eleven.model : null,
        voiceId: local ? config.localVoice.voiceId || null : eleven ? config.eleven.voiceId || null : null,
        // server-side transcription: local Whisper or ElevenLabs Scribe
        stt: provider !== 'browser',
        sttLabel: local ? 'Whisper (local)' : eleven ? 'Scribe' : null,
        sttModel: local ? config.localVoice.sttModel : eleven ? config.eleven.sttModel : null,
        // Clone from an uploaded sample: ElevenLabs IVC (paid plan) or a
        // local Voicebox/VoiceStudio profile (free). Generic OpenAI speech
        // servers have no clone API — profiles are made in their own apps.
        clone: Boolean(
          config.features.voiceClone &&
            (eleven || (local && (kind === 'voicebox' || kind === 'voicestudio'))),
        ),
      };
    })(),
    brain: {
      provider: config.brain.provider,
      model:
        config.brain.provider === 'claude'
          ? config.brain.anthropicModel
          : config.brain.provider === 'openai'
            ? config.brain.openaiModel
            : config.brain.provider === 'claude-cli'
              ? 'claude (CLI)'
              : config.brain.provider === 'wrestle'
                ? 'wrestle-ai /wrestling_chat'
                : `keyless (${config.brain.freeModel})`,
      tools: config.brain.provider === 'claude',
    },
    features: config.features,
    wrestle: {
      configured: Boolean(config.wrestle.url),
      endpoint: config.wrestle.url ? `${config.wrestle.url.replace(/\/+$/, '')}/wrestling_chat` : null,
      userId: config.wrestle.userId,
      persona: config.wrestle.sendPersona,
      humanize: config.wrestle.humanize,
    },
  };
}
