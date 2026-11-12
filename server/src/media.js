// Keep images: local copies of the pictures in saved posts, because X image links can stop working.
//
// 1. Queue: when a post or article is fetched (fetcher.js) or a thread is saved (thread.js), every photo,
//    every video's thumbnail (kind 'poster') and every article image becomes a `media` row (pending).
//    Only https://pbs.twimg.com/ addresses are queued. Videos themselves are never copied (too large).
// 2. Download: a small worker of its own fetches one pending row at a time, only from pbs.twimg.com,
//    and only while no post fetch is due, so it never holds up saving posts. The type comes from the
//    file's first bytes (never from the server's Content-Type), and the file is named by its SHA-256,
//    so the same picture is stored once however many posts use it.
// 3. Serve: GET /media/<sha256>.<ext> (server.js) to a signed-in browser or a read-scoped key.
//
// Which rows get downloaded: rows are queued for every fetched post, context rows (saved = 0) included,
// because a queued row costs one small database row. Only rows whose post is saved are downloaded. A
// context row the owner saves later has its images ready to go, and housekeeping deleting an unused
// context row deletes its rows with it (ON DELETE CASCADE).
//
// Everything read from FxTwitter or pbs.twimg.com is hostile third-party data: addresses are checked
// and capped here, file names are only ever our own hex hash, and nothing is trusted from the response.
import { createHash, randomBytes } from 'node:crypto';
import { open, rename, unlink, utimes } from 'node:fs/promises';
import { existsSync, mkdirSync, opendirSync, lstatSync, unlinkSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { now, tx } from './db.js';

export const MEDIA_HOST = 'pbs.twimg.com';
export const MAX_BYTES = 10 * 1024 * 1024;     // one image; a bigger one is cancelled mid-download
export const MAX_PER_ITEM = 40;                // an X post has at most 4 photos; long articles have more
export const MAX_URL = 2048;
export const MAX_REDIRECTS = 3;
export const TIMEOUT_MS = 15_000;
// waits before retry 1, 2 and 3; the fourth failure in a row ends the row as 'failed'
export const MEDIA_BACKOFF = [60, 600, 3600];
export const FILE_RE = /^[0-9a-f]{64}\.(jpg|png|gif|webp)$/;
export const EXT_MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const MIME_EXT = Object.fromEntries(Object.entries(EXT_MIME).map(([e, m]) => [m, e]));
const TMP_RE = /^\.tmp-[0-9a-f]{16}$/;
const UA = 'TweetVault/1.0 (+https://vault.example.com; personal archive)';

// Where the files live: next to a file database (/data/vault.db -> /data/media). An in-memory database
// has no folder, so media is off unless a folder is given (rows then simply stay pending).
export function mediaDirFor(dbPath, explicit) {
  if (explicit) return explicit;
  if (!dbPath || dbPath === ':memory:') return null;
  return join(dirname(dbPath), 'media');
}

// ---------- 1. what to queue ----------

// A pbs.twimg.com address we are willing to fetch, or null. Photos (/media/...) with no query at all get
// ?name=orig, which asks X for the full-size original instead of a resized copy. An address that already
// says which size or format it wants (?format=jpg&name=small, ?name=orig) is left exactly as it is.
export function normaliseMediaUrl(raw, kind = 'image') {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== MEDIA_HOST || u.port || u.username || u.password) return null;
  u.hash = '';
  if (kind === 'image' && u.pathname.startsWith('/media/') && !u.search) u.search = '?name=orig';
  return u.href;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);

