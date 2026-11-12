// YouTube links (phase 3.3): title, channel, length, description chapters and the transcript.
// Contract (see linkreader.js): isYouTubeUrl(url) -> boolean; readYouTube(db, it, deps) -> Promise<void>.
//
// Sources, in order, each optional except the first:
//   1. keyless oEmbed (title, channel)
//   2. YouTube Data API v3 videos.list when an API key is configured (description, date, channel, length)
//   3. the watch page's ytInitialPlayerResponse (captions list, and description/length when there is no key),
//      then the chosen caption track as json3
// YouTube often answers a data-centre IP (a rented server) with "Sign in to confirm you're not a bot". Then
// the transcript is marked 'blocked' and the rest is still saved; the PC fallback (cli.js youtube-pending /
// set-transcript, deploy/fetch-transcripts.ps1) fills it in with the local yt-dlp.
//
// Everything fetched here is hostile third-party data: hosts are allow-listed (HTTPS only, every redirect hop
// checked again), bodies are size-capped, JSON is parsed (never evaluated) and every string saved is capped.
import { now as dbNow, tx } from './db.js';
import { BACKOFF } from './fetcher.js';   // read at call time (fetcher.js imports this file too, as web.js does)

export const UA = 'TweetVault/1.0 (+https://vault.example.com; personal archive)';
// a desktop browser's user agent for the watch page: YouTube serves the bot wall to unknown agents straight away
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Our own tiny allow-list, separate from the tweet fetcher's and the web reader's.
const ALLOWED_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'www.googleapis.com', 'youtube.googleapis.com']);
// Hosts a shared link may use. Exact names only, so youtube.com.evil.example never matches.
const LINK_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// The container has 128 MB, shared with `docker exec ... cli.js set-transcript`: caption files are capped well
// below that (a 3-hour talk's json3 or VTT is under 2 MB) and parsing stops once there is about twice as much
// text as the transcript can keep, so most of a huge file is never turned into strings.
export const MAX_TRANSCRIPT = 150_000;      // characters of formatted transcript (link_md)
export const MAX_STDIN = 4 * 1024 * 1024;   // a caption file given to the CLI (deploy/fetch-transcripts.ps1 checks the same)
const MAX_PAGE = 2 * 1024 * 1024;           // the watch page
const MAX_JSON = 1024 * 1024;               // oEmbed and Data API answers
export const MAX_CAPTIONS = 2 * 1024 * 1024; // one json3 caption file from timedtext
export const MAX_PARSED = 2 * MAX_TRANSCRIPT; // caption text characters parsed before stopping
const MAX_SEGMENTS = 100_000;
const MAX_CHAPTERS = 200;
const MAX_DESCRIPTION = 10_000;
const PARAGRAPH_S = 60;                     // about one paragraph (and one [mm:ss] mark) a minute
const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------- recognising links

// The video id of a YouTube link in any common form, or null. youtube.com/watch?v=ID, youtu.be/ID,
// /shorts/ID, /live/ID, /embed/ID, on the www., m. and music. hosts.
export function youTubeId(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!LINK_HOSTS.has(host)) return null;
  const seg = u.pathname.split('/').filter(Boolean);
  let id = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') id = seg.length === 1 ? seg[0] : null;
  else if (seg.length === 1 && seg[0] === 'watch') id = u.searchParams.get('v');
  else if (seg.length === 2 && ['shorts', 'live', 'embed'].includes(seg[0])) id = seg[1];
  return id && VIDEO_ID_RE.test(id) ? id : null;
}

// Every link on a YouTube host goes to this reader (a channel page has no video id and simply ends as a
// plain link): the web reader is never pointed at YouTube.
export function isYouTubeUrl(raw) {
  try {
    const u = new URL(String(raw ?? '').trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && LINK_HOSTS.has(u.hostname.toLowerCase());
  } catch { return false; }
}

export const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

// ---------------------------------------------------------------- configuration

// createApp passes its youtubeApiKey option here; deps.youtubeApiKey (tests) wins, then this, then the env.
let configuredKey = null;
export function configureYouTube({ apiKey } = {}) { configuredKey = apiKey || null; }

function apiKeyFrom(deps) {
  const k = deps.youtubeApiKey ?? configuredKey ?? process.env.YOUTUBE_API_KEY ?? '';
  const s = String(k).trim();
  return /^[A-Za-z0-9_-]{20,100}$/.test(s) ? s : null;
}

// ---------------------------------------------------------------- small text helpers

// Control characters and bidi overrides out (they can hide or reorder text), whitespace tidied.
const BIDI = /[‪-‮⁦-⁩‎‏]/g;
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export function cleanLine(s, max = 300) {
  const t = String(s ?? '').replace(CTRL, '').replace(BIDI, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
function cleanBlock(s, max) {
  const t = String(s ?? '').replace(/\r\n?/g, '\n').replace(CTRL, '').replace(BIDI, '');
  return t.length > max ? t.slice(0, max) : t;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6}|#39);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (ENTITIES[k] !== undefined) return ENTITIES[k];
    const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : k.startsWith('#') ? Number(k.slice(1)) : NaN;
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : m;
  });
}

