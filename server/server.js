/**
 * Jax Nova — local server.
 * No npm dependencies. Node 18+ (20+ recommended).
 *
 *   npm start   →  http://localhost:8787
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, capabilities, lockedCapabilities, ROOT } from './config.js';
import { storageWritable } from './media.js';
import { wrestleChat, wrestleHealth, wrestleConfig, stripStageDirections } from './wrestle.js';
import { respond, sanitizeForSpeech } from './brain.js';
import { runSkill, skills } from './skills.js';
import { splitSentences } from './util.js';
import os from 'node:os';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const JSON_LIMIT = 8 * 1024 * 1024; // generated frame sets can be chunky
const log = (...a) => console.log('\x1b[36m[jax]\x1b[0m', ...a);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

async function readBody(req, limit = JSON_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

/* --------------------------------------------------------- access control */

const SESSION_COOKIE = 'jax_pass';
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

function safeEqual(a = '', b = '') {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Operator name from the lock screen. It is a *memory selector*, not an
 * identity: anyone holding the access code can claim any name. What it buys is
 * a separate Wrestle-ai conversation (its MongoDB is keyed by user_id) and a
 * distinguishable HUD, so several people can share one deployment without
 * talking over each other.
 */
const USER_RE = /^[a-z0-9][a-z0-9._-]{1,47}$/;

function normalizeUser(raw) {
  const slug = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^\.+|\.+$/g, '');
  return USER_RE.test(slug) ? slug : '';
}

/** Opaque session value derived from the access code — never the code itself. */
function sessionToken() {
  return crypto.createHmac('sha256', config.accessCode).update('jax-nova-session-v1').digest('hex');
}

/** Signature bound to the operator name, so a cookie cannot be edited to claim another memory. */
function userToken(user) {
  return crypto
    .createHmac('sha256', config.accessCode || 'jax-nova-open')
    .update(`jax-nova-session-v2:${user}`)
    .digest('hex');
}

/**
 * Cookie shape: `<sig>.<user>`. A bare legacy token (no dot) still validates and
 * simply carries no operator, so sessions issued before this existed keep working.
 */
function sessionFrom(req) {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return { authorized: !config.accessCode, user: '' };
  const cut = raw.lastIndexOf('.');
  if (cut === -1) {
    return { authorized: safeEqual(raw, sessionToken()), user: '' };
  }
  const sig = raw.slice(0, cut);
  const user = raw.slice(cut + 1);
  if (!user) return { authorized: safeEqual(sig, sessionToken()), user: '' };
  return { authorized: safeEqual(sig, userToken(user)), user: normalizeUser(user) };
}