// One FxTwitter post object (v1 `tweet` or v2 `status` / thread part) -> [{url, kind}], photos first,
// then video thumbnails, then article images, without repeats. The post's own media only: a quoted
// post's pictures belong to someone else's post, which can be saved on its own.
export function mediaFromPost(post) {
  if (!isObj(post)) return [];
  const found = [];
  const add = (url, kind) => found.push([url, kind]);
  const m = isObj(post.media) ? post.media : {};
  for (const p of arr(m.photos)) if (isObj(p)) add(p.url, 'image');
  for (const v of arr(m.videos)) if (isObj(v)) add(v.thumbnail_url, 'poster');
  // v2 lists everything in media.all, typed (it may come with or without photos / videos)
  for (const x of arr(m.all)) {
    if (!isObj(x)) continue;
    if (x.type === 'photo') add(x.url, 'image');
    else if (x.type === 'video' || x.type === 'gif') add(x.thumbnail_url, 'poster');
  }
  // X Articles: the cover and the pictures inside the text (Draft.js media entities, see draftjs.js)
  const a = isObj(post.article) ? post.article : null;
  if (a) {
    const info = (e) => (isObj(e) && isObj(e.media_info) ? e.media_info : {});
    if (a.cover_media) add(info(a.cover_media).original_img_url, 'image');
    for (const e of arr(a.media_entities)) add(info(e).original_img_url || info(e).url, 'image');
  }
  const seen = new Set();
  const out = [];
  for (const [raw, kind] of found) {
    const url = normaliseMediaUrl(raw, kind);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, kind });
    if (out.length >= MAX_PER_ITEM) break;
  }
  return out;
}

// INSERT OR IGNORE: a post fetched again (refetch, a later thread save) never makes duplicates. Plain
// statements, so it is safe inside a transaction that is already open (thread.js saveThread).
export function queueMedia(db, itemId, list, t = now()) {
  const ins = db.prepare('INSERT OR IGNORE INTO media (item_id, source_url, kind, created_at) VALUES (?, ?, ?, ?)');
  let n = 0;
  for (const { url, kind } of list.slice(0, MAX_PER_ITEM)) n += Number(ins.run(itemId, url, kind, t).changes);
  return n;
}

export const queueMediaForPost = (db, itemId, post, t = now()) => queueMedia(db, itemId, mediaFromPost(post), t);

// The raw FxTwitter body of a single-post fetch (v1 {tweet}, or v2 {status}) -> queued count.
export function queueMediaFromFx(db, itemId, bodyText, t = now()) {
  let j = null;
  try { j = JSON.parse(bodyText); } catch { return 0; }
  if (!isObj(j)) return 0;
  return queueMediaForPost(db, itemId, isObj(j.tweet) ? j.tweet : j.status, t);
}

// ---------- 2. the downloader ----------