// "PT1H2M3S" -> 3723. Data API durations; "P1DT2H" for very long streams. null when it isn't one.
export function parseIsoDuration(s) {
  const str = String(s ?? '').trim();
  const m = /^P(?:(\d{1,4})W)?(?:(\d{1,4})D)?(?:T(?:(\d{1,4})H)?(?:(\d{1,6})M)?(?:(\d{1,7})(?:\.\d+)?S)?)?$/.exec(str);
  // "P" and "PT" alone match the pattern but say nothing
  if (!m || str === 'P' || str.endsWith('T')) return null;
  const [w, d, h, mi, se] = m.slice(1).map((x) => Number(x || 0));
  return (((w * 7 + d) * 24 + h) * 60 + mi) * 60 + se;
}

// 75 -> "1:15", 3723 -> "1:02:03" (chapters and the heading)
export function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// transcript marks: [mm:ss] under an hour, [h:mm:ss] after
export function fmtMark(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `[${h}:${mm}:${ss}]` : `[${mm}:${ss}]`;
}

// "1:02:03" / "12:34" / "0:05" -> seconds, or null
function parseClock(s) {
  const p = String(s).split(':');
  if (p.length < 2 || p.length > 3) return null;
  const n = p.map(Number);
  if (n.some((x) => !Number.isInteger(x) || x < 0)) return null;
  if (p.length === 2) return n[1] < 60 ? n[0] * 60 + n[1] : null;
  return n[1] < 60 && n[2] < 60 ? n[0] * 3600 + n[1] * 60 + n[2] : null;
}

// ---------------------------------------------------------------- chapters

// Chapters the way YouTube itself reads them from a description: lines that start with a timestamp
// (m:ss or h:mm:ss, optionally in brackets), the first at 0:00, each later than the one before, at least 3.
// The first run that starts at 0:00 wins; it ends at the first time that doesn't go forward.
const CHAPTER_LINE = /^\s*[[(]?((?:\d{1,2}:)?\d{1,3}:\d{2})[\])]?\s*(?:[-–—:|•·.)]\s*)?(.*)$/;
export function parseChapters(description, durationS = null) {
  const lines = String(description ?? '').slice(0, MAX_DESCRIPTION).split(/\r?\n/);
  let out = null;
  for (const line of lines) {
    const m = CHAPTER_LINE.exec(line);
    const t = m ? parseClock(m[1]) : null;
    if (t === null) continue;
    const title = cleanLine(m[2].replace(/^[-–—:|•·\s]+/, ''), 200);
    if (!out) {
      if (t === 0) out = [{ t: 0, title }];
      continue;
    }
    if (t <= out[out.length - 1].t || (durationS && t >= durationS)) break;
    out.push({ t, title });
    if (out.length >= MAX_CHAPTERS) break;
  }
  if (!out || out.length < 3) return [];
  return out.map((c) => ({ t: c.t, title: c.title || `Part at ${fmtClock(c.t)}` }));
}

// ---------------------------------------------------------------- oEmbed and the Data API

// oEmbed answer -> {title, channel} or null
export function parseOEmbed(body) {
  let j;
  try { j = JSON.parse(body); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const title = typeof j.title === 'string' ? cleanLine(j.title, 300) : '';
  const channel = typeof j.author_name === 'string' ? cleanLine(j.author_name, 200) : '';
  return title || channel ? { title: title || null, channel: channel || null } : null;
}

// Data API videos.list answer -> {title, channel, description, published_at, duration_s} or null
export function parseVideosList(body) {
  let j;
  try { j = JSON.parse(body); } catch { return null; }
  const v = j && Array.isArray(j.items) ? j.items[0] : null;
  if (!v || typeof v !== 'object') return null;
  const sn = v.snippet && typeof v.snippet === 'object' ? v.snippet : {};
  const cd = v.contentDetails && typeof v.contentDetails === 'object' ? v.contentDetails : {};
  const pub = typeof sn.publishedAt === 'string' ? Date.parse(sn.publishedAt) : NaN;
  return {
    title: typeof sn.title === 'string' ? cleanLine(sn.title, 300) || null : null,
    channel: typeof sn.channelTitle === 'string' ? cleanLine(sn.channelTitle, 200) || null : null,
    description: typeof sn.description === 'string' ? cleanBlock(sn.description, MAX_DESCRIPTION) : null,
    published_at: Number.isFinite(pub) ? Math.floor(pub / 1000) : null,
    duration_s: typeof cd.duration === 'string' ? parseIsoDuration(cd.duration) : null,
  };
}

// ---------------------------------------------------------------- the watch page

// Find `ytInitialPlayerResponse = {...}` and cut out exactly that object by matching braces (strings and
// escapes respected), then JSON.parse it. Never evaluated. null when it isn't there or isn't valid JSON.
export function extractPlayerResponse(html) {
  const s = String(html ?? '');
  const re = /ytInitialPlayerResponse\s*=\s*\{/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length - 1;
    const end = matchBrace(s, start);
    if (end < 0) continue;
    try {
      const j = JSON.parse(s.slice(start, end + 1));
      if (j && typeof j === 'object') return j;
    } catch { /* try the next occurrence */ }
  }
  return null;
}

function matchBrace(s, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (inStr) {
      if (c === 92) i++;                 // backslash: skip the escaped character
      else if (c === 34) inStr = false;  // closing quote
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 123) depth++;
    else if (c === 125 && --depth === 0) return i;
  }
  return -1;
}

