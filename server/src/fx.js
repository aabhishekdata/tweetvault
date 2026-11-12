// Map FxTwitter and oEmbed responses onto item fields. Pure functions, no network.
import { draftToMarkdown, RENDER_VERSION } from './draftjs.js';
import { canonicalTweetUrl } from './urls.js';

const str = (v) => (v === null || v === undefined || v === '' ? null : String(v));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function mediaLines(t) {
  const lines = [];
  for (const p of (t.media && t.media.photos) || []) if (p.url) lines.push(`[Image: ${p.url}]`);
  for (const v of (t.media && t.media.videos) || []) if (v.url) lines.push(`[Video: ${v.url}]`);
  return lines;
}

// Returns {status:'ok', fields} or {status:'not_found'|'private'|'retry', code}
export function interpretFx(httpStatus, bodyText) {
  let json = null;
  try { json = JSON.parse(bodyText); } catch { /* not JSON */ }
  if (!json) {
    if (httpStatus === 429 || httpStatus >= 500) return { status: 'retry', code: httpStatus };
    if (httpStatus === 401 || httpStatus === 403) return { status: 'private', code: httpStatus };
    // FxTwitter answers some unknown IDs with an HTML page and HTTP 200
    if (httpStatus === 200 || httpStatus === 404) return { status: 'not_found', code: httpStatus };
    return { status: 'retry', code: httpStatus };
  }
  const code = Number(json.code || httpStatus);
  if (code === 200 && json.tweet) return { status: 'ok', fields: fxTweetToFields(json.tweet) };
  if (code === 401) return { status: 'private', code };
  if (code === 404) return { status: 'not_found', code };
  if (code === 429 || code >= 500) return { status: 'retry', code };
  return { status: 'retry', code };
}

export function fxTweetToFields(t) {
  const handle = str(t.author && t.author.screen_name);
  const id = str(t.id);
  const f = {
    tweet_id: id,
    url: canonicalTweetUrl(handle, id),
    author_handle: handle,
    author_name: str(t.author && t.author.name),
    posted_at: num(t.created_timestamp),
    parent_tweet_id: str(t.replying_to_status),
    quote_tweet_id: t.quote ? str(t.quote.id) : null,
    quote_json: t.quote ? JSON.stringify({
      handle: str(t.quote.author && t.quote.author.screen_name),
      name: str(t.quote.author && t.quote.author.name),
      text: String(t.quote.text || ''),
      url: canonicalTweetUrl(str(t.quote.author && t.quote.author.screen_name), str(t.quote.id)),
    }) : null,
    likes: num(t.likes),
    replies: num(t.replies),
    reposts: num(t.retweets ?? t.reposts),
    views: num(t.views),
    render_version: RENDER_VERSION,
    kind: 'tweet',
    text: String(t.text || ''),
    article_title: null,
    article_md: null,
  };
  const media = mediaLines(t);
  if (media.length) f.text = [f.text, ...media].filter(Boolean).join('\n');
  if (t.article) {
    const a = t.article;
    f.kind = 'article';
    f.article_title = str(a.title) || 'Untitled article';
    const md = a.content && a.content.blocks && a.content.blocks.length
      ? draftToMarkdown(a.content, a.media_entities)
      : '';
    f.article_md = md || (a.preview_text ? `${a.preview_text}\n\n(Only the preview was available.)` : '');
    // the tweet text of an article post is just the article link; keep it out of the merged text
    if (/^https:\/\/(x|twitter)\.com\/i\/article\/\d+\s*$/.test(f.text.trim())) f.text = '';
  }
  return f;
}

// The v2 API (/2/thread/<id>, /2/status/<id>) shapes a post a little differently from v1:
// replying_to is an object {screen_name, status}, the count is `reposts`, and media comes as
// media.all (typed 'photo' / 'video' / 'gif') next to, or instead of, media.photos / media.videos.
// Turn it into the v1 shape and reuse fxTweetToFields, so quotes, articles and media lines read the same.
function v2Media(m) {
  if (!m || typeof m !== 'object') return {};
  if (Array.isArray(m.all) && m.all.length) {
    const ok = (x) => x && typeof x === 'object' && x.url;
    const photos = m.all.filter((x) => ok(x) && x.type === 'photo');
    const videos = m.all.filter((x) => ok(x) && (x.type === 'video' || x.type === 'gif'));
    if (photos.length || videos.length) return { photos, videos };
  }
  return { photos: Array.isArray(m.photos) ? m.photos : [], videos: Array.isArray(m.videos) ? m.videos : [] };
}

export function fxV2ToFields(t) {
  const rt = t && t.replying_to;
  const parent = rt && typeof rt === 'object' ? rt.status : null;
  return fxTweetToFields({
    ...t,
    replying_to_status: parent ?? null,
    retweets: t.reposts ?? t.retweets,
    media: v2Media(t.media),
  });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// oEmbed JSON -> partial fields, or null
export function oembedToFields(bodyText, tweetId) {
  let j;
  try { j = JSON.parse(bodyText); } catch { return null; }
  if (!j || !j.html) return null;
  const pm = String(j.html).match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const text = pm ? decodeEntities(pm[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim() : '';
  const hm = String(j.author_url || '').match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/);
  const handle = hm ? hm[1] : null;
  return {
    kind: 'tweet',
    text,
    author_handle: handle,
    author_name: str(j.author_name),
    url: canonicalTweetUrl(handle, tweetId),
    render_version: RENDER_VERSION,
  };
}
