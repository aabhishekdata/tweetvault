// "Get full thread": pull an author's own thread from FxTwitter's v2 thread API and save every part.
// The route queues a job on the item (thread_status = 'queued'); the background worker runs it when no
// normal fetch is due (see fetcher.js), so FxTwitter still gets one request a second at most.
//
// Retries without a new column: the first 429/5xx/network failure keeps the job queued with
// thread_at = now + THREAD_RETRY_S and thread_error = RETRY_MARK. A second failure while the marker is
// there ends the job as 'failed'. Queuing the job again clears the marker, so every request gets one retry.
import { tx } from './db.js';
import { fxV2ToFields } from './fx.js';
import { byId, byTweetId, recomputeRoots, ensureContextParent } from './items.js';
import { sortThread } from './tree.js';
import { queueMediaForPost } from './media.js';

export const MAX_PARTS = 100;
export const THREAD_RETRY_S = 120;
export const RETRY_MARK = 'retrying';
const TWEET_ID = /^\d{1,25}$/;

const ITEM_COLS = ['kind', 'tweet_id', 'url', 'parent_tweet_id', 'quote_tweet_id', 'quote_json', 'author_handle',
  'author_name', 'posted_at', 'text', 'article_title', 'article_md', 'likes', 'replies', 'reposts', 'views', 'render_version'];

const lower = (s) => (s ? String(s).toLowerCase() : null);
const authorOf = (p) => (p && p.author && typeof p.author.screen_name === 'string' ? p.author.screen_name : null);
const parentOf = (p) => (p.replying_to && typeof p.replying_to === 'object' && p.replying_to.status ? String(p.replying_to.status) : null);
// the handle ends up in the saved post's x.com link, so only a real X handle is accepted
const HANDLE = /^[A-Za-z0-9_]{1,50}$/;

// Why a post can't have its thread fetched, or null when it can.
export function threadRefusal(it) {
  if (!it) return 'No such item';
  if ((it.kind !== 'tweet' && it.kind !== 'article') || !it.tweet_id) return 'Only posts and articles have a thread to get.';
  if (it.fetch_status !== 'ok' && it.fetch_status !== 'oembed') return 'Wait until this post has loaded, then try again.';
  return null;
}

// Queue (or keep) the job. Returns false when it was already queued.
export function queueThread(db, id) {
  return tx(db, () => {
    const it = byId(db, id);
    if (it.thread_status === 'queued') return false;
    db.prepare("UPDATE items SET thread_status = 'queued', thread_error = NULL, thread_at = NULL WHERE id = ?").run(it.id);
    return true;
  });
}

// The saved items of this post's author's own thread in its conversation: the root first (when the
// author wrote it), then the parts in thread order. The page compares this list before and after a job.
export function threadPartIds(db, it) {
  const author = lower(it.author_handle);
  if (!author || !it.tweet_id) return it.saved ? [it.id] : [];
  const rootId = it.root_tweet_id || it.tweet_id;
  const rows = db.prepare('SELECT * FROM items WHERE root_tweet_id = ? OR tweet_id = ?').all(rootId, rootId);
  const byTid = new Map(rows.filter((r) => r.tweet_id).map((r) => [r.tweet_id, r]));
  const root = byTid.get(rootId);
  const mine = rows.filter((r) => lower(r.author_handle) === author);
  // when someone else wrote the root, "the thread" is everything this author posted in the conversation
  const parts = root && lower(root.author_handle) === author ? mine.filter((r) => r.is_self_thread) : mine.filter((r) => r !== root);
  const ordered = [root && lower(root.author_handle) === author ? root : null, ...sortThread(parts, byTid)].filter(Boolean);
  return ordered.filter((r) => r.saved).map((r) => r.id);
}

export function threadState(db, it) {
  const status = it.thread_status || null;
  return {
    status,
    // the retry marker is bookkeeping, not something to show
    error: it.thread_error && it.thread_error !== RETRY_MARK ? it.thread_error : null,
    part_ids: threadPartIds(db, it),
  };
}

