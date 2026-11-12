// Keep images (pass 1, feature 3.1): queueing from FxTwitter answers, the pbs.twimg.com-only downloader,
// the /media route, images on item DTOs, MCP image content, housekeeping and the backfill command.
// Every download goes through a fake fetchFn and saved fixtures; nothing touches the network.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { openDb, now } from '../src/db.js';
import { createFetcher } from '../src/fetcher.js';
import { buildInbox, itemDto } from '../src/tree.js';
import { renderItems } from '../src/render.js';
import { housekeeping } from '../src/audit.js';
import { main } from '../src/cli.js';
import { createApp } from '../src/server.js';
import * as A from '../src/auth.js';
import { totp, base32Decode } from '../src/totp.js';
import {
  mediaFromPost, normaliseMediaUrl, queueMedia, queueMediaFromFx, sniffImage, createMediaWorker, imagesByItem,
  attachImages, mediaFile, mcpImages, cleanMediaFiles, backfillMedia, mediaDirFor, MAX_BYTES, MEDIA_BACKOFF, MAX_PER_ITEM,
} from '../src/media.js';

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const V1 = fixture('media-v1.json');
const V2T = fixture('media-v2thread.json');
const ART = fixture('media-article.json');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = () => mkdtempSync(join(tmpdir(), 'tv-media-'));
const dirs = [];
const newDir = () => { const d = tmp(); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// ---------- image bytes ----------
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(3000)]);
const JPEG2 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), randomBytes(2500)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(2000)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), randomBytes(500)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP'), randomBytes(800)]);
const HTML = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');

// ---------- fake network ----------
// a response whose body arrives in chunks; tracks how far it was read and whether it was cancelled
function streamed(chunks, { status = 200, headers = {}, forever = false, hang = false } = {}) {
  const st = { pulled: 0, cancelled: false };
  let i = 0;
  const body = new ReadableStream({
    pull(c) {
      if (hang) return new Promise(() => {});
      if (forever) { c.enqueue(new Uint8Array(4096)); st.pulled++; return undefined; }
      if (i < chunks.length) { c.enqueue(new Uint8Array(chunks[i++])); st.pulled++; } else c.close();
      return undefined;
    },
    cancel() { st.cancelled = true; },
  });
  const res = new Response(body, { status, headers });
  res.st = st;
  return res;
}
const img = (buf, headers = { 'content-type': 'image/jpeg' }) => streamed([buf.subarray(0, 7), buf.subarray(7, 1000), buf.subarray(1000)], { headers });
const redirect = (to, status = 302) => new Response(null, { status, headers: { location: to } });

// fetchFn from a function url -> Response (or throws); records every call
function fakeNet(answer) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url: String(url), init }); return answer(String(url), init, calls.length); };
  fn.calls = calls;
  return fn;
}

// ---------- database helpers ----------
let seq = 0;
function insertItem(db, f = {}) {
  const t = now();
  const row = { kind: 'tweet', tweet_id: String(1800000000000000000n + BigInt(++seq)), fetch_status: 'ok', saved: 1, state: 'inbox', first_saved_at: t, last_saved_at: t, text: 'a post', ...f };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c])).lastInsertRowid);
}
const rows = (db, itemId) => db.prepare('SELECT * FROM media WHERE item_id = ? ORDER BY id').all(itemId);
const urls = (db, itemId) => rows(db, itemId).map((r) => [r.source_url, r.kind]);
// a saved image as the downloader leaves it: the file and an ok row
function savedImage(db, dir, itemId, buf, { url = `https://pbs.twimg.com/media/${randomBytes(6).toString('hex')}.jpg`, kind = 'image' } = {}) {
  const t = sniffImage(buf);
  const h = sha(buf);
  writeFileSync(join(dir, `${h}.${t.ext}`), buf);
  db.prepare(`INSERT INTO media (item_id, source_url, kind, status, sha256, mime, bytes, created_at, fetched_at)
      VALUES (?, ?, ?, 'ok', ?, ?, ?, ?, ?)`).run(itemId, url, kind, h, t.mime, buf.length, now(), now());
  return { name: `${h}.${t.ext}`, sha: h, ...t };
}

function worker(db, fetchFn, opts = {}) {
  const clock = { t: 1_000_000 };
  const w = createMediaWorker(db, { mediaDir: opts.mediaDir === undefined ? newDir() : opts.mediaDir, fetchFn, paceMs: 0, nowFn: () => clock.t, ...opts });
  w.clock = clock;
  return w;
}

