/**
 * HUD — everything the user sees: display cards, timers, notes, event log,
 * telemetry, toasts, lightbox. Keeps DOM concerns out of the app controller.
 */

const $ = (sel) => document.querySelector(sel);
const MAX_CARDS = 14;
const NOTES_KEY = 'jax.notes';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/* ── inline SVG weather glyphs (no emoji fonts, consistent at any size) ── */
const WX = {
  clear: `<circle cx="24" cy="24" r="8.5" fill="currentColor" opacity=".85"/>
    <g stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".9">
      <path d="M24 4v5M24 39v5M4 24h5M39 24h5M9.9 9.9l3.5 3.5M34.6 34.6l3.5 3.5M38.1 9.9l-3.5 3.5M13.4 34.6l-3.5 3.5"/></g>`,
  partly: `<circle cx="18" cy="18" r="7" fill="currentColor" opacity=".9"/>
    <g stroke="currentColor" stroke-width="1.8" stroke-linecap="round" opacity=".7">
      <path d="M18 4v4M18 28v4M4 18h4M28 18h4M8 8l2.8 2.8M25.2 25.2L28 28"/></g>
    <path d="M20 34a7 7 0 0 1 .8-13.9A9.5 9.5 0 0 1 38.5 24a5.6 5.6 0 0 1-1 11.1z"
      fill="currentColor" opacity=".35" stroke="currentColor" stroke-width="1.8"/>`,
  cloudy: `<path d="M14 37a8 8 0 0 1 1-15.9A10.5 10.5 0 0 1 34.5 25a6.6 6.6 0 0 1-1.2 13z"
      fill="currentColor" opacity=".3" stroke="currentColor" stroke-width="1.9"/>
    <path d="M22 26a6 6 0 0 1 1-11.9A8 8 0 0 1 38 18a5 5 0 0 1-.6 9.9z"
      fill="currentColor" opacity=".2" stroke="currentColor" stroke-width="1.5"/>`,
  fog: `<g stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity=".8">
      <path d="M8 18h26M14 25h26M8 32h26M16 39h22"/></g>`,
  rain: `<path d="M14 30a8 8 0 0 1 1-15.9A10.5 10.5 0 0 1 34.5 18a6.4 6.4 0 0 1-1.2 12.7z"
      fill="currentColor" opacity=".28" stroke="currentColor" stroke-width="1.9"/>
    <g stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
      <path d="M17 34l-2.5 6M25 34l-2.5 6M33 34l-2.5 6"/></g>`,
  snow: `<path d="M14 28a8 8 0 0 1 1-15.9A10.5 10.5 0 0 1 34.5 16a6.4 6.4 0 0 1-1.2 12.7z"
      fill="currentColor" opacity=".28" stroke="currentColor" stroke-width="1.9"/>
    <g stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
      <path d="M16 34v8M12.5 36l7 4M19.5 36l-7 4M30 34v8M26.5 36l7 4M33.5 36l-7 4"/></g>`,
  storm: `<path d="M14 28a8 8 0 0 1 1-15.9A10.5 10.5 0 0 1 34.5 16a6.4 6.4 0 0 1-1.2 12.7z"
      fill="currentColor" opacity=".28" stroke="currentColor" stroke-width="1.9"/>
    <path d="M25 30l-6 9h5l-3 8 9-11h-5l3-6z" fill="currentColor" opacity=".95"/>`,
};

function wxSvg(code) {
  const c = Number(code);
  const kind =
    c === 0 || c === 1 ? 'clear'
    : c === 2 ? 'partly'
    : c === 3 ? 'cloudy'
    : c === 45 || c === 48 ? 'fog'
    : [51, 53, 55, 61, 63, 65, 66, 67, 80, 81].includes(c) ? 'rain'
    : [71, 73, 75, 77, 85, 86].includes(c) ? 'snow'
    : [82, 95, 96, 99].includes(c) ? 'storm'
    : 'cloudy';
  const svg = `<svg viewBox="0 0 48 48" aria-hidden="true">${WX[kind]}</svg>`;
  return svg;
}

