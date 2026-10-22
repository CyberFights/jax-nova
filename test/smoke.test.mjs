/**
 * Jax Nova test suite — no network, no keys.
 *
 * Covers the layers that must keep working on every commit:
 *   · pure units (router, intents, calculator, speech shaping)
 *   · an HTTP smoke test against a real server process, including the
 *     access-code gate and rate limiting
 *
 * Run with: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { route } from '../server/router.js';
import { fastIntent } from '../server/intents.js';
import { calculate } from '../server/skills.js';
import { sanitizeForSpeech } from '../server/brain.js';
import { splitSentences, parseRss, slugify, clamp } from '../server/util.js';
import { proceduralSvg } from '../server/media.js';

const ROOT = path.resolve(import.meta.dirname, '..');

/* ─────────────────────────────────────────────────────────────── utilities */

test('calculator handles natural phrasing', () => {
  assert.equal(calculate('18% of 240'), 43.2);
  assert.equal(calculate('what is 12 times 8'), 96);
  assert.equal(calculate('sqrt(144) + 10'), 22);
  assert.ok(Math.abs(calculate('2^10') - 1024) < 1e-9);
  assert.equal(calculate('(3 + 4) * 2'), 14);
  assert.throws(() => calculate('make me a sandwich'));
});

test('speech sanitiser strips markdown, urls and emoji', () => {
  const out = sanitizeForSpeech('**Bold** [link](https://example.com) 🚀 and `code`');
  assert.ok(!out.includes('**'));
  assert.ok(!out.includes('http'));
  assert.ok(!out.includes('🚀'));
  assert.ok(out.includes('Bold'));
});

test('sentence splitter keeps chunks speakable', () => {
  const chunks = splitSentences(
    'First sentence here. Second one is a little longer, and carries a comma clause. Third!',
  );
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((c) => c.length > 0 && c.length < 400));
});

test('rss parser reads items and strips markup', () => {
  const xml = `<rss><channel>
    <item><title>Hello &amp; welcome</title><link>https://example.com/a</link>
    <description>Some &lt;b&gt;bold&lt;/b&gt; text</description></item>
  </channel></rss>`;
  const items = parseRss(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Hello & welcome');
  assert.equal(items[0].link, 'https://example.com/a');
  assert.equal(items[0].description, 'Some bold text');
});

test('misc helpers behave', () => {
  assert.equal(slugify('A Holographic City!! '), 'a-holographic-city');
  assert.equal(clamp(120, 0, 100), 100);
  const svg = proceduralSvg('test prompt', 7, 'neon').toString();
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('LOCAL SCHEMATIC RENDER'));
});

/* ────────────────────────────────────────────────────────────────── router */

test('local router answers instantly without a model', () => {
  assert.match(route('hey jax').say, /online|reactor|systems/i);
  assert.equal(route('set a timer for 5 minutes').actions[0].type, 'timer');
  assert.equal(route('set a timer for 5 minutes').actions[0].seconds, 300);
  assert.equal(route('set a timer for 90 seconds').actions[0].seconds, 90);
  assert.equal(route('switch to stealth theme').actions[0].theme, 'stealth');
  assert.equal(route('reactor plasma').actions[0].style, 'plasma');
  assert.equal(route('remember to call Sam').actions[0].type, 'note');
  assert.equal(route('go fullscreen').actions[0].action, 'fullscreen');
  assert.equal(route('what can you do').actions[0].type, 'help');
});

test('local router declines open-ended questions', () => {
  assert.equal(route('what is the airspeed velocity of an unladen swallow'), null);
  assert.equal(route('tell me about the history of the arc reactor'), null);
});

/* ───────────────────────────────────────────────────────────────── intents */

