/**
 * Jax Nova skill registry.
 *
 * Every skill is a plain object:
 *   { name, description, schema (JSON Schema), summary(args) → spoken text, run(args, ctx) → result }
 *
 * A result is: { say?: string, actions?: Action[], data?: any }
 * "actions" are executed by the browser HUD (cards, galleries, themes, timers…).
 * The same registry powers both the Claude tool-use loop and the keyless brain.
 */
import { webSearch, quickAnswer, readPage } from './search.js';
import { generateImages, generateVideo } from './media.js';
import { getJSON, parseRss, stripHtml } from './util.js';
import { config } from './config.js';
import { wrestleChat, wrestleHealth } from './wrestle.js';

const ctxLocation = (ctx = {}) => ({
  lat: ctx.lat,
  lon: ctx.lon,
  name: ctx.location || ctx.cityName || config.assistant.location,
});

/* ------------------------------------------------------------------ weather */

const WMO = {
  0: ['clear sky', '☀️'], 1: ['mainly clear', '🌤️'], 2: ['partly cloudy', '⛅'],
  3: ['overcast', '☁️'], 45: ['fog', '🌫️'], 48: ['freezing fog', '🌫️'],
  51: ['light drizzle', '🌦️'], 53: ['drizzle', '🌦️'], 55: ['heavy drizzle', '🌦️'],
  56: ['freezing drizzle', '🌧️'], 57: ['freezing drizzle', '🌧️'],
  61: ['light rain', '🌧️'], 63: ['rain', '🌧️'], 65: ['heavy rain', '🌧️'],
  66: ['freezing rain', '🌧️'], 67: ['freezing rain', '🌧️'],
  71: ['light snow', '🌨️'], 73: ['snow', '🌨️'], 75: ['heavy snow', '❄️'], 77: ['snow grains', '🌨️'],
  80: ['rain showers', '🌦️'], 81: ['rain showers', '🌦️'], 82: ['violent rain showers', '⛈️'],
  85: ['snow showers', '🌨️'], 86: ['heavy snow showers', '❄️'],
  95: ['thunderstorm', '⛈️'], 96: ['thunderstorm with hail', '⛈️'], 99: ['severe thunderstorm', '⛈️'],
};