const iconNode = (code, cls = 'wx-svg') => {
  const span = document.createElement('span');
  span.className = cls;
  span.innerHTML = wxSvg(code);
  return span;
};

const ICONS = {};

export class Hud {
  constructor({ onOpenUrl, onTimerDone, onTheme } = {}) {
    this.stack = $('#displayStack');
    this.empty = $('#displayEmpty');
    this.countEl = $('#displayCount');
    this.logEl = $('#eventLog');
    this.toastEl = $('#toastStack');
    this.timerList = $('#timerList');
    this.noteList = $('#noteList');
    this.noteCount = $('#noteCount');
    this.spark = $('#spark');
    this.stateLabel = $('#stateLabel');
    this.stateSub = $('#stateSub');
    this.onOpenUrl = onOpenUrl || (() => {});
    this.onTimerDone = onTimerDone || (() => {});
    this.onTheme = onTheme || (() => {});
    this.cardCount = 0;
    this.timers = new Map();
    this.latencyHistory = [12, 18, 14, 22, 17, 26, 19, 24, 16, 21, 18, 23, 20, 25, 19, 22];
    this.notes = this.loadNotes();
    this.spectrumData = new Uint8Array(128).fill(128);
    this.renderNotes();
    this.startClock();
    this.startTelemetry();
    this.startTimerLoop();
    this.startWaveform();
    this.buildHelp();
    this.bindLightbox();
  }

  /* --------------------------------------------------------------- chrome */

  startClock() {
    const time = $('#clockTime');
    const date = $('#clockDate');
    const tick = () => {
      const now = new Date();
      time.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      date.textContent = now
        .toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
        .toUpperCase();
    };
    tick();
    setInterval(tick, 15000);
  }

  setStateLabel(state) {
    const map = {
      idle: ['STANDBY', 'say "hey jax"'],
      wake: ['STANDBY', 'listening for wake word'],
      listening: ['LISTENING', 'speak your command'],
      thinking: ['PROCESSING', 'resolving intent'],
      speaking: ['SPEAKING', 'tap reactor to interrupt'],
      muted: ['MUTED', 'voice output disabled'],
      asleep: ['DORMANT', 'tap reactor to wake'],
    };
    const [main, sub] = map[state] || map.idle;
    this.stateLabel.textContent = main;
    this.stateSub.textContent = sub;
    $('#telemetryState').textContent = main;
    const badge = $('#signalBadge');
    badge.textContent = state === 'listening' ? 'LIVE' : state === 'speaking' ? 'OUT' : state === 'thinking' ? 'BUSY' : 'IDLE';
    badge.classList.toggle('live', state === 'listening');
  }

  log(message, tag = 'sys') {
    const li = el('li');
    const t = el('span', null, tag.toUpperCase().slice(0, 7).padEnd(7, ' '));
    const m = el('em', null, message);
    li.append(t, m);
    this.logEl.prepend(li);
    while (this.logEl.children.length > 30) this.logEl.lastChild.remove();
  }

