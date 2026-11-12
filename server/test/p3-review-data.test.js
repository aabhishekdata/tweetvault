// Phase 3 review, data group (finding 4): after a rollback to a release before v8, its worker marks every
// queued plain link 'n/a'. openDb heals them, read-links / backfill-youtube accept them, and a failed
// re-read of a YouTube video keeps the details saved before. Fake fetches only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { byId } from '../src/items.js';
import { BACKOFF } from '../src/fetcher.js';
import { readYouTube } from '../src/youtube.js';
import { requeueLinks, backfillYouTube } from '../src/cli.js';

function ins(db, f) {
  const row = { kind: 'link', saved: 1, state: 'inbox', fetch_status: 'ok', first_saved_at: 1000, last_saved_at: 1000, ...f };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid);
}

// what the v7 worker's processItem does to a pending link it does not know how to read
const oldWorker = (db, id) => db.prepare("UPDATE items SET fetch_status = 'n/a' WHERE id = ?").run(id);

function withFileDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tv-p3data-'));
  try { return fn(join(dir, 'vault.db')); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('rollback past v8: stranded links', () => {
  test('openDb puts plain links an older worker marked n/a back to pending, and nothing else', () => {
    withFileDb((path) => {
      let db = openDb(path);
      const web = ins(db, { url: 'https://example.com/article', fetch_status: 'pending', fetch_attempts: 2, next_fetch_at: 99, fetch_error: 'x' });
      const yt = ins(db, { url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE', fetch_status: 'pending', note: '' });
      const tco = ins(db, { url: 'https://t.co/abc', fetch_status: 'n/a', note: 'tco' });
      const typed = ins(db, { url: 'https://example.com/read', fetch_status: 'n/a', link_type: 'web' });
      const noted = ins(db, { url: 'https://example.com/n', fetch_status: 'n/a', note: 'my note' });
      const text = ins(db, { kind: 'text', text: 'hello', fetch_status: 'n/a' });
      oldWorker(db, web); oldWorker(db, yt);
      db.close();

      db = openDb(path);
      try {
        for (const id of [web, yt]) {
          const r = byId(db, id);
          assert.equal(r.fetch_status, 'pending', `item ${id} is read again`);
          assert.equal(r.fetch_attempts, 0);
          assert.equal(r.next_fetch_at, null);
          assert.equal(r.fetch_error, null);
        }
        for (const id of [tco, typed, noted, text]) assert.equal(byId(db, id).fetch_status, 'n/a', `item ${id} untouched`);
      } finally { db.close(); }
    });
  });

  test('the check is an index lookup, and a database before v8 is left alone', () => {
    withFileDb((path) => {
      let db = openDb(path, { upTo: 7 });
      const id = ins(db, { url: 'https://example.com/a', fetch_status: 'n/a' });
      db.close();
      db = openDb(path, { upTo: 7 });   // no link_type column yet: the heal must not run (or throw)
      try { assert.equal(byId(db, id).fetch_status, 'n/a'); } finally { db.close(); }
    });
    const db = openDb(':memory:');
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM items WHERE kind = 'link' AND fetch_status = 'n/a'
        AND (note IS NULL OR note = '') AND link_type IS NULL LIMIT 1`).all().map((r) => r.detail).join(' | ');
    assert.match(plan, /USING INDEX (items_fetch|items_link_type)/, plan);
    db.close();
  });

  test('read-links and backfill-youtube also queue links marked n/a', () => {
    const db = openDb(':memory:');
    const web = ins(db, { url: 'https://example.com/article', fetch_status: 'n/a' });
    const yt = ins(db, { url: 'https://youtu.be/M7lc1UVf-VE', fetch_status: 'n/a' });
    const xpage = ins(db, { url: 'https://x.com/someone', fetch_status: 'n/a' });
    const trashed = ins(db, { url: 'https://example.com/t', fetch_status: 'n/a', state: 'trashed' });
    assert.equal(backfillYouTube(db), 1);
    assert.equal(byId(db, yt).fetch_status, 'pending');
    assert.equal(requeueLinks(db), 1);
    assert.equal(byId(db, web).fetch_status, 'pending');
    assert.equal(byId(db, xpage).fetch_status, 'n/a');
    assert.equal(byId(db, trashed).fetch_status, 'n/a');
    db.close();
  });
});

describe('YouTube re-read keeps saved details', () => {
  const URL_ = 'https://www.youtube.com/watch?v=M7lc1UVf-VE';
  const META = JSON.stringify({ video_id: 'M7lc1UVf-VE', channel: 'Google Developers', duration_s: 1344, chapters: [{ t: 0, title: 'Intro' }],
    transcript_status: 'none', transcript_lang: null });
  const saved = (db, f = {}) => ins(db, {
    url: URL_, fetch_status: 'pending', link_type: 'youtube', link_title: 'Saved title', link_site: 'YouTube',
    link_author: 'Google Developers', link_published_at: 1350000000, link_meta: META, link_fetched_at: 500, ...f,
  });
  const nothing = async () => new Response('', { status: 404 });
  const down = async () => new Response('', { status: 503 });

  test('YouTube gives no details this time: title, channel, date and chapters stay, status ok with the reason', async () => {
    const db = openDb(':memory:');
    const id = saved(db);
    await readYouTube(db, byId(db, id), { fetchImpl: nothing, youtubeApiKey: '', transcripts: true });
    const r = byId(db, id);
    assert.equal(r.fetch_status, 'ok');
    assert.equal(r.link_title, 'Saved title');
    assert.equal(r.link_author, 'Google Developers');
    assert.equal(r.link_published_at, 1350000000);
    assert.equal(JSON.parse(r.link_meta).chapters.length, 1);
    assert.match(r.fetch_error, /saved ones are kept/);
    db.close();
  });

  test('a video never read before still ends link_only when YouTube gives nothing', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { url: URL_, fetch_status: 'pending' });
    await readYouTube(db, byId(db, id), { fetchImpl: nothing, youtubeApiKey: '', transcripts: true });
    assert.equal(byId(db, id).fetch_status, 'link_only');
    db.close();
  });

  test('YouTube down on the last try: the saved video stays ok instead of failing', async () => {
    const db = openDb(':memory:');
    const id = saved(db, { fetch_attempts: BACKOFF.length });
    await readYouTube(db, byId(db, id), { fetchImpl: down, youtubeApiKey: '' });
    const r = byId(db, id);
    assert.equal(r.fetch_status, 'ok');
    assert.equal(r.link_title, 'Saved title');
    assert.match(r.fetch_error, /503/);
    // an earlier try still asks the fetcher to retry
    const id2 = saved(db, { fetch_attempts: 0 });
    await assert.rejects(readYouTube(db, byId(db, id2), { fetchImpl: down, youtubeApiKey: '' }), (e) => e.retry === true);
    db.close();
  });
});
