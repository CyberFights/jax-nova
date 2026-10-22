/**
 * Voice I/O.
 *
 *   Listener  — always-on wake word + command capture via SpeechRecognition,
 *               with a MediaRecorder → /api/stt fallback for push-to-talk.
 *   Talker    — sentence-chunked TTS. ElevenLabs via the local proxy when a key
 *               exists, otherwise the browser's speechSynthesis.
 *   MicMeter  — shared mic analyser so the reactor pulses with your voice.
 */

const TAU = Math.PI * 2;

export function splitForSpeech(text = '') {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g) || [clean];
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    const t = s.trim();
    if (!t) continue;
    if ((current + ' ' + t).length > 190 && current) {
      chunks.push(current.trim());
      current = t;
    } else {
      current = current ? `${current} ${t}` : t;
    }
    if (t.length > 300) {
      chunks.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/* ============================================================== microphone */

export class MicMeter {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.data = null;
    this.stream = null;
    this.level = 0;
    this.enabled = false;
  }

  async ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  async start() {
    if (this.stream) return true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) return false;
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      const ctx = await this.ensureContext();
      if (!ctx) return false;
      const src = ctx.createMediaStreamSource(this.stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.75;
      src.connect(this.analyser);
      this.data = new Uint8Array(this.analyser.fftSize);
      this.enabled = true;
      this.tick();
      return true;
    } catch (err) {
      console.warn('[jax] mic unavailable:', err.message);
      return false;
    }
  }

  tick() {
    if (!this.enabled) return;
    const a = this.analyser;
    a.getByteTimeDomainData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) {
      const v = (this.data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.data.length);
    const scaled = Math.min(1, Math.pow(rms * 3.4, 0.75));
    this.level = this.level * 0.7 + scaled * 0.3;
    requestAnimationFrame(() => this.tick());
  }

  spectrum(out) {
    if (!this.analyser) {
      out.fill(128);
      return out;
    }
    this.analyser.getByteFrequencyData(out);
    return out;
  }

  stop() {
    this.enabled = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

/* ================================================================= talker */

const PREFERRED_VOICES = [
  'Google UK English Male', 'Microsoft Guy', 'Microsoft Ryan', 'Microsoft George',
  'Daniel', 'Google US English', 'Microsoft Aria', 'Samantha', 'Aaron', 'Alex',
];

export class Talker {
  constructor(opts = {}) {
    this.elevenlabs = Boolean(opts.elevenlabs);
    this.voiceId = opts.voiceId || null;
    this.rate = opts.rate ?? 1;
    this.pitch = opts.pitch ?? 0.95;
    this.enabled = true;
    this.onLevel = opts.onLevel || (() => {});
    this.onState = opts.onState || (() => {});
    this.onError = opts.onError || (() => {});
    this.queue = [];
    this.playing = false;
    this.generation = 0;
    this.stopRequested = false;
    this.synth = window.speechSynthesis || null;
    this.audioCtx = null;
    this.analyser = null;
    this.audioData = null;
    this.currentAudio = null;
    this.browserVoice = null;
    this.fakeLevelTimer = null;
    this.loadVoices();
    if (this.synth) this.synth.addEventListener?.('voiceschanged', () => this.loadVoices());
  }

  loadVoices() {
    if (!this.synth) return;
    const voices = this.synth.getVoices().filter((v) => /^en/i.test(v.lang || ''));
    if (!voices.length) return;
    const stored = localStorage.getItem('jax.voiceName');
    if (stored) {
      const found = voices.find((v) => v.name === stored);
      if (found) {
        this.browserVoice = found;
        return;
      }
    }
    for (const name of PREFERRED_VOICES) {
      const found = voices.find((v) => v.name.includes(name));
      if (found) {
        this.browserVoice = found;
        return;
      }
    }
    this.browserVoice = voices.find((v) => /male/i.test(v.name)) || voices[0];
  }

  setVoiceName(name) {
    const voices = this.synth?.getVoices() || [];
    const found = voices.find((v) => v.name === name);
    if (found) {
      this.browserVoice = found;
      localStorage.setItem('jax.voiceName', name);
    }
  }

  get engine() {
    return this.elevenlabs ? 'ElevenLabs' : this.synth ? 'browser' : 'none';
  }

  async ensureAudioCtx() {
    if (!this.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.audioCtx = new AC();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.8;
      this.analyser.connect(this.audioCtx.destination);
      this.audioData = new Uint8Array(this.analyser.fftSize);
    }
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume().catch(() => {});
    return this.audioCtx;
  }

  /** Queue text for speech. Returns a promise that resolves when fully spoken. */
  speak(text) {
    if (!this.enabled || !String(text || '').trim()) return Promise.resolve();
    const chunks = splitForSpeech(text);
    if (!chunks.length) return Promise.resolve();
    this.stopRequested = false;
    const gen = this.generation;
    return new Promise((resolve) => {
      this.queue.push({ chunks, gen, resolve, index: 0, prefetch: null });
      this.pump();
    });
  }

  async pump() {
    if (this.playing) return;
    const job = this.queue[0];
    if (!job) return;
    this.playing = true;
    this.onState('speaking');

    while (job.index < job.chunks.length && job.gen === this.generation && !this.stopRequested) {
      const chunk = job.chunks[job.index];
      // start fetching the next chunk while this one speaks
      const next = job.chunks[job.index + 1];
      const prefetch = this.elevenlabs && next ? this.fetchSpeech(next) : null;

      try {
        await this.speakChunk(chunk);
      } catch (err) {
        console.warn('[jax] tts chunk failed:', err.message);
        this.onError(err.message);
        // fall back to browser voice for the rest of this job
        if (this.elevenlabs) {
          this.elevenlabs = false;
          try {
            await this.speakChunk(chunk);
          } catch { /* give up on this chunk */ }
        }
      }
      const fetched = prefetch ? await prefetch.catch(() => null) : null;
      job.index += 1;
      if (job.index < job.chunks.length && fetched) {
        // stash the prefetched blob for the next iteration
        const blobUrl = URL.createObjectURL(fetched);
        this._prefetched = blobUrl;
      }
    }

    this.playing = false;
    job.resolve();
    this.queue.shift();
    this.onLevel(0);
    this.onState(this.queue.length ? 'speaking' : 'silent');
    if (this.queue.length) this.pump();
  }

  async fetchSpeech(text) {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voiceId: this.voiceId }),
    });
    if (res.status === 401) {
      window.dispatchEvent(new Event('jax:locked'));
      throw new Error('locked');
    }
    if (!res.ok) throw new Error(`tts ${res.status}`);
    return res.blob();
  }

  async speakChunk(text) {
    if (this.stopRequested) return;
    if (this.elevenlabs) {
      let url = this._prefetched;
      this._prefetched = null;
      try {
        if (!url) {
          const blob = await this.fetchSpeech(text);
          url = URL.createObjectURL(blob);
        }
        await this.playUrl(url);
      } finally {
        if (url) URL.revokeObjectURL(url);
      }
    } else {
      await this.speakBrowser(text);
    }
  }

  async playUrl(url) {
    const ctx = await this.ensureAudioCtx();
    const audio = new Audio(url);
    audio.crossOrigin = 'anonymous';
    this.currentAudio = audio;
    let source = null;
    if (ctx) {
      try {
        source = ctx.createMediaElementSource(audio);
        source.connect(this.analyser);
      } catch {
        source = null;
      }
    }
    await new Promise((resolve, reject) => {
      const done = () => {
        cancelAnimationFrame(this._levelRaf);
        resolve();
      };
      audio.onended = done;
      audio.onerror = () => reject(new Error('audio playback error'));
      audio.play().catch(reject);
      if (ctx) {
        const pump = () => {
          if (!this.analyser) return;
          this.analyser.getByteTimeDomainData(this.audioData);
          let sum = 0;
          for (let i = 0; i < this.audioData.length; i++) {
            const v = (this.audioData[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / this.audioData.length);
          this.onLevel(Math.min(1, Math.pow(rms * 3.1, 0.8)));
          this._levelRaf = requestAnimationFrame(pump);
        };
        pump();
      }
    }).finally(() => {
      this.currentAudio = null;
      if (source) try { source.disconnect(); } catch { /* noop */ }
      cancelAnimationFrame(this._levelRaf);
      this.onLevel(0);
    });
  }

  speakBrowser(text) {
    return new Promise((resolve) => {
      if (!this.synth) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      if (this.browserVoice) u.voice = this.browserVoice;
      u.rate = this.rate;
      u.pitch = this.pitch;
      u.volume = 1;
      u.lang = this.browserVoice?.lang || 'en-US';

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearInterval(this.fakeLevelTimer);
        cancelAnimationFrame(this._levelRaf);
        this.onLevel(0);
        resolve();
      };
      u.onend = finish;
      u.onerror = finish;

      // speechSynthesis gives no amplitude — fake a believable envelope
      let t = 0;
      const pump = () => {
        t += 0.09;
        const env = 0.22 + 0.2 * Math.abs(Math.sin(t * 2.3)) + 0.16 * Math.abs(Math.sin(t * 5.1 + 1.2));
        this.onLevel(Math.min(0.9, env + (Math.random() - 0.5) * 0.06));
        this._levelRaf = requestAnimationFrame(pump);
      };
      this.synth.cancel();
      this.synth.speak(u);
      pump();
      // hard safety net — some engines never fire onend
      const guard = setTimeout(finish, Math.min(60000, (text.length / 11) * 1000 + 6000));
      const clearGuard = () => clearTimeout(guard);
      u.addEventListener('end', clearGuard);
      u.addEventListener('error', clearGuard);
    });
  }

  stop() {
    this.stopRequested = true;
    this.generation += 1;
    this.queue.forEach((job) => job.resolve());
    this.queue = [];
    if (this.synth) this.synth.cancel();
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
      } catch { /* noop */ }
    }
    if (this._prefetched) {
      URL.revokeObjectURL(this._prefetched);
      this._prefetched = null;
    }
    this.playing = false;
    this.onLevel(0);
    this.onState('silent');
  }

  /** Short synthesised chime — no audio files needed. */
  async chime(kind = 'wake') {
    const ctx = await this.ensureAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const notes = kind === 'wake' ? [880, 1320] : kind === 'error' ? [420, 300] : [660, 990, 1320];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.075);
      gain.gain.setValueAtTime(0, now + i * 0.075);
      gain.gain.linearRampToValueAtTime(kind === 'error' ? 0.05 : 0.075, now + i * 0.075 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.075 + 0.34);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.075);
      osc.stop(now + i * 0.075 + 0.36);
    });
  }
}