  toast(message, kind = '') {
    const t = el('div', `toast ${kind}`, message);
    this.toastEl.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .4s, transform .4s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(-6px)';
      setTimeout(() => t.remove(), 420);
    }, 3200);
  }

  setChips(caps) {
    const chip = (id, ok, label, title, warn = false) => {
      const node = $(id);
      node.classList.toggle('ok', ok);
      node.classList.toggle('warn', warn);
      node.querySelector('span').textContent = label;
      node.title = title;
    };
    const brain = caps?.brain || {};
    const voice = caps?.voice || {};
    chip('#chipBrain', Boolean(brain.provider), brain.provider || 'core', `Language core: ${brain.provider} (${brain.model})`);
    chip('#chipVoice', Boolean(voice.elevenlabs), voice.elevenlabs ? 'elevenlabs' : 'browser', voice.elevenlabs ? `ElevenLabs ${voice.model}` : 'Browser speech synthesis', !voice.elevenlabs);
    chip('#chipMic', true, 'mic', 'Microphone', true);
    chip('#chipNet', navigator.onLine, navigator.onLine ? 'net' : 'offline', 'Network');
    if (caps?.user) this.setOperator(caps.user, !caps.userIsDefault);
    $('#ttsEngine').textContent = voice.elevenlabs ? 'ELEVENLABS' : 'BROWSER';
    $('#dockStatus').textContent = `${brain.provider} core · ${voice.elevenlabs ? 'elevenlabs' : 'browser'} voice`;
  }

  /** Who the current Wrestle-ai memory belongs to. */
  setOperator(user, custom = true) {
    const node = $('#chipUser');
    if (!node) return;
    node.querySelector('span').textContent = user || 'guest';
    node.classList.toggle('custom', Boolean(custom));
    node.title = custom
      ? `Operator "${user}" — your own Wrestle-ai conversation`
      : `Default operator "${user}" — set your name on the lock screen to get your own conversation`;
    const field = $('#setUser');
    if (field && document.activeElement !== field) field.value = user || '';
    const dock = $('#dockUser');
    if (dock) dock.textContent = user || 'guest';
  }

  startTelemetry() {
    // cosmetic but alive: output tracks reactor level via app, others drift
    this.telemetryTimer = setInterval(() => {
      const drift = (base, jitter) => Math.max(4, Math.min(99, base + (Math.random() - 0.5) * jitter));
      const set = (bar, val, v, label) => {
        $(bar).style.width = `${v}%`;
        $(val).textContent = label ?? `${String(Math.round(v)).padStart(2, '0')}%`;
      };
      set('#barCoherence', '#valCoherence', drift(96, 5));
      set('#barThermal', '#valThermal', drift(34, 9));
      this.drawSpark();
    }, 1600);
  }

  /** Voice-signal scope: live mic spectrum when hot, drifting idle trace otherwise. */
  startWaveform() {
    const canvas = $('#waveform');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const spectrum = new Uint8Array(128);
    let t = 0;
    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = (canvas.width = canvas.clientWidth * dpr);
      const h = (canvas.height = canvas.clientHeight * dpr);
      const acc = getComputedStyle(document.documentElement).getPropertyValue('--acc-rgb').trim() || '95,243,255';
      const acc2 = getComputedStyle(document.documentElement).getPropertyValue('--acc2-rgb').trim() || '255,181,69';
      t += 0.05;
      ctx.clearRect(0, 0, w, h);

      // baseline grid
      ctx.strokeStyle = `rgba(${acc},0.12)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();

      const live = this.liveLevel > 0.02;
      let data;
      if (live) {
        this.onSpectrum?.(spectrum);
        data = Array.from(spectrum.slice(0, 64)).map((v) => v / 255);
      } else {
        data = Array.from({ length: 64 }, (_, i) =>
          0.08 + 0.05 * Math.sin(i / 5 + t) + 0.03 * Math.sin(i / 2.1 - t * 1.7),
        );
      }

      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, `rgba(${live ? acc2 : acc},0.85)`);
      grad.addColorStop(0.5, `rgba(${acc},0.6)`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.6 * dpr;
      ctx.beginPath();
      data.forEach((v, i) => {
        const x = (i / (data.length - 1)) * w;
        const amp = (h / 2 - 4) * (live ? v : v * 2.4);
        const y = h / 2 - amp * Math.sin((i / data.length) * Math.PI * 3.2 + t * 0.6);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();

      // mirrored fill
      ctx.lineTo(w, h / 2);
      ctx.lineTo(0, h / 2);
      ctx.closePath();
      const fill = ctx.createLinearGradient(0, 0, 0, h);
      fill.addColorStop(0, `rgba(${acc},0.16)`);
      fill.addColorStop(1, `rgba(${acc},0)`);
      ctx.fillStyle = fill;
      ctx.fill();

      this._waveRaf = requestAnimationFrame(draw);
    };
    draw();
  }

  setLiveLevel(level) {
    this.liveLevel = level;
  }

  setOutput(level) {
    const pct = Math.round(level * 100);
    $('#barOutput').style.width = `${Math.max(4, pct)}%`;
    $('#valOutput').textContent = `${String(pct).padStart(2, '0')}%`;
    $('#micGain').textContent = pct > 3 ? `${pct}%` : '—';
  }

  noteLatency(ms) {
    $('#valLatency').textContent = `${ms} ms`;
    $('#barLatency').style.width = `${Math.min(99, 10 + (ms / 40))}%`;
    this.latencyHistory.push(ms);
    if (this.latencyHistory.length > 40) this.latencyHistory.shift();
    this.drawSpark();
  }

  drawSpark() {
    const canvas = this.spark;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = (canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1));
    const h = (canvas.height = 46 * (window.devicePixelRatio || 1));
    ctx.clearRect(0, 0, w, h);
    const data = this.latencyHistory;
    const max = Math.max(120, ...data);
    const acc = getComputedStyle(document.documentElement).getPropertyValue('--acc-rgb').trim() || '95,243,255';
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - (v / max) * (h - 6) - 3;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, `rgba(${acc},0.35)`);
    grad.addColorStop(1, `rgba(${acc},0)`);
    ctx.strokeStyle = `rgba(${acc},0.9)`;
    ctx.lineWidth = 1.4 * (window.devicePixelRatio || 1);
    ctx.stroke();
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  /* -------------------------------------------------------------- display */

  pushCard(node) {
    this.empty?.remove();
    this.stack.prepend(node);
    this.cardCount += 1;
    this.countEl.textContent = String(this.cardCount);
    while (this.stack.children.length > MAX_CARDS) this.stack.lastChild.remove();
    // flash the frame
    const flare = $('#fxFlare');
    flare.classList.add('on');
    setTimeout(() => flare.classList.remove('on'), 420);
    return node;
  }

  baseCard(title, subtitle, tone = 'info') {
    const card = el('div', `card ${tone}`);
    const head = el('div', 'card-head');
    head.append(el('h4', null, title || ''));
    if (subtitle) head.append(el('span', 'sub', subtitle));
    card.append(head);
    return card;
  }

  clear() {
    [...this.stack.children].forEach((c) => c.remove());
    this.cardCount = 0;
    this.countEl.textContent = '0';
    this.stack.append(this.empty || el('div', 'display-empty'));
    this.empty = this.stack.querySelector('.display-empty');
  }

  showCard({ title, body, items, tone, subtitle, url }) {
    const card = this.baseCard(title, subtitle || (url ? hostOf(url) : ''), tone);
    if (body) {
      const p = el('p');
      p.textContent = body;
      card.append(p);
    }
    if (Array.isArray(items) && items.length) {
      const ul = el('ul', 'bullets');
      items.forEach((i) => ul.append(el('li', null, i)));
      card.append(ul);
    }
    if (url) {
      const a = el('a', 'result-host', 'open source ↗');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.display = 'inline-block';
      a.style.marginTop = '6px';
      card.append(a);
    }
    this.pushCard(card);
    return card;
  }

  showResults({ title = 'Web results', query, items = [] }) {
    const card = this.baseCard(title, query ? `“${query}”` : `${items.length} hits`);
    items.forEach((r) => {
      const a = el('a', 'result-item');
      a.href = r.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.append(el('span', 'result-title', r.title));
      if (r.snippet) a.append(el('span', 'result-snippet', r.snippet.slice(0, 150) + (r.snippet.length > 150 ? '…' : '')));
      a.append(el('span', 'result-host', r.provider || hostOf(r.url)));
      card.append(a);
    });
    if (!items.length) card.append(el('p', null, 'No results returned.'));
    this.pushCard(card);
  }

  showWeather(w) {
    const card = this.baseCard(w.location || 'Weather', 'conditions', 'info');
    const top = el('div', 'wx-top');
    const glyph = iconNode(w.code ?? 3, 'wx-icon');
    top.append(glyph);
    const temp = el('div');
    const t = el('div', 'wx-temp', String(w.temp));
    t.append(el('small', null, w.unit || '°C'));
    temp.append(t, el('div', 'wx-desc', `${w.desc || ''} · feels ${w.feels}°`));
    top.append(temp);
    card.append(top);

    const meta = el('div', 'wx-meta');
    meta.append(el('span', null, `HUMIDITY ${w.humidity ?? '—'}%`));
    meta.append(el('span', null, `WIND ${w.wind ?? '—'} ${w.windUnit || ''}`));
    card.append(meta);

    if (Array.isArray(w.hourly) && w.hourly.length) {
      const bars = el('div', 'wx-bars');
      const slice = w.hourly.slice(0, 16);
      const temps = slice.map((h) => h.temp);
      const min = Math.min(...temps);
      const max = Math.max(...temps);
      slice.forEach((h) => {
        const bar = el('i');
        const pct = max === min ? 60 : 20 + ((h.temp - min) / (max - min)) * 80;
        bar.style.height = `${pct}%`;
        bar.title = `${new Date(h.time).toLocaleTimeString([], { hour: 'numeric' })} · ${h.temp}°`;
        bars.append(bar);
      });
      card.append(bars);
    }

    if (Array.isArray(w.daily) && w.daily.length) {
      const days = el('div', 'wx-days');
      w.daily.forEach((d) => {
        const day = el('div', 'wx-day');
        const label = new Date(d.date).toLocaleDateString([], { weekday: 'short' }).toUpperCase();
        day.append(el('b', null, label), iconNode(d.code, 'wx-day-icon'));
        const span = el('span');
        span.append(document.createTextNode(`${d.high}° `), el('i', null, `${d.low}°`));
        day.append(span);
        days.append(day);
      });
      card.append(days);
    }
    this.pushCard(card);
  }

  showNews({ title, items = [] }) {
    const card = this.baseCard(title || 'Top stories', `${items.length} items`);
    items.forEach((n) => {
      const a = el('a', 'news-item');
      a.href = n.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.append(el('i', 'news-dot'));
      const wrap = el('div');
      wrap.append(el('span', 'news-title', n.title));
      const src = (n.source || hostOf(n.url) || '').replace(/\s*-\s*[^-]+$/, '') || 'news';
      wrap.append(el('span', 'news-src', src));
      a.append(wrap);
      card.append(a);
    });
    this.pushCard(card);
  }

  showImages({ prompt, images = [], style, provider, note }) {
    const card = this.baseCard('Image synthesis', style || 'holo');
    const p = el('p');
    p.textContent = prompt;
    p.style.marginBottom = '2px';
    card.append(p);
    const grid = el('div', `gallery ${images.length === 1 ? 'single' : ''}`);
    images.forEach((img) => {
      const fig = el('figure');
      const node = el('img');
      node.src = img.url;
      node.alt = prompt;
      node.loading = 'lazy';
      fig.append(node);
      fig.addEventListener('click', () => this.openLightbox(img.url, prompt));
      grid.append(fig);
    });
    card.append(grid);
    const meta = el('div', 'wx-meta');
    meta.append(el('span', null, `${images.length} FRAME${images.length === 1 ? '' : 'S'} · ${(provider || 'engine').toUpperCase()}`));
    meta.append(el('span', null, 'CLICK TO EXPAND'));
    card.append(meta);
    if (note) {
      const n = el('p', null, note);
      n.style.marginTop = '6px';
      n.style.opacity = '0.7';
      n.style.fontSize = '10.5px';
      card.append(n);
    }
    this.pushCard(card);
  }

  showMotion({ prompt, frames = [], style, schematic }) {
    const card = this.baseCard('Motion synthesis', style || 'cinematic');
    card.append(el('p', null, prompt));
    if (schematic) {
      const warn = el('p', null, 'Free render engines rate-limited · local schematic sequence');
      warn.style.fontSize = '10px';
      warn.style.opacity = '0.7';
      warn.style.margin = '2px 0 0';
      card.append(warn);
    }
    const wrap = el('div', 'motion');
    const imgs = frames.map((f) => {
      const node = el('img');
      node.src = f.url;
      node.alt = f.beat || prompt;
      wrap.append(node);
      return node;
    });
    wrap.append(el('div', 'motion-grain'), el('div', 'motion-scan'));
    card.append(wrap);

    const meta = el('div', 'motion-meta');
    const dots = el('div', 'motion-dots');
    const dotEls = imgs.map(() => {
      const d = el('i');
      dots.append(d);
      return d;
    });
    meta.append(el('span', null, 'HOLO-MOTION · LOOP'), dots);
    card.append(meta);
    this.pushCard(card);

    let idx = 0;
    wrap.addEventListener('click', () => this.openLightbox(frames[0]?.url, prompt));
    const live = imgs.filter((im) => im.complete && im.naturalWidth > 0);
    if (!live.length) {
      // nothing decoded yet — wait for the first frame, keeping a poster blank
      const first = imgs[0];
      const start = () => {
        first.classList.add('active');
        cycleAll(imgs.length ? imgs : []);
      };
      if (first) {
        first.decode?.().then(start).catch(start);
        first.addEventListener('load', start, { once: true });
        first.addEventListener('error', start, { once: true });
      }
      return;
    }
    function cycleAll(list) {
      const usable = list.filter((im) => im.naturalWidth > 0 || !im.complete);
      if (!usable.length) return;
      let i = 0;
      const step = () => {
        if (!document.body.contains(wrap)) return;
        usable.forEach((im, n) => im.classList.toggle('active', n === i));
        dotEls.forEach((d, n) => d.classList.toggle('on', n === i));
        i = (i + 1) % usable.length;
        card._timer = setTimeout(step, 1700);
      };
      step();
    }
    cycleAll(imgs);
  }

  showStatus(caps) {
    const card = this.baseCard('System diagnostics', 'nominal', 'good');
    const rows = [
      ['CORE', `${caps?.brain?.provider || '—'} · ${caps?.brain?.model || '—'}`],
      ['VOICE OUT', caps?.voice?.elevenlabs ? `elevenlabs ${caps.voice.model}` : 'browser synthesis'],
      ['VOICE IN', caps?.voice?.elevenlabs ? `scribe ${caps.voice.sttModel}` : 'browser recognition'],
      ['SKILLS', `${(caps?.skills || []).length} registered`],
      ['UPTIME', `${Math.round(performance.now() / 1000)}s session`],
      ['LATENCY', `${this.latencyHistory.at(-1) || 0} ms last response`],
    ];
    const ul = el('ul', 'bullets');
    rows.forEach(([k, v]) => {
      const li = el('li');
      li.append(el('strong', null, `${k} `), document.createTextNode(`— ${v}`));
      ul.append(li);
    });
    card.append(ul);
    this.pushCard(card);
  }

  /* --------------------------------------------------------------- timers */

  startTimer({ seconds, label }) {
    const id = `t${Date.now()}${Math.random().toString(16).slice(2, 6)}`;
    const endsAt = Date.now() + seconds * 1000;
    const chip = el('div', 'timer-chip');
    const time = el('b', null, this.fmt(seconds));
    const prog = el('div', 't-prog');
    const fill = el('i');
    prog.append(fill);
    chip.append(time, prog, el('small', null, label || 'timer'));
    const x = el('button', 'x', '✕');
    x.addEventListener('click', () => {
      clearInterval(handle);
      this.timers.delete(id);
      chip.remove();
    });
    chip.append(x);
    this.timerList.append(chip);
    const entry = { id, endsAt, total: seconds * 1000, chip, time, fill, done: false, label };
    const handle = setInterval(() => this.tickTimer(entry), 200);
    entry.handle = handle;
    this.timers.set(id, entry);
    return entry;
  }

  tickTimer(entry) {
    const left = entry.endsAt - Date.now();
    if (left <= 0) {
      if (!entry.done) {
        entry.done = true;
        clearInterval(entry.handle);
        entry.chip.classList.add('done');
        entry.time.textContent = '00:00';
        entry.fill.style.width = '0%';
        this.toast(`Timer complete · ${entry.label}`, 'warn');
        this.onTimerDone(entry.label);
      }
      return;
    }
    entry.time.textContent = this.fmt(left / 1000);
    entry.fill.style.width = `${Math.max(0, 100 - (left / entry.total) * 100)}%`;
  }

  startTimerLoop() {
    setInterval(() => {
      for (const entry of this.timers.values()) if (!entry.done) this.tickTimer(entry);
    }, 250);
  }

  fmt(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  cancelTimers() {
    for (const entry of this.timers.values()) {
      clearInterval(entry.handle);
      entry.chip.classList.add('done');
    }
    this.timers.clear();
    this.timerList.innerHTML = '';
  }

  /* ---------------------------------------------------------------- notes */

  loadNotes() {
    try {
      return JSON.parse(localStorage.getItem(NOTES_KEY) || '[]');
    } catch {
      return [];
    }
  }

  saveNotes() {
    localStorage.setItem(NOTES_KEY, JSON.stringify(this.notes.slice(0, 40)));
    this.renderNotes();
  }

  addNote(text) {
    if (!text) return;
    this.notes.unshift({ text, at: Date.now() });
    this.saveNotes();
  }

  renderNotes() {
    this.noteList.innerHTML = '';
    this.notes.slice(0, 8).forEach((n) => {
      const li = el('li');
      li.append(el('time', null, new Date(n.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), document.createTextNode(n.text));
      this.noteList.append(li);
    });
    this.noteCount.textContent = String(this.notes.length);
  }

  /* -------------------------------------------------------------- overlay */

  openLightbox(url, caption = '') {
    if (!url) return;
    const box = $('#lightbox');
    const stage = $('#lightboxStage');
    stage.innerHTML = '';
    const img = el('img');
    img.src = url;
    img.alt = caption;
    stage.append(img);
    $('#lightboxCaption').textContent = caption;
    box.hidden = false;
  }

  bindLightbox() {
    $('#lightboxClose').addEventListener('click', () => ($('#lightbox').hidden = true));
    $('#lightbox').addEventListener('click', (e) => {
      if (e.target.id === 'lightbox') $('#lightbox').hidden = true;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        $('#lightbox').hidden = true;
        $('#helpModal').hidden = true;
        $('#helpBackdrop').hidden = true;
      }
    });
  }

  buildHelp() {
    const groups = [
      {
        h: 'Voice',
        items: [
          '<code>Hey Jax</code> — wake',
          '<code>Hey Jax, what\'s the weather</code>',
          '<code>search the web for…</code>',
          '<code>open youtube.com</code>',
          '<code>read that page to me</code>',
        ],
      },
      {
        h: 'Create',
        items: [
          '<code>generate an image of a neon city</code>',
          '<code>generate a video of a reactor</code>',
          '<code>in blueprint style</code>',
          '<code>make four variations</code>',
        ],
      },
      {
        h: 'Interface',
        items: [
          '<code>switch to stealth theme</code>',
          '<code>reactor hex</code> / <code>reactor plasma</code>',
          '<code>go fullscreen</code>',
          '<code>clear the display</code>',
          '<code>go to sleep</code>',
        ],
      },
      {
        h: 'Utility',
        items: [
          '<code>set a timer for 5 minutes</code>',
          '<code>remember to call Sam</code>',
          '<code>what are my notes</code>',
          '<code>system status</code>',
          '<code>calculate 18% of 240</code>',
          '<code>/wrestle hey, what\'s new?</code>',
          '<code>/user jeremy</code>',
        ],
      },
      {
        h: 'Keyboard',
        items: [
          '<code>Space</code> wake / listen',
          '<code>M</code> listen &nbsp; <code>X</code> mute',
          '<code>F</code> fullscreen &nbsp; <code>W</code> wake word',
          '<code>,</code> config &nbsp; <code>Esc</code> close',
          '<code>/</code> focus console',
        ],
      },
      {
        h: 'Engines',
        items: [
          'Brain: Claude → local CLI → keyless',
          'Bridge: Wrestle-ai /wrestling_chat',
          'Voice: ElevenLabs → browser',
          'Search: DuckDuckGo → Bing → Wikipedia',
          'Images: FLUX → Pollinations → local',
        ],
      },
    ];
    const grid = $('#helpGrid');
    groups.forEach((g) => {
      const block = el('div', 'help-block');
      block.append(el('h4', null, g.h.toUpperCase()));
      const ul = el('ul');
      g.items.forEach((i) => {
        const li = el('li');
        li.innerHTML = i;
        ul.append(li);
      });
      block.append(ul);
      grid.append(block);
    });
  }

  showHelp() {
    $('#helpModal').hidden = false;
    $('#helpBackdrop').hidden = false;
  }

  hideHelp() {
    $('#helpModal').hidden = true;
    $('#helpBackdrop').hidden = true;
  }
}
