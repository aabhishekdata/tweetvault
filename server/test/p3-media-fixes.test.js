// Phase 3 review fixes, kept images: backfill-media repairs saved rows whose file is missing (IMG1), a
// picture downloaded again refreshes the existing file's age so housekeeping keeps it (IMG2), a thread's
// images are queued after the save so a media problem never undoes it (IMG3), the Drive backup leaves out
// half-finished downloads (IMG4), and housekeeping reads the media folder one entry at a time (IMG6).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, utimesSync, statSync, rmSync, unlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { openDb, now } from '../src/db.js';
import { byTweetId } from '../src/items.js';
import { saveThread, queueThread } from '../src/thread.js';
import { createMediaWorker, cleanMediaFiles, backfillMedia, sniffImage } from '../src/media.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const dirs = [];
const newDir = () => { const d = mkdtempSync(join(tmpdir(), 'tv-p3m-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(3000)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(2000)]);

let seq = 0;
function insertItem(db, f = {}) {
  const t = now();
  const row = { kind: 'tweet', tweet_id: String(1900000000000000000n + BigInt(++seq)), fetch_status: 'ok', saved: 1, state: 'inbox', first_saved_at: t, last_saved_at: t, text: 'a post', ...f };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c])).lastInsertRowid);
}
function savedImage(db, dir, itemId, buf, url = `https://pbs.twimg.com/media/${randomBytes(6).toString('hex')}.jpg`) {
  const t = sniffImage(buf);
  const h = sha(buf);
  writeFileSync(join(dir, `${h}.${t.ext}`), buf);
  db.prepare(`INSERT INTO media (item_id, source_url, kind, status, sha256, mime, bytes, created_at, fetched_at)
      VALUES (?, ?, 'image', 'ok', ?, ?, ?, ?, ?)`).run(itemId, url, h, t.mime, buf.length, now(), now());
  return { name: `${h}.${t.ext}`, url };
}
const serve = (buf) => async () => new Response(buf, { status: 200, headers: { 'content-type': 'image/jpeg' } });
const worker = (db, dir, fetchFn) => createMediaWorker(db, { mediaDir: dir, fetchFn, paceMs: 0 });
const row = (db, url) => db.prepare('SELECT * FROM media WHERE source_url = ?').get(url);

// ======================================================================
describe('IMG1: backfill-media repairs saved images whose file is missing', () => {
  test('a deleted file goes back to pending, and the worker downloads it again', async () => {
    const db = openDb(':memory:');
    const dir = newDir();
    const a = insertItem(db);
    const lost = savedImage(db, dir, a, JPEG);
    const kept = savedImage(db, dir, a, PNG);
    unlinkSync(join(dir, lost.name));
    const r = backfillMedia(db, now(), { mediaDir: dir });
    assert.equal(r.images, 1);
    assert.equal(r.items, 1);
    assert.equal(r.images, 1);
    const lr = row(db, lost.url);
    assert.equal(lr.status, 'pending');
    assert.equal(lr.sha256, null);
    assert.equal(lr.attempts, 0);
    assert.equal(lr.next_at, null);
    assert.equal(row(db, kept.url).status, 'ok', 'a file that is there is left alone');
    let calls = 0;
    const w = worker(db, dir, async (...x) => { calls++; return serve(JPEG)(...x); });
    assert.equal(await w.drain(10, { yieldToItems: false }), 1);
    assert.equal(calls, 1);
    assert.equal(row(db, lost.url).status, 'ok');
    assert.ok(existsSync(join(dir, lost.name)));
    // nothing more to repair
    assert.equal(backfillMedia(db, now(), { mediaDir: dir }).images, 0);
  });

  test('with no options (as cli.js calls it) the folder beside a file database is used', () => {
    const base = newDir();
    const db = openDb(join(base, 'vault.db'));
    const dir = join(base, 'media');
    mkdirSync(dir);
    const a = insertItem(db);
    const lost = savedImage(db, dir, a, JPEG);
    unlinkSync(join(dir, lost.name));
    const r = backfillMedia(db);
    assert.equal(r.images, 1);
    assert.equal(row(db, lost.url).status, 'pending');
    db.close();
  });

  test('mediaDir: null, or an in-memory database, skips the repair', () => {
    const db = openDb(':memory:');
    const dir = newDir();
    const lost = savedImage(db, dir, insertItem(db), JPEG);
    unlinkSync(join(dir, lost.name));
    assert.equal(backfillMedia(db).images, 0);
    assert.equal(backfillMedia(db, now(), { mediaDir: null }).images, 0);
    assert.equal(row(db, lost.url).status, 'ok');
  });
});