/* =============================================================== listener */

export class Listener {
  constructor(opts = {}) {
    this.wakeWords = opts.wakeWords || ['hey jax', 'hey nova', 'jax', 'nova'];
    this.lang = opts.lang || 'en-US';
    this.onWake = opts.onWake || (() => {});
    this.onCommand = opts.onCommand || (() => {});
    this.onInterim = opts.onInterim || (() => {});
    this.onStateChange = opts.onStateChange || (() => {});
    this.onError = opts.onError || (() => {});
    this.silenceMs = opts.silenceMs ?? 1500;
    this.maxCommandMs = opts.maxCommandMs ?? 15000;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = Boolean(SR);
    this.SR = SR;
    this.rec = null;
    this.shouldRun = false;
    this.mode = 'wake';
    this.buffer = '';
    this.interimText = '';
    this.lastActivity = 0;
    this.commandStarted = 0;
    this.silenceTimer = null;
    this.restartTimer = null;
    this.starting = false;
    this.speaking = false;
    this.paused = false;
    this.fatal = false;
  }

  get wakeRegex() {
    const alts = this.wakeWords
      .filter(Boolean)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .sort((a, b) => b.length - a.length);
    return new RegExp(`(?:^|[^a-z])(?:${alts.join('|')})(?![a-z])`, 'i');
  }

