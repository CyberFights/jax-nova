/**
 * High-confidence intent detection.
 *
 * These run before any model call. When a command clearly maps to a skill we
 * execute it immediately — that is what makes Jax feel instant on commands
 * like "what's the weather", "open github.com" or "draw a neon dragon".
 * Anything ambiguous falls through to the brain.
 */

const STYLE_WORDS = {
  holo: ['holo', 'holographic', 'hologram'],
  cinematic: ['cinematic', 'film', 'movie still', 'moody'],
  neon: ['neon', 'cyberpunk', 'synthwave'],
  ink: ['ink', 'watercolour', 'watercolor', 'sketch', 'hand drawn'],
  blueprint: ['blueprint', 'schematic', 'technical drawing'],
  photorealism: ['photorealistic', 'realistic', 'photo', 'photograph'],
  retro: ['retro', 'vintage', 'eighties', '80s'],
};

function detectStyle(text) {
  const t = text.toLowerCase();
  for (const [style, words] of Object.entries(STYLE_WORDS)) {
    if (words.some((w) => t.includes(w))) return style;
  }
  return null;
}

function stripStyle(text) {
  return text
    .replace(/\b(in|with|using)\s+(a\s+)?(holo|holographic|hologram|cinematic|neon|cyberpunk|synthwave|ink|watercolour|watercolor|sketch|blueprint|schematic|photorealistic|realistic|retro|vintage)\s*(style|look|aesthetic)?\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[,\s]+$/, '')
    .trim();
}

function extractAfter(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return m[1].trim().replace(/[.?!]+$/, '');
  }
  return null;
}

const IMAGE_VERB = /\b(generate|create|make|draw|paint|render|produce|show me|give me|imagine|design)\b/i;
const IMAGE_NOUN = /\b(image|picture|photo|photograph|art|artwork|drawing|illustration|render|wallpaper|portrait|logo|concept art)\b/i;
const VIDEO_NOUN = /\b(video|animation|clip|motion|sequence|trailer|loop|film)\b/i;
const COUNT_WORDS = { two: 2, three: 3, four: 4, '2': 2, '3': 3, '4': 4, couple: 2, few: 3 };

/**
 * @returns {{skill:string, args:object, summarize?:boolean}|null}
 */
