/**
 * Small shared helpers: timeouts, HTML/XML wrangling, safe filenames.
 * Deliberately dependency-free.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function fetchWithTimeout(url, options = {}, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  try {
    return await fetch(url, { redirect: 'follow', ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function getText(url, { ms = 12000, headers = {} } = {}) {
  const res = await fetchWithTimeout(
    url,
    { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers } },
    ms,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export async function getJSON(url, opts = {}) {
  const res = await fetchWithTimeout(
    url,
    { headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) } },
    opts.ms || 12000,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export function stripHtml(s = '') {
  return decodeEntities(
    String(s)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim();
}

export function decodeEntities(s = '') {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
    ldquo: '“', rdquo: '”', middot: '·', bull: '•',
  };
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

function safeChar(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Minimal RSS/Atom reader — enough for Bing RSS and Google News. */
export function parseRss(xml = '') {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks) {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      if (!m) return '';
      const raw = m[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '');
      // decode first: escaped markup (&lt;b&gt;) only becomes strippable after decoding
      return stripHtml(decodeEntities(stripHtml(raw)));
    };
    const linkMatch =
      block.match(/<link[^>]*href="([^"]+)"/i) || block.match(/<link>([\s\S]*?)<\/link>/i);
    const item = {
      title: pick('title'),
      link: decodeEntities((linkMatch ? linkMatch[1] : '').trim()),
      description: pick('description') || pick('summary') || pick('content'),
      pubDate: pick('pubDate') || pick('updated') || pick('published'),
      source: pick('source') || '',
    };
    if (item.title) items.push(item);
  }
  return items;
}

/** Grab the most readable chunk of a page (best-effort, no DOM). */
export function extractReadable(html = '') {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => stripHtml(m[1]))
    .filter((p) => p.length > 60);
  return paras.slice(0, 12).join('\n\n').slice(0, 4000);
}

export function slugify(s = 'jax') {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'jax'
  );
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export function pick(obj, keys, fallback = undefined) {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  return fallback;
}

/** Sentence splitter used by the TTS queue (keeps punctuation). */
export function splitSentences(text = '') {
  return String(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+(?=[A-Z0-9"“'(\[])/)
    .flatMap((s) => (s.length > 260 ? s.match(/[^,;:]{1,240}[,;:]?/g) || [s] : [s]))
    .map((s) => s.trim())
    .filter(Boolean);
}
