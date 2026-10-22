/**
 * Jax Nova — application controller.
 * Wires the reactor, voice engine, HUD and skill actions into one state machine.
 */

import { Reactor } from './reactor.js';
import { Hud } from './hud.js';
import { Talker, Listener, MicMeter } from './audio.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`jax.${k}`);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    localStorage.setItem(`jax.${k}`, JSON.stringify(v));
  },
};

const settings = {
  theme: store.get('theme', 'arc'),
  style: store.get('style', 'torus'),
  density: store.get('density', 'tactical'),
  wakeWord: store.get('wakeWord', 'hey jax'),
  rate: store.get('rate', 1),
  pitch: store.get('pitch', 0.95),
  autoListen: store.get('autoListen', true),
  speak: store.get('speak', true),
  reactive: store.get('reactive', true),
  particles: store.get('particles', true),
};

const app = {
  caps: null,
  history: [],
  busy: false,
  awake: false,
  asleep: false,
  listening: false,
  speaking: false,
  wakeEnabled: false,
  muted: false,
  geo: null,
  user: '', // operator name → Wrestle-ai memory key
};

/* ────────────────────────────────────────────────────────────── components */

const reactor = new Reactor($('#reactor'));
const hud = new Hud({
  onTimerDone: (label) => {
    talker.chime('alert');
    say(`Time's up. ${label}.`);
    hud.log(`timer complete · ${label}`, 'timer');
  },
  onTheme: (theme) => setTheme(theme),
});
const mic = new MicMeter();
hud.onSpectrum = (arr) => {
  if (mic.enabled) mic.spectrum(arr);
  else arr.fill(0);
};

const talker = new Talker({
  elevenlabs: false,
  onLevel: (v) => {
    reactor.setLevel(v);
    hud.setOutput(v);
    hud.setLiveLevel(v);
    document.body.style.setProperty('--level', v.toFixed(3));
  },
  onState: (s) => {
    if (s === 'speaking') {
      app.speaking = true;
      document.body.classList.add('speaking');
      setState('speaking');
      listener.pause();
    } else if (s === 'silent') {
      app.speaking = false;
      document.body.classList.remove('speaking');
      if (app.wakeEnabled && !app.asleep) {
        listener.resume();
        setState(listener.mode === 'command' ? 'listening' : 'idle');
      } else {
        setState('idle');
      }
    }
  },
  onError: (msg) => {
    hud.log(`tts · ${msg}`, 'err');
    hud.toast('Voice engine hiccup — using browser voice', 'warn');
  },
});

const listener = new Listener({
  wakeWords: [settings.wakeWord, 'hey jax', 'jax', 'hey nova', 'nova'].filter(Boolean),
  onWake: ({ at }) => {
    if (app.asleep) return;
    talker.stop();
    talker.chime('wake');
    hud.log('wake word detected', 'wake');
    setState('listening');
    flashReactor();
    if (app.caps?.voice?.elevenlabs) {
      /* ElevenLabs mode still uses browser recognition for the wake word only */
    }
    window.__lastWake = at;
  },
  onInterim: (text) => {
    const node = $('#interim');
    if (!text) {
      node.hidden = true;
    } else {
      node.hidden = false;
      node.querySelector('.interim-text').textContent = text;
    }
  },
  onCommand: (text) => send(text, 'voice'),
  onStateChange: (state) => {
    if (state === 'off') {
      app.wakeEnabled = false;
      $('#btnWake').classList.add('off');
      hud.setStateLabel('idle');
      return;
    }
    const listening = state === 'command';
    app.listening = listening;
    document.body.classList.toggle('listening', listening);
    if (!app.speaking) setState(listening ? 'listening' : 'idle');
  },
  onError: (code) => {
    if (code === 'unsupported') {
      hud.log('browser speech recognition unavailable', 'err');
      hud.toast('No speech recognition in this browser — use Chrome/Edge or type', 'warn');
      $('#btnWake').classList.add('off');
    } else if (code === 'not-allowed' || code === 'service-not-allowed') {
      app.wakeEnabled = false;
      $('#btnWake').classList.add('off');
      hud.toast('Microphone blocked — allow mic access and press WAKE', 'warn');
      hud.log('microphone permission denied', 'err');
    } else if (code === 'network') {
      hud.log('recognition network hiccup — retrying', 'err');
    }
  },
});

