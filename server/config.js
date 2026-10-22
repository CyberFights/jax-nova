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
    voice: {
      elevenlabs: Boolean(config.eleven.key),
      model: config.eleven.key ? config.eleven.model : null,
      voiceId: config.eleven.voiceId || null,
      sttModel: config.eleven.key ? config.eleven.sttModel : null,
    },
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
