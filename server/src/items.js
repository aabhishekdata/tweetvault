// Capturing, item lookups and the root/thread bookkeeping shared by the fetcher, inbox and renderer.
import { createHash } from 'node:crypto';
import { tx, now } from './db.js';
import { classifyInput, canonicalTweetUrl, isTweetHost } from './urls.js';
import { youTubeId } from './youtube.js';
import { parseKindleShare, addBook, KINDLE_SITE, textHash } from './kindle.js';

export const MAX_INPUT = 200_000;

export const byTweetId = (db, id) => db.prepare('SELECT * FROM items WHERE tweet_id = ?').get(String(id));
export const byId = (db, id) => db.prepare('SELECT * FROM items WHERE id = ?').get(Number(id));

// A note the owner typed (sync.js createNote): the only kind of item whose text can be edited.
export const isOwnNote = (it) => !!it && it.kind === 'text' && it.source_app === 'note' && !it.voice_id;
// An exact fingerprint of a note's title and text. An editor sends back the one it started from, so a
// change made somewhere else in the meantime is noticed, down to a line break, a capital or the title.
// (text_hash can't do this: it ignores case and spacing on purpose, to fold repeat saves.)
export const noteVersion = (it) => createHash('sha256').update(`${it.article_title || ''}\n\u0000${it.text || ''}`).digest('hex');

function bump(db, id, t, sourceApp) {
  db.prepare(`UPDATE items SET saved = 1, ctx_depth = 0, state = 'inbox', trashed_at = NULL, last_saved_at = ?,
      first_saved_at = COALESCE(first_saved_at, ?), source_app = COALESCE(source_app, ?) WHERE id = ?`)
    .run(t, t, sourceApp ?? null, id);
  // a share of something that failed earlier is a good moment to try again
  db.prepare(`UPDATE items SET fetch_status = 'pending', fetch_attempts = 0, next_fetch_at = NULL, fetch_error = NULL
      WHERE id = ? AND fetch_status = 'failed'`).run(id);
}

function insertItem(db, f) {
  const cols = Object.keys(f);
  const r = db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => f[c]));
  return Number(r.lastInsertRowid);
}