/* ───────────────────────────────────────────────────────────────── state */

function setState(state) {
  app.state = state;
  document.body.classList.remove('listening', 'thinking', 'speaking');
  if (state === 'listening') document.body.classList.add('listening');
  if (state === 'thinking') document.body.classList.add('thinking');
  if (state === 'speaking') document.body.classList.add('speaking');
  reactor.setState(state === 'listening' ? 'listening' : state === 'thinking' ? 'thinking' : state === 'speaking' ? 'speaking' : 'idle');
  hud.setStateLabel(state);
}

/* mic reactivity: the reactor breathes with the user's voice while listening */
setInterval(() => {
  if (!app.listening || app.speaking || !mic.enabled) return;
  const level = mic.level;
  reactor.setLevel(level);
  hud.setOutput(level);
  hud.setLiveLevel(level);
  document.body.style.setProperty('--level', level.toFixed(3));
}, 60);

function flashReactor() {
  const flare = $('#fxFlare');
  flare.classList.add('on');
  setTimeout(() => flare.classList.remove('on'), 520);
}

/* ────────────────────────────────────────────────────────────────── theme */

function applyTheme({ theme = settings.theme, style = settings.style, density = settings.density }) {
  settings.theme = theme;
  settings.style = style;
  settings.density = density;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.style = style;
  document.documentElement.dataset.density = density;
  reactor.setStyle(style);
  reactor.readColors();
  $$('#themeSwatches .swatch').forEach((s) => s.classList.toggle('active', s.dataset.theme === theme));
  $('#styleSelect').value = style;
  $('#densitySelect').value = density;
  store.set('theme', theme);
  store.set('style', style);
  store.set('density', density);
}

function setTheme(theme, style, density) {
  applyTheme({
    theme: theme || settings.theme,
    style: style || settings.style,
    density: density || settings.density,
  });
  hud.log(`theme → ${settings.theme} / ${settings.style}`, 'ui');
}

/* ─────────────────────────────────────────────────────────────────- speech */

function revealText(node, text, speed = 9) {
  node.classList.add('streaming');
  let i = 0;
  const step = Math.max(2, Math.round(text.length / 90));
  const timer = setInterval(() => {
    i += step;
    node.textContent = text.slice(0, i);
    if (i >= text.length) {
      clearInterval(timer);
      node.textContent = text;
      node.classList.remove('streaming');
    }
  }, speed);
  return timer;
}

function say(text, { speak = true } = {}) {
  if (!text) return;
  const wrap = $('#utteranceJax');
  wrap.hidden = false;
  const p = wrap.querySelector('p');
  revealText(p, text);
  if (speak && settings.speak && !app.muted) {
    talker.speak(text);
  }
  hud.log(`jax · ${text.slice(0, 52)}${text.length > 52 ? '…' : ''}`, 'say');
}

function showUser(text) {
  const wrap = $('#utteranceUser');
  wrap.hidden = false;
  wrap.querySelector('p').textContent = text;
}

/* ─────────────────────────────────────────────────────────────────- actions */

function handleAction(action = {}) {
  switch (action.type) {
    case 'results':
      hud.showResults(action);
      break;
    case 'card':
      hud.showCard(action);
      break;
    case 'weather':
      hud.showWeather(action);
      break;
    case 'news':
      hud.showNews(action);
      break;
    case 'image':
      hud.showImages(action);
      break;
    case 'video':
      hud.showMotion(action);
      break;
    case 'timer':
      if (action.action === 'start') hud.startTimer(action);
      else if (action.action === 'cancel') hud.cancelTimers();
      else if (action.action === 'list') {
        const n = hud.timers.size;
        hud.showCard({ title: 'Active timers', body: n ? `${n} running.` : 'No timers armed.', tone: 'info' });
      }
      break;
    case 'note':
      if (action.action === 'save') {
        hud.addNote(action.text);
        hud.toast('Note saved');
      } else {
        hud.showCard({
          title: 'Memory bank',
          subtitle: `${hud.notes.length} entries`,
          items: hud.notes.slice(0, 10).map((n) => `${new Date(n.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${n.text}`),
          body: hud.notes.length ? '' : 'Nothing saved yet. Say “remember to…”',
        });
      }
      break;
    case 'status':
      hud.showStatus(app.caps);
      break;
    case 'theme':
      setTheme(action.theme, action.style, action.density);
      break;
    case 'help':
      hud.showHelp();
      break;
    case 'clear':
      hud.clear();
      break;
    case 'open':
      openExternal(action.url, action.label, action.mode);
      break;
    case 'ui':
      uiAction(action.action, action.direction);
      break;
    default:
      if (action.title) hud.showCard(action);
  }
}