  start() {
    if (!this.supported || this.fatal) {
      this.onError(this.supported ? 'fatal' : 'unsupported');
      return false;
    }
    this.shouldRun = true;
    this.mode = 'wake';
    this.buffer = '';
    this.spawn();
    this.onStateChange('wake');
    return true;
  }

  spawn() {
    if (!this.shouldRun || this.starting) return;
    if (this.rec) {
      try { this.rec.abort(); } catch { /* noop */ }
      this.rec = null;
    }
    const rec = new this.SR();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      this.starting = false;
    };
    rec.onresult = (e) => this.handleResult(e);
    rec.onerror = (e) => this.handleError(e);
    rec.onend = () => {
      this.starting = false;
      this.rec = null;
      if (this.shouldRun && !this.paused) {
        this.restartTimer = setTimeout(() => this.spawn(), 260);
      }
    };

    try {
      this.starting = true;
      rec.start();
      this.rec = rec;
    } catch {
      this.starting = false;
      this.restartTimer = setTimeout(() => this.spawn(), 700);
    }
  }

  handleResult(event) {
    let interim = '';
    let finalText = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const text = (res[0]?.transcript || '').trim();
      if (!text) continue;
      if (res.isFinal) finalText += `${text} `;
      else interim += `${text} `;
    }
    finalText = finalText.trim();
    interim = interim.trim();
    if (!finalText && !interim) return;

    this.lastActivity = Date.now();
    this.onInterim(this.mode === 'command' ? `${this.buffer} ${interim}`.trim() : interim);

    if (this.mode === 'wake') {
      const probe = `${finalText || interim}`;
      const m = probe.match(this.wakeRegex);
      if (m) {
        const after = probe.slice(m.index + m[0].length).replace(/^[\s,.:;!?-]+/, '').trim();
        this.onWake({ at: Date.now() });
        this.enterCommandMode(after, Boolean(finalText));
      }
      return;
    }

    // command mode
    if (finalText) {
      this.buffer = `${this.buffer} ${finalText}`.replace(/\s+/g, ' ').trim();
    }
    if (this.buffer && this.buffer.length > 1) {
      this.armSilenceTimer();
      if (Date.now() - this.commandStarted > this.maxCommandMs) this.finalizeCommand();
    }
  }

  enterCommandMode(seed = '', seeded = false) {
    this.mode = 'command';
    this.buffer = seed ? seed.replace(/\s+/g, ' ').trim() : '';
    this.commandStarted = Date.now();
    this.lastActivity = Date.now();
    this.onStateChange('command');
    if (seeded && this.buffer) {
      // wake word and command arrived in the same final chunk — still confirm
      this.armSilenceTimer(900);
    } else if (this.buffer) {
      this.armSilenceTimer(1500);
    } else {
      // bare wake word: give the user a comfortable window to start talking
      this.armSilenceTimer(5000);
    }
    if (this.buffer) this.onInterim(this.buffer);
  }

  armSilenceTimer(ms = this.silenceMs) {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      if (Date.now() - this.lastActivity < ms - 30) {
        this.armSilenceTimer(ms);
        return;
      }
      this.finalizeCommand();
    }, ms);
  }

  finalizeCommand() {
    clearTimeout(this.silenceTimer);
    const text = this.buffer.replace(/\s+/g, ' ').trim();
    this.buffer = '';
    this.mode = 'wake';
    this.onInterim('');
    this.onStateChange('wake');
    if (text.length > 1) this.onCommand(text);
  }

  cancelCommand() {
    clearTimeout(this.silenceTimer);
    this.buffer = '';
    this.mode = 'wake';
    this.onInterim('');
    this.onStateChange('wake');
  }

  handleError(e) {
    const code = e.error || 'unknown';
    if (code === 'no-speech' || code === 'aborted') return;
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      this.fatal = true;
      this.shouldRun = false;
      this.shouldRun = false;
      this.onError(code);
      return;
    }
    console.warn('[jax] recognition error', code);
    this.onError(code);
  }

  /** Pause during TTS to reduce self-hearing (keeps barge-in handled by caller). */
  pause() {
    this.paused = true;
    clearTimeout(this.restartTimer);
    try { this.rec?.abort(); } catch { /* noop */ }
    this.rec = null;
  }

  resume() {
    this.paused = false;
    if (this.shouldRun && !this.fatal) {
      this.cancelCommand();
      this.spawn();
    }
  }

  stop() {
    this.shouldRun = false;
    clearTimeout(this.restartTimer);
    clearTimeout(this.silenceTimer);
    try { this.rec?.abort(); } catch { /* noop */ }
    this.rec = null;
    this.onStateChange('off');
  }

  /**
   * Push-to-talk fallback path: record N ms with MediaRecorder and transcribe
   * server-side via ElevenLabs Scribe.
   */
  async transcribeClip(ms = 6000, onTick) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('recording unavailable');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start(250);
    const started = Date.now();
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        onTick?.(Date.now() - started, ms);
        if (Date.now() - started >= ms) {
          clearInterval(iv);
          resolve();
        }
      }, 100);
    });
    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: mime || 'audio/webm' });
    if (blob.size < 1200) throw new Error('clip too short');
    const res = await fetch('/api/stt', {
      method: 'POST',
      headers: { 'content-type': blob.type || 'audio/webm' },
      body: blob,
    });
    if (res.status === 401) {
      window.dispatchEvent(new Event('jax:locked'));
      throw new Error('locked');
    }
    if (!res.ok) throw new Error(`stt ${res.status}`);
    const data = await res.json();
    return (data.text || '').trim();
  }
}
