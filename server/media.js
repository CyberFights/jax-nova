/**
 * Media skills — image + "holo-motion" video synthesis.
 *
 * Keyless by default, behind a provider ladder that degrades gracefully:
 *
 *   1. FLUX.1-schnell / FLUX.1-dev on Hugging Face ZeroGPU Spaces
 *      (keyless, ~3-6s, excellent quality — subject to a daily free GPU quota)
 *   2. Pollinations (keyless, 1 free generation / 45s per IP)
 *   3. OpenAI images (only when OPENAI_API_KEY is set)
 *   4. Local procedural SVG schematic (always instant, clearly labelled)
 *
 * Results are cached on disk by prompt so repeats are instant, and each
 * provider gets a cooldown after a quota/rate error so we don't stall.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { fetchWithTimeout } from './util.js';

const POLLINATIONS = 'https://image.pollinations.ai/prompt/';
const POLLEN_TOKEN = (process.env.POLLINATIONS_TOKEN || '').trim();

export const STYLE_PRESETS = {
  holo: 'holographic projection, cyan and gold volumetric light, sci-fi HUD overlay, dark background, cinematic',
  cinematic: 'cinematic still, dramatic rim lighting, shallow depth of field, 35mm film, atmospheric',
  neon: 'neon cyberpunk, rain-slick streets, magenta and teal glow, high contrast',
  ink: 'elegant ink and watercolour illustration, fine linework, parchment texture',
  blueprint: 'technical blueprint schematic, white line art on blue print paper, annotations',
  photorealism: 'photorealistic, natural light, 50mm lens, sharp focus, high detail',
  retro: '1980s airbrush poster art, chrome, gradients, grain',
};

const HF_SPACES = [
  {
    name: 'flux-schnell',
    base: 'https://black-forest-labs-flux-1-schnell.hf.space',
    params: (prompt, seed, w, h) => [prompt, seed, false, w, h, 4],
  },
  {
    name: 'flux-dev',
    base: 'https://black-forest-labs-flux-1-dev.hf.space',
    params: (prompt, seed, w, h) => [prompt, seed, false, w, h, 3.5, 12],
  },
];

const cooldown = { hf: 0, pollinations: 0 };
const now = () => Date.now();

const buildPrompt = (prompt, style, extra = '') =>
  [prompt, STYLE_PRESETS[style] || '', extra].filter(Boolean).join(', ');

/* ------------------------------------------------------------------ cache */

const cacheDir = () => path.join(config.generatedDir, 'cache');

function cacheKey(text, width, height) {
  return crypto.createHash('sha1').update(`${text}|${width}x${height}`).digest('hex').slice(0, 20);
}

async function readCache(key) {
  try {
    const dir = cacheDir();
    const file = (await fs.readdir(dir)).find((f) => f.startsWith(key));
    if (!file) return null;
    const stat = await fs.stat(path.join(dir, file));
    if (now() - stat.mtimeMs > 1000 * 60 * 60 * 24 * 7) return null; // 7 day freshness
    return `/generated/cache/${file}`;
  } catch {
    return null;
  }
}

