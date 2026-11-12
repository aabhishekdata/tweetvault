// Fixes from the review of phase A1 (PLAN-APP-2.md). One block per finding.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { openDb, now } from '../src/db.js';
import { capture, byId } from '../src/items.js';
import * as A from '../src/auth.js';
import * as Y from '../src/sync.js';
import { totp, base32Decode } from '../src/totp.js';

const PW = 'sync-fix password 1';
const realNow = Date.now;
let skewMs = 0;
Date.now = () => realNow() + skewMs;
const advance = (sec) => { skewMs += sec * 1000; };

let seq = 0;
const text = (db, s) => capture(db, { input: s, client_id: `fix-seed-${String(++seq).padStart(4, '0')}` }).item_id;

async function boot(opts = {}) {
  const app = createApp({
    dbPath: ':memory:', passwordHash: await A.makePasswordHash(PW, 100000), secret: 's'.repeat(40),
    origins: 'http://vault.test', cookieSecure: false, startWorker: false,
    fetchFn: async () => new Response('{}', { status: 404 }), paceMs: 0, log: () => {}, ...opts,
  });
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const jar = new Map();
  async function req(method, path, { body, bearer, cookies = true, op } = {}) {
    const headers = { Origin: 'http://vault.test' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (op) headers['X-Op-Id'] = op;
    if (cookies && jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const res = await fetch(base + path, { method, headers, body: payload });
    if (cookies) {
      for (const sc of res.headers.getSetCookie()) {
        const kv = sc.split(';')[0];
        const i = kv.indexOf('=');
        jar.set(kv.slice(0, i).trim(), decodeURIComponent(kv.slice(i + 1).trim()));
      }
    }
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* text */ }
    return { status: res.status, text: raw, json, headers: res.headers };
  }
  assert.equal((await req('POST', '/api/login', { body: { password: PW } })).status, 200);
  const s = await req('POST', '/api/mfa/setup', { body: {} });
  advance(30);
  const c = await req('POST', '/api/mfa/confirm', { body: { code: totp(base32Decode(s.json.secret), now()) } });
  assert.equal(c.status, 200, c.text);
  return { app, db: app.db, req };
}

describe('a resent change: claimed before it runs', () => {
  let env; let P;
  before(async () => {
    env = await boot();
    const phone = A.createDeviceToken(env.db, 'Galaxy', 'capture,organize').token;
    P = (method, path, body, op) => env.req(method, path, { body, bearer: phone, cookies: false, op });
  });
  after(async () => { await env.app.close(); });
  const notes = () => env.db.prepare("SELECT COUNT(*) AS n FROM items WHERE source_app = 'note'").get().n;

  test('two copies of one change arriving together make one note', async () => {
    const [a, b] = await Promise.all([
      P('POST', '/api/notes', { text: 'Sent twice at once' }, 'op-race-0001'),
      P('POST', '/api/notes', { text: 'Sent twice at once' }, 'op-race-0001'),
    ]);
    const statuses = [a.status, b.status].sort();
    // one ran; the other was either told to wait or got the stored answer
    assert.ok(statuses[0] === 201 && (statuses[1] === 201 || statuses[1] === 409), statuses.join(','));
    const waiting = [a, b].find((r) => r.status === 409);
    if (waiting) {
      assert.equal(waiting.json.error, 'in_progress');
      assert.equal(waiting.headers.get('retry-after'), '2');
    }
    assert.equal(notes(), 1);
    // the later resend gets the stored answer
    const again = await P('POST', '/api/notes', { text: 'Sent twice at once' }, 'op-race-0001');
    assert.equal(again.status, 201);
    assert.equal(again.json.item.id, [a, b].find((r) => r.status === 201).json.item.id);
    assert.equal(notes(), 1);
  });

  test('a change that is still running blocks its twin, and a dead one is given up after a minute', async () => {
    assert.equal(Y.claimOp(env.db, 1, 'op-held-0001'), 'new');
    const twin = await P('POST', '/api/notes', { text: 'Twin' }, 'op-held-0001');
    assert.equal(twin.status, 409);
    assert.equal(twin.json.error, 'in_progress');
    assert.equal(notes(), 1);
    advance(Y.CLAIM_SECONDS + 1);
    const later = await P('POST', '/api/notes', { text: 'Twin' }, 'op-held-0001');
    assert.equal(later.status, 201);
    assert.equal(notes(), 2);
  });

  test('a refused change frees its id, whatever refused it', async () => {
    assert.equal((await P('POST', '/api/notes', { text: '  ' }, 'op-bad-00001')).status, 400);
    assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM ops_seen WHERE client_id = 'op-bad-00001'").get().n, 0);
    assert.equal((await P('PUT', '/api/bundles/nope', { title: 'x' }, 'op-bad-00002')).status, 404);
    assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM ops_seen WHERE client_id = 'op-bad-00002'").get().n, 0);
    assert.equal((await P('POST', '/api/notes', { text: 'Fixed' }, 'op-bad-00001')).status, 201);
  });

  test('a long answer is replayed with its ids, without its long text', async () => {
    const long = 'word '.repeat(6000).trim();   // about 30,000 characters
    const first = await P('POST', '/api/notes', { title: 'Long one', text: long }, 'op-long-0001');
    assert.equal(first.status, 201);
    assert.equal(first.json.item.text, long);
    const again = await P('POST', '/api/notes', { title: 'Long one', text: long }, 'op-long-0001');
    assert.equal(again.status, 201);
    assert.equal(again.json.repeated, true);
    assert.equal(again.json.item.id, first.json.item.id);
    assert.equal(again.json.item.note_version, first.json.item.note_version);
    assert.equal(again.json.item.title, 'Long one');
    assert.equal(again.json.item.text, undefined);
    assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM items WHERE article_title = 'Long one'").get().n, 1);
  });

  test('a phone note is held to the phone size; the website may write longer', async () => {
    const big = 'a'.repeat(50_001);
    assert.equal((await P('POST', '/api/notes', { text: big })).status, 413);
    const made = (await P('POST', '/api/notes', { text: 'small' })).json.item;
    assert.equal((await P('PATCH', `/api/notes/${made.id}`, { text: big })).status, 413);
    assert.equal(byId(env.db, made.id).text, 'small');
    assert.equal((await env.req('POST', '/api/notes', { body: { text: big } })).status, 201);
  });
});

describe('the stale check sees every change', () => {
  test('a change of title only, capitals only or line breaks only is noticed', () => {
    const db = openDb(':memory:');
    const id = Y.createNote(db, { title: 'Plan', text: 'ship it. then rest.' });
    const base = Y.noteVersion(byId(db, id));
    const cases = [
      { title: 'Plan B', text: 'ship it. then rest.' },
      { title: 'Plan B', text: 'Ship it. Then rest.' },
      { title: 'Plan B', text: 'Ship it.\n\nThen rest.' },
    ];
    let prev = base;
    for (const c of cases) {
      Y.editNote(db, id, { ...c, base_version: prev });
      const cur = Y.noteVersion(byId(db, id));
      assert.notEqual(cur, prev, JSON.stringify(c));
      // the other device still holds the version before this change
      assert.throws(() => Y.editNote(db, id, { title: 'Other', text: 'other', base_version: prev }), (e) => e.status === 409 && e.extra.current.note_version === cur);
      prev = cur;
    }
    assert.equal(byId(db, id).text, 'Ship it.\n\nThen rest.');
    assert.throws(() => Y.editNote(db, id, { text: 'x', base_version: 5 }), (e) => e.status === 400);
    db.close();
  });
});

describe('a restored database', () => {
  test('a sync answer names its epoch, and another epoch starts the copy again', () => {
    const db = openDb(':memory:');
    const a = text(db, 'One thing in the vault');
    const p1 = Y.syncPage(db, { since: 0 });
    assert.match(p1.epoch, /^[A-Za-z0-9_-]{12}$/);
    assert.equal(Y.syncPage(db, { since: p1.rev, epoch: p1.epoch }).reset, false);
    assert.equal(Y.syncPage(db, { since: p1.rev }).reset, false, 'an app that sends no epoch is not reset');
    const other = Y.syncPage(db, { since: p1.rev, epoch: 'someOtherVault' });
    assert.equal(other.reset, true);
    assert.deepEqual(other.items.map((i) => i.id), [a]);
    assert.equal(other.epoch, p1.epoch);
    assert.equal(Y.syncPage(db, { since: 0, epoch: 'someOtherVault' }).reset, false, 'a first copy is never a reset');
    db.close();
  });

  test('a database that is behind what phones were sent gets a new epoch, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tv-epoch-'));
    try {
      const file = join(dir, 'vault.db.sync.json');
      const db = openDb(':memory:');
      for (let i = 0; i < 5; i++) text(db, `Saved before the backup ${i}`);
      const g = Y.createSyncGuard(db, { file });
      const first = Y.syncEpoch(db);
      assert.equal(g.check(), false);
      g.sent(Y.currentRev(db));
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).served, Y.currentRev(db));

      // "restore": an older database (fewer changes) beside the same file
      const older = openDb(':memory:');
      text(older, 'Only this was in the backup');
      older.prepare("INSERT INTO kv (key, value) VALUES ('sync_epoch', ?)").run(first);
      const logs = [];
      const g2 = Y.createSyncGuard(older, { file, log: (m) => logs.push(m) });
      assert.equal(g2.check(), true);
      const second = Y.syncEpoch(older);
      assert.notEqual(second, first);
      assert.equal(logs.length, 1);
      assert.equal(g2.check(), false, 'only once');
      assert.equal(Y.syncEpoch(older), second);
      // the phone still holds the old epoch and a high number: it is told to start again
      const page = Y.syncPage(older, { since: 3, epoch: first });
      assert.equal(page.reset, true);
      assert.equal(page.items.length, 1);
      // and a database that is level with, or ahead of, what was sent is left alone
      const g3 = Y.createSyncGuard(db, { file: join(dir, 'other.sync.json') });
      g3.sent(Y.currentRev(db));
      text(db, 'One more');
      assert.equal(g3.check(), false);
      assert.equal(Y.syncEpoch(db), first);
      db.close(); older.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the server keeps the highest number it sent beside the database, and checks it at start-up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tv-epoch2-'));
    let env; let env2;
    try {
      const syncFile = join(dir, 'served.json');
      env = await boot({ syncFile });
      for (let i = 0; i < 4; i++) text(env.db, `Server item ${i}`);
      const r = await env.req('GET', '/api/sync');
      assert.equal(r.status, 200);
      assert.equal(JSON.parse(readFileSync(syncFile, 'utf8')).served, r.json.rev);
      await env.app.close(); env = null;
      // a fresh, emptier database started beside the same file: it is "behind"
      env2 = await boot({ syncFile });
      const r2 = await env2.req('GET', `/api/sync?since=${r.json.rev}&epoch=${r.json.epoch}`);
      assert.notEqual(r2.json.epoch, r.json.epoch);
      assert.equal(r2.json.reset, true);
    } finally {
      if (env) await env.app.close();
      if (env2) await env2.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an in-memory database keeps no file', async () => {
    const db = openDb(':memory:');
    const g = Y.createSyncGuard(db);
    g.sent(10);
    assert.equal(g.served, 10);
    assert.equal(existsSync(':memory:.sync.json'), false);
    db.close();
  });
});