function openExternal(url, label, mode = 'tab') {
  if (!url) return;
  hud.log(`open ${label || url}`, 'net');
  if (mode === 'panel') {
    hud.showCard({ title: label || url, subtitle: 'external link', body: url, url, tone: 'info' });
    return;
  }
  const win = window.open(url, '_blank', 'noopener');
  if (!win) {
    hud.toast('Popup blocked — link added to display', 'warn');
    hud.showCard({ title: label || 'Open link', subtitle: 'blocked by browser', body: url, url, tone: 'warn' });
  }
}

function uiAction(action, direction) {
  switch (action) {
    case 'fullscreen':
      document.documentElement.requestFullscreen?.().catch(() => hud.toast('Fullscreen refused', 'warn'));
      break;
    case 'fullscreen-exit':
      document.exitFullscreen?.().catch(() => {});
      break;
    case 'mute':
      setMuted(true);
      break;
    case 'unmute':
      setMuted(false);
      break;
    case 'scroll':
      window.scrollBy({ top: direction === 'up' ? -window.innerHeight * 0.7 : window.innerHeight * 0.7, behavior: 'smooth' });
      break;
    case 'reload':
      setTimeout(() => location.reload(), 700);
      break;
    case 'sleep':
      goToSleep();
      break;
    default:
      break;
  }
}

function setMuted(on) {
  app.muted = on;
  talker.enabled = !on;
  if (on) talker.stop();
  $('#btnMute').classList.toggle('muted', on);
  $('#btnMute').classList.toggle('off', on);
  hud.log(on ? 'audio muted' : 'audio live', 'ui');
  hud.toast(on ? 'Voice muted' : 'Voice active');
}

/* ─────────────────────────────────────────────────────────────────── chat */

async function send(text, source = 'text') {
  const clean = String(text || '').trim();
  if (!clean) return;
  if (app.busy) {
    hud.toast('Still working on the last request…', 'warn');
    return;
  }
  if (app.asleep) wake();
  app.busy = true;
  setState('thinking');
  showUser(clean);
  $('#interim').hidden = true;
  hud.log(`${source} · ${clean.slice(0, 44)}${clean.length > 44 ? '…' : ''}`, source === 'voice' ? 'hear' : 'type');
  hud.setStateLabel('thinking');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: clean,
        history: app.history.slice(-10),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        location: app.caps?.location,
        lat: app.geo?.lat ?? null,
        lon: app.geo?.lon ?? null,
      }),
    });
    if (res.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!res.ok) throw new Error(`server ${res.status}`);
    const data = await res.json();

    app.history.push({ role: 'user', content: clean }, { role: 'assistant', content: data.reply || '' });
    app.history = app.history.slice(-16);

    (data.actions || []).forEach(handleAction);
    hud.noteLatency(data.latencyMs || 0);
    setState('thinking');
    say(data.reply || '…', { speak: Boolean(data.reply) });
    if (data.provider) {
      app.caps = data.capabilities || app.caps;
      hud.setChips(app.caps);
    }
    if (data.errors?.length) hud.log(`fallback: ${data.errors[0].slice(0, 60)}`, 'err');
  } catch (err) {
    hud.log(`error · ${err.message}`, 'err');
    talker.chime('error');
    say("I can't reach my core right now. The interface is still live though.");
    hud.toast(err.message, 'warn');
  } finally {
    app.busy = false;
    if (!app.speaking) setState(app.listening ? 'listening' : 'idle');
    if (settings.autoListen && app.wakeEnabled && !app.speaking) {
      // resume wake listening after the reply finishes
      setTimeout(() => {
        if (!app.speaking && app.wakeEnabled && !listener.rec && !listener.paused) listener.resume();
      }, 300);
    }
  }
}

/* ────────────────────────────────────────────────────────────── wake / sleep */