async function writeCache(key, buffer, ext) {
  try {
    const dir = cacheDir();
    await fs.mkdir(dir, { recursive: true });
    const filename = `${key}.${ext}`;
    await fs.writeFile(path.join(dir, filename), buffer);
    return `/generated/cache/${filename}`;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- storage */

async function saveBuffer(buf, ext, label = 'img') {
  const filename = `${Date.now()}-${label}.${ext}`;
  await fs.mkdir(config.generatedDir, { recursive: true });
  await fs.writeFile(path.join(config.generatedDir, filename), buf);
  return `/generated/${filename}`;
}

/** True when the media directory is actually writable (volume mounted + owned). */
export async function storageWritable() {
  try {
    await fs.mkdir(config.generatedDir, { recursive: true });
    const probe = path.join(config.generatedDir, `.probe-${process.pid}`);
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------- providers */

async function fluxSpace(space, prompt, { width, height, seed }) {
  if (cooldown.hf > now()) throw new Error('flux cooling down');
  const submit = await fetchWithTimeout(
    `${space.base}/gradio_api/call/infer`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: space.params(prompt, seed, width, height) }),
    },
    30000,
  );
  if (!submit.ok) throw new Error(`${space.name} submit ${submit.status}`);
  const { event_id: eventId } = await submit.json();
  if (!eventId) throw new Error(`${space.name}: no event id`);

  const stream = await fetchWithTimeout(`${space.base}/gradio_api/call/infer/${eventId}`, {}, 120000);
  const text = await stream.text();

  if (/exceeded your ZeroGPU quota|GPU quota/i.test(text)) {
    cooldown.hf = now() + 1000 * 60 * 10; // back off 10 minutes
    throw new Error('ZeroGPU quota exhausted');
  }
  if (/event:\s*error/.test(text)) throw new Error(`${space.name} worker error`);

  const match = text.match(/data:\s*(\[[\s\S]*?\])(?:\s*\n|$)/);
  if (!match) throw new Error(`${space.name}: unreadable response`);
  const payload = JSON.parse(match[1]);
  const url = payload?.[0]?.url;
  if (!url || !/^https?:/.test(url)) throw new Error(`${space.name}: no image url`);

  const img = await fetchWithTimeout(url, {}, 45000);
  if (!img.ok) throw new Error(`${space.name} download ${img.status}`);
  const mime = img.headers.get('content-type') || 'image/webp';
  const ext = mime.includes('png') ? 'png' : mime.includes('jpeg') ? 'jpg' : 'webp';
  const buf = Buffer.from(await img.arrayBuffer());
  if (buf.length < 3000) throw new Error(`${space.name}: empty image`);
  return { buf, ext };
}

async function fluxProvider(prompt, opts) {
  let lastErr;
  for (const space of HF_SPACES) {
    try {
      const { buf, ext } = await fluxSpace(space, prompt, opts);
      return { buf, ext, provider: space.name };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('flux unavailable');
}

async function pollinations(prompt, { width, height, seed }) {
  if (cooldown.pollinations > now()) {
    const wait = cooldown.pollinations - now();
    if (wait > 12000) throw new Error(`pollinations cooling down (${Math.ceil(wait / 1000)}s)`);
  }
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    seed: String(seed),
    model: 'flux',
    nologo: 'true',
    referrer: 'jax-nova',
  });
  if (POLLEN_TOKEN) params.set('token', POLLEN_TOKEN);
  const res = await fetchWithTimeout(
    `${POLLINATIONS}${encodeURIComponent(prompt)}?${params}`,
    { headers: { 'User-Agent': 'JaxNova/1.0' } },
    75000,
  );
  if (!res.ok) {
    let detail = `pollinations ${res.status}`;
    try {
      const body = await res.json();
      detail = body?.error?.message || detail;
      if (/FREE_LIMIT|limit reached/i.test(detail)) cooldown.pollinations = now() + 1000 * 10;
    } catch { /* keep default */ }
    throw new Error(detail);
  }
  const mime = res.headers.get('content-type') || 'image/jpeg';
  if (!mime.startsWith('image/')) throw new Error(`pollinations returned ${mime}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 3000) throw new Error('pollinations: empty image');
  return { buf, ext: mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg', provider: 'pollinations' };
}

async function openaiProvider(prompt, { seed }) {
  const base = config.brain.openaiBase.replace(/\/$/, '');
  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
  const res = await fetchWithTimeout(
    `${base}/images/generations`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.brain.openaiKey}` },
      body: JSON.stringify({ model, prompt, n: 1, size: '1024x1024' }),
    },
    120000,
  );
  if (!res.ok) throw new Error(`openai image ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const item = data.data?.[0];
  if (item?.b64_json) return { buf: Buffer.from(item.b64_json, 'base64'), ext: 'png', provider: 'openai' };
  if (item?.url) {
    const img = await fetchWithTimeout(item.url, {}, 45000);
    if (!img.ok) throw new Error(`openai image download ${img.status}`);
    return { buf: Buffer.from(await img.arrayBuffer()), ext: 'png', provider: 'openai' };
  }
  throw new Error('openai image: empty response');
}

/* ------------------------------------------- local procedural fallback */

function proceduralSvg(prompt, seed = 1, style = 'holo') {
  const rand = (n) => {
    const x = Math.sin(seed * 9301 + n * 49297) * 233280;
    return x - Math.floor(x);
  };
  const palettes = {
    holo: ['#5ff3ff', '#ffb545', '#04121a'],
    cinematic: ['#ffc25c', '#ff5545', '#120a06'],
    neon: ['#ff7ad9', '#5ff3ff', '#0b0416'],
    ink: ['#e8e2d4', '#9aa7ff', '#0c0b09'],
    blueprint: ['#8ecbff', '#ffffff', '#04101f'],
    photorealism: ['#cfe8ff', '#ffd9a0', '#0a0c0e'],
    retro: ['#ffb545', '#ff5fa2', '#150a14'],
  };
  const [a, b, bg] = palettes[style] || palettes.holo;
  const rings = Array.from({ length: 10 }, (_, i) => {
    const r = 58 + i * 32 + rand(i) * 16;
    const dash = i % 2 ? `${8 + rand(i + 3) * 22} ${12 + rand(i + 7) * 30}` : 'none';
    return `<circle cx="512" cy="512" r="${r.toFixed(0)}" fill="none" stroke="${i % 3 ? a : b}" stroke-width="${(1.7 - i * 0.11).toFixed(2)}" stroke-dasharray="${dash}" opacity="${(0.92 - i * 0.075).toFixed(2)}" transform="rotate(${(rand(i + 11) * 360).toFixed(1)} 512 512)"/>`;
  }).join('');
  const spokes = Array.from({ length: 28 }, (_, i) => {
    const ang = (i / 28) * Math.PI * 2 + rand(i) * 0.1;
    const r1 = 140 + rand(i) * 40;
    const r2 = r1 + 40 + rand(i + 5) * 150;
    return `<line x1="${(512 + Math.cos(ang) * r1).toFixed(1)}" y1="${(512 + Math.sin(ang) * r1).toFixed(1)}" x2="${(512 + Math.cos(ang) * r2).toFixed(1)}" y2="${(512 + Math.sin(ang) * r2).toFixed(1)}" stroke="${a}" stroke-width="1" opacity="0.3"/>`;
  }).join('');
  const grid = Array.from({ length: 17 }, (_, i) =>
    `<line x1="0" y1="${i * 64}" x2="1024" y2="${i * 64}"/><line x1="${i * 64}" y1="0" x2="${i * 64}" y2="1024"/>`,
  ).join('');
  const caption = String(prompt).slice(0, 82).replace(/[<>&]/g, '').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <radialGradient id="g" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.96"/>
      <stop offset="16%" stop-color="${a}" stop-opacity="0.9"/>
      <stop offset="50%" stop-color="${a}" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="${bg}" stop-opacity="0"/>
    </radialGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="1024" height="1024" fill="${bg}"/>
  <g opacity="0.16" stroke="${a}" stroke-width="0.6">${grid}</g>
  <circle cx="512" cy="512" r="330" fill="url(#g)"/>
  <g filter="url(#glow)">${spokes}${rings}</g>
  <circle cx="512" cy="512" r="52" fill="#ffffff" opacity="0.92"/>
  <circle cx="512" cy="512" r="86" fill="none" stroke="${b}" stroke-width="2" opacity="0.8"/>
  <text x="512" y="946" fill="${a}" font-family="monospace" font-size="19" text-anchor="middle" letter-spacing="5" opacity="0.85">${caption}</text>
  <text x="512" y="978" fill="${b}" font-family="monospace" font-size="13" text-anchor="middle" letter-spacing="8" opacity="0.6">LOCAL SCHEMATIC RENDER</text>
</svg>`;
  return Buffer.from(svg, 'utf8');
}

