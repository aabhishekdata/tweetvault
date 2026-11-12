// Recognise what was captured: a tweet link, a t.co short link, an X article page, another link, or plain text.

const TWEET_HOSTS = new Set([
  'x.com', 'twitter.com', 'fxtwitter.com', 'fixupx.com', 'vxtwitter.com', 'fixvx.com',
  'twittpr.com', 'xcancel.com', 'nitter.net',
]);

export function normHost(host) {
  let h = String(host || '').toLowerCase();
  for (const p of ['www.', 'mobile.', 'm.']) if (h.startsWith(p)) h = h.slice(p.length);
  return h;
}

export function isTweetHost(host) {
  const h = normHost(host);
  return TWEET_HOSTS.has(h) || h.startsWith('nitter.');
}

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const ID_RE = /^\d{5,25}$/;

// Returns {tweetId, handle} | {articleId} | null
export function parseTweetUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!isTweetHost(url.hostname)) return null;
  const p = url.pathname.split('/').filter(Boolean);
  for (let i = 0; i < p.length - 1; i++) {
    if ((p[i] === 'status' || p[i] === 'statuses') && ID_RE.test(p[i + 1])) {
      const prev = i > 0 ? p[i - 1] : null;
      const handle = prev && prev !== 'i' && prev !== 'web' && HANDLE_RE.test(prev) ? prev : null;
      return { tweetId: p[i + 1], handle };
    }
  }
  if (p[0] === 'i' && p[1] === 'article' && /^\d+$/.test(p[2] || '')) return { articleId: p[2] };
  return null;
}

export function isTcoUrl(raw) {
  try {
    const u = new URL(raw);
    return normHost(u.hostname) === 't.co' && /^\/[A-Za-z0-9]+$/.test(u.pathname);
  } catch { return false; }
}

// Trailing punctuation is trimmed with plain index scans (linear time): end-anchored `[...]+$` regexes
// backtrack from every position and made a long crafted paste cost quadratic time.
const TRAIL = new Set([...')]}>.,;:!?\'"»”’。、，．！？）」』】']);
const isWs = (c) => /\s/u.test(c);
const setOf = (chars) => { const s = new Set([...chars]); return (c) => s.has(c) || isWs(c); };
const BEFORE_END = setOf('()[]<>|·:–—-');
const AFTER_START = setOf('()[]<>.,;:!?"\'|·–—-');
const REST_START = setOf('()[]<>|·–—-');
function trimEnd(s, test) { let e = s.length; while (e > 0 && test(s[e - 1])) e--; return s.slice(0, e); }
function trimStart(s, test) { let i = 0; while (i < s.length && test(s[i])) i++; return s.slice(i); }

export function extractUrls(text, { withRaw = false } = {}) {
  const out = [];
  const re = /https?:\/\/[^\s<>"'“”‘’。、，！？「」『』【】]+/gi;
  for (const m of String(text || '').matchAll(re)) {
    const raw = m[0];
    let opens = 0;
    let closes = 0;
    for (const c of raw) { if (c === '(') opens++; else if (c === ')') closes++; }
    let end = raw.length;
    // drop trailing punctuation, but keep a closing paren when the URL also opened one
    while (end > 0 && TRAIL.has(raw[end - 1])) {
      const c = raw[end - 1];
      if (c === ')') { if (opens >= closes) break; closes--; }
      end--;
    }
    const u = raw.slice(0, end);
    out.push(withRaw ? { url: u, raw } : u);
  }
  return out;
}

// "only a link", maybe with a short page title around it (as share sheets send it)
function linkOnly(text, found) {
  if (found.length !== 1) return null;
  // share sheets put the link alone, or after/before a title; a link in the middle of prose is a note
  const idx = text.indexOf(found[0].raw);
  const before = trimEnd(text.slice(0, idx), BEFORE_END);
  const after = trimStart(text.slice(idx + found[0].raw.length), AFTER_START);
  if (before && after) return null;
  const rest = trimStart(trimEnd(text.replace(found[0].raw, ''), AFTER_START), REST_START).trim();
  if (rest.length > 200 || rest.includes('\n\n')) return null;
  return { url: found[0].url, title: rest || null };
}

export function canonicalTweetUrl(handle, id) {
  return `https://x.com/${handle || 'i'}/status/${id}`;
}

// Decide what one capture is. Never fetches anything.
//   {type:'tweet', tweetId, handle, url}
//   {type:'tco', url}
//   {type:'article_link', articleId, url}
//   {type:'link', url}
//   {type:'text', text}
export function classifyInput(input) {
  const text = String(input || '').trim();
  const found = extractUrls(text, { withRaw: true });
  const urls = found.map((f) => f.url);
  for (const u of urls) {
    const t = parseTweetUrl(u);
    if (t && t.tweetId) return { type: 'tweet', tweetId: t.tweetId, handle: t.handle, url: canonicalTweetUrl(t.handle, t.tweetId) };
  }
  // Short links and other links count only when the capture is essentially just the link;
  // a highlighted paragraph that merely mentions one stays a note.
  const only = linkOnly(text, found);
  if (only && isTcoUrl(only.url)) return { type: 'tco', url: only.url.replace(/^http:/i, 'https:') };
  for (const u of urls) {
    const t = parseTweetUrl(u);
    if (t && t.articleId && only) return { type: 'article_link', articleId: t.articleId, url: `https://x.com/i/article/${t.articleId}` };
  }
  if (only) return { type: 'link', url: only.url, title: only.title };
  return { type: 'text', text };
}