const BOT_WALL = /confirm you(?:'|’|&#39;)re not a bot|g-recaptcha|\/sorry\/index|unusual traffic/i;

// What the watch page says: {blocked, details, tracks, reason}
export function readWatchPage(html) {
  const pr = extractPlayerResponse(html);
  if (!pr) return { blocked: BOT_WALL.test(String(html ?? '').slice(0, MAX_PAGE)), details: null, tracks: [], reason: 'no player data' };
  const ps = pr.playabilityStatus && typeof pr.playabilityStatus === 'object' ? pr.playabilityStatus : {};
  const status = typeof ps.status === 'string' ? ps.status : '';
  const reason = typeof ps.reason === 'string' ? cleanLine(ps.reason, 200) : status;
  const blocked = status === 'LOGIN_REQUIRED' || BOT_WALL.test(reason);
  const vd = pr.videoDetails && typeof pr.videoDetails === 'object' ? pr.videoDetails : null;
  const mf = pr.microformat && pr.microformat.playerMicroformatRenderer && typeof pr.microformat.playerMicroformatRenderer === 'object'
    ? pr.microformat.playerMicroformatRenderer : {};
  let details = null;
  if (vd) {
    const len = Number(vd.lengthSeconds);
    const pub = Date.parse(typeof mf.publishDate === 'string' ? mf.publishDate : (typeof mf.uploadDate === 'string' ? mf.uploadDate : ''));
    details = {
      title: typeof vd.title === 'string' ? cleanLine(vd.title, 300) || null : null,
      channel: typeof vd.author === 'string' ? cleanLine(vd.author, 200) || null : null,
      description: typeof vd.shortDescription === 'string' ? cleanBlock(vd.shortDescription, MAX_DESCRIPTION) : null,
      duration_s: Number.isInteger(len) && len > 0 && len < 10 * 86400 ? len : null,
      published_at: Number.isFinite(pub) ? Math.floor(pub / 1000) : null,
    };
  }
  const list = pr.captions && pr.captions.playerCaptionsTracklistRenderer
    && Array.isArray(pr.captions.playerCaptionsTracklistRenderer.captionTracks)
    ? pr.captions.playerCaptionsTracklistRenderer.captionTracks : [];
  const tracks = list.filter((t) => t && typeof t.baseUrl === 'string').slice(0, 100).map((t) => ({
    baseUrl: t.baseUrl,
    lang: typeof t.languageCode === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/.test(t.languageCode) ? t.languageCode : null,
    asr: t.kind === 'asr',
  }));
  return { blocked, unplayable: status === 'ERROR' || status === 'UNPLAYABLE', details, tracks, reason };
}

// A manual English track, then auto-generated English, then whatever comes first.
export function pickTrack(tracks) {
  const en = (t) => t.lang && /^en(-|$)/i.test(t.lang);
  return tracks.find((t) => en(t) && !t.asr) || tracks.find((t) => en(t) && t.asr) || tracks[0] || null;
}

// The caption track's address must be YouTube's own timedtext endpoint; anything else is refused.
export function timedTextUrl(baseUrl) {
  let u;
  try { u = new URL(String(baseUrl), 'https://www.youtube.com'); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'www.youtube.com' || u.port || u.username || u.password) return null;
  if (u.pathname !== '/api/timedtext') return null;
  u.searchParams.set('fmt', 'json3');
  return u.href;
}

// ---------------------------------------------------------------- caption formats

// json3: {events: [{tStartMs, segs: [{utf8}]}]} -> [[startSeconds, text], ...]
export function parseJson3(body) {
  let j;
  try { j = typeof body === 'string' ? JSON.parse(body) : body; } catch { return []; }
  const ev = j && Array.isArray(j.events) ? j.events : [];
  const out = [];
  let chars = 0;
  for (const e of ev) {
    if (out.length >= MAX_SEGMENTS || chars > MAX_PARSED) break;
    if (!e || !Array.isArray(e.segs)) continue;
    let raw = '';
    for (const s of e.segs) if (s && typeof s.utf8 === 'string') raw += s.utf8;
    const text = cleanLine(decodeEntities(raw), 2000);
    const t = Number(e.tStartMs);
    if (!text || !Number.isFinite(t) || t < 0) continue;
    out.push([Math.floor(t / 1000), text]);
    chars += text.length + 1;
  }
  return out;
}

// WebVTT -> [[startSeconds, text], ...]. Tags (<c>, <00:00:01.000>, <i>) and cue settings are stripped.
// YouTube's auto captions "roll": each cue repeats the line before it and adds the new one, with tiny
// in-between cues that repeat it again, so there a line equal to one of the last two kept lines is dropped.
// Auto captions are told apart by "Kind: asr" in the header or by their word-timing tags. In manual captions
// a line said twice ("Yeah." "Yeah.") is kept; only the same line again at the same time is dropped.
// The text is walked line by line with indexOf (no copy of the whole file) and parsing stops past MAX_PARSED.
const VTT_WORD_TAGS = /<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}>|<c[.>]/;
export function parseVtt(body) {
  const s = String(body ?? '');
  const len = s.length;
  const rolling = /^Kind:\s*asr\s*$/m.test(s.slice(0, 2000)) || VTT_WORD_TAGS.test(s);
  const out = [];
  const recent = [];
  let chars = 0;
  let start = null;   // start of the cue being read; null outside a cue's text
  let skipBlock = false;
  let pos = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  let cr = s.indexOf('\r', pos);   // the next carriage return, looked up again only once passed
  while (pos < len && out.length < MAX_SEGMENTS && chars <= MAX_PARSED) {
    if (cr !== -1 && cr < pos) cr = s.indexOf('\r', pos);
    let end = s.indexOf('\n', pos);
    if (end === -1) end = len;
    let next = end + 1;
    if (cr !== -1 && cr < end) { end = cr; next = s.charCodeAt(cr + 1) === 10 ? cr + 2 : cr + 1; }
    const raw = s.slice(pos, end);
    pos = next;
    const line = raw.trim();
    const timing = /^((?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s+-->\s+\S+/.exec(line);
    if (timing) { start = vttSeconds(timing[1]); skipBlock = false; continue; }
    // only a truly empty line ends a cue: auto captions put a line of one space inside their cues
    if (!raw.length) { start = null; skipBlock = false; continue; }
    if (!line) continue;
    if (start === null) {
      // header, NOTE / STYLE / REGION blocks and cue identifiers
      if (/^(NOTE|STYLE|REGION)\b/.test(line)) skipBlock = true;
      continue;
    }
    if (skipBlock) continue;
    const text = cleanLine(decodeEntities(line.replace(/<[^>]{0,200}>/g, '')), 2000);
    if (!text) continue;
    if (rolling) {
      if (recent.includes(text)) continue;
      recent.push(text);
      if (recent.length > 2) recent.shift();
    } else {
      const last = out[out.length - 1];
      if (last && last[0] === start && last[1] === text) continue;
    }
    out.push([start, text]);
    chars += text.length + 1;
  }
  return out;
}

function vttSeconds(s) {
  const p = s.replace(',', '.').split(':').map(Number);
  const sec = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  return Number.isFinite(sec) ? Math.floor(sec) : 0;
}

// "Language: en" from a VTT header, if it is a plain language code
export function vttLanguage(body) {
  const head = String(body ?? '').slice(0, 2000).split(/\r?\n\r?\n/)[0];
  const m = /^Language:\s*([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3})\s*$/m.exec(head);
  return m ? m[1] : null;
}

// Either format, told apart by its first characters. null when it is neither.
export function parseCaptions(body) {
  const s = String(body ?? '');
  let i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s.startsWith('WEBVTT', i)) return parseVtt(i ? s.slice(i) : s);
  if (s.startsWith('{', i)) return parseJson3(i ? s.slice(i) : s);
  return null;
}

// ---------------------------------------------------------------- transcript text

// Paragraphs of about a minute, each starting with its [mm:ss] mark; at most MAX_TRANSCRIPT characters,
// cut at a paragraph boundary with a note saying so.
export function formatTranscript(segments, max = MAX_TRANSCRIPT) {
  const segs = (Array.isArray(segments) ? segments : [])
    .filter((x) => Array.isArray(x) && Number.isFinite(x[0]) && typeof x[1] === 'string' && x[1].trim())
    .slice(0, MAX_SEGMENTS)
    .sort((a, b) => a[0] - b[0]);
  const paras = [];
  let cur = null;
  for (const [t, text] of segs) {
    if (!cur || t >= cur.t + PARAGRAPH_S) { cur = { t, words: [] }; paras.push(cur); }
    cur.words.push(text.trim());
  }
  const note = `\n\n(Transcript cut here: it is longer than ${max.toLocaleString('en-US')} characters.)`;
  const blocks = [];
  let size = 0;
  for (const p of paras) {
    const block = `${fmtMark(p.t)} ${p.words.join(' ').replace(/\s+/g, ' ')}`;
    const nextSize = size + (blocks.length ? 2 : 0) + block.length;
    if (nextSize > max) {
      if (!blocks.length) blocks.push(block.slice(0, Math.max(0, max - note.length)));   // one huge paragraph
      return `${blocks.join('\n\n')}${note}`;
    }
    blocks.push(block);
    size = nextSize;
  }
  return blocks.join('\n\n');
}

// ---------------------------------------------------------------- fetching

class YtError extends Error {
  constructor(msg, extra = {}) { super(msg); Object.assign(this, extra); }
}

// GET from the allow-list only. Redirects are followed by hand and every hop is checked again.
// Returns {status, body, headers}. Throws YtError({refused}) for a host or scheme we don't talk to.
async function ytGet(fetchImpl, url, { headers = {}, max = MAX_JSON } = {}) {
  let cur = url;
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(cur);
    if (u.protocol !== 'https:' || u.port || u.username || u.password) throw new YtError('refusing a non-https address', { refused: true });
    if (!ALLOWED_HOSTS.has(u.hostname)) throw new YtError(`refusing to fetch ${u.hostname.slice(0, 80)}`, { refused: true });
    const res = await fetchImpl(u.href, {
      headers: { 'User-Agent': UA, ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const loc = res.headers && res.headers.get ? res.headers.get('location') : null;
    if (res.status >= 300 && res.status < 400 && loc) {
      // drop the redirect body without waiting: a cancelled stream may never settle
      if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
      cur = new URL(loc, u).href;
      continue;
    }
    const len = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0);
    if (len > max) {
      // let the socket and its buffers go now, not at garbage collection
      if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
      throw new YtError('response too large', { tooLarge: true });
    }
    return { status: res.status, body: await readCapped(res, max), headers: res.headers };
  }
  throw new YtError('too many redirects', { refused: true });
}

async function readCapped(res, max) {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const t = await res.text();
    if (t.length > max) throw new YtError('response too large', { tooLarge: true });
    return t;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { reader.cancel().catch(() => {}); throw new YtError('response too large', { tooLarge: true }); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Messages from fetch() can carry the address; the key must never reach a log or an error.
const scrub = (msg, key) => (key ? String(msg).split(key).join('[key]') : String(msg)).slice(0, 200);

function retryError(msg, headers) {
  const ra = headers && headers.get ? headers.get('retry-after') : null;
  return new YtError(msg, { retry: true, retryAfter: ra || 0 });
}

async function getOEmbed(fetchImpl, id) {
  let r;
  try {
    r = await ytGet(fetchImpl, `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl(id))}&format=json`,
      { headers: { Accept: 'application/json' } });
  } catch (e) {
    if (e.refused || e.tooLarge) return null;
    throw new YtError(`YouTube oEmbed: ${scrub(e.message)}`, { retry: true });   // network trouble: try later
  }
  if (r.status === 429 || r.status >= 500) throw retryError(`YouTube oEmbed answered ${r.status}`, r.headers);
  return r.status === 200 ? parseOEmbed(r.body) : null;   // 401/403: embedding off; 404: private or gone
}

async function getVideosList(fetchImpl, id, key, log) {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${id}&key=${encodeURIComponent(key)}`;
  try {
    const r = await ytGet(fetchImpl, url, { headers: { Accept: 'application/json' } });
    if (r.status !== 200) { log(`youtube ${id}: Data API answered ${r.status}`); return null; }
    return parseVideosList(r.body);
  } catch (e) {
    log(`youtube ${id}: Data API failed: ${scrub(e.message, key)}`);
    return null;
  }
}

const PAGE_HEADERS = {
  'User-Agent': BROWSER_UA,
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml',
  // skips the EU cookie-consent interstitial (consent.youtube.com is not on the allow-list)
  Cookie: 'CONSENT=YES+1; SOCS=CAI',
};

// The watch page and, when it lists captions, the transcript.
// Returns {details, status: 'ok'|'blocked'|'none', lang, segments}
async function getWatchPage(fetchImpl, id, log, { transcripts = true } = {}) {
  let page;
  try {
    page = await ytGet(fetchImpl, `${watchUrl(id)}&hl=en`, { headers: PAGE_HEADERS, max: MAX_PAGE });
  } catch (e) {
    // a redirect to consent.youtube.com or google.com/sorry lands here as "refused"
    log(`youtube ${id}: watch page ${scrub(e.message)}`);
    return { details: null, status: 'blocked', lang: null, segments: [] };
  }
  if (page.status !== 200) {
    log(`youtube ${id}: watch page answered ${page.status}`);
    return { details: null, status: page.status === 404 ? 'none' : 'blocked', lang: null, segments: [] };
  }
  const w = readWatchPage(page.body);
  page = null;   // 2 MB string: let it go before fetching captions
  if (w.blocked) { log(`youtube ${id}: transcript blocked (${w.reason})`); return { details: w.details, status: 'blocked', lang: null, segments: [] }; }
  if (!transcripts) return { details: w.details, status: 'pending_pc', lang: null, segments: [] };
  const track = pickTrack(w.tracks);
  if (!track) return { details: w.details, status: w.details || w.unplayable ? 'none' : 'blocked', lang: null, segments: [] };
  const url = timedTextUrl(track.baseUrl);
  if (!url) { log(`youtube ${id}: caption address refused`); return { details: w.details, status: 'blocked', lang: null, segments: [] }; }
  try {
    const r = await ytGet(fetchImpl, url, { headers: { ...PAGE_HEADERS, Accept: 'application/json' }, max: MAX_CAPTIONS });
    const segments = r.status === 200 ? parseJson3(r.body) : [];
    // an empty 200 is how timedtext says no to a data-centre address
    if (!segments.length) { log(`youtube ${id}: captions answered ${r.status} with no lines`); return { details: w.details, status: 'blocked', lang: null, segments: [] }; }
    return { details: w.details, status: 'ok', lang: track.lang, segments };
  } catch (e) {
    log(`youtube ${id}: captions ${scrub(e.message)}`);
    return { details: w.details, status: 'blocked', lang: null, segments: [] };
  }
}

// ---------------------------------------------------------------- saving

export function parseMeta(it) {
  try {
    const m = it && it.link_meta ? JSON.parse(it.link_meta) : null;
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch { return null; }
}

// The worker's entry point (via linkreader.js).
export async function readYouTube(db, it, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const log = deps.log || (() => {});
  const nowFn = deps.now || dbNow;
  const id = youTubeId(it.url);
  if (!id) {
    db.prepare("UPDATE items SET fetch_status = 'link_only', fetch_error = NULL, next_fetch_at = NULL WHERE id = ?").run(it.id);
    return;
  }
  const key = apiKeyFrom(deps);
  let oe;
  try {
    oe = await getOEmbed(fetchImpl, id);      // throws {retry} on 429/5xx: nothing saved yet
  } catch (e) {
    // a re-read of a video whose details are already saved: on the last try, keep them and stay 'ok'
    // (the fetcher would end it 'failed'), like web.js does for a page's saved text
    if (e && e.retry && (it.fetch_attempts || 0) + 1 > BACKOFF.length && keepSavedVideo(db, it.id, e.message)) return;
    throw e;
  }
  const api = key ? await getVideosList(fetchImpl, id, key, log) : null;
  const transcripts = deps.transcripts ?? process.env.YOUTUBE_TRANSCRIPTS !== 'pc';
  const wp = await getWatchPage(fetchImpl, id, log, { transcripts });
  const d = wp.details || {};
  const title = (api && api.title) || (oe && oe.title) || d.title || null;
  const channel = (api && api.channel) || (oe && oe.channel) || d.channel || null;
  const duration = (api && api.duration_s) || d.duration_s || null;
  const description = (api && api.description) || d.description || '';
  const published = (api && api.published_at) || d.published_at || null;
  saveVideo(db, it.id, {
    id, title, channel, duration, published, chapters: parseChapters(description, duration),
    transcript: wp.status === 'ok' ? { status: 'ok', lang: wp.lang, md: formatTranscript(wp.segments) } : { status: wp.status },
    raw: JSON.stringify({ oembed: oe, api: api ? { ...api, description: undefined } : null, transcript_status: wp.status }),
  }, nowFn());
}

// Details saved by an earlier read of this video, which a failed re-read must never take away.
function hasSavedVideo(cur) {
  return !!(cur && cur.link_type === 'youtube' && (cur.link_title || cur.link_md));
}

// A re-read failed but the video's details from before are there: keep them, say what went wrong in
// fetch_error, and stay 'ok'. Returns false when there is nothing saved to keep.
function keepSavedVideo(db, itemId, why) {
  const cur = db.prepare('SELECT link_type, link_title, link_md FROM items WHERE id = ?').get(itemId);
  if (!hasSavedVideo(cur)) return false;
  db.prepare("UPDATE items SET fetch_status = 'ok', fetch_error = ?, fetch_attempts = 0, next_fetch_at = NULL WHERE id = ?")
    .run(String(why || 'Reading this video again failed').slice(0, 300), itemId);
  return true;
}

// One transaction: the item and its raw record are saved together or not at all.
function saveVideo(db, itemId, v, t) {
  tx(db, () => {
    const cur = db.prepare('SELECT text, link_type, link_title, link_md, link_meta FROM items WHERE id = ?').get(itemId);
    if (!cur) return;   // deleted while we were fetching
    const old = parseMeta(cur) || {};
    // a re-read where YouTube gave no details this time: the saved title, channel, date and chapters stay.
    // A transcript this read did get is still added.
    if (!v.title && cur.link_type === 'youtube' && cur.link_title) {
      if (v.transcript.status === 'ok' && v.transcript.md) {
        const meta = { ...old, transcript_status: 'ok', transcript_lang: v.transcript.lang || null };
        delete meta.pc_checked_at;
        db.prepare('UPDATE items SET link_md = ?, link_meta = ?, link_fetched_at = ? WHERE id = ?')
          .run(v.transcript.md, JSON.stringify(meta), t, itemId);
      }
      db.prepare("UPDATE items SET fetch_status = 'ok', fetch_error = ?, fetch_attempts = 0, next_fetch_at = NULL WHERE id = ?")
        .run('YouTube gave no details this time; the saved ones are kept', itemId);
      return;
    }
    // a transcript already saved (from the PC, or an earlier read) is kept when this attempt got none
    const keep = !!(v.transcript.status !== 'ok' && old.transcript_status === 'ok' && cur.link_md);
    // the PC already looked and found no subtitles: a later read without a transcript doesn't queue it again
    const pcNone = v.transcript.status !== 'ok' && !keep && old.transcript_status === 'none_pc';
    const meta = {
      video_id: v.id,
      channel: v.channel,
      duration_s: v.duration,
      chapters: v.chapters,
      transcript_status: keep ? 'ok' : pcNone ? 'none_pc' : v.transcript.status,
      transcript_lang: keep ? (old.transcript_lang || null) : (v.transcript.lang || null),
    };
    if (pcNone && old.pc_checked_at) meta.pc_checked_at = old.pc_checked_at;
    // a kept transcript is something to show, so the video stays 'ok' (render.js) even when YouTube gave no title
    const shown = !!(v.title || keep);
    const title = v.title || (keep ? (cleanLine(cur.text, 300) || 'YouTube video') : null);
    db.prepare(`UPDATE items SET link_type = 'youtube', link_title = ?, link_site = 'YouTube', link_author = ?,
        link_published_at = ?, link_md = ?, link_meta = ?, link_fetched_at = ?, fetch_status = ?,
        fetch_attempts = 0, next_fetch_at = NULL, fetch_error = ? WHERE id = ?`)
      .run(title, v.channel, v.published, keep ? cur.link_md : (v.transcript.md || null), JSON.stringify(meta), t,
        shown ? 'ok' : 'link_only', shown ? null : 'YouTube gave no details for this video', itemId);
    db.prepare(`INSERT INTO raw_fetches (item_id, source, fetched_at, http_status, body) VALUES (?, 'youtube', ?, 200, ?)
        ON CONFLICT(item_id, source) DO UPDATE SET fetched_at = excluded.fetched_at, body = excluded.body`).run(itemId, t, v.raw);
  });
}

// ---------------------------------------------------------------- PC fallback (cli.js)

// Videos whose transcript the server couldn't get, newest first. 'none_pc' (the PC looked and found no
// subtitles: markNoTranscript) is left out, so caption-less videos never crowd out older blocked ones.
export function pendingTranscripts(db, limit = 20) {
  const n = Math.min(100, Math.max(1, Number(limit) || 20));
  const rows = db.prepare(`SELECT id, url, link_meta FROM items WHERE link_type = 'youtube' AND state != 'trashed'
      AND json_valid(link_meta) AND json_extract(link_meta, '$.transcript_status') IN ('blocked','none','pending_pc')
      ORDER BY COALESCE(last_saved_at, first_saved_at, 0) DESC, id DESC LIMIT ?`).all(n + 50);   // room for rows without a usable id
  const out = [];
  for (const r of rows) {
    const m = parseMeta(r) || {};
    const vid = VIDEO_ID_RE.test(String(m.video_id || '')) ? m.video_id : youTubeId(r.url);
    if (vid && out.length < n) out.push({ item_id: r.id, video_id: vid });
  }
  return out;
}

const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/;

// Save a caption file (WebVTT or json3) as an item's transcript. Returns {ok, message}.
export function setTranscript(db, itemId, input, { lang = null, t = dbNow() } = {}) {
  const it = /^\d{1,15}$/.test(String(itemId)) ? db.prepare('SELECT * FROM items WHERE id = ?').get(Number(itemId)) : null;
  if (!it) return { ok: false, message: `No item ${String(itemId).slice(0, 20)}.` };
  const vid = (parseMeta(it) || {}).video_id || youTubeId(it.url);
  if (it.kind !== 'link' || !vid || !VIDEO_ID_RE.test(vid)) return { ok: false, message: `Item ${it.id} is not a YouTube video.` };
  const body = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  if (Buffer.byteLength(body) > MAX_STDIN) return { ok: false, message: `That caption file is too large (${MAX_STDIN / 1024 / 1024} MB at most).` };
  const segs = parseCaptions(body);
  if (segs === null) return { ok: false, message: 'That is not a WebVTT or json3 caption file.' };
  if (!segs.length) return { ok: false, message: 'The caption file has no lines.' };
  const language = lang && LANG_RE.test(lang) ? lang : vttLanguage(body);
  const md = formatTranscript(segs);
  const meta = { video_id: vid, channel: null, duration_s: null, chapters: [], ...(parseMeta(it) || {}), transcript_status: 'ok', transcript_lang: language || null };
  // a video the server never read gets its type now; a pending read later keeps this transcript
  tx(db, () => {
    db.prepare(`UPDATE items SET link_type = 'youtube', link_site = COALESCE(link_site, 'YouTube'), link_md = ?, link_meta = ?,
        link_fetched_at = COALESCE(link_fetched_at, ?),
        fetch_status = CASE WHEN fetch_status IN ('link_only','failed') THEN 'ok' ELSE fetch_status END WHERE id = ?`)
      .run(md, JSON.stringify(meta), t, it.id);
  });
  return { ok: true, message: `Saved the transcript for item ${it.id}: ${segs.length.toLocaleString('en-US')} lines, ${md.length.toLocaleString('en-US')} characters.` };
}

// The PC tried (deploy/fetch-transcripts.ps1: yt-dlp wrote no subtitle file): 'none_pc' and when, so
// youtube-pending moves on to other videos. A saved transcript is never replaced. Returns {ok, message}.
export function markNoTranscript(db, itemId, { t = dbNow() } = {}) {
  return tx(db, () => {
    const it = /^\d{1,15}$/.test(String(itemId)) ? db.prepare('SELECT * FROM items WHERE id = ?').get(Number(itemId)) : null;
    if (!it) return { ok: false, message: `No item ${String(itemId).slice(0, 20)}.` };
    const old = parseMeta(it) || {};
    const vid = old.video_id || youTubeId(it.url);
    if (it.kind !== 'link' || !vid || !VIDEO_ID_RE.test(vid)) return { ok: false, message: `Item ${it.id} is not a YouTube video.` };
    if (old.transcript_status === 'ok' && it.link_md) return { ok: true, message: `Item ${it.id} already has a transcript; left as it is.` };
    const meta = { video_id: vid, channel: null, duration_s: null, chapters: [], ...old, transcript_status: 'none_pc', transcript_lang: null, pc_checked_at: t };
    db.prepare('UPDATE items SET link_meta = ? WHERE id = ?').run(JSON.stringify(meta), it.id);
    return { ok: true, message: `Item ${it.id}: no English subtitles on the PC either; marked so.` };
  });
}

// ---------------------------------------------------------------- the page and merged text

// The video fields the page needs (tree.js itemDto). null for anything that isn't a read YouTube link.
export function videoDto(it) {
  if (!it || it.link_type !== 'youtube') return null;
  const m = parseMeta(it) || {};
  return {
    video_id: VIDEO_ID_RE.test(String(m.video_id || '')) ? m.video_id : null,
    title: it.link_title || null,
    channel: it.link_author || m.channel || null,
    duration_s: Number.isFinite(m.duration_s) ? m.duration_s : null,
    duration: Number.isFinite(m.duration_s) && m.duration_s > 0 ? fmtClock(m.duration_s) : null,
    chapters: Array.isArray(m.chapters) ? m.chapters.length : 0,
    transcript: m.transcript_status === 'ok' ? (it.link_md ? 'ok' : 'none') : (m.transcript_status || 'none'),
    published_at: it.link_published_at || null,
  };
}

// The "## Video" section of the merged text (render.js).
export function videoSection(it) {
  const m = parseMeta(it) || {};
  const title = it.link_title || it.text || 'YouTube video';
  const bits = [it.link_author || m.channel, Number.isFinite(m.duration_s) && m.duration_s > 0 ? fmtClock(m.duration_s) : null].filter(Boolean);
  const out = [`## Video: ${cleanLine(title, 300)}${bits.length ? ` (${bits.join(', ')})` : ''}`];
  const ch = Array.isArray(m.chapters) ? m.chapters.filter((c) => c && Number.isFinite(c.t)) : [];
  if (ch.length) out.push(`Chapters:\n${ch.map((c) => `- ${fmtClock(c.t)} ${cleanLine(c.title, 200)}`).join('\n')}`);
  out.push(`Transcript:\n${it.link_md && it.link_md.trim() ? it.link_md.trim() : '(No transcript yet.)'}`);
  return out.join('\n\n');
}

// "[Link 1] YouTube · channel · 2026-11-01 · url"
export function videoSourceLine(label, it) {
  const date = it.link_published_at ? new Date(it.link_published_at * 1000).toISOString().slice(0, 10) : null;
  return `[${label}] ${['YouTube', it.link_author, date, it.url].filter(Boolean).join(' · ')}`;
}