export function fastIntent(text, ctx = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const t = raw.toLowerCase();

  /* ---------------------------------------------------------------- weather */
  if (/\b(weather|forecast|temperature|how (hot|cold|warm) is it|is it (raining|snowing)|rain today|snow today|humidity|wind speed)\b/.test(t)) {
    const place = extractAfter(raw, [
      /\b(?:weather|forecast|temperature)\s+(?:in|at|for)\s+([a-z][a-z\s,'.-]{2,40})/i,
      /\b(?:in|at|for)\s+([a-z][a-z\s,'.-]{2,40})$/i,
    ]);
    return { skill: 'get_weather', args: place ? { location: place } : {} };
  }

  /* ------------------------------------------------------------------- news */
  if (/\b(news|headlines|what's happening|whats happening|top stories|breaking)\b/.test(t)) {
    const topic = extractAfter(raw, [
      /\b(?:news|headlines)\s+(?:about|on|for|in)\s+([a-z0-9][\w\s'.-]{1,40})/i,
      /\b(?:about|on)\s+([a-z0-9][\w\s'.-]{1,40})$/i,
    ]);
    return { skill: 'get_news', args: topic ? { topic } : {} };
  }

  /* ------------------------------------------------------------------ video */
  if (VIDEO_NOUN.test(t) && (IMAGE_VERB.test(t) || /\bvideo of\b/.test(t) || /\banimat(e|ion)\b/.test(t))) {
    const prompt =
      extractAfter(raw, [
        /\b(?:video|animation|clip|motion|sequence|trailer|loop|film)\s+(?:of|showing|about)\s+(.+)$/i,
        /\b(?:generate|create|make|render|produce|show me|give me|imagine|design)\s+(?:me\s+)?(?:a|an|some)?\s*(?:short\s+)?(?:video|animation|clip|motion|sequence|trailer|loop|film)\s*(?:of|showing|about|for)?\s*(.+)$/i,
      ]) || null;
    if (prompt) {
      return { skill: 'generate_video', args: { prompt: stripStyle(prompt), style: detectStyle(raw) || 'cinematic' } };
    }
  }

  /* ------------------------------------------------------------------ image */
  if (IMAGE_NOUN.test(t) && (IMAGE_VERB.test(t) || /\bof\b/.test(t))) {
    const prompt =
      extractAfter(raw, [
        /\b(?:image|picture|photo|photograph|art|artwork|drawing|illustration|render|wallpaper|portrait|concept art)\s+of\s+(.+)$/i,
        /\b(?:generate|create|make|draw|paint|render|produce|imagine|design|show me|give me)\s+(?:me\s+)?(?:a|an|some|the)?\s*(?:image|picture|photo|photograph|art|artwork|drawing|illustration|render|wallpaper|portrait|concept art)?\s*(?:of|showing|with|featuring)?\s*(.+)$/i,
      ]) || null;
    if (prompt && prompt.length > 2) {
      const countMatch = t.match(/\b(two|three|four|couple|few)\b/);
      const count = countMatch ? COUNT_WORDS[countMatch[1]] || 1 : 1;
      return {
        skill: 'generate_image',
        args: { prompt: stripStyle(prompt), style: detectStyle(raw) || 'holo', count },
      };
    }
  }

  // bare art verbs with no explicit noun: "draw a neon dragon", "sketch my cat"
  const artVerb = raw.match(/^(?:please\s+)?(?:can you\s+|could you\s+)?(draw|paint|render|sketch|imagine|illustrate)\s+(?:me\s+)?(?:a|an|some)?\s*(.+)$/i);
  if (artVerb && artVerb[2].trim().length > 2) {
    const prompt = stripStyle(artVerb[2]);
    const countMatch = prompt.match(/\b(two|three|four|couple|few)\b/);
    return {
      skill: 'generate_image',
      args: {
        prompt,
        style: detectStyle(raw) || 'holo',
        count: countMatch ? COUNT_WORDS[countMatch[1]] || 1 : 1,
      },
    };
  }

  /* ------------------------------------------------------------------- open */
  const openMatch = raw.match(/\b(?:open|launch|go to|goto|pull up|bring up|navigate to)\s+(?:the\s+)?(?:site\s+|website\s+)?([\w-]+\.[a-z]{2,}(?:\/\S*)?|https?:\/\/\S+)$/i);
  if (openMatch) {
    return { skill: 'open_url', args: { url: openMatch[1] } };
  }
  const openSite = raw.match(/\b(?:open|launch|go to|pull up)\s+(the\s+)?([a-z][a-z0-9\s]{2,24})\s*(site|website|page)?$/i);
  if (openSite && !/\b(notes?|display|settings|config|help|drawer|screen|timer)\b/i.test(openSite[2])) {
    const name = openSite[2].trim();
    if (/^(youtube|github|google|gmail|reddit|twitter|x|facebook|instagram|netflix|spotify|amazon|wikipedia|maps|stack overflow|hacker news)$/i.test(name)) {
      return { skill: 'open_url', args: { url: `https://${name.replace(/\s+/g, '')}.com`, label: name } };
    }
  }

  /* ------------------------------------------------------ search / knowledge */
  const searchMatch = raw.match(/^(?:please\s+)?(?:can you\s+|could you\s+)?(?:search|look up|look for|google|find out|find me|tell me about|what do you know about)\s+(?:for\s+|about\s+|on\s+)?(.+)$/i);
  if (searchMatch) {
    return { skill: 'web_search', args: { query: searchMatch[1].trim() }, summarize: true };
  }
  const PRONOUN_START = /^(you|i|we|they|he|she|it|this|that|these|those|there|my|your|our)\b/i;
  const whoWhat = raw.match(/^(?:hey jax,?\s*)?(who|what|where|when|why)\s+(?:is|are|was|were)\s+(.+)$/i);
  if (whoWhat && !PRONOUN_START.test(whoWhat[2].trim())) {
    return { skill: 'wikipedia', args: { topic: whoWhat[2].trim() }, original: raw };
  }

  // measurements and other factoid questions read better as a live search
  const measure = raw.match(/^(?:hey jax,?\s*)?how\s+(tall|high|big|large|far|old|long|heavy|hot|cold|deep|wide|many|much)\s+(?:is|are|was|were|does|do)\s+(.+)$/i);
  if (measure) {
    return { skill: 'web_search', args: { query: raw.replace(/^(?:hey jax,?\s*)/i, '') }, summarize: true, original: raw };
  }

  return null;
}

export { detectStyle, stripStyle };
