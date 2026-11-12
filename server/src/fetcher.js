// Background worker: fills in tweets from FxTwitter (oEmbed as a fallback), resolves t.co links,
// adds unsaved parents as context rows and keeps conversation roots up to date.
import { tx, now } from './db.js';
import { interpretFx, oembedToFields } from './fx.js';
import { parseTweetUrl, isTcoUrl, canonicalTweetUrl } from './urls.js';
import { byTweetId, byId, ensureContextParent, recomputeRoots, linkStartStatus, findYouTubeItem } from './items.js';
import { youTubeId } from './youtube.js';
import { addItemsToBundleMeta } from './organize.js';
import { interpretThread, saveThread, threadRetryOrFail, threadFail } from './thread.js';
import { readLink } from './linkreader.js';
import { WebFetchError } from './webfetch.js';
import { queueMediaFromFx } from './media.js';

export const BACKOFF = [30, 120, 600, 3600, 21600];
export const UA = 'TweetVault/1.0 (+https://vault.example.com; personal archive)';
const ALLOWED_HOSTS = new Set(['api.fxtwitter.com', 'publish.twitter.com', 'publish.x.com', 't.co']);

const ITEM_COLS = new Set(['kind', 'tweet_id', 'url', 'parent_tweet_id', 'quote_tweet_id', 'quote_json', 'author_handle',
  'author_name', 'posted_at', 'text', 'article_title', 'article_md', 'likes', 'replies', 'reposts', 'views', 'render_version']);

// Reading shared web pages needs the real network (webfetch.js), and only on purpose: unless the caller
// passes its own page fetcher (webFetch) or realWeb: true (the server started for real, which then uses
// web.js's SSRF-safe safeFetch), pages are read by one that reads nothing, so a test can never reach out.
const offlineWebFetch = async () => { throw new WebFetchError('offline', 'Reading web pages is off here'); };

