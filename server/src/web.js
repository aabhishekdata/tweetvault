// Normal web links: the readable article text (phase 3.2).
// Contract (see linkreader.js): readWebPage(db, it, deps) -> Promise<void>. It ends the item at
//   'ok'        the article text is saved in link_md
//   'link_only' nothing readable (a paywall, an app shell, not a web page, a refused address); the URL stays
// or throws an Error with retry = true for a temporary failure (the worker's backoff tries again later).
//
// The page is fetched by safeFetch (webfetch.js, the SSRF defences). deps.webFetch replaces it in tests;
// deps.fetchImpl (the general fetch used for fixed APIs) is never used for pages someone shared.
import { tx } from './db.js';
import { safeFetch, WebFetchError } from './webfetch.js';
import { extractArticle } from './htmltext.js';
import { BACKOFF } from './fetcher.js';

const nowSec = () => Math.floor(Date.now() / 1000);

// The address to read. A shared http:// link is read over https (the fetcher only speaks https);
// the item keeps the address exactly as it was shared.
export function readableUrl(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return null; }
  if (u.protocol === 'http:') {
    if (u.port && u.port !== '80') return null;
    u.protocol = 'https:';
    u.port = '';
  }
  return u.protocol === 'https:' ? u.href : null;
}

// Text saved by an earlier read of this page, which a failed re-read must never take away.
function savedText(db, it) {
  const row = db.prepare('SELECT link_type, link_md FROM items WHERE id = ?').get(it.id);
  return !!(row && row.link_type === 'web' && row.link_md);
}

// A re-read failed but the page's text from before is still there: keep it (and its title, site, author
// and date), say what went wrong in fetch_error, and stay 'ok'.
function keepSaved(db, it, why) {
  db.prepare("UPDATE items SET fetch_status = 'ok', fetch_error = ?, fetch_attempts = 0, next_fetch_at = NULL WHERE id = ?")
    .run(String(why).slice(0, 300), it.id);
}

// End the item without text. The link was tried as a web page, so link_type says so (read-links skips it).
// An item that already has text from an earlier read keeps it.
function endLinkOnly(db, it, t, why, extra = {}) {
  if (savedText(db, it)) { keepSaved(db, it, why); return; }
  db.prepare(`UPDATE items SET fetch_status = 'link_only', fetch_error = ?, fetch_attempts = 0, next_fetch_at = NULL,
      link_type = 'web', link_title = ?, link_site = ?, link_author = ?, link_published_at = ?, link_md = NULL,
      link_meta = ?, link_fetched_at = ? WHERE id = ?`)
    .run(String(why).slice(0, 300), extra.title ?? null, extra.site ?? null, extra.author ?? null,
      extra.published_at ?? null, extra.meta ? JSON.stringify(extra.meta) : null, t, it.id);
}

// a small record of the fetch (never the page itself: it can be 3 MB)
function rawRecord(db, it, t, page) {
  const body = JSON.stringify({ final_url: page.finalUrl, content_type: page.contentType, charset: page.charset, bytes: page.bytes });
  db.prepare(`INSERT INTO raw_fetches (item_id, source, fetched_at, http_status, body)
      SELECT ?, 'web', ?, ?, ? WHERE EXISTS (SELECT 1 FROM items WHERE id = ?)
      ON CONFLICT(item_id, source) DO UPDATE SET fetched_at = excluded.fetched_at, http_status = excluded.http_status, body = excluded.body`)
    .run(it.id, t, page.status ?? 200, body, it.id);
}

export async function readWebPage(db, it, deps = {}) {
  const now = deps.now || nowSec;
  const log = deps.log || (() => {});
  const target = readableUrl(it.url);
  if (!target) { endLinkOnly(db, it, now(), 'Only web pages (https) are read'); return; }

  // Count the attempt before the page is fetched and read: if reading it takes the process down (a hostile
  // page and the 128 MB container), the restarted worker sees a failed attempt and waits out the backoff,
  // and after the last step the item ends instead of crashing the vault again and again.
  const before = it.fetch_attempts || 0;
  if (before > BACKOFF.length) {
    const why = 'Reading this page kept failing';
    if (savedText(db, it)) keepSaved(db, it, why);
    else db.prepare("UPDATE items SET fetch_status = 'failed', next_fetch_at = NULL, fetch_error = ? WHERE id = ?").run(why, it.id);
    return;
  }
  db.prepare('UPDATE items SET fetch_attempts = ?, next_fetch_at = ? WHERE id = ?')
    .run(before + 1, now() + BACKOFF[Math.min(before, BACKOFF.length - 1)], it.id);

  let page;
  try {
    page = await (deps.webFetch || safeFetch)(target);
  } catch (e) {
    if (e && e.retry) {
      // temporary: the worker schedules the retry with its backoff and counts the attempt itself; the
      // last one, for a page with text saved before, keeps that text instead of ending 'failed'
      if (before + 1 > BACKOFF.length && savedText(db, it)) { keepSaved(db, it, e.message || "Couldn't read this page"); return; }
      db.prepare('UPDATE items SET fetch_attempts = ? WHERE id = ?').run(before, it.id);
      throw e;
    }
    const why = e instanceof WebFetchError ? e.message : "Couldn't read this page";
    log(`web item ${it.id}: ${e && e.message}`);
    endLinkOnly(db, it, now(), why);
    return;
  }

  let art;
  try {
    art = extractArticle(page.html, page.finalUrl || target, { nowSec: now() });
  } catch (e) {
    log(`web item ${it.id}: extract failed: ${e && e.message}`);
    endLinkOnly(db, it, now(), "Couldn't read this page");
    return;
  }
  const t = now();
  const meta = { final_url: String(page.finalUrl || target).slice(0, 2048), words: art.words };
  tx(db, () => {
    rawRecord(db, it, t, page);
    if (!art.readable) {
      // keep what the page is called, but there is no article to save
      endLinkOnly(db, it, t, 'No readable article text', { ...art, meta });
      return;
    }
    db.prepare(`UPDATE items SET fetch_status = 'ok', fetch_error = NULL, fetch_attempts = 0, next_fetch_at = NULL,
        link_type = 'web', link_title = ?, link_site = ?, link_author = ?, link_published_at = ?, link_md = ?,
        link_meta = ?, link_fetched_at = ? WHERE id = ?`)
      .run(art.title, art.site, art.author, art.published_at, art.md, JSON.stringify(meta), t, it.id);
  });
}