// ======================================================================
describe('what gets queued', () => {
  test('v1 post: photos (full size when the address names none), the video thumbnail; nothing off pbs.twimg.com', () => {
    const list = mediaFromPost(JSON.parse(V1).tweet);
    assert.deepEqual(list, [
      { url: 'https://pbs.twimg.com/media/AAAphoto1.jpg?name=orig', kind: 'image' },
      { url: 'https://pbs.twimg.com/media/AAAphoto2.png?format=png&name=small', kind: 'image' },
      { url: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/thumb1.jpg', kind: 'poster' },
    ]);
    // the quoted post's picture belongs to the other post
    assert.ok(!list.some((m) => m.url.includes('QUOTED')));
  });

  test('v2 thread parts: media.all photos and gif/video thumbnails, repeats in all + videos counted once', () => {
    const t = JSON.parse(V2T).thread;
    assert.deepEqual(mediaFromPost(t[0]), [
      { url: 'https://pbs.twimg.com/media/THphotoA.jpg?name=orig', kind: 'image' },
      { url: 'https://pbs.twimg.com/tweet_video_thumb/gifthumb.jpg', kind: 'poster' },
    ]);
    assert.deepEqual(mediaFromPost(t[1]), [{ url: 'https://pbs.twimg.com/amplify_video_thumb/3/img/vthumb.jpg', kind: 'poster' }]);
    assert.deepEqual(mediaFromPost(t[2]), [{ url: 'https://pbs.twimg.com/media/THphotoC.png?name=orig', kind: 'image' }]);
  });

  test('article: the cover and the media entities, but only pbs.twimg.com ones', () => {
    assert.deepEqual(mediaFromPost(JSON.parse(ART).tweet), [
      { url: 'https://pbs.twimg.com/media/ARTcover.jpg?name=orig', kind: 'image' },
      { url: 'https://pbs.twimg.com/media/ARTbody1.png?name=orig', kind: 'image' },
    ]);
  });

  test('address checks: https, exactly pbs.twimg.com, no port, no user, capped length; only photos get name=orig', () => {
    assert.equal(normaliseMediaUrl('https://pbs.twimg.com/media/A.jpg'), 'https://pbs.twimg.com/media/A.jpg?name=orig');
    assert.equal(normaliseMediaUrl('https://pbs.twimg.com/media/A.jpg', 'poster'), 'https://pbs.twimg.com/media/A.jpg');
    assert.equal(normaliseMediaUrl('https://pbs.twimg.com/media/A.jpg?name=small'), 'https://pbs.twimg.com/media/A.jpg?name=small');
    assert.equal(normaliseMediaUrl('https://pbs.twimg.com/media/A.jpg#frag'), 'https://pbs.twimg.com/media/A.jpg?name=orig');
    assert.equal(normaliseMediaUrl('https://PBS.TWIMG.COM/media/A.jpg?x=1'), 'https://pbs.twimg.com/media/A.jpg?x=1');
    for (const bad of ['http://pbs.twimg.com/media/A.jpg', 'https://pbs.twimg.com.evil.example/a.jpg', 'https://evilpbs.twimg.com/a.jpg',
      'https://x.pbs.twimg.com/a.jpg', 'https://pbs.twimg.com:444/a.jpg', 'https://u:p@pbs.twimg.com/a.jpg', 'https://u@pbs.twimg.com/a.jpg',
      'file:///etc/passwd', 'data:image/png;base64,AAAA', '//pbs.twimg.com/a.jpg', '', null, 42, {},
      `https://pbs.twimg.com/media/${'a'.repeat(2100)}.jpg`]) {
      assert.equal(normaliseMediaUrl(bad), null, String(bad).slice(0, 60));
    }
    // hostile shapes never throw
    for (const p of [null, 'x', [], { media: 'x' }, { media: { photos: 'x', all: [null, 1, { type: 'photo', url: 5 }] } }, { article: { media_entities: [null, { media_info: 'x' }] } }]) {
      assert.deepEqual(mediaFromPost(p), []);
    }
  });

  test('at most MAX_PER_ITEM per post', () => {
    const photos = Array.from({ length: MAX_PER_ITEM + 10 }, (_, i) => ({ url: `https://pbs.twimg.com/media/P${i}.jpg` }));
    assert.equal(mediaFromPost({ media: { photos } }).length, MAX_PER_ITEM);
  });

  test('a post fetch queues its pictures after saving, a refetch adds no duplicates, and the worker is woken', async () => {
    const db = openDb(':memory:');
    let woken = 0;
    const fetchFn = fakeNet((u) => (u.startsWith('https://api.fxtwitter.com/') ? new Response(u.includes('1920000000000000001') ? ART : V1, { status: 200 }) : new Response('', { status: 404 })));
    const f = createFetcher(db, { fetchFn, paceMs: 0, onMedia: () => { woken++; } });
    const id = insertItem(db, { tweet_id: '1900000000000000001', author_handle: 'pic_author', fetch_status: 'pending' });
    await f.drain();
    assert.equal(db.prepare('SELECT fetch_status FROM items WHERE id = ?').get(id).fetch_status, 'ok');
    assert.equal(rows(db, id).length, 3);
    assert.ok(rows(db, id).every((r) => r.status === 'pending' && r.attempts === 0));
    assert.equal(woken, 1);
    // fetched again: still three
    db.prepare("UPDATE items SET fetch_status = 'pending' WHERE id = ?").run(id);
    await f.drain();
    assert.equal(rows(db, id).length, 3);
    // an article fetch
    const aid = insertItem(db, { tweet_id: '1920000000000000001', author_handle: 'writer', fetch_status: 'pending' });
    await f.drain();
    assert.deepEqual(urls(db, aid), [['https://pbs.twimg.com/media/ARTcover.jpg?name=orig', 'image'], ['https://pbs.twimg.com/media/ARTbody1.png?name=orig', 'image']]);
    // no request ever went to pbs.twimg.com from the post fetcher
    assert.ok(fetchFn.calls.every((c) => new URL(c.url).hostname === 'api.fxtwitter.com'));
  });

  test('context rows are queued too (cheap), but only saved posts are downloaded', async () => {
    const db = openDb(':memory:');
    const fetchFn = fakeNet(() => new Response(V1, { status: 200 }));
    const f = createFetcher(db, { fetchFn, paceMs: 0 });
    const id = insertItem(db, { tweet_id: '1900000000000000001', author_handle: 'pic_author', fetch_status: 'pending', saved: 0 });
    await f.drain();
    assert.equal(rows(db, id).length, 3);
    const net2 = fakeNet(() => img(JPEG));
    const w = worker(db, net2);
    assert.equal(await w.runOnce(), false);
    assert.equal(net2.calls.length, 0);
    db.prepare('UPDATE items SET saved = 1 WHERE id = ?').run(id);
    assert.equal(await w.drain(), 3);
    assert.ok(rows(db, id).every((r) => r.status === 'ok'));
  });

  test('a saved thread queues each part its own pictures (not other authors\')', async () => {
    const db = openDb(':memory:');
    const fetchFn = fakeNet((u) => (u.includes('/2/thread/') ? new Response(V2T, { status: 200 }) : new Response('', { status: 404 })));
    let woken = 0;
    const f = createFetcher(db, { fetchFn, paceMs: 0, onMedia: () => { woken++; } });
    const job = insertItem(db, { tweet_id: '1910000000000000001', author_handle: 'thread_author', thread_status: 'queued' });
    await f.drain();
    assert.equal(db.prepare('SELECT thread_status FROM items WHERE id = ?').get(job).thread_status, 'done');
    const part = (tid) => db.prepare('SELECT id FROM items WHERE tweet_id = ?').get(tid);
    assert.deepEqual(urls(db, job), [['https://pbs.twimg.com/media/THphotoA.jpg?name=orig', 'image'], ['https://pbs.twimg.com/tweet_video_thumb/gifthumb.jpg', 'poster']]);
    assert.deepEqual(urls(db, part('1910000000000000002').id), [['https://pbs.twimg.com/amplify_video_thumb/3/img/vthumb.jpg', 'poster']]);
    assert.deepEqual(urls(db, part('1910000000000000003').id), [['https://pbs.twimg.com/media/THphotoC.png?name=orig', 'image']]);
    assert.equal(part('1910000000000000004'), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM media WHERE source_url LIKE '%OTHER%'").get().n, 0);
    assert.equal(woken, 1);
    // the same thread again: no duplicates
    db.prepare("UPDATE items SET thread_status = 'queued' WHERE id = ?").run(job);
    await f.drain();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media').get().n, 4);
  });

  test('queueMediaFromFx reads v1 {tweet} and v2 {status}, and ignores junk', () => {
    const db = openDb(':memory:');
    const a = insertItem(db);
    const b = insertItem(db);
    assert.equal(queueMediaFromFx(db, a, V1), 3);
    assert.equal(queueMediaFromFx(db, a, V1), 0);
    assert.equal(queueMediaFromFx(db, b, V2T), 2);
    for (const junk of ['', 'not json', 'null', '[]', '{"tweet":"x"}', '{"code":404}']) assert.equal(queueMediaFromFx(db, b, junk), 0);
  });
});

// ======================================================================
describe('the downloader', () => {
  test('saves a JPEG under its SHA-256 name, streamed, with the row filled in', async () => {
    const db = openDb(':memory:');
    const id = insertItem(db);
    queueMedia(db, id, [{ url: 'https://pbs.twimg.com/media/A.jpg?name=orig', kind: 'image' }]);
    const net1 = fakeNet(() => img(JPEG));
    const dir = join(newDir(), 'nested', 'media');   // made when missing
    const w = worker(db, net1, { mediaDir: dir });
    assert.equal(await w.runOnce(), true);
    const r = rows(db, id)[0];
    assert.equal(r.status, 'ok');
    assert.equal(r.sha256, sha(JPEG));
    assert.equal(r.mime, 'image/jpeg');
    assert.equal(r.bytes, JPEG.length);
    assert.equal(r.fetched_at, w.clock.t);
    assert.deepEqual(readdirSync(dir), [`${sha(JPEG)}.jpg`]);
    assert.ok(readFileSync(join(dir, `${sha(JPEG)}.jpg`)).equals(JPEG));
    // what was asked for: the queued address, manual redirects, a signal
    assert.equal(net1.calls[0].url, 'https://pbs.twimg.com/media/A.jpg?name=orig');
    assert.equal(net1.calls[0].init.redirect, 'manual');
    assert.ok(net1.calls[0].init.signal);
    assert.equal(await w.runOnce(), false);
  });

  test('PNG, GIF and WebP are told apart by their bytes, whatever the server says', async () => {
    const db = openDb(':memory:');
    const id = insertItem(db);
    const bodies = { 'p.png': PNG, 'g.gif': GIF, 'w.webp': WEBP };
    queueMedia(db, id, Object.keys(bodies).map((k) => ({ url: `https://pbs.twimg.com/media/${k}?x=1`, kind: 'image' })));
    const w = worker(db, fakeNet((u) => img(bodies[new URL(u).pathname.slice(7)], { 'content-type': 'text/html' })));
    assert.equal(await w.drain(), 3);
    assert.deepEqual(rows(db, id).map((r) => r.mime), ['image/png', 'image/gif', 'image/webp']);
    assert.equal(sniffImage(Buffer.from('GIF87a')).ext, 'gif');
    assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WAVE')), null);
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8])), null);
    assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null);
  });

  test('an HTML page sent as image/jpeg is refused as "not an image", and nothing is written', async () => {
    const db = openDb(':memory:');
    const id = insertItem(db);
    queueMedia(db, id, [{ url: 'https://pbs.twimg.com/media/fake.jpg', kind: 'image' }]);
    const dir = newDir();
    const res = img(Buffer.concat([HTML, randomBytes(5000)]));
    const w = worker(db, fakeNet(() => res), { mediaDir: dir });
    await w.runOnce();
    const r = rows(db, id)[0];
    assert.equal(r.status, 'failed');
    assert.equal(r.error, 'not an image');
    assert.equal(r.sha256, null);
    assert.deepEqual(readdirSync(dir), []);
    assert.ok(res.st.cancelled, 'the download was cancelled after the first bytes');
    // a tiny non-image too
    const id2 = insertItem(db);
    queueMedia(db, id2, [{ url: 'https://pbs.twimg.com/media/tiny.jpg', kind: 'image' }]);
    const w2 = worker(db, fakeNet(() => streamed([Buffer.from('hi')])), { mediaDir: dir });
    await w2.runOnce();
    assert.equal(rows(db, id2)[0].error, 'not an image');
    assert.deepEqual(readdirSync(dir), []);
  });

  test('other hosts are never fetched, and neither is plain http', async () => {
    const db = openDb(':memory:');
    const id = insertItem(db);
    // rows that could only exist if something wrote them by hand: the worker still checks
    for (const u of ['https://evil.example.com/a.jpg', 'http://pbs.twimg.com/media/a.jpg', 'https://169.254.169.254/latest/meta-data', 'not a url']) {
      db.prepare('INSERT INTO media (item_id, source_url, created_at) VALUES (?, ?, ?)').run(id, u, now());
    }
    const net1 = fakeNet(() => img(JPEG));
    const w = worker(db, net1);
    assert.equal(await w.drain(), 4);
    assert.equal(net1.calls.length, 0);
    assert.ok(rows(db, id).every((r) => r.status === 'failed'), JSON.stringify(rows(db, id)));
  });

  test('redirects: followed on pbs.twimg.com, refused anywhere else, at most 3', async () => {
    const db = openDb(':memory:');
    const a = insertItem(db);
    queueMedia(db, a, [{ url: 'https://pbs.twimg.com/media/moved.jpg', kind: 'image' }]);
    const net1 = fakeNet((u) => (u.endsWith('moved.jpg') ? redirect('/media/here.jpg', 301) : img(JPEG)));
    await worker(db, net1).runOnce();
    assert.equal(rows(db, a)[0].status, 'ok');
    assert.deepEqual(net1.calls.map((c) => c.url), ['https://pbs.twimg.com/media/moved.jpg', 'https://pbs.twimg.com/media/here.jpg']);

    for (const to of ['https://evil.example.com/x.jpg', 'http://pbs.twimg.com/media/x.jpg', 'https://127.0.0.1/x.jpg', 'file:///etc/passwd']) {
      const b = insertItem(db);
      queueMedia(db, b, [{ url: 'https://pbs.twimg.com/media/off.jpg', kind: 'image' }]);
      const net2 = fakeNet(() => redirect(to));
      await worker(db, net2).runOnce();
      assert.equal(net2.calls.length, 1, to);
      assert.equal(rows(db, b)[0].status, 'failed', to);
      assert.match(rows(db, b)[0].error, /refusing/, to);
    }

    const c = insertItem(db);
    queueMedia(db, c, [{ url: 'https://pbs.twimg.com/media/loop.jpg', kind: 'image' }]);
    const net3 = fakeNet((u, init, n) => redirect(`https://pbs.twimg.com/media/loop${n}.jpg`));
    await worker(db, net3).runOnce();
    assert.equal(net3.calls.length, 4);   // the first ask and 3 redirects
    assert.equal(rows(db, c)[0].status, 'failed');
    assert.equal(rows(db, c)[0].error, 'too many redirects');
  });

  test('size cap: a large Content-Length is refused unread; a stream past the cap is cancelled; no temp file is left', async () => {
    assert.equal(MAX_BYTES, 10 * 1024 * 1024);
    const db = openDb(':memory:');
    const dir = newDir();
    const a = insertItem(db);
    queueMedia(db, a, [{ url: 'https://pbs.twimg.com/media/big.jpg', kind: 'image' }]);
    const r1 = streamed([JPEG], { headers: { 'content-length': String(MAX_BYTES + 1) } });
    await worker(db, fakeNet(() => r1), { mediaDir: dir }).runOnce();
    assert.equal(rows(db, a)[0].status, 'failed');
    assert.equal(rows(db, a)[0].error, 'too large');
    assert.equal(r1.st.pulled <= 1, true);

    const b = insertItem(db);
    queueMedia(db, b, [{ url: 'https://pbs.twimg.com/media/endless.jpg', kind: 'image' }]);
    const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    let n = 0;
    const r2 = new Response(new ReadableStream({
      pull(c) { n++; c.enqueue(n === 1 ? new Uint8Array(head) : new Uint8Array(8192)); },
      cancel() { r2.cancelled = true; },
    }), { status: 200 });
    await worker(db, fakeNet(() => r2), { mediaDir: dir, maxBytes: 64 * 1024 }).runOnce();
    assert.equal(rows(db, b)[0].status, 'failed');
    assert.equal(rows(db, b)[0].error, 'too large');
    assert.ok(r2.cancelled);
    assert.ok(n < 20, `read ${n} chunks`);
    assert.deepEqual(readdirSync(dir), []);
  });

  test('the same picture is stored once (dedupe by hash), and a known address is not downloaded again', async () => {
    const db = openDb(':memory:');
    const dir = newDir();
    const a = insertItem(db);
    const b = insertItem(db);
    const c = insertItem(db);
    queueMedia(db, a, [{ url: 'https://pbs.twimg.com/media/one.jpg', kind: 'image' }]);
    queueMedia(db, b, [{ url: 'https://pbs.twimg.com/media/same-bytes-other-name.jpg', kind: 'image' }]);
    queueMedia(db, c, [{ url: 'https://pbs.twimg.com/media/one.jpg', kind: 'image' }]);
    const net1 = fakeNet(() => img(JPEG));
    assert.equal(await worker(db, net1, { mediaDir: dir }).drain(), 3);
    assert.equal(net1.calls.length, 2);   // c reused a's file
    assert.deepEqual(readdirSync(dir), [`${sha(JPEG)}.jpg`]);
    for (const id of [a, b, c]) assert.equal(rows(db, id)[0].sha256, sha(JPEG));
  });

  test('temporary failures retry 3 times with growing waits, then fail; 404 and 410 fail at once', async () => {
    const db = openDb(':memory:');
    const a = insertItem(db);
    queueMedia(db, a, [{ url: 'https://pbs.twimg.com/media/busy.jpg', kind: 'image' }]);
    let k = 0;
    const net1 = fakeNet(() => { k++; if (k === 2) throw new Error('socket hang up'); return new Response('busy', { status: 503 }); });
    const w = worker(db, net1);
    const start = w.clock.t;
    let waited = 0;
    for (let i = 0; i < MEDIA_BACKOFF.length; i++) {
      assert.equal(await w.runOnce(), true);
      const r = rows(db, a)[0];
      assert.equal(r.status, 'pending');
      assert.equal(r.attempts, i + 1);
      assert.equal(r.next_at, start + waited + MEDIA_BACKOFF[i]);
      assert.equal(await w.runOnce(), false, 'not due yet');
      w.clock.t += MEDIA_BACKOFF[i];
      waited += MEDIA_BACKOFF[i];
    }
    assert.equal(await w.runOnce(), true);
    const r = rows(db, a)[0];
    assert.equal(r.status, 'failed');
    assert.equal(r.attempts, 4);
    assert.match(r.error, /503/);
    assert.equal(net1.calls.length, 4);
    assert.deepEqual(MEDIA_BACKOFF, [60, 600, 3600]);

    for (const code of [404, 410]) {
      const b = insertItem(db);
      queueMedia(db, b, [{ url: `https://pbs.twimg.com/media/gone${code}.jpg`, kind: 'image' }]);
      const net2 = fakeNet(() => new Response('nope', { status: code }));
      await worker(db, net2).runOnce();
      assert.equal(rows(db, b)[0].status, 'failed');
      assert.equal(rows(db, b)[0].attempts, 1);
      assert.equal(rows(db, b)[0].error, `gone (${code})`);
    }
  });

  test('a download that stalls is cut off by the timeout and retried later; no temp file is left', async () => {
    const db = openDb(':memory:');
    const dir = newDir();
    const a = insertItem(db);
    queueMedia(db, a, [{ url: 'https://pbs.twimg.com/media/slow.jpg', kind: 'image' }]);
    const r1 = streamed([], { hang: true });
    await worker(db, fakeNet(() => r1), { mediaDir: dir, timeoutMs: 50 }).runOnce();
    const r = rows(db, a)[0];
    assert.equal(r.status, 'pending');
    assert.equal(r.attempts, 1);
    assert.equal(r.error, 'timed out');
    assert.deepEqual(readdirSync(dir), []);
    // and a fetch that never answers at all (it honours the signal, as real fetch does)
    const b = insertItem(db);
    queueMedia(db, b, [{ url: 'https://pbs.twimg.com/media/silent.jpg', kind: 'image' }]);
    const never = fakeNet((u, init) => new Promise((res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))));
    db.prepare('UPDATE media SET next_at = 9999999999 WHERE item_id = ?').run(a);
    await worker(db, never, { mediaDir: dir, timeoutMs: 50 }).runOnce();
    assert.equal(rows(db, b)[0].error, 'timed out');
    assert.equal(rows(db, b)[0].status, 'pending');
  });

  test('post fetches come first: while one is due the downloader waits', async () => {
    const db = openDb(':memory:');
    const a = insertItem(db);
    queueMedia(db, a, [{ url: 'https://pbs.twimg.com/media/later.jpg', kind: 'image' }]);
    const p = insertItem(db, { fetch_status: 'pending' });
    const net1 = fakeNet(() => img(JPEG));
    const w = worker(db, net1);
    assert.equal(await w.runOnce(), false);
    assert.equal(net1.calls.length, 0);
    db.prepare('UPDATE items SET next_fetch_at = ? WHERE id = ?').run(w.clock.t + 100, p);   // waiting out a retry: not due
    db.prepare("UPDATE items SET thread_status = 'queued' WHERE id = ?").run(a);
    assert.equal(await w.runOnce(), false, 'a due thread job comes first too');
    db.prepare('UPDATE items SET thread_status = NULL WHERE id = ?').run(a);
    assert.equal(await w.runOnce(), true);
    assert.equal(rows(db, a)[0].status, 'ok');
  });

  test('no media folder (an in-memory database): nothing is fetched, rows stay pending, nothing breaks', async () => {
    const db = openDb(':memory:');
    const a = insertItem(db);
    queueMedia(db, a, [{ url: 'https://pbs.twimg.com/media/x.jpg', kind: 'image' }]);
    const net1 = fakeNet(() => img(JPEG));
    const w = createMediaWorker(db, { mediaDir: null, fetchFn: net1, paceMs: 0 });
    assert.equal(w.enabled, false);
    assert.equal(await w.runOnce(), false);
    w.start(); w.wake(); w.stop();
    assert.equal(net1.calls.length, 0);
    assert.equal(rows(db, a)[0].status, 'pending');
    assert.equal(mediaDirFor(':memory:'), null);
    assert.equal(mediaDirFor('/data/vault.db'), join('/data', 'media'));
    assert.equal(mediaDirFor(':memory:', '/elsewhere'), '/elsewhere');
    assert.deepEqual(mcpImages(db, null, a), []);
    assert.equal(mediaFile(db, null, `${sha(JPEG)}.jpg`), null);
  });

  test('the merged text keeps the original [Image: …] lines after a copy is saved', async () => {
    const db = openDb(':memory:');
    const f = createFetcher(db, { fetchFn: fakeNet(() => new Response(V1, { status: 200 })), paceMs: 0 });
    const id = insertItem(db, { tweet_id: '1900000000000000001', author_handle: 'pic_author', fetch_status: 'pending' });
    await f.drain();
    await worker(db, fakeNet(() => img(JPEG))).drain();
    const it = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    const r = renderItems(db, [it], {});
    assert.match(r.text, /\[Image: https:\/\/pbs\.twimg\.com\/media\/AAAphoto1\.jpg\]/);
    assert.doesNotMatch(r.text, /\/media\/[0-9a-f]{64}/);
  });
});