async function wake() {
  if (app.awake) return;
  app.awake = true;
  app.asleep = false;
  document.body.classList.remove('asleep');
  $('#shell').classList.add('awake');
  $('#boot').classList.add('done');
  await mic.start();
  enableWake();
  hud.log('reactor online', 'sys');
  setTimeout(() => {
    if (!app.speaking) pulseHello();
  }, 500);
}

function pulseHello() {
  if (store.get('greeted', false)) return;
  store.set('greeted', true);
  const name = app.caps?.ownerName ? `, ${app.caps.ownerName}` : '';
  say(`Systems online${name}. Say “hey jax” whenever you need me.`, { speak: false });
}

function enableWake() {
  if (app.wakeEnabled || app.asleep) return;
  const env = micEnvironment();
  if (!env.usable) {
    hud.log('wake word unavailable — voice loop offline', 'err');
    hud.toast(
      env.secure
        ? 'No speech recognition here — use Chrome/Edge, or type'
        : 'Mic needs localhost or https — open the localhost URL',
      'warn',
    );
    $('#btnWake').classList.add('off');
    return;
  }
  const ok = listener.start();
  app.wakeEnabled = ok;
  $('#btnWake').classList.toggle('off', !ok);
  $('#btnWake').classList.toggle('on', ok);
  if (ok) {
    hud.log('wake word armed', 'mic');
    hud.setChips(app.caps);
  }
}

function disableWake() {
  listener.stop();
  app.wakeEnabled = false;
  app.listening = false;
  document.body.classList.remove('listening');
  $('#btnWake').classList.remove('on');
  $('#btnWake').classList.add('off');
  $('#interim').hidden = true;
  setState('idle');
  hud.log('wake word disarmed', 'mic');
}

function goToSleep() {
  app.asleep = true;
  talker.stop();
  disableWake();
  document.body.classList.add('asleep');
  setState('asleep');
  hud.toast('Dormant — click the reactor to wake');
  hud.log('entering dormant state', 'sys');
}

/* ─────────────────────────────────────────────────────────────────-- boot */

const BOOT_LINES = [
  ['initialising arc reactor', 'OK'],
  ['mounting holographic display', 'OK'],
  ['calibrating gyros', 'OK'],
  ['linking language core', '…'],
  ['arming voice pipeline', '…'],
  ['loading skill matrix', '…'],
];

function micEnvironment() {
  const secure = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const sr = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const media = Boolean(navigator.mediaDevices?.getUserMedia);
  return { secure, sr, media, usable: secure && (sr || media) };
}

async function bootSequence() {
  const env = micEnvironment();
  if (!env.secure) {
    const hint = $('#bootHint');
    hint.innerHTML = 'voice needs <b>localhost</b> or https — type commands for now';
    hud.log('insecure origin: mic disabled', 'err');
  } else if (!env.sr) {
    $('#bootHint').textContent = 'wake word needs Chrome or Edge — typing still works';
    hud.log('speech recognition unavailable in this browser', 'err');
  }
  const log = $('#bootLog');
  for (const [line, status] of BOOT_LINES) {
    log.innerHTML += `> ${line.padEnd(30, '.')} <b>${status}</b>\n`;
    await new Promise((r) => setTimeout(r, 190));
  }
  const enter = $('#bootEnter');
  enter.hidden = false;
  $('#bootHint').textContent = 'click to grant microphone access';
  enter.onclick = () => wake();
}

async function loadCapabilities() {
  try {
    const res = await fetch('/api/capabilities');
    const data = await res.json();
    if (data?.locked) {
      app.locked = true;
      lockInfo = data;
      return null;
    }
    app.locked = false;
    app.caps = data;
  } catch {
    app.caps = { brain: { provider: 'offline' }, voice: { elevenlabs: false }, wakeWord: 'hey jax', skills: [] };
  }
  talker.elevenlabs = Boolean(app.caps.voice?.elevenlabs);
  talker.voiceId = app.caps.voice?.voiceId || null;
  hud.setChips(app.caps);
  $('#brandTag').textContent = `MK VII · ${(app.caps.brain?.provider || 'local').toUpperCase()} CORE`;
  $('#sysReport').textContent = [
    `core        ${app.caps.brain?.provider} · ${app.caps.brain?.model}`,
    `voice out   ${app.caps.voice?.elevenlabs ? `elevenlabs · ${app.caps.voice.model}` : 'browser synthesis'}`,
    `voice in    ${app.caps.voice?.elevenlabs ? `scribe · ${app.caps.voice.sttModel}` : 'browser recognition'}`,
    `skills      ${(app.caps.skills || []).length} registered`,
    `location    ${app.caps.location}`,
    `wake word   “${app.caps.wakeWord}”`,
    `node        ${app.caps.host?.node || '—'}`,
    `image gen   ${app.caps.features?.imageGen ? 'ready' : 'off'}`,
    `motion gen  ${app.caps.features?.videoGen ? 'ready' : 'off'}`,
  ].join('\n');
  populateVoices();
  return app.caps;
}