// The file type from its first bytes. Anything that is not one of these four is refused, whatever
// Content-Type the server claimed (an HTML page sent as image/jpeg is still HTML).
export function sniffImage(b) {
  if (!b || b.length < 3) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  const ascii = (from, to) => b.subarray(from, to).toString('latin1');
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return { ext: 'gif', mime: 'image/gif' };
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

// A failure that will not get better by trying again (404, not an image, too large, a refused address)
class Permanent extends Error {}

const cancelBody = async (res) => { try { await res.body?.cancel?.(); } catch { /* already closed */ } };

export function createMediaWorker(db, { mediaDir = null, fetchFn = globalThis.fetch, paceMs = 1000, log = () => {},
  nowFn = now, maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  let lastNet = 0;
  let wakeUp = null;
  let stopped = true;
  let dirReady = false;

  function ensureDir() {
    if (!dirReady) { mkdirSync(mediaDir, { recursive: true }); dirReady = true; }
  }

  // post fetches and thread jobs come first: while one is due, the downloader waits
  function itemWorkDue() {
    const t = nowFn();
    return !!(db.prepare(`SELECT 1 FROM items WHERE fetch_status = 'pending' AND (next_fetch_at IS NULL OR next_fetch_at <= ?) LIMIT 1`).get(t)
      || db.prepare(`SELECT 1 FROM items WHERE thread_status = 'queued' AND (thread_at IS NULL OR thread_at <= ?) LIMIT 1`).get(t));
  }

  function nextDue() {
    return db.prepare(`SELECT m.* FROM media m JOIN items i ON i.id = m.item_id
        WHERE m.status = 'pending' AND (m.next_at IS NULL OR m.next_at <= ?) AND i.saved = 1
        ORDER BY COALESCE(m.next_at, 0), m.id LIMIT 1`).get(nowFn());
  }

  // HTTPS to pbs.twimg.com only. Thrown as Permanent: a refused address stays refused.
  function checkUrl(raw) {
    let u;
    try { u = new URL(raw); } catch { throw new Permanent('bad address'); }
    if (u.protocol !== 'https:') throw new Permanent(`refusing non-https ${u.protocol}`);
    if (u.hostname !== MEDIA_HOST || u.port || u.username || u.password) throw new Permanent(`refusing to fetch ${u.hostname}`);
    return u.href;
  }

  async function pace() {
    const wait = lastNet + paceMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNet = Date.now();
  }

  // Redirects are followed by hand, and every hop is checked against the allow-list again.
  async function download(url) {
    let cur = checkUrl(url);
    for (let hop = 0; ; hop++) {
      await pace();
      // our own timer covers the whole download, body included, and works with any response stream
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetchFn(cur, {
          headers: { 'User-Agent': UA, Accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1' },
          redirect: 'manual',
          signal: ac.signal,
        });
        const status = Number(res.status);
        if (status >= 300 && status < 400) {
          await cancelBody(res);
          const loc = res.headers && res.headers.get && res.headers.get('location');
          if (!loc) throw new Permanent('a redirect without a target');
          if (hop >= MAX_REDIRECTS) throw new Permanent('too many redirects');
          let next;
          try { next = new URL(loc, cur).href; } catch { throw new Permanent('bad redirect'); }
          cur = checkUrl(next);
          continue;
        }
        if (status === 404 || status === 410) { await cancelBody(res); throw new Permanent(`gone (${status})`); }
        if (status !== 200) { await cancelBody(res); throw new Error(`${MEDIA_HOST} answered ${status}`); }
        const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
        if (len > maxBytes) { await cancelBody(res); throw new Permanent('too large'); }
        return await saveBody(res, ac.signal);
      } catch (e) {
        if (ac.signal.aborted && !(e instanceof Permanent)) throw new Error('timed out');
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  // Stream to a temp file while hashing; check the first bytes as soon as there are enough; cancel past
  // the cap. Then rename to <sha256>.<ext>, unless that file is already there (the same picture again).
  async function saveBody(res, signal) {
    const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
    if (!reader) throw new Error('empty answer');
    const stop = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    ensureDir();
    const tmp = join(mediaDir, `.tmp-${randomBytes(8).toString('hex')}`);
    const fh = await open(tmp, 'wx');
    let closed = false;
    try {
      const hash = createHash('sha256');
      let size = 0;
      let head = Buffer.alloc(0);
      let type = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw new Error('timed out');
        if (done) break;
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        size += chunk.length;
        if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new Permanent('too large'); }
        if (!type && head.length < 12) {
          head = Buffer.concat([head, chunk.subarray(0, 12 - head.length)]);
          if (head.length >= 12) {
            type = sniffImage(head);
            if (!type) { await reader.cancel().catch(() => {}); throw new Permanent('not an image'); }
          }
        }
        hash.update(chunk);
        await fh.write(chunk);
      }
      if (signal.aborted) throw new Error('timed out');
      // a tiny file (under 12 bytes) still gets its check
      if (!type) type = sniffImage(head);
      if (!type) throw new Permanent('not an image');
      await fh.close();
      closed = true;
      const sha = hash.digest('hex');
      const final = join(mediaDir, `${sha}.${type.ext}`);
      if (existsSync(final)) {
        // The same picture is already here, perhaps as an old orphan. Mark it as just written first, so the
        // housekeeping grace period covers it until markOk points a row at it. Gone meanwhile: keep ours.
        const d = new Date();
        try { await utimes(final, d, d); await unlink(tmp); } catch { await rename(tmp, final); }
      } else await rename(tmp, final);
      return { sha, mime: type.mime, bytes: size };
    } catch (e) {
      if (!closed) await fh.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      throw e;
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }

  function markOk(row, r) {
    db.prepare(`UPDATE media SET status = 'ok', sha256 = ?, mime = ?, bytes = ?, fetched_at = ?, error = NULL, next_at = NULL,
        attempts = attempts + 1 WHERE id = ?`).run(r.sha, r.mime, r.bytes, nowFn(), row.id);
  }

  function markFailed(row, msg) {
    db.prepare("UPDATE media SET status = 'failed', attempts = attempts + 1, next_at = NULL, error = ? WHERE id = ?")
      .run(String(msg).slice(0, 200), row.id);
  }

  function retryOrFail(row, msg) {
    const attempts = (row.attempts || 0) + 1;
    if (attempts > MEDIA_BACKOFF.length) return markFailed(row, msg);
    db.prepare('UPDATE media SET attempts = ?, next_at = ?, error = ? WHERE id = ?')
      .run(attempts, nowFn() + MEDIA_BACKOFF[attempts - 1], String(msg).slice(0, 200), row.id);
  }

  async function processRow(row) {
    // the same address already saved for another post: reuse that file, no second download
    const same = db.prepare(`SELECT sha256, mime, bytes FROM media WHERE source_url = ? AND status = 'ok' AND sha256 IS NOT NULL
        AND id != ? LIMIT 1`).get(row.source_url, row.id);
    if (same && MIME_EXT[same.mime] && existsSync(join(mediaDir, `${same.sha256}.${MIME_EXT[same.mime]}`))) {
      markOk(row, { sha: same.sha256, mime: same.mime, bytes: same.bytes });
      return;
    }
    try {
      markOk(row, await download(row.source_url));
    } catch (e) {
      const msg = (e && e.message) || String(e);
      log(`media ${row.id}: ${msg}`);
      if (e instanceof Permanent) markFailed(row, msg);
      else retryOrFail(row, msg);
    }
  }

  // One pending image, if one is due and no post fetch is waiting. true when it did something.
  async function runOnce({ yieldToItems = true } = {}) {
    if (!mediaDir) return false;
    if (yieldToItems && itemWorkDue()) return false;
    const row = nextDue();
    if (!row) return false;
    await processRow(row);
    return true;
  }

  async function drain(limit = 1000, opts) {
    let n = 0;
    while (n < limit && await runOnce(opts)) n++;
    return n;
  }

  function sleepMs() {
    if (itemWorkDue()) return 2000;   // look again soon, once the post fetches are done
    const nxt = db.prepare(`SELECT MIN(m.next_at) AS m FROM media m JOIN items i ON i.id = m.item_id
        WHERE m.status = 'pending' AND m.next_at IS NOT NULL AND i.saved = 1`).get().m;
    return nxt ? Math.min(60_000, Math.max(500, (nxt - nowFn()) * 1000)) : 60_000;
  }

  async function loop() {
    while (!stopped) {
      let did = false;
      try { did = await runOnce(); } catch (e) { log(`media worker: ${e.message}`); }
      if (did) continue;
      let ms = 60_000;
      try { ms = sleepMs(); } catch (e) { log(`media worker: ${e.message}`); }
      await new Promise((r) => {
        const t = setTimeout(r, ms);
        wakeUp = () => { clearTimeout(t); r(); };
      });
      wakeUp = null;
    }
  }

  return {
    enabled: !!mediaDir,
    start() {
      if (!mediaDir || !stopped) return;
      stopped = false;
      loop().catch((e) => log(`media worker stopped: ${e && e.message}`));
    },
    stop() { stopped = true; if (wakeUp) wakeUp(); },
    wake() { if (wakeUp) wakeUp(); },
    runOnce,
    drain,
  };
}

// ---------- 3. reading and serving ----------

const urlFor = (r) => (r.status === 'ok' && r.sha256 && MIME_EXT[r.mime] ? `/media/${r.sha256}.${MIME_EXT[r.mime]}` : null);
const CHUNK = 500;   // ids per IN (...) query, well under SQLite's parameter limit

// item id -> [{url, original, kind}] for a list of items, in a few queries (never one per item).
// url is the vault's own copy once it is saved, null until then (or when it could not be saved).
export function imagesByItem(db, ids) {
  const out = new Map();
  const list = [...new Set(ids.filter((x) => Number.isInteger(x)))];
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    const rows = db.prepare(`SELECT item_id, source_url, kind, status, sha256, mime FROM media
        WHERE item_id IN (${part.map(() => '?').join(',')}) ORDER BY item_id, id`).all(...part);
    for (const r of rows) {
      if (!out.has(r.item_id)) out.set(r.item_id, []);
      out.get(r.item_id).push({ url: urlFor(r), original: r.source_url, kind: r.kind });
    }
  }
  return out;
}

// Give each item DTO its `images` (see tree.js itemDto). Mutates and returns the list.
export function attachImages(db, dtos) {
  const list = dtos.filter(Boolean);
  if (!list.length) return dtos;
  const map = imagesByItem(db, list.map((d) => d.id));
  for (const d of list) d.images = map.get(d.id) || [];
  return dtos;
}

// The saved file behind /media/<name>, or null. The name must be our own <sha256>.<ext> and a media row
// must say it was saved with that type, so nothing else in the folder (or outside it) can be reached.
export function mediaFile(db, mediaDir, name) {
  if (!mediaDir || typeof name !== 'string' || !FILE_RE.test(name)) return null;
  const [sha, ext] = name.split('.');
  const mime = EXT_MIME[ext];
  if (!db.prepare("SELECT 1 FROM media WHERE sha256 = ? AND mime = ? AND status = 'ok' LIMIT 1").get(sha, mime)) return null;
  const path = join(mediaDir, name);
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    return { path, mime, size: st.size };
  } catch { return null; }
}

// Saved images of one item for MCP get_item: at most `max`, each under `maxBytes`, as
// { type: 'image', data: <base64>, mimeType }. A picture used twice in a post is sent once.
export function mcpImages(db, mediaDir, itemId, { max = 4, maxBytes = 1024 * 1024 } = {}) {
  if (!mediaDir) return [];
  const rows = db.prepare(`SELECT sha256, mime, bytes FROM media WHERE item_id = ? AND status = 'ok' AND sha256 IS NOT NULL
      ORDER BY id`).all(itemId);
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (out.length >= max) break;
    if (seen.has(r.sha256) || !MIME_EXT[r.mime] || !(r.bytes > 0) || r.bytes > maxBytes) continue;
    seen.add(r.sha256);
    const f = mediaFile(db, mediaDir, `${r.sha256}.${MIME_EXT[r.mime]}`);
    if (!f || f.size > maxBytes) continue;
    try { out.push({ type: 'image', data: readFileSync(f.path).toString('base64'), mimeType: f.mime }); } catch { /* gone meanwhile */ }
  }
  return out;
}

// ---------- housekeeping and the one-off backfill ----------

// Delete files in mediaDir that no media row points at any more (their posts were deleted). Only our
// own <sha256>.<ext> files and our own leftover temp files, only directly inside mediaDir, and only
// ones older than graceMs: the downloader renames a file a moment before it marks its row saved.
// The folder is read one entry at a time (opendir), so memory stays flat however many pictures there are.
export function cleanMediaFiles(db, mediaDir, { graceMs = 3600_000, nowMs = Date.now() } = {}) {
  if (!mediaDir) return 0;
  let dir;
  try { dir = opendirSync(mediaDir); } catch { return 0; }
  const used = db.prepare('SELECT 1 FROM media WHERE sha256 = ? LIMIT 1');
  let n = 0;
  try {
    for (let d; (d = dir.readSync()) !== null;) if (cleanOne(d)) n++;
  } catch { /* the folder went away mid-read: what was deleted so far still counts */ } finally {
    try { dir.closeSync(); } catch { /* already closed */ }
  }
  return n;

  function cleanOne(d) {
    if (!d.isFile()) return false;
    const isMedia = FILE_RE.test(d.name);
    if (!isMedia && !TMP_RE.test(d.name)) return false;
    if (isMedia && used.get(d.name.slice(0, 64))) return false;
    const p = join(mediaDir, d.name);
    try {
      const st = lstatSync(p);
      if (!st.isFile() || nowMs - st.mtimeMs < graceMs) return false;
      unlinkSync(p);
      return true;
    } catch { return false; /* gone already */ }
  }
}

// Saved rows whose file is no longer in mediaDir (restored without the images, or the file was lost) go
// back to pending, so the worker downloads them again. Only ids are kept in memory; each file is checked once.
export function repairMissingMedia(db, mediaDir) {
  const items = new Set();
  if (!mediaDir) return { items, images: 0 };
  const seen = new Map();   // file name -> there
  const missing = [];
  for (const r of db.prepare("SELECT id, item_id, sha256, mime FROM media WHERE status = 'ok'").iterate()) {
    const name = r.sha256 && MIME_EXT[r.mime] ? `${r.sha256}.${MIME_EXT[r.mime]}` : null;
    if (name && FILE_RE.test(name) && !seen.has(name)) {
      let there = false;
      try { there = lstatSync(join(mediaDir, name)).isFile(); } catch { /* missing */ }
      seen.set(name, there);
    }
    if (!(name && seen.get(name))) { missing.push(r.id); items.add(r.item_id); }
  }
  if (missing.length) {
    const up = db.prepare(`UPDATE media SET status = 'pending', attempts = 0, sha256 = NULL, mime = NULL, bytes = NULL,
        fetched_at = NULL, next_at = NULL, error = NULL WHERE id = ? AND status = 'ok'`);
    tx(db, () => { for (const id of missing) up.run(id); });
  }
  return { items, images: missing.length };
}

// The folder beside a file database, as server.js uses (cli.js calls backfillMedia(db) with no options).
// An in-memory database has none.
function defaultMediaDir(db) {
  try {
    const main = db.prepare('PRAGMA database_list').all().find((r) => r.name === 'main');
    return main && main.file ? mediaDirFor(main.file) : null;
  } catch { return null; }
}

// For posts saved before images were kept: queue media for every saved post or article that has a raw
// FxTwitter answer and no media rows yet. Thread parts have no answer of their own, so the saved thread
// answers (fxthread) are read too. Bodies are read one at a time (the container has 128 MB).
// First it repairs saved rows whose file is missing (repairMissingMedia), so pictures lost in a restore
// are downloaded again. backfillMedia(db, t, { mediaDir }): without the option the folder beside a file
// database is used; mediaDir: null skips the repair.
export function backfillMedia(db, t = now(), { mediaDir } = {}) {
  const fixed = repairMissingMedia(db, mediaDir === undefined ? defaultMediaDir(db) : mediaDir);
  const todo = new Set(db.prepare(`SELECT id FROM items WHERE saved = 1 AND kind IN ('tweet', 'article')
      AND NOT EXISTS (SELECT 1 FROM media m WHERE m.item_id = items.id)`).all().map((r) => r.id));
  const touched = new Set(fixed.items);
  let images = fixed.images;
  const body = db.prepare('SELECT body FROM raw_fetches WHERE item_id = ? AND source = ?');
  const note = (id, n) => { if (n) { images += n; touched.add(id); } };
  for (const id of todo) {
    const r = body.get(id, 'fxtwitter');
    if (r && r.body) note(id, tx(db, () => queueMediaFromFx(db, id, r.body, t)));
  }
  const byTid = db.prepare('SELECT id FROM items WHERE tweet_id = ?');
  for (const { item_id: jobId } of db.prepare("SELECT item_id FROM raw_fetches WHERE source = 'fxthread'").all()) {
    const r = body.get(jobId, 'fxthread');
    let j = null;
    try { j = JSON.parse(r && r.body); } catch { continue; }
    if (!isObj(j)) continue;
    const posts = [...arr(j.thread), j.status].filter((p) => isObj(p) && /^\d{1,25}$/.test(String(p.id || '')));
    tx(db, () => {
      for (const p of posts) {
        const it = byTid.get(String(p.id));
        if (it && todo.has(it.id)) note(it.id, queueMediaForPost(db, it.id, p, t));
      }
    });
  }
  return { items: touched.size, images };
}