// onMedia: called after images were queued (media.js), so the image downloader can wake up
export function createFetcher(db, { fetchFn = globalThis.fetch, paceMs = 1000, log = () => {}, nowFn = now, webFetch, realWeb = false, onMedia = () => {} } = {}) {
  const linkDeps = {
    now: nowFn, log, fetchImpl: fetchFn,
    webFetch: webFetch || (realWeb === true ? undefined : offlineWebFetch),
  };
  let lastNet = 0;
  let wakeUp = null;
  let stopped = false;

  const MAX_BODY = 2 * 1024 * 1024;

  // Fetch only from the allowed hosts. Redirects are never followed blindly: with follow=true each
  // hop is checked against the allow-list again (oEmbed moves from publish.twitter.com to publish.x.com).
  async function http(url, { follow = true, headers = {} } = {}) {
    let cur = url;
    for (let hop = 0; hop < 4; hop++) {
      const u = new URL(cur);
      if (u.protocol !== 'https:') throw new Error(`refusing non-https ${u.protocol}`);
      if (!ALLOWED_HOSTS.has(u.hostname)) throw new Error(`refusing to fetch ${u.hostname}`);
      const wait = lastNet + paceMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastNet = Date.now();
      const res = await fetchFn(cur, {
        headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      const loc = res.headers && res.headers.get && res.headers.get('location');
      if (follow && res.status >= 300 && res.status < 400 && loc) {
        cur = new URL(loc, cur).href;
        continue;
      }
      const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
      if (len > MAX_BODY) throw new Error('response too large');
      const body = await readCapped(res);
      if (body.length > MAX_BODY) throw new Error('response too large');
      return { status: res.status, body, headers: res.headers };
    }
    throw new Error('too many redirects');
  }

  // Read a response body but stop (and cancel the download) once it passes MAX_BODY, even without Content-Length.
  async function readCapped(res) {
    const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
    if (!reader) return res.text();   // simple test doubles
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel().catch(() => {}); throw new Error('response too large'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }

  function retryAfterSeconds(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (/^\d+$/.test(String(v).trim())) return Number(v);
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? Math.max(0, Math.ceil((t - nowFn() * 1000) / 1000)) : 0;
  }

  function scheduleRetry(it, err, retryAfter = 0) {
    const attempts = (it.fetch_attempts || 0) + 1;
    if (attempts > BACKOFF.length) {
      db.prepare("UPDATE items SET fetch_status = 'failed', fetch_attempts = ?, next_fetch_at = NULL, fetch_error = ? WHERE id = ?")
        .run(attempts, String(err).slice(0, 300), it.id);
    } else {
      const delay = Math.min(86400, Math.max(BACKOFF[attempts - 1], retryAfterSeconds(retryAfter)));
      db.prepare('UPDATE items SET fetch_attempts = ?, next_fetch_at = ?, fetch_error = ? WHERE id = ?')
        .run(attempts, nowFn() + delay, String(err).slice(0, 300), it.id);
    }
  }

  function apply(it, fields, status, source, httpStatus, body) {
    const parentHandle = fields.parent_handle || null;
    tx(db, () => {
      const set = Object.entries(fields).filter(([k, v]) => ITEM_COLS.has(k) && v !== undefined);
      db.prepare(`UPDATE items SET ${set.map(([k]) => `${k} = ?`).join(', ')}, fetch_status = ?, fetch_attempts = 0,
          next_fetch_at = NULL, fetch_error = NULL, stats_at = ? WHERE id = ?`)
        .run(...set.map(([, v]) => v), status, nowFn(), it.id);
      db.prepare(`INSERT INTO raw_fetches (item_id, source, fetched_at, http_status, body) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(item_id, source) DO UPDATE SET fetched_at = excluded.fetched_at, http_status = excluded.http_status, body = excluded.body`)
        .run(it.id, source, nowFn(), httpStatus, body);
      if (fields.parent_tweet_id) ensureContextParent(db, fields.parent_tweet_id, parentHandle, it.tweet_id);
      recomputeRoots(db, it.tweet_id);
    });
    if (source === 'fxtwitter') queueImages(it.id, body);
  }

  // Keep images (media.js): queue the post's pictures after the save is committed, so a problem here
  // can never undo or block saving the post itself.
  function queueImages(itemId, body) {
    try {
      if (queueMediaFromFx(db, itemId, body, nowFn())) onMedia();
    } catch (e) { log(`media queue item ${itemId}: ${e.message}`); }
  }

  async function fetchTweet(it) {
    const r = await http(`https://api.fxtwitter.com/${it.author_handle || 'i'}/status/${it.tweet_id}`);
    const v = interpretFx(r.status, r.body);
    if (v.status === 'ok') {
      let parentHandle = null;
      try { parentHandle = JSON.parse(r.body).tweet.replying_to || null; } catch { /* ignore */ }
      apply(it, { ...v.fields, parent_handle: parentHandle }, 'ok', 'fxtwitter', r.status, r.body);
      return;
    }
    if (v.status === 'retry') {
      scheduleRetry(it, `FxTwitter answered ${v.code}`, r.headers && r.headers.get && r.headers.get('retry-after'));
      return;
    }
    // not found or private: try oEmbed once
    const canon = canonicalTweetUrl(it.author_handle, it.tweet_id);
    let o = null;
    let r2;
    try {
      r2 = await http(`https://publish.twitter.com/oembed?url=${encodeURIComponent(canon)}&omit_script=1&dnt=true`);
    } catch (e) {
      scheduleRetry(it, `oEmbed: ${e.message}`);
      return;
    }
    if (r2.status === 429 || r2.status >= 500) {
      scheduleRetry(it, `oEmbed answered ${r2.status}`, r2.headers && r2.headers.get && r2.headers.get('retry-after'));
      return;
    }
    if (r2.status === 200) o = { fields: oembedToFields(r2.body, it.tweet_id), r2 };
    if (o && o.fields && o.fields.text) {
      apply(it, o.fields, 'oembed', 'oembed', o.r2.status, o.r2.body);
      return;
    }
    db.prepare("UPDATE items SET fetch_status = 'unavailable', next_fetch_at = NULL, fetch_error = ? WHERE id = ?")
      .run(v.status === 'private' ? 'Private account' : 'Deleted or not found', it.id);
    tx(db, () => recomputeRoots(db, it.tweet_id));
  }

  function becomeTweet(it, tweetId, handle) {
    tx(db, () => {
      const existing = byTweetId(db, tweetId);
      if (existing && existing.id !== it.id) {
        foldInto(it, existing);
      } else {
        db.prepare(`UPDATE items SET kind = 'tweet', tweet_id = ?, url = ?, author_handle = ?, note = NULL,
            fetch_status = 'pending', fetch_attempts = 0, next_fetch_at = NULL, fetch_error = NULL WHERE id = ?`)
          .run(tweetId, canonicalTweetUrl(handle, tweetId), handle, it.id);
      }
    });
  }

  // A short link that turned out to be something already saved (a tweet, or a YouTube video): the short-link
  // row is folded into that item and deleted, so the same thing is saved only once. Runs inside the caller's tx.
  function foldInto(it, existing) {
    // `it` was read before the redirect was fetched; the owner may have organized the row since,
    // so merge what is in the database now. If the row is gone (deleted meanwhile), there is nothing to merge.
    const cur = byId(db, it.id);
    if (!cur) return;
    // keep the user's organizing from the short-link row on the existing item
    db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id) SELECT ?, tag_id FROM item_tags WHERE item_id = ?').run(existing.id, it.id);
    db.prepare('UPDATE items SET category_id = COALESCE(category_id, ?), priority = MAX(priority, ?) WHERE id = ?')
      .run(cur.category_id ?? null, cur.priority || 0, existing.id);
    db.prepare('UPDATE captures SET item_id = ? WHERE item_id = ?').run(existing.id, it.id);
    // and the owner's own note: take it when the item has none, join the two when both have one
    if (cur.my_note) {
      db.prepare(`UPDATE items SET my_note = CASE WHEN my_note IS NULL OR my_note = '' THEN ?
          WHEN my_note = ? THEN my_note ELSE my_note || char(10) || char(10) || ? END WHERE id = ?`)
        .run(cur.my_note, cur.my_note, cur.my_note, existing.id);
    }
    // a merge holding the short link now holds the existing item instead: bump its version so a page that
    // still lists the short link gets a 409 and reloads, instead of saving the item out of the merge
    const merges = db.prepare('SELECT bundle_id FROM bundle_items WHERE item_id = ?').all(it.id).map((r) => r.bundle_id);
    db.prepare('UPDATE bundles SET version = version + 1, updated_at = ? WHERE id IN (SELECT bundle_id FROM bundle_items WHERE item_id = ?)')
      .run(nowFn(), it.id);
    db.prepare('UPDATE OR IGNORE bundle_items SET item_id = ? WHERE item_id = ?').run(existing.id, it.id);
    db.prepare('DELETE FROM bundle_items WHERE item_id = ?').run(it.id);
    db.prepare('DELETE FROM items WHERE id = ?').run(it.id);
    for (const bid of merges) addItemsToBundleMeta(db, bid, [existing.id]);
    db.prepare(`UPDATE items SET saved = 1, state = 'inbox', trashed_at = NULL, last_saved_at = ?,
        first_saved_at = COALESCE(first_saved_at, ?) WHERE id = ?`).run(cur.last_saved_at, cur.first_saved_at, existing.id);
    // a failed item, or a video link saved before videos were read (plain link_only), is read again
    db.prepare(`UPDATE items SET fetch_status = 'pending', fetch_attempts = 0, next_fetch_at = NULL, fetch_error = NULL
        WHERE id = ? AND (fetch_status = 'failed' OR (kind = 'link' AND link_type IS NULL AND fetch_status = 'link_only'))`).run(existing.id);
  }

  // The short link leads to a YouTube video already in the vault (in any address form): fold into it.
  function foldIntoVideo(it, videoId) {
    return tx(db, () => {
      const existing = findYouTubeItem(db, videoId);
      if (!existing || existing.id === it.id) return false;
      foldInto(it, existing);
      return true;
    });
  }

  async function resolveTco(it) {
    let url = String(it.url).replace(/^http:/i, 'https:');
    for (let hop = 0; hop < 3; hop++) {
      const r = await http(url, { follow: false, headers: { 'User-Agent': 'curl/8 TweetVault' } });
      let loc = r.headers && r.headers.get && r.headers.get('location');
      if (!loc) {
        const m = r.body.match(/URL=([^"'>\s]+)/i) || r.body.match(/<title>(https?:\/\/[^<]+)<\/title>/i);
        loc = m ? m[1].replace(/&amp;/g, '&') : null;
      }
      if (!loc) break;
      let next;
      try { next = new URL(loc, url); } catch { break; }
      if (next.protocol !== 'https:' && next.protocol !== 'http:') break;
      const tw = parseTweetUrl(next.href);
      if (tw && tw.tweetId) { becomeTweet(it, tw.tweetId, tw.handle); return; }
      if (isTcoUrl(next.href)) { url = next.href.replace(/^http:/i, 'https:'); continue; }
      const vid = youTubeId(next.href);
      if (vid && foldIntoVideo(it, vid)) return;
      // an ordinary page: read it next (readLink), like a link shared directly. X's own pages (profiles,
      // lists, search) stay a plain link, as capture() leaves them (linkStartStatus).
      db.prepare(`UPDATE items SET url = ?, note = NULL, fetch_status = ?, fetch_attempts = 0, next_fetch_at = NULL,
          fetch_error = NULL WHERE id = ?`).run(next.href, linkStartStatus(next.href), it.id);
      return;
    }
    db.prepare("UPDATE items SET note = NULL, fetch_status = 'link_only', fetch_error = 'Could not expand the short link' WHERE id = ?").run(it.id);
  }

  async function processItem(it) {
    if (it.kind === 'link' && it.note === 'tco') return resolveTco(it);
    if (it.kind === 'link') return readLink(db, it, linkDeps);   // web article or YouTube (linkreader.js)
    if (it.tweet_id) return fetchTweet(it);
    db.prepare("UPDATE items SET fetch_status = 'n/a' WHERE id = ?").run(it.id);
  }

  function nextDue() {
    return db.prepare(`SELECT * FROM items WHERE fetch_status = 'pending' AND (next_fetch_at IS NULL OR next_fetch_at <= ?)
        ORDER BY COALESCE(next_fetch_at, 0), id LIMIT 1`).get(nowFn());
  }

  // ---- "Get full thread" jobs (thread.js): run only when no normal fetch is due ----
  function nextThreadJob() {
    return db.prepare(`SELECT * FROM items WHERE thread_status = 'queued' AND (thread_at IS NULL OR thread_at <= ?)
        ORDER BY COALESCE(thread_at, 0), id LIMIT 1`).get(nowFn());
  }

  async function runThreadJob(job) {
    if (!/^\d{1,25}$/.test(String(job.tweet_id))) { threadFail(db, job.id, 'This post has no thread to get.'); return; }
    let r;
    try {
      r = await http(`https://api.fxtwitter.com/2/thread/${job.tweet_id}`);
    } catch (e) {
      log(`thread error item ${job.id}: ${e.message}`);
      if (/too large/.test(e.message)) threadFail(db, job.id, 'This thread is too large to fetch.');
      else if (/refusing|too many redirects/.test(e.message)) threadFail(db, job.id, "Couldn't reach FxTwitter for this thread.");
      else threadRetryOrFail(db, job, nowFn());
      return;
    }
    const v = interpretThread(r.status, r.body);
    if (v.ok) { saveThread(db, job.id, v.ok, { httpStatus: r.status, body: r.body, t: nowFn() }); onMedia(); }
    else if (v.retry) threadRetryOrFail(db, job, nowFn());
    else threadFail(db, job.id, v.fail);
  }

  async function runOnce() {
    const it = nextDue();
    if (!it) {
      const job = nextThreadJob();
      if (!job) return false;
      try { await runThreadJob(job); } catch (e) {
        log(`thread error item ${job.id}: ${e.message}`);
        threadFail(db, job.id, 'Something went wrong while saving the thread.');
      }
      return true;
    }
    try {
      await processItem(it);
    } catch (e) {
      log(`fetch error item ${it.id}: ${e.message}`);
      const fresh = byId(db, it.id);
      if (fresh && fresh.fetch_status === 'pending') scheduleRetry(fresh, e.message || String(e));
    }
    return true;
  }

  async function drain(limit = 1000) {
    let n = 0;
    while (n < limit && await runOnce()) n++;
    return n;
  }

  async function loop() {
    while (!stopped) {
      let did = false;
      try { did = await runOnce(); } catch (e) { log(`worker: ${e.message}`); }
      if (did) continue;
      let ms = 60_000;
      try {
        const nf = db.prepare("SELECT MIN(next_fetch_at) AS m FROM items WHERE fetch_status = 'pending'").get().m;
        // a thread job waiting out its retry wakes the worker too
        const nt = db.prepare("SELECT MIN(thread_at) AS m FROM items WHERE thread_status = 'queued'").get().m;
        const nxt = nf && nt ? Math.min(nf, nt) : nf || nt;
        ms = nxt ? Math.min(60_000, Math.max(500, (nxt - nowFn()) * 1000)) : 60_000;
      } catch (e) { log(`worker: ${e.message}`); }
      await new Promise((r) => {
        const t = setTimeout(r, ms);
        wakeUp = () => { clearTimeout(t); r(); };
      });
      wakeUp = null;
    }
  }

  return {
    start() { stopped = false; loop().catch((e) => log(`worker stopped: ${e && e.message}`)); },
    stop() { stopped = true; if (wakeUp) wakeUp(); },
    wake() { if (wakeUp) wakeUp(); },
    runOnce,
    drain,
  };
}