describe('sync rows stay light', () => {
  let env;
  before(async () => { env = await boot(); });
  after(async () => { await env.app.close(); });

  test('a row says English is stored but does not carry it, and a long read page is cut', async () => {
    const id = text(env.db, 'यह एक परीक्षण नोट है जो हिंदी में लिखा गया है');
    env.db.prepare('INSERT INTO translations (item_id, source_hash, text, lang, model, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'x', 'ENGLISH '.repeat(5000), 'hi', 'm', now());
    const link = Number(env.db.prepare(`INSERT INTO items (kind, url, fetch_status, saved, state, link_type, link_title, link_md, link_meta, first_saved_at, last_saved_at)
        VALUES ('link', 'https://example.com/a', 'ok', 1, 'inbox', 'web', 'A long page', ?, '{"words":12345}', 1, 1)`).run('para '.repeat(40000)).lastInsertRowid);
    const r = await env.req('GET', '/api/sync');
    assert.equal(r.status, 200);
    assert.ok(r.text.length < 20_000, `the page is small (${r.text.length})`);
    const row = r.json.items.find((i) => i.id === id);
    assert.equal(row.has_translation, true);
    assert.equal(row.translation, undefined);
    assert.ok(row.lang, 'the language is named');
    const page = r.json.items.find((i) => i.id === link);
    assert.equal(page.link_has_text, true);
    assert.equal(page.words, 12345);
    assert.ok(page.preview.length <= 601);
    assert.equal(page.has_translation, false);
    // opening the item still gives everything
    const full = await env.req('GET', `/api/items/${link}`);
    assert.equal(full.json.item.link_md.length, 200000);
  });
});

describe('a merge is sent again when an item inside it changes', () => {
  test('editing a note bumps every merge that holds it, and they arrive on one page', () => {
    const db = openDb(':memory:');
    const note = Y.createNote(db, { title: 'Inside', text: 'first words' });
    const other = text(db, 'Not in any merge at all');
    const mk = (slug) => {
      const id = Number(db.prepare('INSERT INTO bundles (slug, title, created_at, updated_at, version) VALUES (?, ?, 1, 1, 1)').run(slug, slug).lastInsertRowid);
      db.prepare('INSERT INTO bundle_items (bundle_id, item_id, position) VALUES (?, ?, 0)').run(id, note);
      return id;
    };
    const b1 = mk('one'); const b2 = mk('two'); const b3 = mk('three');
    const lonely = Number(db.prepare("INSERT INTO bundles (slug, title, created_at, updated_at, version) VALUES ('lonely', 'L', 1, 1, 1)").run().lastInsertRowid);
    db.prepare('INSERT INTO bundle_items (bundle_id, item_id, position) VALUES (?, ?, 0)').run(lonely, other);
    const since = Y.currentRev(db);

    Y.editNote(db, note, { title: 'Inside', text: 'second words' });
    const page = Y.syncPage(db, { since, limit: 1 });
    assert.deepEqual(page.bundles.map((b) => b.id), [b1, b2, b3], 'all three, although the page size is one');
    assert.equal(new Set(page.bundles.map((b) => b.rev)).size, 1);
    // paging still ends: the next page carries what is left and no merge twice
    const rest = [];
    let p = page;
    while (p.more) { p = Y.syncPage(db, { since: p.rev, limit: 1 }); rest.push(...p.bundles.map((b) => b.id)); }
    assert.deepEqual(rest, []);
    assert.equal(db.prepare('SELECT version FROM bundles WHERE id = ?').get(b1).version, 1, 'its edit version is its own');

    // the owner's note on an item, and a refetch that changes the text, count too
    for (const sql of ["UPDATE items SET my_note = 'why' WHERE id = ?", "UPDATE items SET text = 'third words' WHERE id = ?"]) {
      const at = Y.currentRev(db);
      db.prepare(sql).run(note);
      assert.deepEqual(Y.syncPage(db, { since: at }).bundles.map((b) => b.id), [b1, b2, b3], sql);
    }
    // bookkeeping that changes nothing a reader sees does not
    const at = Y.currentRev(db);
    db.prepare('UPDATE items SET likes = 9, fetch_attempts = 2, last_saved_at = 5 WHERE id = ?').run(note);
    db.prepare("UPDATE items SET text = 'third words' WHERE id = ?").run(note);   // same text again
    assert.deepEqual(Y.syncPage(db, { since: at }).bundles, []);
    // and an item in no merge bumps nothing but itself
    db.prepare("UPDATE items SET my_note = 'x' WHERE id = ?").run(text(db, 'free item'));
    assert.deepEqual(Y.syncPage(db, { since: at }).bundles, []);
    db.close();
  });
});