/** The Wrestle-ai memory key for this request. */
function sessionUser(req) {
  return sessionFrom(req).user;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthorized(req, url) {
  if (!config.accessCode) return true;
  if (sessionFrom(req).authorized) return true;
  const fromHeader = req.headers['x-jax-code'];
  if (fromHeader && safeEqual(fromHeader, config.accessCode)) return true;
  const fromQuery = url?.searchParams?.get('code');
  return Boolean(fromQuery && safeEqual(fromQuery, config.accessCode));
}

function setSessionCookie(res, req, user = '') {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') || config.deployed;
  const value = user ? `${userToken(user)}.${user}` : sessionToken();
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/* ------------------------------------------------------------ rate limiting */

const buckets = new Map();

function clientIp(req) {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/** Returns { ok, retryAfter } — a simple fixed-window counter per IP. */
function checkRate(ip, cost = 1) {
  if (!config.rateLimit || config.rateLimit <= 0) return { ok: true };
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || now > bucket.reset) {
    bucket = { count: 0, reset: now + 60_000 };
    buckets.set(ip, bucket);
  }
  bucket.count += cost;
  if (buckets.size > 5000) {
    for (const [key, b] of buckets) if (now > b.reset) buckets.delete(key);
  }
  return bucket.count > config.rateLimit
    ? { ok: false, retryAfter: Math.ceil((bucket.reset - now) / 1000) }
    : { ok: true };
}

/* ------------------------------------------------------------------ static */

async function serveGenerated(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/generated\/?/, '');
  const full = path.join(config.generatedDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(config.generatedDir)) return send(res, 403, 'Forbidden');
  return sendFile(req, res, full, 'public, max-age=31536000, immutable');
}

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const full = path.join(config.publicDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(config.publicDir)) return send(res, 403, 'Forbidden');
  return sendFile(req, res, full, full.includes(`${path.sep}generated${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
}

async function sendFile(req, res, full, cacheControl) {

  try {
    const stat = await fs.stat(full);
    if (stat.isDirectory()) return send(res, 404, 'Not found');
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fsSync.createReadStream(full).pipe(res);
  } catch {
    send(res, 404, 'Not found');
  }
}

/* ---------------------------------------------------------------- elevenlabs */

const EL_BASE = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // "Adam" — warm, neutral
let cachedVoiceId = config.eleven.voiceId || null;

async function resolveVoiceId() {
  if (cachedVoiceId) return cachedVoiceId;
  try {
    const res = await fetch(`${EL_BASE}/voices`, { headers: { 'xi-api-key': config.eleven.key } });
    if (res.ok) {
      const data = await res.json();
      const voices = data?.voices || [];
      const preferred =
        voices.find((v) => /british|george|daniel|adam|brian/i.test(`${v.name} ${v.labels?.accent || ''}`)) ||
        voices[0];
      if (preferred?.voice_id) {
        cachedVoiceId = preferred.voice_id;
        return cachedVoiceId;
      }
    }
  } catch {
    /* fall through */
  }
  cachedVoiceId = DEFAULT_VOICE;
  return cachedVoiceId;
}

async function elevenTTS(text, { voiceId, model } = {}) {
  const id = voiceId || (await resolveVoiceId());
  const res = await fetch(`${EL_BASE}/text-to-speech/${id}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': config.eleven.key, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: model || config.eleven.model,
      voice_settings: { stability: 0.42, similarity_boost: 0.78, style: 0.3, use_speaker_boost: true },
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`ElevenLabs TTS ${res.status}: ${err.slice(0, 240)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function elevenSTT(buffer, filename = 'speech.webm', mimetype = 'audio/webm') {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }), filename);
  form.append('model_id', config.eleven.sttModel);
  form.append('tag_audio_events', 'false');
  form.append('diarize', 'false');
  const res = await fetch(`${EL_BASE}/speech-to-text`, {
    method: 'POST',
    headers: { 'xi-api-key': config.eleven.key },
    body: form,
  });
  if (!res.ok) throw new Error(`ElevenLabs STT ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const data = await res.json();
  return (data.text || '').trim();
}

/* ----------------------------------------------------------------- API routes */

async function handleApi(req, res, pathname, url) {
  const method = req.method;
  const ip = clientIp(req);

  // health is always open — Railway's healthcheck needs it before auth exists
  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'jax-nova',
      version: process.env.npm_package_version || '1.0.0',
      uptime: Math.round(process.uptime()),
      node: process.version,
      brain: capabilities().brain.provider,
      locked: Boolean(config.accessCode),
      // a Railway volume that arrived root-owned shows up here immediately
      storage: (await storageWritable()) ? 'writable' : 'read-only',
    });
  }

  // unlocking is open, but tightly rate limited to slow brute force attempts
  if (pathname === '/api/unlock' && method === 'POST') {
    const attempt = checkRate(`unlock:${ip}`, 1);
    if (!attempt.ok) {
      return sendJson(res, 429, { error: 'too many attempts', retryAfter: attempt.retryAfter }, { 'Retry-After': String(attempt.retryAfter) });
    }
    const body = await readJson(req).catch(() => ({}));
    const rawUser = body.username ?? body.user ?? body.user_id;
    let user = '';
    if (rawUser !== undefined && String(rawUser).trim() !== '') {
      user = normalizeUser(rawUser);
      if (!user) {
        return sendJson(res, 400, {
          error: 'operator name must be 2–48 characters: letters, numbers, dot, dash or underscore',
        });
      }
    }

    // open mode still stores the name — it is how a public instance keeps
    // several Wrestle-ai conversations apart
    if (!config.accessCode) {
      if (user) setSessionCookie(res, req, user);
      return sendJson(res, 200, { ok: true, required: false, user: user || config.wrestle.userId });
    }

    const code = String(body.code || body.accessCode || '').trim();
    if (!code || !safeEqual(code, config.accessCode)) {
      return sendJson(res, 401, { error: 'invalid access code', locked: true });
    }
    setSessionCookie(res, req, user);
    return sendJson(res, 200, {
      ok: true,
      required: true,
      user: user || config.wrestle.userId,
      custom: Boolean(user),
    });
  }

  // the HUD asks who it is talking as, and can switch without re-entering the code
  if (pathname === '/api/session') {
    if (!isAuthorized(req, url)) return sendJson(res, 401, { error: 'locked', locked: true });
    if (method === 'POST') {
      const rl = checkRate(`session:${ip}`, 1);
      if (!rl.ok) {
        return sendJson(res, 429, { error: 'rate limited', retryAfter: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });
      }
      const body = await readJson(req).catch(() => ({}));
      const raw = body.username ?? body.user;
      if (String(raw || '').trim() === '') {
        setSessionCookie(res, req, '');
        return sendJson(res, 200, { ok: true, user: config.wrestle.userId, custom: false });
      }
      const user = normalizeUser(raw);
      if (!user) {
        return sendJson(res, 400, {
          error: 'operator name must be 2–48 characters: letters, numbers, dot, dash or underscore',
        });
      }
      setSessionCookie(res, req, user);
      return sendJson(res, 200, { ok: true, user, custom: true });
    }
    return sendJson(res, 200, {
      user: sessionUser(req) || config.wrestle.userId,
      custom: Boolean(sessionUser(req)),
      default: config.wrestle.userId,
      codeRequired: Boolean(config.accessCode),
    });
  }

  // capabilities answers either way: a locked stub without a session, the full
  // report with one — the HUD needs this to render the lock screen correctly
  if (pathname === '/api/capabilities') {
    if (!isAuthorized(req, url)) return sendJson(res, 200, lockedCapabilities());
    const caps = capabilities();
    caps.user = sessionUser(req) || config.wrestle.userId;
    caps.userIsDefault = !sessionUser(req);
    caps.skills = skills.map((s) => ({ name: s.name, description: s.description, schema: s.schema }));
    caps.host = { platform: os.platform(), node: process.version };
    return sendJson(res, 200, caps);
  }

  // everything below this line requires the access code when one is configured
  if (!isAuthorized(req, url)) {
    return sendJson(res, 401, { error: 'locked', locked: true });
  }

  if (pathname === '/api/chat' && method === 'POST') {
    const rl = checkRate(ip, 1);
    if (!rl.ok) {
      return sendJson(res, 429, { error: 'rate limited', retryAfter: rl.retryAfter, reply: 'I need a moment — try again in a few seconds.' }, { 'Retry-After': String(rl.retryAfter) });
    }
    const started = Date.now();
    const body = await readJson(req);
    const text = String(body.text || '').slice(0, 2000);
    if (!text.trim()) return sendJson(res, 400, { error: 'empty text' });
    const ctx = {
      timezone: body.timezone || 'America/Toronto',
      location: body.location || config.assistant.location,
      lat: body.lat ?? null,
      lon: body.lon ?? null,
      capabilities: capabilities(),
      // which Wrestle-ai memory this turn belongs to
      wrestleUser: sessionUser(req) || config.wrestle.userId,
    };
    log(`◂ "${text}"`);
    try {
      const out = await respond({ text, history: body.history || [], ctx });
      log(`▸ ${out.provider}/${out.model || '-'} ${out.latencyMs}ms — ${out.reply.slice(0, 90)}`);
      return sendJson(res, 200, {
        ...out,
        sentences: splitSentences(out.reply),
        totalMs: Date.now() - started,
        capabilities: capabilities(),
      });
    } catch (err) {
      log('chat error:', err.message);
      return sendJson(res, 500, { error: err.message, reply: 'My core hit an error. Say that again?' });
    }
  }

  if (pathname === '/api/skill' && method === 'POST') {
    const body = await readJson(req);
    if (!body.name) return sendJson(res, 400, { error: 'name required' });
    try {
      const out = await runSkill(body.name, body.args || {}, {
        timezone: body.timezone,
        location: body.location || config.assistant.location,
        wrestleUser: sessionUser(req) || config.wrestle.userId,
      });
      return sendJson(res, 200, out);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // ── Wrestle-ai bridge ──────────────────────────────────────────────────
  // A thin, auth-gated proxy in front of POST /wrestling_chat: the HUD uses it
  // for testing and other local clients (wrestlestory, scripts) can too.
  if (pathname === '/api/wrestle/health') {
    return sendJson(res, 200, { ...wrestleConfig(), ...(await wrestleHealth()) });
  }

  if (pathname === '/api/wrestle/chat' && method === 'POST') {
    const rl = checkRate(ip, 1);
    if (!rl.ok) {
      return sendJson(
        res,
        429,
        { error: 'rate limited', retryAfter: rl.retryAfter },
        { 'Retry-After': String(rl.retryAfter) },
      );
    }
    const body = await readJson(req);
    const message = String(body.message || body.text || '').slice(0, 4000);
    if (!message.trim()) return sendJson(res, 400, { error: 'message required' });
    try {
      const out = await wrestleChat(message, {
        userId: body.user_id || sessionUser(req) || undefined,
        systemPrompt: body.system_p,
        humanize: body.humanize,
      });
      return sendJson(res, 200, {
        response: out.response,
        raw: out.raw,
        user_id: out.userId,
        latency_ms: out.latencyMs,
        humanized: out.humanized,
        source: 'wrestle-ai /wrestling_chat',
      });
    } catch (err) {
      log('wrestle error:', err.message);
      return sendJson(res, 502, { error: err.message });
    }
  }

  if (pathname === '/api/tts' && method === 'POST') {
    const rl = checkRate(ip, 1);
    if (!rl.ok) return sendJson(res, 429, { error: 'rate limited', retryAfter: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });
    if (!config.eleven.key) return sendJson(res, 501, { error: 'elevenlabs-not-configured' });
    const body = await readJson(req);
    const text = sanitizeForSpeech(body.text || '').slice(0, 2500);
    if (!text) return sendJson(res, 400, { error: 'empty text' });
    try {
      const audio = await elevenTTS(text, { voiceId: body.voiceId, model: body.model });
      return send(res, 200, audio, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audio.length,
        'X-Voice-Engine': 'elevenlabs',
      });
    } catch (err) {
      log('tts error:', err.message);
      return sendJson(res, 502, { error: err.message });
    }
  }

  if (pathname === '/api/tts/voices') {
    if (!config.eleven.key) return sendJson(res, 200, { voices: [], selected: null });
    try {
      const r = await fetch(`${EL_BASE}/voices`, { headers: { 'xi-api-key': config.eleven.key } });
      const data = await r.json();
      return sendJson(res, 200, {
        voices: (data.voices || []).map((v) => ({
          id: v.voice_id,
          name: v.name,
          labels: v.labels,
          preview: v.preview_url,
        })),
        selected: await resolveVoiceId(),
      });
    } catch (err) {
      return sendJson(res, 502, { error: err.message });
    }
  }

  if (pathname === '/api/stt' && method === 'POST') {
    const rl = checkRate(ip, 1);
    if (!rl.ok) return sendJson(res, 429, { error: 'rate limited', retryAfter: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });
    if (!config.eleven.key) return sendJson(res, 501, { error: 'elevenlabs-not-configured' });
    const buf = await readBody(req, 25 * 1024 * 1024);
    if (buf.length < 1200) return sendJson(res, 400, { error: 'audio too short' });
    const type = req.headers['content-type'] || 'audio/webm';
    try {
      const text = await elevenSTT(buf, type.includes('wav') ? 'speech.wav' : 'speech.webm', type.split(';')[0]);
      return sendJson(res, 200, { text });
    } catch (err) {
      log('stt error:', err.message);
      return sendJson(res, 502, { error: err.message });
    }
  }

  if (pathname === '/api/generated') {
    try {
      const files = (await fs.readdir(config.generatedDir)).filter((f) => /\.(jpg|jpeg|png|webp|gif|svg)$/i.test(f));
      const withStats = await Promise.all(
        files.map(async (f) => {
          const s = await fs.stat(path.join(config.generatedDir, f));
          return { url: `/generated/${f}`, mtime: s.mtimeMs, size: s.size };
        }),
      );
      withStats.sort((a, b) => b.mtime - a.mtime);
      return sendJson(res, 200, { files: withStats.slice(0, 60) });
    } catch {
      return sendJson(res, 200, { files: [] });
    }
  }

  return sendJson(res, 404, { error: 'unknown endpoint' });
}