async function geocode(name) {
  if (!name) return null;
  const data = await getJSON(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`,
  );
  const hit = data?.results?.[0];
  if (!hit) return null;
  return {
    lat: hit.latitude,
    lon: hit.longitude,
    name: [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(', '),
  };
}

/* --------------------------------------------------------------- calculator */

/** Tiny safe arithmetic evaluator (no eval). */
function calculate(expression) {
  let src = String(expression)
    .toLowerCase()
    .trim()
    .replace(/^(what('| i)?s|what is|calculate|compute|work out|how much is|evaluate)\s+/i, '')
    .replace(/\?$/, '')
    .replace(/\bsquared\b/g, '^2')
    .replace(/\bcubed\b/g, '^3')
    .replace(/\bpercent of\b/g, '% of')
    .replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*/g, '($1/100)*')
    .replace(/\bof\b/g, '*')
    .replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-')
    .replace(/\bplus\b/g, '+').replace(/\bminus\b/g, '-')
    .replace(/\btimes\b|\bmultiplied by\b/g, '*').replace(/\bdivided by\b|\bover\b/g, '/')
    .replace(/\bto the power of\b|\bpower\b/g, '^')
    .replace(/\bpi\b/g, String(Math.PI)).replace(/\be\b/g, String(Math.E))
    .replace(/[^0-9a-z+\-*/%^().,\s]/g, ' ')
    .replace(/,/g, '');

  let i = 0;
  const s = src.replace(/\s+/g, '');
  const peek = () => s[i];
  const eat = (c) => (s[i] === c ? (i++, true) : false);

  function parseExpr() {
    let v = parseTerm();
    for (;;) {
      if (eat('+')) v += parseTerm();
      else if (eat('-')) v -= parseTerm();
      else return v;
    }
  }
  function parseTerm() {
    let v = parsePow();
    for (;;) {
      if (eat('*')) v *= parsePow();
      else if (eat('/')) v /= parsePow();
      else if (eat('%')) v %= parsePow();
      else return v;
    }
  }
  function parsePow() {
    const base = parseUnary();
    if (eat('^')) return Math.pow(base, parsePow());
    return base;
  }
  function parseUnary() {
    if (eat('-')) return -parseUnary();
    if (eat('+')) return parseUnary();
    return parseAtom();
  }
  function parseAtom() {
    if (eat('(')) {
      const v = parseExpr();
      eat(')');
      return v;
    }
    const fnMatch = /^[a-z]+/.exec(s.slice(i));
    if (fnMatch) {
      const name = fnMatch[0];
      i += name.length;
      const fns = {
        sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor,
        ceil: Math.ceil, sin: Math.sin, cos: Math.cos, tan: Math.tan,
        log: Math.log10, ln: Math.log, exp: Math.exp, cbrt: Math.cbrt,
      };
      if (fns[name]) {
        let arg;
        if (eat('(')) {
          arg = parseExpr();
          eat(')');
        } else arg = parseUnary();
        return fns[name](arg);
      }
      throw new Error(`unknown function ${name}`);
    }
    const numMatch = /^\d*\.?\d+/.exec(s.slice(i));
    if (!numMatch) throw new Error('unexpected token');
    i += numMatch[0].length;
    return parseFloat(numMatch[0]);
  }

  const value = parseExpr();
  if (i < s.length) throw new Error('trailing input');
  if (!Number.isFinite(value)) throw new Error('not a finite number');
  // trim binary floating point noise (18% of 240 → 43.2, not 43.199999999999996)
  return Math.round(value * 1e12) / 1e12;
}

/* ------------------------------------------------------------------ skills */

export const skills = [
  {
    name: 'web_search',
    description:
      'Search the live web. Use for current events, facts you are unsure about, prices, scores, products, people, or anything time-sensitive. Returns titles, snippets and URLs.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'integer', description: 'How many results (1-8)', default: 5 },
      },
      required: ['query'],
    },
    async run({ query, limit = 5 }) {
      const res = await webSearch(query, Math.min(Math.max(limit, 1), 8));
      const lines = res.items.map((r, idx) => `${idx + 1}. ${r.title} — ${r.snippet}`).join('\n');
      return {
        say: res.items.length
          ? `Here's what I found on ${query}.`
          : `I couldn't pull live results for that.`,
        actions: res.items.length
          ? [{ type: 'results', title: 'Web results', query, items: res.items }]
          : [],
        data: { query, results: res.items, provider: res.provider, formatted: lines },
      };
    },
  },

  {
    name: 'read_page',
    description: 'Fetch a web page and return its readable text. Use to dig into a specific URL.',
    schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    async run({ url }) {
      const page = await readPage(url);
      return {
        say: `I read ${page.title || 'that page'}.`,
        actions: [{ type: 'card', title: page.title || 'Page', subtitle: url, body: page.text.slice(0, 1400) }],
        data: page,
      };
    },
  },

  {
    name: 'get_weather',
    description: 'Current conditions and today\'s forecast for a place. Omit location to use the user\'s location.',
    schema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name, or omit for current location' },
        days: { type: 'integer', description: '1-5 day forecast', default: 3 },
      },
    },
    async run({ location, days = 3 }, ctx = {}) {
      let place = ctxLocation(ctx);
      if (location) {
        const geo = await geocode(location).catch(() => null);
        if (geo) place = geo;
      }
      if (place.lat == null || place.lon == null) {
        const geo = await geocode(config.assistant.location);
        if (geo) place = geo;
      }
      const metric = config.assistant.units !== 'imperial';
      const unit = metric ? 'celsius' : 'fahrenheit';
      const windUnit = metric ? 'kmh' : 'mph';
      const data = await getJSON(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
          `&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m` +
          `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
          `&hourly=temperature_2m,weather_code&forecast_days=${Math.min(Math.max(days, 1), 5)}` +
          `&timezone=auto&temperature_unit=${unit}&wind_speed_unit=${windUnit}`,
      );
      const cur = data.current || {};
      const [desc, icon] = WMO[cur.weather_code] || ['unknown', '🌡️'];
      const temp = Math.round(cur.temperature_2m);
      const feels = Math.round(cur.apparent_temperature);
      const daily = (data.daily?.time || []).map((t, i) => ({
        date: t,
        high: Math.round(data.daily.temperature_2m_max[i]),
        low: Math.round(data.daily.temperature_2m_min[i]),
        code: data.daily.weather_code[i],
        rain: data.daily.precipitation_probability_max?.[i] ?? null,
      }));
      const hourly = (data.hourly?.time || []).slice(0, 24).map((t, i) => ({
        time: t,
        temp: Math.round(data.hourly.temperature_2m[i]),
        code: data.hourly.weather_code[i],
      }));
      const deg = metric ? 'C' : 'F';
      return {
        say: `${place.name || 'your area'} is ${temp} degrees ${desc}, feels like ${feels}. High of ${daily[0]?.high} and a low of ${daily[0]?.low}.`,
        actions: [
          {
            type: 'weather',
            location: place.name || 'Current location',
            temp,
            feels,
            desc,
            icon,
            unit: `°${deg}`,
            humidity: cur.relative_humidity_2m,
            wind: Math.round(cur.wind_speed_10m),
            windUnit,
            daily,
            hourly,
          },
        ],
        data: { current: cur, daily, location: place, desc },
      };
    },
  },

  {
    name: 'get_news',
    description: 'Top news headlines, optionally about a topic.',
    schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Optional topic, e.g. "AI", "Maple Leafs"' },
        limit: { type: 'integer', default: 6 },
      },
    },
    async run({ topic, limit = 6 }) {
      const q = topic ? topic : 'top stories';
      const url = topic
        ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-CA&gl=CA&ceid=CA:en`
        : 'https://news.google.com/rss?hl=en-CA&gl=CA&ceid=CA:en';
      const res = await fetch(url, { headers: { 'User-Agent': 'JaxNova/1.0' } });
      const xml = await res.text();
      const items = parseRss(xml).slice(0, Math.min(Math.max(limit, 1), 10)).map((i) => ({
        title: i.title,
        url: i.link,
        source: i.source || '',
        date: i.pubDate,
      }));
      const headline = items[0]?.title || '';
      return {
        say: items.length
          ? `${topic ? `Top ${topic} headlines` : 'Top stories right now'}. First: ${headline}`
          : `I couldn't reach the news feed.`,
        actions: [{ type: 'news', title: topic ? `News · ${topic}` : 'Top stories', items }],
        data: { items },
      };
    },
  },

  {
    name: 'wikipedia',
    description: 'Encyclopedic summary of a person, place, thing or concept.',
    schema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
    async run({ topic }) {
      const ans = await quickAnswer(topic);
      if (!ans) {
        const res = await webSearch(topic, 4);
        return {
          say: `No direct encyclopaedia entry. Here are the closest web results.`,
          actions: [{ type: 'results', title: topic, query: topic, items: res.items }],
          data: res,
        };
      }
      const short = ans.text.split(/(?<=[.!?])\s/).slice(0, 3).join(' ');
      return {
        say: short,
        actions: [
          { type: 'card', title: ans.title, subtitle: ans.source, body: ans.text, url: ans.url, tone: 'info' },
        ],
        data: ans,
      };
    },
  },

  {
    name: 'open_url',
    description: 'Open a website in the user\'s browser, or show it in a HUD viewer panel.',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        label: { type: 'string' },
        mode: { type: 'string', enum: ['tab', 'panel'], description: 'New tab or in-HUD panel' },
      },
      required: ['url'],
    },
    async run({ url, label, mode = 'tab' }) {
      let fixed = url.trim();
      if (!/^https?:\/\//i.test(fixed)) fixed = `https://${fixed}`;
      const host = (() => {
        try {
          return new URL(fixed).hostname.replace(/^www\./, '');
        } catch {
          return fixed;
        }
      })();
      return {
        say: `Opening ${label || host}.`,
        actions: [{ type: 'open', url: fixed, label: label || host, mode }],
      };
    },
  },

  {
    name: 'browser_control',
    description:
      'Drive the HUD/browser: start a web search in a real tab, scroll, go fullscreen, mute, play or pause media, or switch theme.',
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search_tab', 'scroll', 'fullscreen', 'mute', 'theme', 'reload'],
        },
        query: { type: 'string' },
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
        theme: { type: 'string' },
      },
      required: ['action'],
    },
    async run({ action, query, direction, theme }) {
      switch (action) {
        case 'search_tab':
          return {
            say: `Searching the web for ${query}.`,
            actions: [
              { type: 'open', url: `https://duckduckgo.com/?q=${encodeURIComponent(query || '')}`, label: query },
            ],
          };
        case 'fullscreen':
          return { say: 'Going fullscreen.', actions: [{ type: 'ui', action: 'fullscreen' }] };
        case 'mute':
          return { say: 'Audio muted.', actions: [{ type: 'ui', action: 'mute' }] };
        case 'reload':
          return { say: 'Recompiling the interface.', actions: [{ type: 'ui', action: 'reload' }] };
        case 'scroll':
          return { say: '', actions: [{ type: 'ui', action: 'scroll', direction: direction || 'down' }] };
        case 'theme':
          return { say: `Switching to ${theme}.`, actions: [{ type: 'theme', theme }] };
        default:
          return { say: 'I can search a tab, scroll, go fullscreen, mute, or change theme.' };
      }
    },
  },

  {
    name: 'show_card',
    description: 'Put information on the holographic display as a card.',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        items: { type: 'array', items: { type: 'string' }, description: 'Optional bullet list' },
        tone: { type: 'string', enum: ['info', 'warn', 'good'] },
      },
      required: ['title'],
    },
    async run({ title, body, items, tone = 'info' }) {
      return { say: body ? body.split(/(?<=[.!?])\s/)[0] : title, actions: [{ type: 'card', title, body, items, tone }] };
    },
  },

  {
    name: 'generate_image',
    description:
      'Create an image from a text prompt and display it in the HUD gallery. Default to one image; only request several when the user explicitly asks for variations (free engines rate-limit bursts).',
    schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        style: {
          type: 'string',
          enum: ['holo', 'cinematic', 'neon', 'ink', 'blueprint', 'photorealism', 'retro'],
        },
        count: { type: 'integer', default: 1, description: '1-4 images; keep at 1 unless variations were requested' },
      },
      required: ['prompt'],
    },
    async run({ prompt, style = 'holo', count = 1 }) {
      if (!config.features.imageGen) return { say: 'Image generation is disabled in config.' };
      const images = await generateImages({ prompt, style, count });
      const ok = images.filter((i) => i.url);
      const provider = ok[0]?.provider || 'none';
      const note = ok.find((i) => i.note)?.note;
      const label =
        provider === 'local-schematic'
          ? 'The image engines are rate-limited right now, so I rendered a local holographic schematic.'
          : ok.length === 1
            ? `Rendering an image of ${prompt}.`
            : `Rendering ${ok.length} images of ${prompt}.`;
      return {
        say: ok.length ? label : `The image engine didn't return anything, sorry.`,
        actions: ok.length
          ? [{ type: 'image', prompt, style, images: ok, provider, note }]
          : [{ type: 'card', title: 'Image engine', body: images[0]?.errors?.join('\n') || 'No image returned.', tone: 'warn' }],
        data: { images },
      };
    },
  },

  {
    name: 'generate_video',
    description:
      'Synthesise a short looping cinematic "holo-motion" clip from a text prompt (frame synthesis + motion). Use when the user asks for a video or animation.',
    schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        style: { type: 'string', enum: ['cinematic', 'neon', 'holo', 'blueprint', 'retro'] },
      },
      required: ['prompt'],
    },
    async run({ prompt, style = 'cinematic' }) {
      if (!config.features.videoGen) return { say: 'Video synthesis is disabled in config.' };
      const frames = await generateVideo({ prompt, style });
      const ok = frames.filter((f) => f.url);
      const schematic = ok.some((f) => f.provider === 'local-schematic');
      const label = schematic
        ? 'The free render engines are rate-limited, so this motion study is built from local schematics.'
        : `Sequencing a ${ok.length}-frame motion study of ${prompt}.`;
      return {
        say: ok.length ? label : 'The render failed.',
        actions: ok.length
          ? [{ type: 'video', prompt, style, frames: ok, schematic }]
          : [{ type: 'card', title: 'Motion engine', body: frames[0]?.errors?.join('\n') || 'No frames returned.', tone: 'warn' }],
        data: { frames },
      };
    },
  },

  {
    name: 'set_timer',
    description: 'Start a countdown timer on the HUD, or list/cancel active timers.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'list', 'cancel'], default: 'start' },
        seconds: { type: 'integer' },
        label: { type: 'string' },
      },
      required: ['action'],
    },
    async run({ action = 'start', seconds = 60, label }) {
      if (action === 'list') return { say: 'Listing active timers.', actions: [{ type: 'timer', action: 'list' }] };
      if (action === 'cancel')
        return { say: 'Timers cleared.', actions: [{ type: 'timer', action: 'cancel', label }] };
      const mins = seconds >= 60 ? `${Math.round(seconds / 60)} minute${seconds >= 120 ? 's' : ''}` : `${seconds} seconds`;
      return {
        say: `Timer set for ${mins}.`,
        actions: [{ type: 'timer', action: 'start', seconds, label: label || `${mins} timer` }],
      };
    },
  },

  {
    name: 'remember',
    description: 'Save a note/memory to the local HUD, or recall saved notes.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'list'], default: 'save' },
        text: { type: 'string' },
      },
      required: ['action'],
    },
    async run({ action = 'save', text }) {
      if (action === 'list') return { say: 'Here are your notes.', actions: [{ type: 'note', action: 'list' }] };
      return { say: `Noted: ${text}`, actions: [{ type: 'note', action: 'save', text }] };
    },
  },

  {
    name: 'calculate',
    description: 'Evaluate an arithmetic expression or quick unit conversion.',
    schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
    async run({ expression }) {
      try {
        const value = calculate(expression);
        const pretty = Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);
        return {
          say: `${expression.trim()} equals ${pretty}.`,
          actions: [{ type: 'card', title: pretty, subtitle: expression.trim(), tone: 'good' }],
          data: { value },
        };
      } catch {
        return { say: `I couldn't parse that expression.` };
      }
    },
  },

  {
    name: 'set_theme',
    description: 'Change the HUD colour theme or visual style (reactor look, density, effects).',
    schema: {
      type: 'object',
      properties: {
        theme: { type: 'string', enum: ['arc', 'mark3', 'stealth', 'ultron', 'vibranium', 'quantum'] },
        style: { type: 'string', enum: ['torus', 'hex', 'plasma', 'wave', 'minimal'] },
        density: { type: 'string', enum: ['minimal', 'tactical', 'full'] },
      },
    },
    async run(args) {
      return {
        say: `Interface reconfigured.`,
        actions: [{ type: 'theme', ...args }],
      };
    },
  },

  {
    name: 'wrestle_chat',
    description:
      'Talk to the Wrestle-ai /wrestling_chat endpoint — a separate Mistral-powered conversational persona (Jax Nova) that keeps its own memory per user_id. Use when the user explicitly asks for "the wrestling bot", "the other Jax", or asks you to relay a message to that service. Do not use it for ordinary conversation unless this brain is configured as the wrestle provider.',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to say to the Wrestle-ai persona' },
        user_id: { type: 'string', description: 'Optional override for the memory key' },
      },
      required: ['message'],
    },
    async run({ message, user_id }, ctx) {
      if (!config.wrestle.url) return { say: 'The Wrestle-ai bridge is not configured.' };
      try {
        const out = await wrestleChat(message, { userId: user_id || ctx?.wrestleUser || undefined });
        return {
          say: out.response,
          actions: [
            {
              type: 'card',
              title: 'Wrestle-ai',
              subtitle: `/wrestling_chat · ${out.latencyMs} ms`,
              body: out.response,
              tone: 'info',
            },
          ],
          data: {
            response: out.response,
            user_id: out.userId,
            latency_ms: out.latencyMs,
            source: 'wrestle-ai /wrestling_chat',
          },
        };
      } catch (err) {
        return {
          say: `The Wrestle-ai endpoint didn't answer — ${err.message.slice(0, 90)}.`,
          actions: [{ type: 'card', title: 'Wrestle-ai unreachable', body: err.message, tone: 'warn' }],
        };
      }
    },
  },

  {
    name: 'system_status',
    description: 'Report assistant diagnostics: brain, voice engine, latency, uptime.',
    schema: { type: 'object', properties: {} },
    async run(_args, ctx = {}) {
      const caps = ctx.capabilities || {};
      const provider = caps?.brain?.provider || config.brain.provider;
      return {
        say: `Running on the ${provider} brain, with ${caps?.voice?.elevenlabs ? 'ElevenLabs' : 'browser'} voice. All systems nominal.`,
        actions: [{ type: 'status' }],
        data: caps,
      };
    },
  },
];

export const skillMap = new Map(skills.map((s) => [s.name, s]));

/** Anthropic tool definitions. */
export const toolDefinitions = skills.map((s) => ({
  name: s.name,
  description: s.description,
  input_schema: s.schema,
}));

/** OpenAI-style definitions (for the OpenAI-compatible brain). */
export const openaiToolDefinitions = skills.map((s) => ({
  type: 'function',
  function: { name: s.name, description: s.description, parameters: s.schema },
}));

export async function runSkill(name, args, ctx) {
  const skill = skillMap.get(name);
  if (!skill) throw new Error(`unknown skill: ${name}`);
  return { skill: name, args, ...(await skill.run(args || {}, ctx)) };
}

export { calculate };