async function populateVoices() {
  const select = $('#setVoice');
  select.innerHTML = '';
  const addGroup = (label, items) => {
    if (!items.length) return;
    const group = document.createElement('optgroup');
    group.label = label;
    items.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v.value;
      opt.textContent = v.label;
      group.append(opt);
    });
    select.append(group);
  };

  let elVoices = [];
  if (app.caps?.voice?.elevenlabs) {
    try {
      const res = await fetch('/api/tts/voices');
      const data = await res.json();
      elVoices = (data.voices || []).map((v) => ({ label: `${v.name}${v.labels?.accent ? ` · ${v.labels.accent}` : ''}`, value: `el:${v.id}` }));
      app.elDefaultVoice = data.selected;
    } catch {
      /* ignore */
    }
  }
  const browserVoices = (window.speechSynthesis?.getVoices() || [])
    .filter((v) => /^en/i.test(v.lang))
    .map((v) => ({ label: `${v.name}${v.default ? ' (default)' : ''}`, value: `local:${v.name}` }));

  addGroup('ElevenLabs', elVoices);
  addGroup('Browser', browserVoices);
  if (!elVoices.length && !browserVoices.length) {
    const opt = document.createElement('option');
    opt.value = 'local:';
    opt.textContent = 'System default voice';
    select.append(opt);
  }

  const current = app.caps?.voice?.elevenlabs ? `el:${app.elDefaultVoice}` : `local:${localStorage.getItem('jax.voiceName') || talker.browserVoice?.name || ''}`;
  select.value = current;
  $('#voiceHint').textContent = app.caps?.voice?.elevenlabs
    ? 'ElevenLabs is active — speech synthesis and Scribe transcription are proxied through the local server.'
    : 'Browser voices active. Add ELEVENLABS_API_KEY to .env for a much more natural voice.';
}

/* ────────────────────────────────────────────────────────── access lock */

let lockInfo = null;

function showLock(message = '') {
  const lock = $('#lock');
  if (!lock || !lock.hidden) {
    if (message) setLockError(message);
    return;
  }
  lock.hidden = false;
  $('#boot').classList.add('done');
  $('#lockCode').value = '';
  const userField = $('#lockUser');
  if (userField && !userField.value) userField.value = store.get('user', '');
  document.title = `${lockInfo?.name || 'Jax Nova'} — locked`;
  if (message) setLockError(message);
  // returning operators keep their name; first-timers start at the name field
  setTimeout(() => (userField?.value ? $('#lockCode') : userField || $('#lockCode'))?.focus(), 120);
}

function setLockError(message) {
  const el = $('#lockError');
  el.textContent = message;
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}