/* ------------------------------------------------------------------ public */

async function renderOne(fullPrompt, opts) {
  const { width, height, seed, style } = opts;
  const health = opts.health || { flux: true, pollinations: true, openai: true };
  const key = cacheKey(fullPrompt, width, height);
  const cached = await readCache(key);
  if (cached) return { url: cached, provider: 'cache', seed };

  const errors = [];
  const ladder = [];
  if (health.flux) ladder.push(['flux', () => fluxProvider(fullPrompt, opts)]);
  if (health.pollinations) {
    ladder.push([
      'pollinations',
      async () => {
        try {
          return await pollinations(fullPrompt, opts);
        } catch (err) {
          if (!/limit|cooling|402/i.test(err.message)) throw err;
          await new Promise((r) => setTimeout(r, 3000));
          return pollinations(fullPrompt, opts);
        }
      },
    ]);
  }
  if (config.brain.openaiKey && health.openai) ladder.push(['openai', () => openaiProvider(fullPrompt, opts)]);

  for (const [name, fn] of ladder) {
    try {
      const { buf, ext, provider } = await fn();
      const saved = await writeCache(key, buf, ext);
      const url = saved || (await saveBuffer(buf, ext, 'gen'));
      return { url, provider: provider || name, seed };
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
      // short-circuit the rest of this batch once a provider is clearly down
      if (name === 'flux' && /quota|unavailable|cooling|worker error|no image/i.test(err.message)) {
        health.flux = false;
      }
      if (name === 'pollinations' && /limit|cooling|402|403/i.test(err.message)) {
        health.pollinations = false;
      }
      if (name === 'openai') health.openai = false;
    }
  }

  const svgBuf = proceduralSvg(fullPrompt, seed, style);
  let url;
  try {
    url = await saveBuffer(svgBuf, 'svg', 'schematic');
  } catch {
    // read-only or full volume: hand the browser an inline SVG instead of failing
    url = `data:image/svg+xml;base64,${svgBuf.toString('base64')}`;
  }
  return {
    url,
    provider: 'local-schematic',
    seed,
    errors,
    note: 'Image providers were unavailable or rate-limited — rendered a local holographic schematic instead.',
  };
}