/* -------------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url.pathname, url);
    if (url.pathname.startsWith('/generated/')) return await serveGenerated(req, res, url.pathname);
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    log('unhandled:', err.stack || err.message);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

async function ensureDirs() {
  await fs.mkdir(config.generatedDir, { recursive: true });
  if (!fsSync.existsSync(path.join(config.publicDir, 'index.html'))) {
    console.error('Missing public/index.html — is the project complete?');
  }
}

await ensureDirs();

server.listen(config.port, config.host, () => {
  const caps = capabilities();
  const bar = '─'.repeat(56);
  console.log(`\n\x1b[36m${bar}\x1b[0m`);
  console.log(`  \x1b[1m◉ ${caps.name.toUpperCase()}\x1b[0m  — holographic voice interface`);
  console.log(`\x1b[36m${bar}\x1b[0m`);
  console.log(`  HUD        http://localhost:${config.port}`);
  console.log(`  Brain      ${caps.brain.provider}  (${caps.brain.model})`);
  console.log(`  Voice out  ${caps.voice.elevenlabs ? 'ElevenLabs' : 'browser speech synthesis'}`);
  console.log(`  Voice in   ${caps.voice.elevenlabs ? 'ElevenLabs Scribe' : 'browser SpeechRecognition'}`);
  console.log(`  Wake word  "${caps.wakeWord}"`);
  console.log(`  Storage    ${config.generatedDir}`);
  console.log(`  Access     ${config.accessCode ? 'access code required' : 'open (no code set)'}`);
  console.log(`  Rate limit ${config.rateLimit ? `${config.rateLimit} req/min per IP` : 'off'}`);
  console.log(`  Folder     ${ROOT}`);
  if (!caps.voice.elevenlabs) {
    console.log(`\n  \x1b[33mTip:\x1b[0m add ELEVENLABS_API_KEY=... to .env for a natural voice.`);
  }
  if (caps.brain.provider === 'free') {
    console.log(`  \x1b[33mTip:\x1b[0m running keyless. Add ANTHROPIC_API_KEY=... for Claude tool-use.`);
  }
  if (config.deployed && !config.accessCode) {
    console.log(`\n  \x1b[31mWarning:\x1b[0m public deployment with no JAX_ACCESS_CODE — anyone with the URL can use your keys.`);
  }
  const nets = os.networkInterfaces();
  const lan = Object.values(nets)
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  if (lan.length) {
    console.log(`  LAN        http://${lan[0]}:${config.port}  \x1b[2m(typing only — mic needs localhost/https)\x1b[0m`);
  }
  console.log(`\n  \x1b[2mOpen in Chrome or Edge and click the reactor to wake Jax.\x1b[0m`);
  console.log(`  \x1b[2mVoice needs Chrome/Edge on http://localhost or an https origin.\x1b[0m\n`);
});

const shutdown = () => {
  log('powering down…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