test('high-confidence intents map to the right skills', () => {
  assert.equal(fastIntent("what's the weather").skill, 'get_weather');
  assert.equal(fastIntent('weather in Tokyo').args.location, 'Tokyo');
  assert.equal(fastIntent('top headlines').skill, 'get_news');
  assert.equal(fastIntent('news about SpaceX').args.topic, 'SpaceX');
  assert.equal(fastIntent('open github.com').args.url, 'github.com');
  assert.equal(fastIntent('draw a neon dragon').skill, 'generate_image');
  assert.equal(fastIntent('draw a neon dragon').args.style, 'neon');
  assert.equal(fastIntent('make me a picture of an owl, blueprint style').args.style, 'blueprint');
  assert.equal(fastIntent('generate a video of a reactor').skill, 'generate_video');
  assert.equal(fastIntent('search for the latest launch').skill, 'web_search');
  assert.equal(fastIntent('who is Ada Lovelace').skill, 'wikipedia');
});

test('intents do not hijack conversation', () => {
  assert.equal(fastIntent('what do you think about coffee'), null);
  assert.equal(fastIntent('tell me a joke'), null);
  assert.equal(fastIntent('how are you'), null);
  assert.equal(fastIntent('thanks, that was helpful'), null);
});

/* ─────────────────────────────────────────────────────────── http smoke test */

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(env = {}) {
  const port = await freePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jax-test-'));
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      JAX_DATA_DIR: dataDir,
      JAX_BRAIN: 'free',
      // keep the suite offline: no external calls should be needed by these tests
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return { base, child, dataDir, port, log: () => output };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start in 15s:\n${output}`);
}

async function stopServer(handle) {
  handle.child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 250));
  await fs.rm(handle.dataDir, { recursive: true, force: true });
}

test('server: health, static assets and the HUD shell', async () => {
  const srv = await startServer();
  try {
    const health = await (await fetch(`${srv.base}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.service, 'jax-nova');
    assert.equal(health.locked, false);

    const index = await fetch(`${srv.base}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.ok(html.includes('JAX NOVA'));
    assert.ok(html.includes('/js/app.js'));

    for (const asset of ['/css/hud.css', '/js/app.js', '/js/audio.js', '/js/reactor.js', '/js/hud.js']) {
      const res = await fetch(`${srv.base}${asset}`);
      assert.equal(res.status, 200, `${asset} should be served`);
    }

    const caps = await (await fetch(`${srv.base}/api/capabilities`)).json();
    assert.equal(caps.locked, undefined);
    assert.equal(caps.brain.provider, 'free');
    assert.ok(caps.skills.length >= 15);
  } finally {
    await stopServer(srv);
  }
});

test('server: router answers come back without a model call', async () => {
  const srv = await startServer();
  try {
    const ask = async (text) => {
      const res = await fetch(`${srv.base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, timezone: 'America/Toronto' }),
      });
      assert.equal(res.status, 200);
      return res.json();
    };

    const greeting = await ask('hey jax');
    assert.equal(greeting.provider, 'local-router');
    assert.ok(greeting.reply.length > 0);

    const timer = await ask('set a timer for 2 minutes');
    assert.equal(timer.actions[0].type, 'timer');
    assert.equal(timer.actions[0].seconds, 120);

    const theme = await ask('switch to ultron theme');
    assert.equal(theme.actions[0].theme, 'ultron');
    assert.ok(theme.latencyMs < 1000, 'router answers should be effectively instant');
  } finally {
    await stopServer(srv);
  }
});

test('server: access code gates the API but not the shell', async () => {
  const srv = await startServer({ JAX_ACCESS_CODE: 'arc-reactor-42' });
  try {
    // the HTML shell stays public so the lock screen can render
    assert.equal((await fetch(`${srv.base}/`)).status, 200);

    // health stays open for platform healthchecks
    assert.equal((await fetch(`${srv.base}/api/health`)).status, 200);

    const lockedCaps = await (await fetch(`${srv.base}/api/capabilities`)).json();
    assert.equal(lockedCaps.locked, true);
    assert.equal(lockedCaps.requiresCode, true);

    const blocked = await fetch(`${srv.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hey jax' }),
    });
    assert.equal(blocked.status, 401);

    const wrong = await fetch(`${srv.base}/api/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'nope' }),
    });
    assert.equal(wrong.status, 401);

    const good = await fetch(`${srv.base}/api/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'arc-reactor-42' }),
    });
    assert.equal(good.status, 200);
    const cookie = good.headers.get('set-cookie');
    assert.ok(cookie && cookie.includes('jax_pass='), 'should issue a session cookie');
    assert.ok(cookie.includes('HttpOnly'), 'session cookie must be HttpOnly');

    const authed = await fetch(`${srv.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie.split(';')[0] },
      body: JSON.stringify({ text: 'hey jax' }),
    });
    assert.equal(authed.status, 200);
    assert.equal((await authed.json()).provider, 'local-router');
  } finally {
    await stopServer(srv);
  }
});