// FxTwitter's answer -> {ok: posts} | {retry: reason} | {fail: message}
export function interpretThread(httpStatus, bodyText) {
  let j = null;
  try { j = JSON.parse(bodyText); } catch { /* not JSON */ }
  const busy = httpStatus === 429 || httpStatus >= 500;
  if (!j || typeof j !== 'object') {
    if (busy) return { retry: `FxTwitter answered ${httpStatus}` };
    if (httpStatus === 401 || httpStatus === 403) return { fail: 'This account is private.' };
    if (httpStatus === 404) return { fail: 'This post was deleted or could not be found.' };
    return { fail: 'FxTwitter sent something we could not read.' };
  }
  const code = Number(j.code || httpStatus);
  if (code === 401 || code === 403) return { fail: 'This account is private.' };
  if (code === 404) return { fail: 'This post was deleted or could not be found.' };
  if (code === 429 || code >= 500 || busy) return { retry: `FxTwitter answered ${code}` };
  if (code !== 200 || !Array.isArray(j.thread)) return { fail: 'FxTwitter did not send a thread for this post.' };
  const posts = j.thread.filter((p) => p && typeof p === 'object' && TWEET_ID.test(String(p.id || '')));
  // the post asked about should be in thread[], but add it from `status` if FxTwitter left it out
  if (j.status && typeof j.status === 'object' && TWEET_ID.test(String(j.status.id || ''))
      && !posts.some((p) => String(p.id) === String(j.status.id))) posts.push(j.status);
  if (!posts.length) return { fail: 'FxTwitter did not send a thread for this post.' };
  return { ok: posts };
}

// Only the author's own posts, parents before children (then by time), at most MAX_PARTS.
// The author is the saved post's author; when no post matches it (a renamed account), the author of the
// post with the same id, and only then the first post's author.
export function pickParts(it, posts) {
  let author = lower(it.author_handle);
  if (!author || !posts.some((p) => lower(authorOf(p)) === author)) {
    // a renamed account: trust only the post with the saved id, never some other post's author
    const same = posts.find((p) => String(p.id) === String(it.tweet_id));
    if (!same) return { parts: [], capped: false };
    author = lower(authorOf(same));
  }
  if (!author || !HANDLE.test(author)) return { parts: [], capped: false };
  const mine = posts.filter((p) => lower(authorOf(p)) === author);
  const seen = new Set();
  const uniq = mine.filter((p) => { const k = String(p.id); if (seen.has(k)) return false; seen.add(k); return true; });
  const byPid = new Map(uniq.map((p) => [String(p.id), p]));
  // time order (FxTwitter's order breaks ties), with each part pulled in right after its parent
  const byTime = uniq.map((p, i) => [p, i])
    .sort((a, b) => (Number(a[0].created_timestamp) || 0) - (Number(b[0].created_timestamp) || 0) || a[1] - b[1])
    .map(([p]) => p);
  const ordered = [];
  const placed = new Set();
  for (const p of byTime) {
    const up = [];   // p and its not-yet-placed parents, nearest first (a reply loop stops at a repeat)
    for (let q = p; q && !placed.has(q) && !up.includes(q); q = byPid.get(parentOf(q))) up.push(q);
    for (const q of up.reverse()) { placed.add(q); ordered.push(q); }
  }
  if (ordered.length <= MAX_PARTS) return { parts: ordered, capped: false };
  // too long: the first MAX_PARTS, unless the saved post comes later; then the MAX_PARTS leading up to it
  const at = ordered.findIndex((p) => String(p.id) === String(it.tweet_id));
  const from = at >= MAX_PARTS ? at - MAX_PARTS + 1 : 0;
  return { parts: ordered.slice(from, from + MAX_PARTS), capped: true, upTo: from > 0 };
}