// ======================================================================
describe('IMG2: a picture downloaded again protects the existing file from housekeeping', () => {
  test('the existing file gets a fresh modification time, so the grace period covers it', async () => {
    const db = openDb(':memory:');
    const dir = newDir();
    const final = join(dir, `${sha(JPEG)}.jpg`);
    writeFileSync(final, JPEG);
    const old = now() - 7200;
    utimesSync(final, old, old);   // an orphan older than the grace period
    const a = insertItem(db);
    const url = 'https://pbs.twimg.com/media/again.jpg';
    db.prepare("INSERT INTO media (item_id, source_url, kind, created_at) VALUES (?, ?, 'image', ?)").run(a, url, now());
    const w = worker(db, dir, serve(JPEG));
    assert.equal(await w.drain(5, { yieldToItems: false }), 1);
    assert.equal(row(db, url).status, 'ok');
    assert.ok(Date.now() - statSync(final).mtimeMs < 60_000, 'mtime refreshed');
    // housekeeping running before the row pointed at it would now keep the file
    db.prepare('DELETE FROM media').run();
    assert.equal(cleanMediaFiles(db, dir), 0);
    assert.ok(existsSync(final));
    assert.deepEqual(fs.readdirSync(dir), [`${sha(JPEG)}.jpg`], 'the temp file is gone');
  });
});

// ======================================================================
describe('IMG3: a media problem never undoes saving a thread', () => {
  const post = (id, parent = null, i = 0) => ({
    id: String(id), text: `post ${id}`, author: { screen_name: 'alice', name: 'alice' }, created_timestamp: 1790000000 + i,
    replying_to: parent ? { screen_name: 'alice', status: String(parent) } : null, likes: 0, replies: 0, reposts: 0, views: 1,
    media: { photos: [{ url: `https://pbs.twimg.com/media/p${id}.jpg` }] },
  });

  test('the thread is saved even when queueing its images fails; the error is logged', () => {
    const db = openDb(':memory:');
    const id = insertItem(db, { tweet_id: '200', author_handle: 'alice', url: 'https://x.com/alice/status/200' });
    queueThread(db, id);
    db.exec("CREATE TRIGGER no_media BEFORE INSERT ON media BEGIN SELECT RAISE(ABORT, 'media is broken'); END");
    const logs = [];
    const r = saveThread(db, id, [post(200), post(201, 200, 1)], { httpStatus: 200, body: '{}', t: 500, log: (m) => logs.push(m) });
    assert.deepEqual(r, { saved: 2, added: 1 });
    assert.equal(byTweetId(db, '201').saved, 1);
    assert.equal(db.prepare('SELECT thread_status FROM items WHERE id = ?').get(id).thread_status, 'done');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /media is broken/);
  });

  test('images are still queued for every part when nothing goes wrong', () => {
    const db = openDb(':memory:');
    const id = insertItem(db, { tweet_id: '300', author_handle: 'alice', url: 'https://x.com/alice/status/300' });
    queueThread(db, id);
    saveThread(db, id, [post(300), post(301, 300, 1)], { httpStatus: 200, body: '{}', t: 500 });
    const urls = db.prepare('SELECT source_url FROM media ORDER BY source_url').all().map((x) => x.source_url);
    assert.deepEqual(urls, ['https://pbs.twimg.com/media/p300.jpg?name=orig', 'https://pbs.twimg.com/media/p301.jpg?name=orig']);
  });
});

// ======================================================================
describe('IMG4: the Drive backup leaves out half-finished downloads', () => {
  test("rclone copy of data/media has --exclude '.tmp-*'", () => {
    const sh = readFileSync(new URL('../../deploy/backup-vault.sh', import.meta.url), 'utf8');
    const line = sh.split('\n').find((l) => /rclone"? copy data\/media/.test(l) || /"\$RCLONE" copy data\/media/.test(l));
    assert.ok(line, 'the media copy line');
    assert.match(line, /--exclude '\.tmp-\*'/);
  });
});

// ======================================================================
describe('IMG6: housekeeping reads the media folder one entry at a time', () => {
  test('cleanMediaFiles works without readdirSync (it streams with opendir)', () => {
    const db = openDb(':memory:');
    const dir = newDir();
    const old = now() - 7200;
    const orphan = join(dir, `${sha(PNG)}.png`);
    writeFileSync(orphan, PNG);
    utimesSync(orphan, old, old);
    const kept = savedImage(db, dir, insertItem(db), JPEG);
    utimesSync(join(dir, kept.name), old, old);
    const real = fs.readdirSync;
    fs.readdirSync = () => { throw new Error('readdirSync holds the whole folder in memory'); };
    syncBuiltinESMExports();
    let n;
    try { n = cleanMediaFiles(db, dir); } finally { fs.readdirSync = real; syncBuiltinESMExports(); }
    assert.equal(n, 1);
    assert.ok(!existsSync(orphan));
    assert.ok(existsSync(join(dir, kept.name)));
  });

  test('a missing folder still counts as nothing to clean', () => {
    assert.equal(cleanMediaFiles(openDb(':memory:'), join(newDir(), 'nope')), 0);
  });
});
