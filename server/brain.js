/**
 * Jax Nova brain.
 *
 * Provider ladder (config.brain.provider):
 *   claude      → Anthropic Messages API with native tool use
 *   claude-cli  → local `claude` binary in print mode (no API key, uses your login)
 *   openai      → any OpenAI-compatible chat-completions endpoint
 *   free        → keyless Pollinations text model + prompt-level skills
 *
 * Every path returns the same shape:
 *   { reply, actions, provider, model, latencyMs, trace }
 */
import { execFile } from 'node:child_process';
import { config } from './config.js';
import { toolDefinitions, openaiToolDefinitions, runSkill, skills } from './skills.js';
import { route } from './router.js';
import { fastIntent } from './intents.js';
import { wrestleChat } from './wrestle.js';
import { fetchWithTimeout } from './util.js';

/* ------------------------------------------------------------------ prompt */

const PERSONA = (ctx) => `You are ${config.assistant.name} — a voice-first AI assistant running inside a holographic Iron-Man-style heads-up display on the user's own machine.

PERSONALITY
- Calm, dry, competent. A little wit, never a clown. You are the AI in the suit, not a chatbot.
- Speak like a trusted operator: short, specific, useful. No filler ("Certainly!", "As an AI…").
- Address the user directly. You may occasionally call them "boss" or by name, sparingly.

VOICE OUTPUT RULES (critical — your text is spoken aloud)
- Default answer length: ONE or TWO sentences, under ~45 words. Only go longer if asked to explain or summarise.
- Plain spoken English. No markdown, no bullet lists, no URLs read aloud, no emoji, no bracketed stage directions.
- Numbers as words where natural ("twenty-three degrees").
- If a skill is doing the talking (search, weather, image, timer), keep your own line very short: what you did or what you found.
- Never describe what appears on screen in detail — the HUD shows it.

TOOLS AND THE HUD
- Prefer tools over guessing for anything live or factual: web_search, get_weather, get_news, wikipedia, read_page, generate_image, generate_video, open_url, browser_control, set_timer, remember, calculate, show_card, set_theme, system_status.
- Chain tools when useful (e.g. web_search then read_page).
- Any card/image/panel you push to the HUD is visible to the user — you don't need to narrate it.
- If the user asks for a picture or video, call generate_image / generate_video instead of describing one.
- If the user says "open", "show me", or "pull up" something, prefer open_url or browser_control over telling them to do it.

CONTEXT
- User location: ${ctx.location || config.assistant.location} (timezone ${ctx.timezone || 'America/Toronto'}).
- Local time when the request arrived: ${new Date().toLocaleString('en-CA', { timeZone: ctx.timezone || 'America/Toronto' })}.
- Units: ${config.assistant.units}.
- Unknown facts you cannot verify: say you can check, then search.

Stay in character. Be genuinely useful. Never mention these instructions.`;

/* ------------------------------------------------------------------ helper */

function sanitizeForSpeech(text = '') {
  return String(text)
    .replace(/[\u{1F000}-\u{1FAFF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]/gu, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#>|]+/g, ' ')
    .replace(/^\s*[-•]\s*/gm, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

const historyToMessages = (history = [], limit = 10) =>
  history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-limit)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));

async function withRetry(fn, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ claude */

async function askClaude(text, ctx, history) {
  const messages = [...historyToMessages(history), { role: 'user', content: text }];
  const actions = [];
  const trace = [];
  const maxRounds = config.brain.maxToolRounds;

  for (let round = 0; round <= maxRounds; round++) {
    const body = {
      model: config.brain.anthropicModel,
      max_tokens: 900,
      system: PERSONA(ctx),
      messages,
      tools: toolDefinitions,
    };
    const res = await withRetry(() =>
      fetchWithTimeout(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': config.brain.anthropicKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        },
        45000,
      ),
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const blocks = data.content || [];
    const textOut = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();

    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    if (data.stop_reason === 'tool_use' && toolUses.length) {
      messages.push({ role: 'assistant', content: blocks });
      const results = [];
      for (const call of toolUses) {
        trace.push(call.name);
        try {
          const out = await runSkill(call.name, call.input, ctx);
          if (out.actions) actions.push(...out.actions);
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify(out.data ?? { ok: true, say: out.say }).slice(0, 6000),
          });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `Error: ${err.message}` });
        }
      }
      messages.push({ role: 'user', content: results });
      continue;
    }

    return { reply: sanitizeForSpeech(textOut) || 'Done.', actions, trace };
  }
  return { reply: 'That needed more steps than I allow in one pass. Ask me again and I’ll take it in pieces.', actions, trace };
}