async function submitLock(event) {
  event.preventDefault();
  const username = $('#lockUser')?.value.trim() || '';
  const code = $('#lockCode').value.trim();
  if (username && username.length < 2) return setLockError('operator name needs at least 2 characters');
  if (!code && lockInfo?.requiresCode !== false) return setLockError('enter the operator code');
  const btn = $('#lockSubmit');
  btn.disabled = true;
  setLockError('');
  try {
    const res = await fetch('/api/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, username }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setLockError(res.status === 429 ? 'too many attempts — wait a moment' : body.error || 'invalid code');
      return;
    }
    const data = await res.json().catch(() => ({}));
    store.set('user', username);
    $('#lock').hidden = true;
    document.title = 'Jax Nova — Holographic Interface';
    const caps = await loadCapabilities();
    applyOperator(data.user || username, data.custom ?? Boolean(username));
    if (caps) await continueBoot();
  } catch (err) {
    setLockError(`unlock failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

/**
 * Point the session at a different Wrestle-ai memory. The conversation thread
 * belongs to the previous operator, so it is cleared rather than carried over.
 */
async function switchOperator(rawName, { silent = false } = {}) {
  const username = String(rawName || '').trim();
  if (username && username.length < 2) {
    hud.toast('operator name needs at least 2 characters', 'warn');
    return null;
  }
  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    if (res.status === 401) return handleUnauthorized();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `server ${res.status}`);
    store.set('user', username);
    applyOperator(data.user, data.custom);
    if (!silent) {
      hud.clear();
      hud.toast(`talking as ${data.user}`, 'ok');
      hud.showCard({
        title: 'Operator switched',
        subtitle: data.user,
        body: data.custom
          ? `New conversation thread. Jax will store this one on the Wrestle-ai server under "${data.user}".`
          : `Back to the default thread ("${data.user}").`,
        tone: 'info',
      });
    }
    return data;
  } catch (err) {
    hud.toast(`operator switch failed: ${err.message}`, 'warn');
    return null;
  }
}

/** Local bookkeeping after a session change: new operator, new thread. */
function applyOperator(user, custom) {
  if (app.user && app.user !== user) {
    app.history = [];
    hud.clear();
  }
  app.user = user || '';
  hud.setOperator(user, custom);
}

/** A 401 from any endpoint (or from the audio engine) re-opens the lock screen. */
function handleUnauthorized(message = 'session expired — re-enter the code') {
  if (!lockInfo) lockInfo = { name: 'Jax Nova' };
  talker.stop();
  listener.stop();
  setState('idle');
  showLock(message);
}

/* ─────────────────────────────────────────────────────────────── controls */

function bindControls() {
  const form = $('#consoleForm');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#consoleInput');
    const value = input.value.trim();
    if (!value) return;
    input.value = '';
    if (value.startsWith('/')) return handleSlash(value.slice(1));
    send(value, 'text');
  });

  $('#micBtn').addEventListener('click', () => manualListen());
  $('#reactorWrap').addEventListener('click', () => {
    if (!app.awake) return wake();
    if (app.asleep) {
      wake();
      return;
    }
    if (app.speaking || app.busy) {
      talker.stop();
      setState(app.listening ? 'listening' : 'idle');
      hud.toast('Interrupted');
      return;
    }
    manualListen();
  });
  $('#reactorWrap').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      $('#reactorWrap').click();
    }
  });

  $$('#quickActions button').forEach((b) =>
    b.addEventListener('click', () => send(b.dataset.cmd, 'text')),
  );

  $$('#themeSwatches .swatch').forEach((s) =>
    s.addEventListener('click', () => setTheme(s.dataset.theme)),
  );
  $('#styleSelect').addEventListener('change', (e) => setTheme(undefined, e.target.value));
  $('#densitySelect').addEventListener('change', (e) => setTheme(undefined, undefined, e.target.value));

  $('#btnWake').addEventListener('click', () => {
    if (!app.awake) return wake();
    if (app.wakeEnabled) disableWake();
    else enableWake();
  });
  $('#btnMute').addEventListener('click', () => setMuted(!app.muted));
  $('#btnFull').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });
  $('#btnSettings').addEventListener('click', () => toggleDrawer(true));
  $('#closeDrawer').addEventListener('click', () => toggleDrawer(false));
  $('#drawerBackdrop').addEventListener('click', () => toggleDrawer(false));
  $('#btnHelp').addEventListener('click', () => hud.showHelp());
  $('#closeHelp').addEventListener('click', () => hud.hideHelp());
  $('#helpBackdrop').addEventListener('click', () => hud.hideHelp());
  $('#clearDisplay').addEventListener('click', () => hud.clear());
  $('#btnReset').addEventListener('click', () => {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('jax.'))
      .forEach((k) => localStorage.removeItem(k));
    location.reload();
  });

  // settings fields
  $('#setWake').value = settings.wakeWord;
  $('#setWake').addEventListener('change', (e) => {
    const value = e.target.value.trim().toLowerCase() || 'hey jax';
    settings.wakeWord = value;
    store.set('wakeWord', value);
    listener.wakeWords = [value, 'hey jax', 'jax', 'nova'].filter(Boolean);
    hud.toast(`Wake word → “${value}”`);
  });

  $('#setVoice').addEventListener('change', (e) => {
    const value = e.target.value;
    if (value.startsWith('el:')) {
      talker.voiceId = value.slice(3);
      talker.elevenlabs = true;
      store.set('voiceId', talker.voiceId);
    } else if (value.startsWith('local:')) {
      talker.setVoiceName(value.slice(6));
    }
    talker.chime('wake');
    hud.toast('Voice updated');
  });
  if (store.get('voiceId', null)) talker.voiceId = store.get('voiceId');

  const rateInput = $('#setRate');
  const pitchInput = $('#setPitch');
  rateInput.value = settings.rate;
  pitchInput.value = settings.pitch;
  rateInput.addEventListener('input', (e) => {
    settings.rate = Number(e.target.value);
    talker.rate = settings.rate;
    store.set('rate', settings.rate);
  });
  pitchInput.addEventListener('input', (e) => {
    settings.pitch = Number(e.target.value);
    talker.pitch = settings.pitch;
    store.set('pitch', settings.pitch);
  });

  const bindToggle = (sel, key, onChange) => {
    const node = $(sel);
    node.setAttribute('aria-pressed', String(Boolean(settings[key])));
    node.addEventListener('click', () => {
      settings[key] = !settings[key];
      node.setAttribute('aria-pressed', String(settings[key]));
      store.set(key, settings[key]);
      onChange?.(settings[key]);
    });
  };
  bindToggle('#setAutoListen', 'autoListen');
  bindToggle('#setSpeak', 'speak', (on) => {
    if (!on) talker.stop();
    hud.toast(on ? 'Voice replies on' : 'Voice replies off');
  });
  bindToggle('#setReactive', 'reactive', (on) => {
    reactor.reactive = on;
    if (!on) reactor.setLevel(0);
  });
  bindToggle('#setParticles', 'particles', (on) => (reactor.particlesOn = on));

  const lockForm = $('#lockForm');
  if (lockForm) lockForm.addEventListener('submit', submitLock);

  const applyUser = $('#applyUser');
  const setUser = $('#setUser');
  if (applyUser) applyUser.addEventListener('click', () => switchOperator(setUser?.value || ''));
  if (setUser) {
    setUser.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        switchOperator(setUser.value || '');
      }
    });
  }

  // audio engine can't show UI itself — it signals us
  window.addEventListener('jax:locked', () => handleUnauthorized());

  // keyboard
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (e.key === 'Escape') {
      toggleDrawer(false);
      hud.hideHelp();
      $('#lightbox').hidden = true;
    }
    if (typing) return;
    switch (e.key.toLowerCase()) {
      case ' ':
        e.preventDefault();
        $('#reactorWrap').click();
        break;
      case 'm':
        manualListen();
        break;
      case 'x':
        setMuted(!app.muted);
        break;
      case 'f':
        $('#btnFull').click();
        break;
      case 'w':
        $('#btnWake').click();
        break;
      case ',':
        toggleDrawer(true);
        break;
      case '/':
        e.preventDefault();
        $('#consoleInput').focus();
        break;
      case '?':
        hud.showHelp();
        break;
      default:
        break;
    }
  });

  window.addEventListener('online', () => hud.setChips(app.caps));
  window.addEventListener('offline', () => hud.setChips(app.caps));
}

function toggleDrawer(open) {
  $('#drawer').hidden = !open;
  $('#drawerBackdrop').hidden = !open;
  if (open) populateVoices();
}

function handleSlash(cmd) {
  const [name, ...rest] = cmd.split(/\s+/);
  const arg = rest.join(' ');
  switch (name.toLowerCase()) {
    case 'theme':
      setTheme(arg || 'arc');
      break;
    case 'style':
      setTheme(undefined, arg || 'torus');
      break;
    case 'density':
      setTheme(undefined, undefined, arg || 'tactical');
      break;
    case 'user':
    case 'operator':
    case 'as': {
      if (!arg) {
        hud.showCard({
          title: 'Operator',
          subtitle: app.caps?.wrestle?.endpoint ? 'wrestle-ai memory key' : 'session',
          body: `Currently talking as "${app.user || 'guest'}". Use /user <name> to switch to your own conversation thread.`,
          tone: 'info',
        });
        return;
      }
      switchOperator(arg);
      break;
    }
    case 'wrestle': {
      if (!arg) return hud.toast('usage: /wrestle <message>', 'warn');
      bridgeToWrestle(arg);
      break;
    }
    case 'clear':
      hud.clear();
      break;
    case 'help':
      hud.showHelp();
      break;
    case 'mute':
      setMuted(true);
      break;
    default:
      hud.toast(`Unknown command /${name}`, 'warn');
  }
}

async function manualListen() {
  if (!app.awake) return wake();
  if (!listener.supported) {
    if (app.caps?.voice?.elevenlabs) return pushToTalk();
    hud.toast('Speech recognition unavailable — type instead', 'warn');
    return;
  }
  if (app.speaking) {
    talker.stop();
    return;
  }
  await mic.start();
  talker.chime('wake');
  listener.cancelCommand();
  // force a command capture window without needing the wake word
  listener.onWake({ at: Date.now() });
  listener.enterCommandMode('', false);
  setState('listening');
  hud.log('manual listen', 'mic');
}

/**
 * Direct line to the Wrestle-ai /wrestling_chat bridge, bypassing the local
 * brain. Useful for testing the integration without changing JAX_BRAIN.
 */
async function bridgeToWrestle(message) {
  hud.log(`wrestle · ${message.slice(0, 40)}${message.length > 40 ? '…' : ''}`, 'net');
  showUser(message);
  setState('thinking');
  try {
    const res = await fetch('/api/wrestle/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (res.status === 401) return handleUnauthorized();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `server ${res.status}`);
    hud.noteLatency(data.latency_ms || 0);
    hud.showCard({
      title: 'Wrestle-ai',
      subtitle: `/wrestling_chat · ${data.latency_ms || 0} ms`,
      body: data.response,
      tone: 'info',
    });
    say(data.response);
  } catch (err) {
    hud.toast(`Wrestle-ai: ${err.message}`, 'warn');
    say("The Wrestle-ai endpoint isn't answering right now.");
    hud.log(`wrestle error · ${err.message}`, 'err');
  } finally {
    if (!app.speaking) setState(app.listening ? 'listening' : 'idle');
  }
}

async function pushToTalk() {
  hud.toast('Recording 6s — speak now');
  setState('listening');
  document.body.classList.add('listening');
  try {
    const text = await listener.transcribeClip(6000);
    document.body.classList.remove('listening');
    if (text) send(text, 'voice');
    else hud.toast('Heard nothing', 'warn');
  } catch (err) {
    document.body.classList.remove('listening');
    setState('idle');
    hud.toast(`Transcription failed: ${err.message}`, 'warn');
  }
}

/* ─────────────────────────────────────────────────────────────────- entry */

async function continueBoot() {
  // the lock screen hides #boot so the page behind it can stay dark; restore it
  $('#boot').classList.remove('done');
  applyTheme(settings);
  reactor.reactive = settings.reactive;
  reactor.particlesOn = settings.particles;
  talker.rate = settings.rate;
  talker.pitch = settings.pitch;
  talker.enabled = settings.speak && !app.muted;
  hud.setStateLabel('idle');
  hud.log('display booted', 'sys');
  await bootSequence();

  // optional geolocation for weather defaults (silent, non-blocking)
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        app.geo = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        hud.log('location acquired', 'gps');
      },
      () => hud.log('location unavailable — using configured city', 'gps'),
      { timeout: 6000, maximumAge: 600000 },
    );
  }

  // clicking anywhere on the boot screen also wakes
  $('#boot').addEventListener('click', (e) => {
    if (e.target.id !== 'bootEnter' && !$('#bootEnter').hidden) wake();
  });

  // First-visit nudge in the console
  setTimeout(() => {
    if (!app.awake) $('#bootHint').textContent = 'click the button above to activate the interface';
  }, 4000);

  window.addEventListener('beforeunload', () => {
    talker.stop();
    listener.stop();
    mic.stop();
  });

}

async function main() {
  bindControls();
  hud.setStateLabel('idle');

  const caps = await loadCapabilities().catch(() => null);
  if (app.locked) {
    showLock();
    // the lock form calls continueBoot() once the code is accepted
    window.jax = { app, send, hud, reactor, talker, listener, setTheme, settings };
    return;
  }
  if (caps === null && !app.caps) app.caps = { brain: { provider: 'offline' }, voice: {}, skills: [] };
  await continueBoot();

  // expose a tiny debug handle
  window.jax = { app, send, hud, reactor, talker, listener, setTheme, settings };
  console.log('%c JAX NOVA ', 'background:#5ff3ff;color:#001018;font-weight:700', 'interface ready — window.jax for debugging');
}

main();
