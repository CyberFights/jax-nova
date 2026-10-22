/**
 * Instant intent router.
 * Anything deterministic is answered here in ~1ms, before any model call.
 * That's what keeps "react to voice commands" feeling lag-free.
 */

const norm = (s = '') =>
  String(s)
    .toLowerCase()
    .replace(/[^\w\s:'’\-.,!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const timeIn = (tz) => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/Toronto',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toLocaleTimeString();
  }
};

const dateIn = (tz) => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/Toronto',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date());
  } catch {
    return new Date().toDateString();
  }
};

const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fortyfive: 45, sixty: 60, half: 0.5, a: 1, an: 1 };

function parseDuration(text) {
  const t = norm(text);
  const m = t.match(/(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fortyfive|sixty|half|an?|a)\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs)/);
  if (!m) return null;
  const raw = m[1];
  const n = /^\d/.test(raw) ? parseFloat(raw) : words[raw] ?? 1;
  const unit = m[2];
  const mult = unit.startsWith('h') ? 3600 : unit.startsWith('m') && !unit.startsWith('mo') ? 60 : 1;
  return Math.round(n * mult);
}

const THEMES = ['arc', 'mark3', 'stealth', 'ultron', 'vibranium', 'quantum'];
const STYLES = ['torus', 'hex', 'plasma', 'wave', 'minimal'];

/** Returns { say, actions, kind } or null if the brain should handle it. */
export function route(text, ctx = {}) {
  const t = norm(text);
  if (!t) return null;
  const tz = ctx.timezone;

  // --- wake / greeting
  if (/^(hey |ok |okay )?(jax|nova|jarvis)[,.! ]*$/.test(t) || /^(hello|hi|hey|yo|good (morning|afternoon|evening))( there)?( jax| nova| jarvis)?[!.]*$/.test(t)) {
    const greeting = /good morning/.test(t)
      ? 'Morning. Systems are warm and I am listening.'
      : /good (afternoon|evening)/.test(t)
        ? 'Right here. What are we building?'
        : ctx.briefOnWake === false
          ? 'Online.'
          : 'Online. Reactor stable, all systems nominal. What do you need?';
    return { say: greeting, actions: [], kind: 'greeting' };
  }

  if (/\b(who are you|what are you|your name)\b/.test(t)) {
    return {
      say: "I'm Jax Nova. Your interface to everything wired into this machine — search, weather, images, whatever you point me at.",
      actions: [],
      kind: 'identity',
    };
  }

  if (/\b(what can you do|help|commands|capabilities)\b/.test(t)) {
    return { say: 'Opening the capability list.', actions: [{ type: 'help' }], kind: 'help' };
  }

  if (/\b(thank you|thanks|cheers|appreciate it)\b/.test(t)) return { say: 'Anytime.', actions: [], kind: 'ack' };

  // --- time & date
  if (/\b(what('s| is)? the time|what time is it|current time|time is it)\b/.test(t)) {
    const now = timeIn(tz);
    return { say: `It's ${now}.`, actions: [{ type: 'card', title: now, subtitle: 'Local time', tone: 'info' }], kind: 'time' };
  }
  if (/\b(what('s| is)? the date|what day is it|today'?s date)\b/.test(t)) {
    const d = dateIn(tz);
    return { say: `It's ${d}.`, actions: [{ type: 'card', title: d, subtitle: 'Today', tone: 'info' }], kind: 'date' };
  }

  // --- timers
  if (/\b(timer|countdown|remind me in)\b/.test(t)) {
    if (/\b(cancel|stop|clear)\b/.test(t)) return { say: 'Timers cleared.', actions: [{ type: 'timer', action: 'cancel' }], kind: 'timer' };
    if (/\b(list|show)\b/.test(t)) return { say: 'Here are your timers.', actions: [{ type: 'timer', action: 'list' }], kind: 'timer' };
    const seconds = parseDuration(t);
    if (seconds) {
      const label = `${seconds % 60 === 0 ? seconds / 60 + ' min' : seconds + ' sec'} timer`;
      return {
        say: `Timer armed. ${label}.`,
        actions: [{ type: 'timer', action: 'start', seconds, label }],
        kind: 'timer',
      };
    }
  }

  // --- interface control
  if (/\b(full ?screen)\b/.test(t)) {
    const off = /\b(exit|leave|off)\b/.test(t);
    return { say: off ? 'Exiting fullscreen.' : 'Fullscreen.', actions: [{ type: 'ui', action: off ? 'fullscreen-exit' : 'fullscreen' }], kind: 'ui' };
  }
  if (/\b(mute|silence|quiet|shut up|stop talking)\b/.test(t) && !/unmute/.test(t)) {
    return { say: '', actions: [{ type: 'ui', action: 'mute' }], kind: 'ui', silent: true };
  }
  if (/\bunmute\b/.test(t)) return { say: 'Audio back on.', actions: [{ type: 'ui', action: 'unmute' }], kind: 'ui' };
  if (/\b(clear|wipe|clean) (the )?(screen|display|feed|board)\b/.test(t)) {
    return { say: 'Cleared.', actions: [{ type: 'clear' }], kind: 'ui' };
  }
  if (/\b(sleep|stand by|standby|go dark)\b/.test(t)) {
    return { say: 'Standing by.', actions: [{ type: 'ui', action: 'sleep' }], kind: 'ui' };
  }

  const themeHit = THEMES.find((th) => new RegExp(`\\b${th}\\b`).test(t));
  if (/\b(theme|palette|colour|color|skin)\b/.test(t) && themeHit) {
    return { say: `${themeHit} palette engaged.`, actions: [{ type: 'theme', theme: themeHit }], kind: 'theme' };
  }
  const styleHit = STYLES.find((st) => new RegExp(`\\b${st}\\b`).test(t));
  if (/\b(reactor|style|visual|look)\b/.test(t) && styleHit) {
    return { say: `Reactor set to ${styleHit}.`, actions: [{ type: 'theme', style: styleHit }], kind: 'theme' };
  }

  // --- notes
  if (/^(remember|note)( that)?[ :]/.test(t) || /\b(make a note|take a note)\b/.test(t)) {
    const body = text.replace(/^(remember|note)( that)?[ :]+/i, '').replace(/^(make a note|take a note)( that)?[ :]*/i, '').trim();
    if (body) return { say: `Noted.`, actions: [{ type: 'note', action: 'save', text: body }], kind: 'note' };
  }
  if (/\b(what are my notes|read my notes|list notes|show notes)\b/.test(t)) {
    return { say: 'Bringing up your notes.', actions: [{ type: 'note', action: 'list' }], kind: 'note' };
  }

  // --- diagnostics
  if (/\b(system status|systems check|diagnostics|status report|are you online)\b/.test(t)) {
    return { say: 'Running diagnostics.', actions: [{ type: 'status' }], kind: 'status' };
  }

  return null;
}

export { parseDuration, timeIn, dateIn };