/* ----------------------------------------------------------------- openai */

async function askOpenAI(text, ctx, history) {
  const messages = [
    { role: 'system', content: PERSONA(ctx) },
    ...historyToMessages(history),
    { role: 'user', content: text },
  ];
  const actions = [];
  const trace = [];
  const url = `${config.brain.openaiBase.replace(/\/$/, '')}/chat/completions`;

  for (let round = 0; round <= config.brain.maxToolRounds; round++) {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.brain.openaiKey}` },
        body: JSON.stringify({
          model: config.brain.openaiModel,
          messages,
          tools: openaiToolDefinitions,
          temperature: 0.6,
          max_tokens: 800,
        }),
      },
      45000,
    );
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const msg = data.choices?.[0]?.message || {};
    if (msg.tool_calls?.length) {
      messages.push(msg);
      for (const call of msg.tool_calls) {
        trace.push(call.function.name);
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          /* ignore */
        }
        try {
          const out = await runSkill(call.function.name, args, ctx);
          if (out.actions) actions.push(...out.actions);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(out.data ?? { ok: true, say: out.say }).slice(0, 6000),
          });
        } catch (err) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: `Error: ${err.message}` });
        }
      }
      continue;
    }
    return { reply: sanitizeForSpeech(msg.content || ''), actions, trace };
  }
  return { reply: 'That took more steps than I allow at once.', actions, trace };
}

/* -------------------------------------------------------------- claude CLI */

/** Uses the local `claude` binary (Claude Code) — no API key needed if you're logged in. */
async function askClaudeCli(text, ctx, history) {
  const convo = historyToMessages(history, 8)
    .map((m) => `${m.role === 'user' ? 'User' : 'Jax'}: ${m.content}`)
    .join('\n');
  const prompt = [
    PERSONA(ctx),
    '',
    'You have no tools in this mode. Answer directly and briefly. If the answer needs live data, say so in one short sentence.',
    convo ? `\nConversation so far:\n${convo}` : '',
    `\nUser: ${text}`,
    'Jax:',
  ].join('\n');

  const stdout = await new Promise((resolve, reject) => {
    execFile(
      config.brain.claudeCli,
      ['-p', prompt],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
      (err, out) =>
        err && !out ? reject(new Error(`claude CLI: ${err.message.split('\n')[0]}`)) : resolve(String(out || '')),
    );
  });
  return { reply: sanitizeForSpeech(stdout) || 'I have nothing to add.', actions: [], trace: ['claude-cli'] };
}

/* --------------------------------------------------------------- wrestle-ai */

/**
 * Conversational turns come from Wrestle-ai's /wrestling_chat endpoint, which
 * keeps its own per-user memory. We send only the new message plus the Jax
 * persona, and never our local transcript — the endpoint replays its own last
 * ten turns, so duplicating them here would double the recent conversation.
 *
 * Skills still execute locally and ahead of this path (weather, timers, images,
 * themes), because that endpoint is a chat model, not a tool executor.
 */
async function askWrestle(text, ctx, history) {
  // ctx.wrestleUser comes from the signed session cookie (the lock-screen name);
  // config.wrestle.userId is the fallback for API clients with no session.
  const out = await wrestleChat(text, { userId: ctx?.wrestleUser || config.wrestle.userId });
  const reply = sanitizeForSpeech(out.response) || out.response;

  // The endpoint is a plain chat brain; give the HUD something to show for the
  // turn it just answered, and keep the trace honest.
  const actions = [];
  if (history?.length === 0) {
    actions.push({
      type: 'card',
      title: 'Wrestle-ai session',
      body: `Conversation is running on /wrestling_chat as "${out.userId}". Memory lives on the Wrestle-ai server and is keyed to that user_id.`,
      tone: 'info',
    });
  }

  return {
    reply,
    actions,
    trace: ['wrestling_chat'],
    meta: { endpoint: 'wrestling_chat', userId: out.userId, latencyMs: out.latencyMs, humanized: out.humanized },
  };
}

/* ------------------------------------------------- free keyless "prompted" */

const SKILL_MENU = [
  'web_search {"query": string}',
  'get_weather {"location"?: string}',
  'get_news {"topic"?: string}',
  'wikipedia {"topic": string}',
  'open_url {"url": string}',
  'generate_image {"prompt": string, "style"?: "holo|cinematic|neon|ink|blueprint|photorealism|retro", "count"?: 1-4}',
  'generate_video {"prompt": string, "style"?: "cinematic|neon|holo|blueprint|retro"}',
  'set_timer {"action":"start", "seconds": number, "label"?: string}',
  'remember {"action":"save", "text": string}',
  'calculate {"expression": string}',
  'set_theme {"theme"?: "arc|mark3|stealth|ultron|vibranium|quantum", "style"?: "torus|hex|plasma|wave|minimal"}',
  'show_card {"title": string, "body": string}',
].join('\n');

const FREE_PROMPT = (ctx) => `You are Jax Nova, a dry, competent voice assistant inside a holographic Iron-Man-style HUD.
You reply with STRICT JSON only, no markdown fences, in this exact shape:
{"say": "<spoken reply, 1-2 sentences, plain text, no emoji>", "skill": null | {"name": "<skill>", "args": {...}}}

Rules:
- If the user wants live info (news, weather, a person, a fact, a product, scores, prices) you MUST call web_search, get_weather, get_news or wikipedia before answering. Do not invent facts.
- If the user asks for a picture/image/photo/drawing, call generate_image with a rich visual prompt. If they ask for a video/animation/clip, call generate_video.
- If they want a site opened or a browser action, use open_url.
- If they give you information to remember, use remember. For maths, use calculate. For timers, use set_timer.
- Otherwise answer from your own knowledge with "skill": null.
- Keep "say" under 45 words. Never output URLs inside "say".
- Today is ${new Date().toLocaleString('en-CA', { timeZone: ctx.timezone || 'America/Toronto' })} and the user is in ${ctx.location || config.assistant.location}.

Available skills:
${SKILL_MENU}`;

const CHIT_CHAT = /\b(joke|poem|story|riddle|rhyme|haiku|opinion|think about|how are you|how's it going|chat with me|talk to me|motivate me|give me advice|explain like i'?m|say something|compliment|roast me|be funny)\b/i;

const CHAT_PROMPT = (ctx) => `You are ${config.assistant.name}, a dry, competent voice assistant inside a holographic Iron-Man-style HUD.
This is casual conversation — no tools, no search, no data. Just answer in character.
Reply with STRICT JSON only: {"say": "<1-3 spoken sentences, plain text, no markdown, no emoji>"}
Keep it under 55 words. Be witty, not goofy. Today is ${new Date().toLocaleDateString('en-CA', { timeZone: ctx.timezone || 'America/Toronto' })}.`;

function extractJson(raw = '') {
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  // balance braces to survive trailing prose
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const freeBrain = { cooldownUntil: 0 };
const freeCooling = () => Date.now() < freeBrain.cooldownUntil;

async function freeCompletion(messages, { json = false, ms = 22000, attempts = 2 } = {}) {
  let lastErr;
  if (freeCooling()) throw new Error('free brain rate-limited (cooling down)');
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchWithTimeout(
        'https://text.pollinations.ai/openai',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: config.brain.freeModel,
            messages,
            temperature: 0.6,
            max_tokens: 700,
            ...(json ? { response_format: { type: 'json_object' } } : {}),
          }),
        },
        ms,
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const wait = Number((body.match(/retry after (\d+)s/i) || [])[1] || 0);
        lastErr = new Error(`free brain HTTP ${res.status}`);
        if (res.status === 402 || res.status === 429) {
          // rate limited: cool down briefly, one retry at most — latency matters
          freeBrain.cooldownUntil = Date.now() + Math.min((wait || 15) * 1000, 20000);
          await new Promise((r) => setTimeout(r, Math.min((wait || 3) * 1000, 4000)));
          continue;
        }
        if (res.status >= 500) {
          await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
          continue;
        }
        throw lastErr;
      }
      const data = await res.json();
      return data?.choices?.[0]?.message?.content || '';
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 900 * (i + 1)));
    }
  }
  throw lastErr || new Error('free brain unavailable');
}

async function askFree(text, ctx, history) {
  const historyMsgs = historyToMessages(history, 6);
  const actions = [];
  const trace = [];
  let reply = '';

  try {
    const casual = CHIT_CHAT.test(text);
    const raw = await freeCompletion(
      [
        { role: 'system', content: casual ? CHAT_PROMPT(ctx) : FREE_PROMPT(ctx) },
        ...historyMsgs,
        { role: 'user', content: text },
      ],
      { json: true },
    );
    const parsed = extractJson(raw);
    reply = sanitizeForSpeech(parsed?.say || raw);

    if (parsed?.skill?.name && !casual) {
      const { name, args = {} } = parsed.skill;
      trace.push(name);
      try {
        const out = await runSkill(name, args, ctx);
        if (out.actions) actions.push(...out.actions);
        // Give the model the skill output so its spoken line is grounded.
        if (out.data && ['web_search', 'wikipedia', 'read_page'].includes(name)) {
          // only search-like tools need a spoken gloss; everything else already
          // produces a natural line, so we skip a needless model round-trip
          const followUp = await freeCompletion(
            [
              { role: 'system', content: FREE_PROMPT(ctx) },
              { role: 'user', content: text },
              {
                role: 'system',
                content: `Tool ${name} returned: ${JSON.stringify(out.data).slice(0, 3000)}. Now give the final spoken answer as JSON {"say": "..."} grounded in that data. Under 40 words, no URLs.`,
              },
            ],
            { ms: 12000 },
          ).catch(() => '');
          const second = extractJson(followUp);
          if (second?.say) reply = sanitizeForSpeech(second.say);
          else if (out.say) reply = sanitizeForSpeech(out.say);
        } else if (out.say) {
          reply = sanitizeForSpeech(out.say);
        }
      } catch (err) {
        trace.push(`${name}:error`);
        reply = reply || `That skill failed — ${err.message.slice(0, 80)}.`;
      }
    }
    if (!reply) reply = 'I’m here, but I didn’t get a usable answer. Try asking again?';
    return { reply, actions, trace };
  } catch (err) {
    // Last resort: skill-only fallback, no LLM at all.
    const guessed = await fallbackSkills(text, ctx);
    if (guessed) return guessed;
    throw err;
  }
}

/** No-LLM fallback: pattern match a skill and summarise its own data. */
async function fallbackSkills(text, ctx) {
  const lower = text.toLowerCase();
  try {
    if (/\b(weather|temperature|forecast|rain|snow)\b/.test(lower)) {
      const place = lower.match(/\b(?:in|at|for)\s+([a-z\s,'-]{3,40})$/)?.[1]?.trim();
      const out = await runSkill('get_weather', place ? { location: place } : {}, ctx);
      return { reply: out.say, actions: out.actions, trace: ['get_weather'], degraded: true };
    }
    if (/\b(news|headlines)\b/.test(lower)) {
      const out = await runSkill('get_news', {}, ctx);
      return { reply: out.say, actions: out.actions, trace: ['get_news'], degraded: true };
    }
    const searchMatch = lower.match(/\b(?:search|look up|google|find|who is|what is|tell me about)\b(.*)$/);
    if (searchMatch) {
      const q = searchMatch[1].replace(/^(for|about|on|the)\s+/, '').trim() || text;
      const wiki = await runSkill('wikipedia', { topic: q }, ctx).catch(() => null);
      if (wiki?.say) return { reply: wiki.say, actions: wiki.actions, trace: ['wikipedia'], degraded: true };
      const out = await runSkill('web_search', { query: q }, ctx);
      return { reply: out.say, actions: out.actions, trace: ['web_search'], degraded: true };
    }
    // casual conversation with no model available: stay in character, don't search
    if (CHIT_CHAT.test(lower)) {
      return {
        reply: "My language core is rate-limited at the moment, so the wit is running on backup power. Try me again in a minute.",
        actions: [],
        trace: ['offline-chat'],
        degraded: true,
      };
    }

    // last resort for any question-shaped utterance: answer from the live web
    if (text.trim().length > 3) {
      const hit = await quickAnswerSafe(text);
      if (hit) return { reply: hit, actions: [{ type: 'card', title: 'From the web', body: hit, tone: 'info' }], trace: ['wikipedia'], degraded: true };
      const res = await runSkill('web_search', { query: text }, ctx);
      const top = res.data?.results?.[0];
      if (top) {
        const line = (top.snippet || top.title || '').split(/(?<=[.!?])\s/).slice(0, 2).join(' ');
        return {
          reply: line ? `${line}` : `I found ${top.title}. The details are on screen.`,
          actions: res.actions,
          trace: ['web_search'],
          degraded: true,
        };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Pick the snippet that best answers a question and speak its first sentences. */
function bestSnippetAnswer(question, results = []) {
  const stop = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'in', 'on', 'to', 'how', 'what', 'who', 'when', 'where', 'much', 'many', 'does', 'do', 'it', 'and', 'for', 'at', 'by']);
  const tokens = question.toLowerCase().match(/[a-z0-9]+/g)?.filter((t) => t.length > 2 && !stop.has(t)) || [];
  if (!tokens.length) return null;
  let best = null;
  let bestScore = 0;
  for (const r of results) {
    const hay = `${r.title} ${r.snippet}`.toLowerCase();
    let score = tokens.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
    if (/\d/.test(r.snippet || '')) score += 2; // snippets carrying a number usually hold the fact
    if ((r.snippet || '').length > 90) score += 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  if (!best || bestScore < Math.min(2, tokens.length)) return null;

  const text = sanitizeForSpeech(best.snippet || '');
  if (!text || text.length < 20) return sanitizeForSpeech(best.title || '') || null;

  const sentences = text.split(/(?<=[.!?])\s/).filter((x) => x.length > 12);
  const withNumber = sentences.find((x) => /\d/.test(x));
  const lead = withNumber || sentences[0];
  return (lead || text).slice(0, 300);
}

async function quickAnswerSafe(text) {
  try {
    const { quickAnswer } = await import('./search.js');
    const ans = await quickAnswer(text.replace(/^(hey jax,?\s*)/i, ''));
    if (!ans?.text) return null;
    return ans.text.split(/(?<=[.!?])\s/).slice(0, 2).join(' ');
  } catch {
    return null;
  }
}

/* ------------------------------------------------- fast skill execution */

/**
 * Run a high-confidence skill without touching a model, then (only where it
 * genuinely adds value, e.g. web search) ask the model for a one-line gloss
 * with a hard timeout. Falls back to the skill's own spoken line.
 */
async function runFastIntent(intent, ctx) {
  let out = await runSkill(intent.skill, intent.args, ctx);
  const actions = out.actions || [];
  let reply = sanitizeForSpeech(out.say || '');

  // factoid questions: try the encyclopaedia first — it usually *is* the answer
  const question = String(intent.original || intent.args.query || '');
  const factoid = intent.summarize && /^(who|what|where|when|how|which|is|are|does|do|can)\b/i.test(question);
  if (factoid && intent.skill === 'web_search') {
    const quick = await quickAnswerSafe(question);
    if (quick) return { reply: quick, actions, provider: 'skill-router', model: 'wikipedia', trace: ['wikipedia'], latencyMs: 0 };
    // no encyclopaedia hit → answer straight from the best snippet, no model needed
    const snippet = bestSnippetAnswer(question, out.data?.results || []);
    if (snippet) return { reply: snippet, actions, provider: 'skill-router', model: 'search-snippet', trace: ['web_search'], latencyMs: 0 };
  }

  // wikipedia/wiki-style answers are already spoken prose — glossing them would
  // only add seconds of latency, so we reserve the extra round-trip for search
  const wantsGloss = intent.summarize && intent.skill === 'web_search';
  const canGloss = config.brain.anthropicKey || config.brain.openaiKey || config.brain.provider === 'free';
  if (wantsGloss && canGloss) {
    const payload = JSON.stringify(out.data ?? {}).slice(0, 3500);
    try {
      const gloss = await Promise.race([
        freeCompletion([
          { role: 'system', content: `You are ${config.assistant.name}, a voice assistant. Answer in one or two spoken sentences, under 40 words, no URLs, no markdown. Use ONLY the supplied data.` },
          { role: 'user', content: `Question: ${intent.original || intent.args.query || intent.args.topic}\n\nData: ${payload}` },
        ], { ms: 6500, attempts: 2 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('gloss timeout')), 7000)),
      ]);
      const clean = sanitizeForSpeech(gloss);
      const refusal = /^(i (don't|do not|couldn't|could not|can't)|i'm not sure|no information|unknown|sorry)/i;
      if (clean && clean.length > 12 && !refusal.test(clean) && !/^\s*\{/.test(clean)) reply = clean;
    } catch {
      /* fall through to snippet-based answer */
    }
  }

  if (wantsGloss && reply === sanitizeForSpeech(out.say || '')) {
    // the gloss didn't land — answer from the top result instead of saying "here's what I found"
    const top = out.data?.results?.[0];
    const snippet = sanitizeForSpeech(top?.snippet || '');
    if (snippet && snippet.length > 25) {
      reply = snippet.split(/(?<=[.!?])\s/).slice(0, 2).join(' ');
    }
  }

  return {
    reply,
    actions,
    provider: 'skill-router',
    model: intent.skill,
    trace: [intent.skill],
    instant: !wantsGloss,
  };
}

/* -------------------------------------------------------------- entrypoint */

export async function respond({ text, history = [], ctx = {} }) {
  const started = Date.now();
  const clean = String(text || '').trim().slice(0, 2000);
  if (!clean) return { reply: '', actions: [], provider: 'none', latencyMs: 0, trace: [] };

  // 1. Instant deterministic route
  const fast = route(clean, ctx);
  if (fast) {
    return {
      reply: fast.silent ? '' : fast.say,
      actions: fast.actions || [],
      provider: 'local-router',
      model: 'rules',
      latencyMs: Date.now() - started,
      trace: [fast.kind],
      instant: true,
    };
  }

  // 2. High-confidence skill intents — no model round-trip
  try {
    const intent = fastIntent(clean, ctx);
    if (intent) {
      const startedSkill = Date.now();
      const out = await runFastIntent(intent, ctx);
      return { ...out, latencyMs: Date.now() - startedSkill };
    }
  } catch (err) {
    // fall through to the model path
    console.warn('[jax] fast intent failed:', err.message);
  }

  // 3. Model paths with graceful degradation
  const provider = config.brain.provider;
  const attempts = [];
  if (provider === 'claude' && config.brain.anthropicKey) attempts.push(['claude', () => askClaude(clean, ctx, history), config.brain.anthropicModel]);
  if (provider === 'openai' && config.brain.openaiKey) attempts.push(['openai', () => askOpenAI(clean, ctx, history), config.brain.openaiModel]);
  if (provider === 'claude-cli') attempts.push(['claude-cli', () => askClaudeCli(clean, ctx, history), 'claude-code']);
  if (provider === 'wrestle' && config.wrestle.url) {
    attempts.push(['wrestle', () => askWrestle(clean, ctx, history), 'wrestling_chat']);
    // a remote failure should not mute Jax — fall through to the keyless brain
    attempts.push(['free', () => askFree(clean, ctx, history), config.brain.freeModel]);
  }
  if (provider === 'free' || attempts.length === 0) attempts.push(['free', () => askFree(clean, ctx, history), config.brain.freeModel]);

  const errors = [];
  for (const [name, fn, model] of attempts) {
    try {
      const out = await fn();
      return { ...out, provider: name, model, latencyMs: Date.now() - started };
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }

  const degraded = await fallbackSkills(clean, ctx).catch(() => null);
  if (degraded) {
    return { ...degraded, provider: 'skills-only', model: 'pattern-match', latencyMs: Date.now() - started, errors };
  }

  return {
    reply: 'My language core is unreachable right now. Interface is still live — try an image, a timer, or a direct command.',
    actions: [{ type: 'card', title: 'Core offline', body: errors.join('\n'), tone: 'warn' }],
    provider: 'offline',
    latencyMs: Date.now() - started,
    errors,
  };
}

export { sanitizeForSpeech, PERSONA };