test('server: rate limiter trips and reports Retry-After', async () => {
  const srv = await startServer({ JAX_RATE_LIMIT: '3' });
  try {
    const hit = () =>
      fetch(`${srv.base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hey jax' }),
      });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await hit()).status);
    assert.ok(statuses.includes(429), `expected a 429 in ${statuses.join(',')}`);
    const limited = await hit();
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));

    // health is never rate limited
    assert.equal((await fetch(`${srv.base}/api/health`)).status, 200);
  } finally {
    await stopServer(srv);
  }
});

test('server: generated media is served from JAX_DATA_DIR', async () => {
  const srv = await startServer();
  try {
    const svg = proceduralSvg('data dir check', 3, 'holo');
    await fs.writeFile(path.join(srv.dataDir, 'probe.svg'), svg);
    const res = await fetch(`${srv.base}/generated/probe.svg`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /svg/);
    assert.ok((await res.text()).includes('<svg'));

    const listing = await (await fetch(`${srv.base}/api/generated`)).json();
    assert.ok(listing.files.some((f) => f.url === '/generated/probe.svg'));

    // path traversal must not escape the data dir
    const traversal = await fetch(`${srv.base}/generated/..%2f..%2fpackage.json`);
    assert.notEqual(traversal.status, 200);
  } finally {
    await stopServer(srv);
  }
});

/* ─────────────────────────────────────────────── wrestle-ai bridge (stubs) */

import http from 'node:http';
import { stripStageDirections, wrestleChat } from '../server/wrestle.js';
import { config } from '../server/config.js';

/**
 * config.js snapshots the environment at import time, so point its wrestle URL
 * at a local stub for the duration of a test and restore it afterwards.
 */
async function withWrestleUrl(url, fn) {
  const previous = config.wrestle.url;
  config.wrestle.url = url;
  try {
    return await fn();
  } finally {
    config.wrestle.url = previous;
  }
}

/** A stand-in for POST /wrestling_chat that records what Jax sends. */
async function startStubWrestle(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        /* leave empty */
      }
      seen.push({ method: req.method, url: req.url, body: parsed });
      handler(req, res, parsed, seen);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('stage directions are stripped from model output', () => {
  assert.equal(stripStageDirections('*smiles* Well hello there.'), 'Well hello there.');
  assert.equal(stripStageDirections('[grins] Nice to meet you.'), 'Nice to meet you.');
  assert.equal(stripStageDirections('**sighs** Fine.'), 'Fine.');
  assert.equal(stripStageDirections('Leans back. So, about that match…'), 'So, about that match…');
  assert.equal(stripStageDirections('Sure thing (mostly) — *shrugs* that works.'), 'Sure thing (mostly) — that works.');
  // legitimate parenthesis and ordinary sentences must survive
  assert.equal(stripStageDirections('Fine. Let us get to work.'), 'Fine. Let us get to work.');
  assert.ok(stripStageDirections('It shipped in (1998).').includes('(1998)'));
});

test('wrestleChat sends only the new message plus the persona', async () => {
  const stub = await startStubWrestle((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ response: '*nods* Not a chance, Jeremy.' }));
  });
  try {
    const out = await withWrestleUrl(stub.url, () =>
      wrestleChat('hello there', { userId: 'unit-test-user', timeoutMs: 5000 }),
    );
    assert.equal(out.userId, 'unit-test-user');
    assert.equal(out.response, 'Not a chance, Jeremy.');
    assert.equal(out.raw, '*nods* Not a chance, Jeremy.');

    const sent = stub.seen.at(-1);
    assert.equal(sent.method, 'POST');
    assert.equal(sent.url, '/wrestling_chat');
    assert.equal(sent.body.user_id, 'unit-test-user');
    assert.equal(sent.body.message, 'hello there');
    // the endpoint owns its history — we must never replay a transcript
    assert.equal(sent.body.history, undefined);
    assert.equal(sent.body.messages, undefined);
    // persona is sent, and it is the Jax Nova one
    assert.match(String(sent.body.system_p || ''), /Jax Nova/);
    assert.match(String(sent.body.system_p || ''), /shadowsnemesis/);
  } finally {
    await stub.close();
  }
});

test('wrestleChat surfaces endpoint errors instead of a blank reply', async () => {
  const stub = await startStubWrestle((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Mistral API error', details: 'upstream said no' }));
  });
  try {
    await assert.rejects(
      () =>
        withWrestleUrl(stub.url, () =>
          wrestleChat('hi', { userId: 'unit-test-user', timeoutMs: 5000 }),
        ),
      /wrestling_chat 500: upstream said no/,
    );
  } finally {
    await stub.close();
  }
});

test('server: wrestle brain answers through the bridge and keeps local skills', async () => {
  const stub = await startStubWrestle((req, res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ response: `You said: ${body.message}` }));
  });
  const srv = await startServer({
    JAX_BRAIN: 'wrestle',
    WRESTLE_AI_URL: stub.url,
    WRESTLE_USER_ID: 'smoke-user',
  });
  try {
    const health = await (await fetch(`${srv.base}/api/health`)).json();
    assert.equal(health.brain, 'wrestle');

    const res = await fetch(`${srv.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Tell me a story about your day.', history: [] }),
    });
    const out = await res.json();
    assert.equal(out.provider, 'wrestle');
    assert.ok(out.trace.includes('wrestling_chat'));
    assert.match(out.reply, /You said: Tell me a story about your day\./);

    // a card is offered on the first turn so the HUD can explain the bridge
    assert.ok(out.actions.some((a) => a.type === 'card' && /Wrestle-ai/.test(a.title)));

    // the transcript is never forwarded — only the new message
    const sent = stub.seen.at(-1);
    assert.equal(sent.body.user_id, 'smoke-user');
    assert.equal(sent.body.message, 'Tell me a story about your day.');
    assert.equal(sent.body.history, undefined);

    // local skills still answer without touching the bridge
    const before = stub.seen.length;
    const local = await (
      await fetch(`${srv.base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'set a timer for 5 minutes', history: [] }),
      })
    ).json();
    assert.equal(local.trace[0], 'timer');
    assert.equal(stub.seen.length, before, 'local skill must not call wrestling_chat');
  } finally {
    await stopServer(srv);
    await stub.close();
  }
});

test('server: the wrestle proxy reports the bridge state and errors cleanly', async () => {
  const stub = await startStubWrestle((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ response: 'Ready when you are.' }));
  });
  const srv = await startServer({ WRESTLE_AI_URL: stub.url, WRESTLE_USER_ID: 'probe-user' });
  try {
    const state = await (await fetch(`${srv.base}/api/wrestle/health`)).json();
    assert.equal(state.configured, true);
    assert.equal(state.endpoint, `${stub.url}/wrestling_chat`);
    assert.equal(state.userId, 'probe-user');

    const ok = await fetch(`${srv.base}/api/wrestle/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello bridge' }),
    });
    assert.equal(ok.status, 200);
    const payload = await ok.json();
    assert.equal(payload.response, 'Ready when you are.');
    assert.equal(payload.user_id, 'probe-user');
    assert.equal(stub.seen.at(-1).body.message, 'hello bridge');

    const empty = await fetch(`${srv.base}/api/wrestle/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    assert.equal(empty.status, 400);
  } finally {
    await stopServer(srv);
    await stub.close();
  }
});

/* ───────────────────────────────────────────── operator / session identity */

/** Unlock and return the raw session cookie value. */
async function unlock(base, body) {
  const res = await fetch(`${base}/api/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  const cookie = res.headers.getSetCookie?.().find((c) => c.startsWith('jax_')) || '';
  return { status: res.status, payload, cookie: cookie.split(';')[0] };
}

test('server: the lock-screen name becomes the wrestle user_id', async () => {
  const stub = await startStubWrestle((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ response: 'Noted.' }));
  });
  const srv = await startServer({
    JAX_ACCESS_CODE: 'test-code',
    JAX_BRAIN: 'wrestle',
    WRESTLE_AI_URL: stub.url,
    WRESTLE_USER_ID: 'server-default',
  });
  try {
    // locked: capabilities is a stub and chat is refused
    const stubCaps = await (await fetch(`${srv.base}/api/capabilities`)).json();
    assert.equal(stubCaps.locked, true);
    assert.equal(stubCaps.user, undefined);

    // a name is required to be sane
    const bad = await unlock(srv.base, { code: 'test-code', username: '!' });
    assert.equal(bad.status, 400);
    assert.match(bad.payload.error, /operator name/);

    const noCode = await unlock(srv.base, { code: 'nope', username: 'jeremy' });
    assert.equal(noCode.status, 401);

    // names are slugified so they are safe as a memory key
    const ok = await unlock(srv.base, { code: 'test-code', username: 'Jeremy Smith' });
    assert.equal(ok.payload.user, 'jeremy-smith');
    assert.equal(ok.payload.custom, true);

    const session = await (await fetch(`${srv.base}/api/session`, { headers: { cookie: ok.cookie } })).json();
    assert.equal(session.user, 'jeremy-smith');
    assert.equal(session.codeRequired, true);

    // capabilities reports the operator
    const caps = await (await fetch(`${srv.base}/api/capabilities`, { headers: { cookie: ok.cookie } })).json();
    assert.equal(caps.user, 'jeremy-smith');
    assert.equal(caps.userIsDefault, false);

    // and the turn is stored under that user_id, not the server default
    const chat = await fetch(`${srv.base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ok.cookie },
      body: JSON.stringify({ text: 'Tell me something long enough to bypass the router.', history: [] }),
    });
    assert.equal(chat.status, 200);
    assert.equal(stub.seen.at(-1).body.user_id, 'jeremy-smith');

    // switching name switches the memory key
    const switched = await fetch(`${srv.base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ok.cookie },
      body: JSON.stringify({ username: 'someone-else' }),
    });
    const nextCookie = switched.headers.getSetCookie().find((c) => c.startsWith('jax_')).split(';')[0];
    const after = await (await fetch(`${srv.base}/api/session`, { headers: { cookie: nextCookie } })).json();
    assert.equal(after.user, 'someone-else');

    // the signature is bound to the name: editing the cookie does not work
    const forged = `${ok.cookie.split('.').slice(0, -1).join('.')}.victim-account`;
    const tampered = await fetch(`${srv.base}/api/session`, { headers: { cookie: forged } });
    assert.equal(tampered.status, 401);
  } finally {
    await stopServer(srv);
    await stub.close();
  }
});

test('server: without an access code the name still selects a memory', async () => {
  const stub = await startStubWrestle((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ response: 'Ready.' }));
  });
  const srv = await startServer({ JAX_BRAIN: 'wrestle', WRESTLE_AI_URL: stub.url });
  try {
    const anon = await (await fetch(`${srv.base}/api/session`)).json();
    assert.equal(anon.user, 'jax-nova');
    assert.equal(anon.codeRequired, false);

    const open = await unlock(srv.base, { username: 'open-mode-user' });
    assert.equal(open.status, 200);
    assert.equal(open.payload.user, 'open-mode-user');

    const res = await fetch(`${srv.base}/api/wrestle/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: open.cookie },
      body: JSON.stringify({ message: 'who am i' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user_id, 'open-mode-user');
    assert.equal(stub.seen.at(-1).body.user_id, 'open-mode-user');

    // an explicit user_id still overrides the session for API clients
    const explicit = await fetch(`${srv.base}/api/wrestle/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: open.cookie },
      body: JSON.stringify({ message: 'hi', user_id: 'explicit-client' }),
    });
    assert.equal((await explicit.json()).user_id, 'explicit-client');
  } finally {
    await stopServer(srv);
    await stub.close();
  }
});
