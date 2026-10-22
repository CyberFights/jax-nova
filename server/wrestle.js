/**
 * Wrestle-ai bridge.
 *
 * Talks to POST /wrestling_chat on a CyberFights/Wrestle-ai deployment:
 *
 *   request   { user_id, message, system_p?, humanize? }
 *   response  { response }                       ← 250-token casual chat
 *
 * That endpoint owns its own per-user memory in MongoDB (keyed by user_id,
 * separate from the battle and UGCW folders), so we deliberately send only the
 * new message and let it manage history. Sending our local transcript too would
 * duplicate recent turns in its prompt.
 *
 * No API key is involved — the endpoint is open — which is exactly why
 * WRESTLE_USER_ID should be something unguessable: anyone who knows it can
 * interleave messages into the same stored conversation.
 */
import { config } from './config.js';
import { JAX_NOVA_PERSONA } from './personas.js';
import { fetchWithTimeout } from './util.js';

const STAGE_VERBS =
  /\b(smiles?|smirks?|grins?|laughs?|chuckles?|sighs?|shrugs?|nods?|winks?|leans?|pauses?|whispers?|murmurs?|grumbles?|snorts?|beams?|frowns?|blinks?|shakes? (his|her|their) head|raises? an eyebrow|shifts?|gestures?|waves?|scoffs?|snickers?)\b/i;

/**
 * The persona forbids asterisks, brackets and stage directions, so enforce it
 * on the way out — a model slipping into roleplay narration would otherwise be
 * read aloud as "asterisk smiles asterisk".
 */
export function stripStageDirections(text = '') {
  let out = String(text);

  // *action* and **action** — the persona bans asterisks entirely
  out = out.replace(/\*{1,3}([^*\n]{1,160})\*{1,3}/g, (m, inner) =>
    STAGE_VERBS.test(inner) ? '' : inner,
  );
  out = out.replace(/\*/g, '');

  // [action] — likewise banned
  out = out.replace(/\[([^\]\n]{1,160})\]/g, (m, inner) =>
    STAGE_VERBS.test(inner) ? '' : inner,
  );

  // (laughs softly) — only strip when it is clearly an action, because
  // parentheses carry legitimate asides ("(mostly)", "(1998)")
  out = out.replace(/\(([^)\n]{1,80})\)/g, (m, inner) =>
    STAGE_VERBS.test(inner) ? '' : m,
  );

  // A bare action clause opening a line: "Leans back. So, about that match…"
  // Only stripped when the clause really is stage business — "Fine. Let's go."
  // has to survive.
  out = out.replace(/(^|\n)([ \t]*)([A-Z][a-z]+(?:\s+[a-z]+){0,3})[.!][ \t]+/g, (m, pre, ws, clause) =>
    STAGE_VERBS.test(clause) ? pre : m,
  );

  // A whole line that is nothing but one action word: "*smiles*" left "Smiles."
  out = out
    .split(/\n+/)
    .filter((line) => {
      const m = line.match(/^\s*[-–—•]*\s*([A-Za-z][a-z]+)[ ,.]{0,3}$/);
      return !(m && STAGE_VERBS.test(m[1]));
    })
    .join('\n');

  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/^\s*[,;:]\s*/g, '')
    .trim();
}

export function wrestleConfig() {
  const url = (config.wrestle.url || '').replace(/\/+$/, '');
  return {
    url,
    endpoint: url ? `${url}/wrestling_chat` : '',
    userId: config.wrestle.userId,
    humanize: config.wrestle.humanize,
    sendPersona: config.wrestle.sendPersona,
    timeoutMs: config.wrestle.timeoutMs,
    configured: Boolean(url),
  };
}

/**
 * One conversational turn.
 * @returns {{ response: string, raw: string, latencyMs: number, userId: string }}
 */
export async function wrestleChat(message, options = {}) {
  const cfg = wrestleConfig();
  if (!cfg.endpoint) throw new Error('WRESTLE_AI_URL is not set');

  const text = String(message || '').trim();
  if (!text) throw new Error('empty message');

  const userId = String(options.userId || cfg.userId || 'jax-nova').trim();
  if (!userId) throw new Error('empty user_id');

  const body = { user_id: userId, message: text };

  const systemPrompt =
    options.systemPrompt !== undefined ? options.systemPrompt : cfg.sendPersona ? JAX_NOVA_PERSONA : '';
  if (systemPrompt && String(systemPrompt).trim()) body.system_p = String(systemPrompt);

  if (options.humanize !== undefined) body.humanize = options.humanize;
  else if (cfg.humanize !== null) body.humanize = cfg.humanize;

  const started = Date.now();
  const res = await fetchWithTimeout(
    cfg.endpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    },
    options.timeoutMs || cfg.timeoutMs,
  );

  const payload = await res.json().catch(() => ({}));

  if (!res.ok) {
    const detail = payload?.details || payload?.error || `HTTP ${res.status}`;
    throw new Error(`wrestling_chat ${res.status}: ${String(detail).slice(0, 200)}`);
  }
  if (typeof payload.response !== 'string' || !payload.response.trim()) {
    throw new Error('wrestling_chat returned no response text');
  }

  return {
    response: stripStageDirections(payload.response),
    raw: payload.response,
    latencyMs: Date.now() - started,
    userId,
    humanized: body.humanize ?? null,
  };
}

/**
 * Reachability probe. A POST would spend Mistral tokens and write to the
 * memory store, so we only check that the host answers at all — any HTTP
 * status, including the 500 its root path returns, proves the service is up.
 */
export async function wrestleHealth() {
  const cfg = wrestleConfig();
  if (!cfg.configured) return { configured: false, reachable: false };
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(cfg.url, { method: 'GET' }, 8000);
    return {
      configured: true,
      reachable: true,
      status: res.status,
      latencyMs: Date.now() - started,
      endpoint: cfg.endpoint,
      userId: cfg.userId,
    };
  } catch (err) {
    return {
      configured: true,
      reachable: false,
      error: err.message,
      latencyMs: Date.now() - started,
      endpoint: cfg.endpoint,
    };
  }
}