/** Generate one or more images → [{url, provider, seed, note?}] */
export async function generateImages({ prompt, style = 'holo', count = 1, width = 1024, height = 1024 }) {
  const n = Math.min(Math.max(1, Number(count) || 1), 4);
  const seedBase = Math.floor(Math.random() * 900000) + 1000;
  const full = buildPrompt(prompt, style);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(await renderOne(full, { seed: seedBase + i * 37, width, height, style }));
    // small stagger keeps the free endpoints from rejecting a burst
    if (i < n - 1) await new Promise((r) => setTimeout(r, 350));
  }
  return out;
}

/**
 * "Holo-motion" — a short looping sequence built from consistent keyframes
 * (wide → push in → detail → hero), animated in the HUD with crossfade,
 * grain and a scan sweep so it reads as a cinematic clip.
 */
const MOTION_BEATS = [
  'wide establishing shot',
  'slow push in, closer framing',
  'dramatic detail close-up',
  'pull back, final hero shot',
  'macro detail, shallow focus',
];

export async function generateVideo({ prompt, style = 'cinematic', frames = 4, width = 960, height = 540 }) {
  const n = Math.min(Math.max(2, Number(frames) || 4), 4);
  const seedBase = Math.floor(Math.random() * 900000) + 1000;
  const health = { flux: true, pollinations: true, openai: true };
  const out = [];
  for (let i = 0; i < n; i++) {
    const beat = MOTION_BEATS[i];
    const full = buildPrompt(prompt, style, beat);
    out.push({ ...(await renderOne(full, { seed: seedBase + i * 19, width, height, style, health })), beat });
  }
  return out;
}

export { proceduralSvg };