// Save the parts and finish the job, all in one transaction. Returns {saved, added} or null when the
// item went away (or was trashed) while the thread was being fetched.
//
// Where the parts go: the job's post is read again here, so this is its state now, not when it was queued.
// - trashed: the job ends quietly and nothing is saved (trashing also clears a queued job, server.js).
// - archived: the parts are saved into the Archive, so nothing jumps into the Inbox.
// - inbox: the parts are saved into the Inbox.
// Only brand-new rows and unsaved context rows (saved = 0) take that state. A part the owner already
// saved keeps its own state, so a part they archived or trashed stays where they put it.
export function saveThread(db, itemId, posts, { httpStatus, body, t, log = (m) => console.error(m) }) {
  const media = [];   // [part id, post], queued after the commit
  const r = tx(db, () => {
    const it = byId(db, itemId);
    if (!it || it.thread_status !== 'queued') return null;
    if (it.saved && it.state === 'trashed') {
      db.prepare('UPDATE items SET thread_status = NULL, thread_error = NULL, thread_at = NULL WHERE id = ?').run(it.id);
      return null;
    }
    const into = it.saved && it.state === 'archived' ? 'archived' : 'inbox';
    const { parts, capped, upTo } = pickParts(it, posts);
    if (!parts.length) {
      db.prepare("UPDATE items SET thread_status = 'failed', thread_error = ?, thread_at = NULL WHERE id = ?")
        .run("Couldn't find this post's thread.", it.id);
      return { saved: 0, added: 0 };
    }
    const fill = db.prepare(`UPDATE items SET ${ITEM_COLS.map((c) => `${c} = ?`).join(', ')}, fetch_status = 'ok',
        fetch_attempts = 0, next_fetch_at = NULL, fetch_error = NULL, stats_at = ? WHERE id = ?`);
    // a context row becomes a saved part (like items.js bump, but into the job's state)
    const keep = db.prepare(`UPDATE items SET saved = 1, ctx_depth = 0, state = ?, trashed_at = NULL, last_saved_at = ?,
        first_saved_at = COALESCE(first_saved_at, ?) WHERE id = ? AND saved = 0`);
    const ids = new Set(parts.map((p) => String(p.id)));
    const tops = [];   // parts whose parent is not a part: [tweet id, parent id, parent handle]
    let added = 0;
    for (const p of parts) {
      const f = fxV2ToFields(p);
      // ids from third-party data become lookup keys: keep only real post ids
      if (f.parent_tweet_id && !TWEET_ID.test(f.parent_tweet_id)) f.parent_tweet_id = null;
      if (f.quote_tweet_id && !TWEET_ID.test(f.quote_tweet_id)) f.quote_tweet_id = null;
      const vals = ITEM_COLS.map((c) => (f[c] === undefined ? null : f[c]));
      const have = byTweetId(db, f.tweet_id);
      let partId = have ? have.id : null;
      if (have) {
        if (!have.saved) { added++; keep.run(into, t, t, have.id); }
        if (have.fetch_status !== 'ok') fill.run(...vals, t, have.id);
        // a post saved before its parent was known still joins the thread
        else if (!have.parent_tweet_id && f.parent_tweet_id) db.prepare('UPDATE items SET parent_tweet_id = ? WHERE id = ?').run(f.parent_tweet_id, have.id);
      } else {
        partId = Number(db.prepare(`INSERT INTO items (${ITEM_COLS.join(', ')}, fetch_status, saved, ctx_depth, state, first_saved_at, last_saved_at, stats_at)
            VALUES (${ITEM_COLS.map(() => '?').join(', ')}, 'ok', 1, 0, ?, ?, ?, ?)`).run(...vals, into, t, t, t).lastInsertRowid);
        added++;
      }
      media.push([partId, p]);
      if (f.parent_tweet_id && !ids.has(f.parent_tweet_id)) {
        const h = p.replying_to && typeof p.replying_to === 'object' ? p.replying_to.screen_name : null;
        tops.push([f.tweet_id, f.parent_tweet_id, typeof h === 'string' && HANDLE.test(h) ? h : null]);
      }
    }
    db.prepare(`INSERT INTO raw_fetches (item_id, source, fetched_at, http_status, body) VALUES (?, 'fxthread', ?, ?, ?)
        ON CONFLICT(item_id, source) DO UPDATE SET fetched_at = excluded.fetched_at, http_status = excluded.http_status, body = excluded.body`)
      .run(it.id, t, httpStatus, body);
    // A thread that opens as a reply keeps its "In reply to" post: queue the parent as a context row,
    // as a normal fetch does (fetcher.js apply). Nothing is added when the parent is already there.
    for (const [tid, parent, handle] of tops) ensureContextParent(db, parent, handle, tid);
    // Group from the top of each chain: recomputeRoots walks up to the root and refreshes the whole
    // subtree under it, so one call per part whose parent is not a part covers them all.
    for (const p of parts) if (!ids.has(String(parentOf(p)))) recomputeRoots(db, String(p.id));
    db.prepare("UPDATE items SET thread_status = 'done', thread_at = ?, thread_error = ? WHERE id = ?")
      .run(t, capped ? `This thread has more than ${MAX_PARTS} parts. Saved ${upTo ? `the ${MAX_PARTS} up to this post` : `the first ${MAX_PARTS}`}.` : null, it.id);
    return { saved: parts.length, added };
  });
  // Keep images (media.js): each part's own pictures, queued after the save is committed (as fetcher.js
  // queueImages does), so a problem here can never undo saving the thread.
  if (r && media.length) {
    try {
      tx(db, () => { for (const [id, p] of media) queueMediaForPost(db, id, p, t); });
    } catch (e) { log(`media queue thread ${itemId}: ${e.message}`); }
  }
  return r;
}

// A job that could not finish: one retry in THREAD_RETRY_S seconds, then 'failed'.
export function threadRetryOrFail(db, it, t, message = 'FxTwitter is busy. Try again in a few minutes.') {
  if (it.thread_error === RETRY_MARK) return threadFail(db, it.id, message);
  db.prepare("UPDATE items SET thread_error = ?, thread_at = ? WHERE id = ? AND thread_status = 'queued'")
    .run(RETRY_MARK, t + THREAD_RETRY_S, it.id);
}

export function threadFail(db, id, message) {
  db.prepare("UPDATE items SET thread_status = 'failed', thread_error = ?, thread_at = NULL WHERE id = ? AND thread_status = 'queued'")
    .run(String(message).slice(0, 300), id);
}