// A shared page is read in the background (fetcher -> linkreader.js), so it starts 'pending'. X's own pages
// (profiles, lists, search) are an app shell with nothing to read, so they stay a plain link.
export function linkStartStatus(url) {
  let u;
  try { u = new URL(url); } catch { return 'link_only'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'link_only';
  return isTweetHost(u.hostname) ? 'link_only' : 'pending';
}

// The saved link item for a YouTube video, whatever form its address took (watch?v=, youtu.be, shorts...).
// Read videos carry the id in link_meta.video_id; ones not read yet are matched on their address.
export function findYouTubeItem(db, videoId) {
  if (!videoId) return null;
  const byMeta = db.prepare(`SELECT id FROM items WHERE kind = 'link' AND link_type = 'youtube' AND json_valid(link_meta)
      AND json_extract(link_meta, '$.video_id') = ? ORDER BY id LIMIT 1`).get(videoId);
  if (byMeta) return byMeta;
  // only links that mention the id can match; youTubeId then checks the address properly
  const rows = db.prepare("SELECT id, url FROM items WHERE kind = 'link' AND instr(url, ?) > 0 ORDER BY id LIMIT 50").all(videoId);
  return rows.find((r) => youTubeId(r.url) === videoId) || null;
}

// A YouTube share: a second share of the same video bumps the first item instead of adding another.
// New ones start 'pending' so the worker's link reader (linkreader.js -> youtube.js) fills them in, and so
// does one saved before videos were read (a plain link_only link with no link_type) when it is shared again.
function captureYouTube(db, c, base, t, app) {
  const id = youTubeId(c.url);
  const it = findYouTubeItem(db, id);
  if (it) {
    bump(db, it.id, t, app);
    db.prepare(`UPDATE items SET fetch_status = 'pending', fetch_attempts = 0, next_fetch_at = NULL, fetch_error = NULL
        WHERE id = ? AND kind = 'link' AND link_type IS NULL AND fetch_status = 'link_only' AND (note IS NULL OR note = '')`).run(it.id);
    return it.id;
  }
  return insertItem(db, { ...base, kind: 'link', url: c.url, text: c.title, fetch_status: 'pending' });
}

// Save one capture. Returns {capture_id, item_id, fetch_status, duplicate}
export function capture(db, { input, source_app = null, client_id, captured_at = null, device_id = null }) {
  const raw = String(input ?? '');
  if (!raw.trim()) throw Object.assign(new Error('Nothing to save'), { status: 400, expose: true });
  if (raw.length > MAX_INPUT) throw Object.assign(new Error('Too large'), { status: 413, expose: true });
  if (!client_id || !/^[A-Za-z0-9._:-]{8,80}$/.test(String(client_id))) {
    throw Object.assign(new Error('client_id missing or malformed'), { status: 400, expose: true });
  }
  const app = source_app ? String(source_app).slice(0, 120) : null;
  return tx(db, () => {
    const seen = db.prepare(`SELECT c.id, c.item_id, i.fetch_status FROM captures c
        LEFT JOIN items i ON i.id = c.item_id WHERE c.client_id = ?`).get(String(client_id));
    if (seen) return { capture_id: seen.id, item_id: seen.item_id, fetch_status: seen.fetch_status, duplicate: true };

    const t = now();
    const kindle = parseKindleShare(raw);
    const c = kindle ? { type: 'kindle' } : classifyInput(raw);
    let itemId;
    const base = { saved: 1, state: 'inbox', first_saved_at: t, last_saved_at: t, source_app: app };
    if (c.type === 'kindle') {
      // a Kindle highlight: the passage, with its book beside it (kindle.js)
      const h = textHash(kindle.quote);
      const it = db.prepare("SELECT id FROM items WHERE kind = 'text' AND text_hash = ? AND last_saved_at > ?").get(h, t - 86400);
      // the same passage copied earlier (no book yet): this share fills in the book
      if (it) { bump(db, it.id, t, app); addBook(db, it.id, kindle); itemId = it.id; }
      else itemId = insertItem(db, { ...base, kind: 'text', text: kindle.quote, text_hash: h, fetch_status: 'n/a',
        url: kindle.url, link_title: kindle.title, link_author: kindle.author, link_site: KINDLE_SITE });
    } else if (c.type === 'tweet') {
      const it = byTweetId(db, c.tweetId);
      if (it) { bump(db, it.id, t, app); itemId = it.id; }
      else itemId = insertItem(db, { ...base, kind: 'tweet', tweet_id: c.tweetId, url: c.url, author_handle: c.handle, fetch_status: 'pending' });
    } else if (c.type === 'tco') {
      itemId = insertItem(db, { ...base, kind: 'link', url: c.url, note: 'tco', fetch_status: 'pending' });
    } else if (c.type === 'article_link') {
      const it = db.prepare("SELECT id FROM items WHERE kind = 'link' AND url = ?").get(c.url);
      if (it) { bump(db, it.id, t, app); itemId = it.id; }
      else itemId = insertItem(db, { ...base, kind: 'link', url: c.url, fetch_status: 'link_only',
        note: 'This is the article page link. Share the post itself to get the full article.' });
    } else if (c.type === 'link' && youTubeId(c.url)) {
      itemId = captureYouTube(db, c, base, t, app);
    } else if (c.type === 'link') {
      const it = db.prepare("SELECT id FROM items WHERE kind = 'link' AND url = ?").get(c.url);
      if (it) { bump(db, it.id, t, app); itemId = it.id; }
      else itemId = insertItem(db, { ...base, kind: 'link', url: c.url, text: c.title, fetch_status: linkStartStatus(c.url) });
    } else {
      const h = textHash(c.text);
      const it = db.prepare("SELECT id FROM items WHERE kind = 'text' AND text_hash = ? AND last_saved_at > ?").get(h, t - 86400);
      if (it) { bump(db, it.id, t, app); itemId = it.id; }
      else itemId = insertItem(db, { ...base, kind: 'text', text: c.text, text_hash: h, fetch_status: 'n/a' });
    }
    const r = db.prepare(`INSERT INTO captures (client_id, item_id, raw_input, source_app, device_id, captured_at, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(String(client_id), itemId, raw, app, device_id, Number(captured_at) || null, t);
    const st = db.prepare('SELECT fetch_status FROM items WHERE id = ?').get(itemId).fetch_status;
    return { capture_id: Number(r.lastInsertRowid), item_id: itemId, fetch_status: st, duplicate: false };
  });
}

// Add a parent we have not saved as a context row (saved = 0) so replies can hang off it.
export function ensureContextParent(db, parentTweetId, parentHandle, childTweetId) {
  if (!parentTweetId || byTweetId(db, parentTweetId)) return false;
  // depth guard: ctx_depth counts how far above the nearest saved item a context row sits
  const child = byTweetId(db, childTweetId);
  const depth = child ? (child.saved ? 0 : child.ctx_depth || 0) : 0;
  // other people's conversations: 10 levels up; an author's own thread: up to 40 parts
  const sameAuthor = child && child.author_handle && parentHandle
    && child.author_handle.toLowerCase() === String(parentHandle).toLowerCase();
  if (depth >= (sameAuthor ? 40 : 10)) return false;
  insertItem(db, {
    kind: 'tweet', tweet_id: String(parentTweetId), url: canonicalTweetUrl(parentHandle, parentTweetId),
    author_handle: parentHandle || null, fetch_status: 'pending', saved: 0, ctx_depth: depth + 1, state: 'inbox',
  });
  return true;
}

// Work out the root of tweetId's conversation (as far as we know it) and refresh
// root_tweet_id / is_self_thread for everything under that root.
export function recomputeRoots(db, tweetId) {
  let cur = byTweetId(db, tweetId);
  if (!cur) return null;
  let guard = 0;
  // 120 levels: a fetched full thread can be 100 parts deep (thread.js MAX_PARTS)
  while (cur.parent_tweet_id && guard++ < 120) {
    const p = byTweetId(db, cur.parent_tweet_id);
    if (!p) break;
    cur = p;
  }
  const rootId = cur.tweet_id;
  const rows = db.prepare(`WITH RECURSIVE sub(tid) AS (
      SELECT ? UNION SELECT i.tweet_id FROM items i JOIN sub ON i.parent_tweet_id = sub.tid)
    SELECT i.id, i.tweet_id, i.parent_tweet_id, i.author_handle FROM items i JOIN sub ON i.tweet_id = sub.tid`).all(rootId);
  const byTid = new Map(rows.map((r) => [r.tweet_id, r]));
  const root = byTid.get(rootId);
  const rootAuthor = root && root.author_handle ? root.author_handle.toLowerCase() : null;
  const self = new Map([[rootId, true]]);
  const isSelf = (r, depth = 0) => {
    if (self.has(r.tweet_id)) return self.get(r.tweet_id);
    const p = byTid.get(r.parent_tweet_id);
    const v = !!(rootAuthor && p && depth < 50 && r.author_handle && r.author_handle.toLowerCase() === rootAuthor && isSelf(p, depth + 1));
    self.set(r.tweet_id, v);
    return v;
  };
  const upd = db.prepare('UPDATE items SET root_tweet_id = ?, is_self_thread = ? WHERE id = ?');
  for (const r of rows) upd.run(rootId, r.tweet_id === rootId ? 0 : (isSelf(r) ? 1 : 0), r.id);
  return rootId;
}

export const groupKey = (it) => it.root_tweet_id || (it.tweet_id ? it.tweet_id : `item:${it.id}`);