// ======================================================================
describe('images on items', () => {
  test('itemDto has images: [] by default; attachImages fills url (saved) or null (not yet)', () => {
    const db = openDb(':memory:');
    const dir = newDir();
    const a = insertItem(db);
    const s = savedImage(db, dir, a, JPEG, { url: 'https://pbs.twimg.com/media/ok.jpg?name=orig' });
    queueMedia(db, a, [{ url: 'https://pbs.twimg.com/ext_tw_video_thumb/p.jpg', kind: 'poster' }]);
    const it = db.prepare('SELECT * FROM items WHERE id = ?').get(a);
    assert.deepEqual(itemDto(it).images, []);
    const [d] = attachImages(db, [itemDto(it)]);
    assert.deepEqual(d.images, [
      { url: `/media/${s.name}`, original: 'https://pbs.twimg.com/media/ok.jpg?name=orig', kind: 'image' },
      { url: null, original: 'https://pbs.twimg.com/ext_tw_video_thumb/p.jpg', kind: 'poster' },
    ]);
  });

  test('the Inbox reads images for the whole page in one query, not one per item', () => {
    const db = openDb(':memory:');
    const dir = newDir();
    const ids = [];
    for (let i = 0; i < 30; i++) {
      const id = insertItem(db);
      ids.push(id);
      savedImage(db, dir, id, Buffer.concat([JPEG, Buffer.from(String(i))]));
    }
    let mediaQueries = 0;
    const spy = new Proxy(db, {
      get(target, k) {
        if (k === 'prepare') return (sql) => { if (/FROM media/i.test(sql)) mediaQueries++; return target.prepare(sql); };
        const v = target[k];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const groups = buildInbox(spy, { state: 'inbox' });
    assert.equal(groups.length, 30);
    assert.equal(mediaQueries, 1);
    for (const g of groups) assert.match(g.root.images[0].url, /^\/media\/[0-9a-f]{64}\.jpg$/);
    // a big list still works (chunked IN queries)
    const many = Array.from({ length: 1300 }, (_, i) => i + 1);
    assert.equal(imagesByItem(db, many).size, 30);
  });
});

// ======================================================================
describe('housekeeping and backfill', () => {
  test('files no media row points at are deleted; everything else stays', () => {
    const db = openDb(':memory:');
    const dir = newDir();
    const a = insertItem(db);
    const kept = savedImage(db, dir, a, JPEG);
    const old = (now() - 7200);
    const put = (name, body = 'x', aged = true) => { const p = join(dir, name); writeFileSync(p, body); if (aged) utimesSync(p, old, old); return p; };
    const orphan = put(`${sha(PNG)}.png`, PNG);
    const fresh = put(`${sha(GIF)}.gif`, GIF, false);            // just written: the downloader may be about to save its row
    const tmpOld = put('.tmp-0123456789abcdef');
    const tmpNew = put('.tmp-fedcba9876543210', 'x', false);
    const other = put('readme.txt');
    const dbFile = put('vault.db');
    mkdirSync(join(dir, `${'a'.repeat(64)}.jpg`));               // a folder with a media-like name is not ours
    utimesSync(join(dir, kept.name), old, old);
    const r = housekeeping(db, { mediaDir: dir });
    assert.equal(r.media_files, 2);
    assert.ok(!existsSync(orphan));
    assert.ok(!existsSync(tmpOld));
    for (const p of [join(dir, kept.name), fresh, tmpNew, other, dbFile, join(dir, `${'a'.repeat(64)}.jpg`)]) assert.ok(existsSync(p), p);
    // the post is deleted: its rows go with it, then its file
    db.prepare('DELETE FROM items WHERE id = ?').run(a);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media').get().n, 0);
    assert.equal(cleanMediaFiles(db, dir), 1);
    assert.ok(!existsSync(join(dir, kept.name)));
    // a file still used by another post stays when one of its posts goes
    const b = insertItem(db);
    const c = insertItem(db);
    const s1 = savedImage(db, dir, b, JPEG2);
    savedImage(db, dir, c, JPEG2);
    utimesSync(join(dir, s1.name), old, old);
    db.prepare('DELETE FROM items WHERE id = ?').run(b);
    assert.equal(cleanMediaFiles(db, dir), 0);
    assert.ok(existsSync(join(dir, s1.name)));
    // no folder: nothing to do
    assert.equal(cleanMediaFiles(db, join(dir, 'missing')), 0);
    assert.equal(housekeeping(db).media_files, undefined);
  });

  test('cli backfill-media queues saved posts and articles with raw FxTwitter answers and no media rows', () => {
    const db = openDb(':memory:');
    const raw = (id, source, body) => db.prepare('INSERT INTO raw_fetches (item_id, source, fetched_at, http_status, body) VALUES (?, ?, ?, 200, ?)').run(id, source, now(), body);
    const a = insertItem(db, { tweet_id: '1900000000000000001' });
    raw(a, 'fxtwitter', V1);
    const b = insertItem(db, { kind: 'article', tweet_id: '1920000000000000001' });
    raw(b, 'fxtwitter', ART);
    const ctx = insertItem(db, { saved: 0 });
    raw(ctx, 'fxtwitter', V1);
    const done = insertItem(db);
    raw(done, 'fxtwitter', V1);
    queueMedia(db, done, [{ url: 'https://pbs.twimg.com/media/already.jpg', kind: 'image' }]);
    const note = insertItem(db, { kind: 'text', tweet_id: null });
    raw(note, 'fxtwitter', V1);
    const broken = insertItem(db);
    raw(broken, 'fxtwitter', '<html>');
    // a thread saved before images were kept: the parts have no answer of their own
    const job = insertItem(db, { tweet_id: '1910000000000000001', author_handle: 'thread_author' });
    raw(job, 'fxthread', V2T);
    const p2 = insertItem(db, { tweet_id: '1910000000000000002', author_handle: 'thread_author' });
    const p3 = insertItem(db, { tweet_id: '1910000000000000003', author_handle: 'thread_author' });
    const out = [];
    assert.equal(main(['backfill-media'], { db, out: (s) => out.push(s) }), 0);
    assert.match(out[0], /^Queued 9 images from 5 posts\./);
    assert.equal(rows(db, a).length, 3);
    assert.equal(rows(db, b).length, 2);
    assert.equal(rows(db, job).length, 2);
    assert.equal(rows(db, p2).length, 1);
    assert.equal(rows(db, p3).length, 1);
    assert.equal(rows(db, ctx).length, 0);
    assert.equal(rows(db, done).length, 1);
    assert.equal(rows(db, note).length, 0);
    assert.equal(rows(db, broken).length, 0);
    const again = [];
    main(['backfill-media'], { db, out: (s) => again.push(s) });
    assert.match(again[0], /^No images to queue/);
    assert.deepEqual(backfillMedia(db), { items: 0, images: 0 });
  });

  test('cli housekeeping cleans the media folder it is given', () => {
    const db = openDb(':memory:');
    const dir = newDir();
    const p = join(dir, `${sha(WEBP)}.webp`);
    writeFileSync(p, WEBP);
    utimesSync(p, now() - 7200, now() - 7200);
    const out = [];
    assert.equal(main(['housekeeping'], { db, out: (s) => out.push(s), mediaDir: dir }), 0);
    assert.equal(JSON.parse(out[0]).media_files, 1);
    assert.ok(!existsSync(p));
  });
});

// ======================================================================
// a real server over HTTP, for the /media route, the item routes and MCP get_item
const PW = 'correct horse battery staple';
const realNow = Date.now;
let skewMs = 0;

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

describe('over HTTP', () => {
  let app;
  let db;
  let base;
  let dir;
  let cookie = '';
  let readKey;
  let captureKey;
  const ids = {};
  const pics = {};

  const req = async (path, { auth = 'session', method = 'GET', body, headers = {} } = {}) => {
    const h = { ...headers };
    if (auth === 'session' && cookie) h.Cookie = cookie;
    else if (auth && auth !== 'session' && auth !== 'none') h.Authorization = `Bearer ${auth}`;
    if (body !== undefined) { h['Content-Type'] = 'application/json'; h.Origin = base; }
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
    return { status: res.status, headers: res.headers, buf, json };
  };

  before(async () => {
    Date.now = () => realNow() + skewMs;
    dir = newDir();
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    app = createApp({
      dbPath: ':memory:', mediaDir: dir, passwordHash: await A.makePasswordHash(PW, 100000), secret: 'x'.repeat(40),
      origins: base, cookieSecure: false, trustProxy: false, startWorker: false, paceMs: 0,
      fetchFn: async () => new Response('', { status: 404 }), log: () => {},
    });
    await app.listen(port, '127.0.0.1');
    db = app.db;
    readKey = A.createDeviceToken(db, 'Claude', 'read').token;
    captureKey = A.createDeviceToken(db, 'Phone', 'capture').token;
    // sign in with two-step sign-in set up
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: PW }) });
    assert.equal(login.status, 200);
    cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const s = await req('/api/mfa/setup', { method: 'POST', body: {} });
    skewMs += 30_000;
    const c = await fetch(`${base}/api/mfa/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
      body: JSON.stringify({ code: totp(base32Decode(s.json.secret), now()) }) });
    assert.equal(c.status, 200, await c.text());
    const set = c.headers.getSetCookie().map((x) => x.split(';')[0]);
    if (set.length) cookie = set.join('; ');

    ids.post = insertItem(db, { text: 'A post with pictures [Image: https://pbs.twimg.com/media/ok.jpg]' });
    pics.jpeg = savedImage(db, dir, ids.post, JPEG, { url: 'https://pbs.twimg.com/media/ok.jpg?name=orig' });
    queueMedia(db, ids.post, [{ url: 'https://pbs.twimg.com/media/notyet.jpg?name=orig', kind: 'image' }]);
    // failed row with a file on disk, an orphan file, a type mismatch
    pics.failedSha = sha(PNG);
    writeFileSync(join(dir, `${pics.failedSha}.png`), PNG);
    db.prepare("INSERT INTO media (item_id, source_url, status, sha256, mime, bytes, created_at) VALUES (?, 'https://pbs.twimg.com/media/f.png', 'failed', ?, 'image/png', ?, ?)")
      .run(ids.post, pics.failedSha, PNG.length, now());
    pics.orphan = `${sha(GIF)}.gif`;
    writeFileSync(join(dir, pics.orphan), GIF);
    writeFileSync(join(dir, `${pics.jpeg.sha}.png`), JPEG);   // same hash, other extension
    writeFileSync(join(dir, '..', 'secret.txt'), 'secret');
  });

  after(async () => { await app.close(); Date.now = realNow; });

  test('the vault serves a saved image to a session and to a read key, with locked-down headers', async () => {
    for (const auth of ['session', readKey]) {
      const r = await req(`/media/${pics.jpeg.name}`, { auth });
      assert.equal(r.status, 200);
      assert.ok(r.buf.equals(JPEG));
      assert.equal(r.headers.get('content-type'), 'image/jpeg');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('cache-control'), 'private, max-age=31536000, immutable');
      assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; sandbox");
      assert.equal(r.headers.get('content-disposition'), 'inline');
      assert.equal(r.headers.get('content-length'), String(JPEG.length));
    }
  });

  test('signed out, or a capture-only phone key: refused', async () => {
    assert.equal((await req(`/media/${pics.jpeg.name}`, { auth: 'none' })).status, 401);
    assert.equal((await req(`/media/${pics.jpeg.name}`, { auth: captureKey })).status, 403);
    assert.equal((await req(`/media/${pics.jpeg.name}`, { auth: 'tv_notarealtokennotarealtoken' })).status, 401);
    assert.equal((await req(`/media/${pics.jpeg.name}`, { method: 'POST', body: {} })).status, 405);
  });

  test('bad names, path tricks, unknown hashes, failed rows and orphan files: 404', async () => {
    const s = pics.jpeg.sha;
    const bad = [
      `/media/${s.toUpperCase()}.jpg`, `/media/${s}.JPG`, `/media/${s}.jpeg`, `/media/${s}.svg`, `/media/${s}.html`,
      `/media/${s.slice(1)}.jpg`, `/media/${s}0.jpg`, `/media/${s}.jpg%00.png`, `/media/${s}.jpg.png`,
      '/media/..%2Fsecret.txt', '/media/..%2F..%2Fsecret.txt', '/media/%2e%2e%2fsecret.txt', '/media/..%5Csecret.txt',
      `/media/${'0'.repeat(64)}.jpg`, `/media/${pics.failedSha}.png`, `/media/${pics.orphan}`,
      `/media/${s}.png`,   // the file exists, but the row says it is a JPEG
      '/media/%E0%A4%A.jpg',
    ];
    for (const p of bad) {
      const r = await req(p);
      assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
      assert.ok(!r.buf.equals(JPEG) && !r.buf.toString().includes('secret'), p);
    }
    // a row that says ok but whose file is gone
    const gone = insertItem(db);
    const g = savedImage(db, dir, gone, WEBP);
    rmSync(join(dir, g.name));
    assert.equal((await req(`/media/${g.name}`)).status, 404);
  });

  test('item routes carry images: the Inbox, one item, a collection', async () => {
    const want = [
      { url: `/media/${pics.jpeg.name}`, original: 'https://pbs.twimg.com/media/ok.jpg?name=orig', kind: 'image' },
      { url: null, original: 'https://pbs.twimg.com/media/notyet.jpg?name=orig', kind: 'image' },
      { url: null, original: 'https://pbs.twimg.com/media/f.png', kind: 'image' },
    ];
    const inbox = await req('/api/inbox');
    assert.equal(inbox.status, 200);
    const g = inbox.json.groups.find((x) => x.root && x.root.id === ids.post);
    assert.deepEqual(g.root.images, want);
    const one = await req(`/api/items/${ids.post}`);
    assert.deepEqual(one.json.item.images, want);
    const bid = Number(db.prepare("INSERT INTO bundles (slug, title, created_at, updated_at, version) VALUES ('pics', 'Pics', ?, ?, 1)").run(now(), now()).lastInsertRowid);
    db.prepare('INSERT INTO bundle_items (bundle_id, item_id, position) VALUES (?, ?, 0)').run(bid, ids.post);
    const b = await req('/api/bundles/pics');
    assert.deepEqual(b.json.items[0].images, want);
    // merged text keeps the original line
    assert.match(b.json.text, /\[Image: https:\/\/pbs\.twimg\.com\/media\/ok\.jpg\]/);
    db.prepare('DELETE FROM bundles WHERE id = ?').run(bid);
  });

  test('MCP get_item adds up to 4 saved images under 1 MB each, after the text', async () => {
    const id = insertItem(db, { text: 'Many pictures' });
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1024 * 1024)]);
    savedImage(db, dir, id, big);                        // over 1 MB: left out
    const small = [JPEG2, PNG, GIF, WEBP, Buffer.concat([JPEG, Buffer.from('5')])];
    savedImage(db, dir, id, small[0]);
    savedImage(db, dir, id, small[0], { url: 'https://pbs.twimg.com/media/twice.jpg' });   // the same picture twice: sent once
    for (const b of small.slice(1)) savedImage(db, dir, id, b);
    queueMedia(db, id, [{ url: 'https://pbs.twimg.com/media/pending.jpg', kind: 'image' }]);
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${readKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_item', arguments: { id } } }) });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    const content = j.result.content;
    assert.equal(content[0].type, 'text');
    assert.match(content[0].text, /Many pictures/);
    const images = content.slice(1);
    assert.equal(images.length, 4);
    assert.deepEqual(images.map((x) => x.type), ['image', 'image', 'image', 'image']);
    assert.deepEqual(images.map((x) => x.mimeType), ['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
    assert.ok(Buffer.from(images[0].data, 'base64').equals(JPEG2));
    assert.ok(Buffer.from(images[3].data, 'base64').equals(WEBP));
    // a post without saved images: text only
    const plain = insertItem(db, { text: 'No pictures' });
    const r2 = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${readKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_item', arguments: { id: plain } } }) });
    assert.equal((await r2.json()).result.content.length, 1);
    // the helper's limits directly
    assert.equal(mcpImages(db, dir, id, { max: 2 }).length, 2);
    assert.equal(mcpImages(db, dir, id, { maxBytes: 1000 }).length, 2);   // only the GIF (506 B) and WebP (812 B)
  });

  test('an in-memory database without a media folder: images off, route 404, no crash', async () => {
    const other = createApp({ dbPath: ':memory:', secret: 'y'.repeat(40), origins: base, startWorker: false, log: () => {} });
    assert.equal(other.mediaDir, null);
    assert.equal(other.media.enabled, false);
    assert.equal(await other.media.runOnce(), false);
    const fileDb = join(newDir(), 'vault.db');
    const third = createApp({ dbPath: fileDb, secret: 'y'.repeat(40), origins: base, startWorker: false, log: () => {} });
    assert.equal(third.mediaDir, join(dirname(fileDb), 'media'));
    third.db.close();
    other.db.close();
  });
});
