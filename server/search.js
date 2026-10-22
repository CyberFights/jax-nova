/**
 * Keyless web search.
 * Chain of providers, first one that yields results wins:
 *   1. DuckDuckGo HTML, read through the r.jina.ai text proxy (best relevance)
 *   2. Bing RSS feed (structured, very reliable)
 *   3. Wikipedia full-text search (always available, narrower)
 */
import { getText, getJSON, stripHtml, decodeEntities, extractReadable } from './util.js';

const UA_PROXY = { 'x-respond-with': 'markdown' };

function decodeDdgLink(url = '') {
  const m = url.match(/[?&]uddg=([^&]+)/);
  if (!m) return url;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return url;
  }
}

async function duckduckgo(query, limit) {
  const target = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const text = await getText(`https://r.jina.ai/${target}`, { ms: 15000, headers: UA_PROXY });
  const items = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{1,4}\s*\[(.+?)\]\((https?:\/\/duckduckgo\.com\/l\/\?uddg=[^)\s]+)/);
    if (!m) continue;
    const title = stripHtml(m[1]);
    const url = decodeDdgLink(m[2]);
    if (!url.startsWith('http') || url.includes('duckduckgo.com')) continue;
    // the paragraph after the heading is usually the snippet
    let snippet = '';
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const cand = lines[j].trim();
      if (!cand || cand.startsWith('#') || cand.startsWith('![') || cand.startsWith('[')) continue;
      snippet = stripHtml(cand).slice(0, 320);
      break;
    }
    items.push({ title, url, snippet, provider: 'duckduckgo' });
    if (items.length >= limit) break;
  }
  return items;
}

async function bingRss(query, limit) {
  const xml = await getText(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=${limit + 4}`,
    { ms: 10000 },
  );
  const { parseRss } = await import('./util.js');
  return parseRss(xml)
    .slice(0, limit)
    .map((i) => ({ title: i.title, url: i.link, snippet: i.description, provider: 'bing' }));
}

async function wikipediaSearch(query, limit) {
  const data = await getJSON(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      query,
    )}&format=json&srlimit=${limit}&origin=*`,
    { headers: { 'User-Agent': 'JaxNova/1.0 (local assistant)' } },
  );
  const hits = data?.query?.search || [];
  return hits.map((h) => ({
    title: h.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`,
    snippet: stripHtml(h.snippet || ''),
    provider: 'wikipedia',
  }));
}

export async function webSearch(query, limit = 5) {
  const attempts = [duckduckgo, bingRss, wikipediaSearch];
  const errors = [];
  for (const fn of attempts) {
    try {
      const items = (await fn(query, limit)).filter((i) => i.title && i.url);
      if (items.length) return { query, items, provider: items[0].provider };
    } catch (err) {
      errors.push(`${fn.name}: ${err.message}`);
    }
  }
  return { query, items: [], provider: null, errors };
}

/** Fetch and condense a URL into readable text (for "summarise this page"). */
export async function readPage(url) {
  const html = await getText(url, { ms: 15000 });
  const body = extractReadable(html);
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]).trim();
  return { title, text: body, url };
}

/** Good enough instant answers without any LLM in the loop. */
export async function quickAnswer(query) {
  const q = query.trim();
  const wikiTitle = q.replace(/^(who|what|where|when|why|how)\s+(is|are|was|were|does|do|did)\s+/i, '');
  try {
    const data = await getJSON(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
        wikiTitle.replace(/\s+/g, '_'),
      )}?redirect=true`,
      { headers: { 'User-Agent': 'JaxNova/1.0 (local assistant)' }, ms: 8000 },
    );
    if (data?.extract && data.type !== 'disambiguation') {
      return {
        text: data.extract,
        title: data.title,
        url: data.content_urls?.desktop?.page || '',
        source: 'Wikipedia',
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}
