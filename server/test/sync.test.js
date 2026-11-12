// Phase A1 (PLAN-APP-2.md): sync for the phone app. Database v10's change counter and triggers, the
// /api/sync pages, a phone's resent change (X-Op-Id), the routes a phone that may organize can call,
// and the owner's own typed notes.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { openDb, now, tx } from '../src/db.js';
import { capture, byId } from '../src/items.js';
import { renderItems, loadItemsInOrder } from '../src/render.js';
import { housekeeping } from '../src/audit.js';
import * as A from '../src/auth.js';
import * as Y from '../src/sync.js';
import * as O from '../src/organize.js';
import { textHash } from '../src/kindle.js';
import { totp, base32Decode } from '../src/totp.js';

const PW = 'sync-test password 1';
const realNow = Date.now;
let skewMs = 0;
Date.now = () => realNow() + skewMs;
const advance = (sec) => { skewMs += sec * 1000; };

let seq = 0;
const text = (db, s) => capture(db, { input: s, client_id: `sync-seed-${String(++seq).padStart(4, '0')}` }).item_id;
const revOf = (db, table, id) => db.prepare(`SELECT rev FROM ${table} WHERE id = ?`).get(id).rev;

// Everything a phone would hold after syncing from `since` until no page is left.
function pull(db, since = 0, limit) {
  const out = { items: new Map(), bundles: new Map(), deletedItems: [], deletedBundles: [], pages: 0, rev: since, reset: false };
  for (;;) {
    const p = Y.syncPage(db, { since: out.rev, limit });
    out.pages++;
    if (p.reset) { out.reset = true; out.items.clear(); out.bundles.clear(); }
    for (const it of p.items) out.items.set(it.id, it);
    for (const b of p.bundles) out.bundles.set(b.id, b);
    out.deletedItems.push(...p.deleted.items);
    out.deletedBundles.push(...p.deleted.bundles);
    assert.ok(p.rev >= out.rev, 'the number never goes back');
    out.rev = p.rev;
    out.categories = p.categories; out.tags = p.tags;
    if (!p.more) return out;
    assert.ok(out.pages < 500, 'paging must end');
  }
}

describe('database v10: the change counter', () => {
  test('an existing v9 database is numbered once, every row differently, and keeps its rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tv-sync-'));
    try {
      const path = join(dir, 'v.db');
      const old = openDb(path, { upTo: 9 });
      const ids = [1, 2, 3].map((n) => text(old, `Older saved text number ${n}`));
      old.prepare("INSERT INTO bundles (slug, title, created_at, updated_at, version) VALUES ('a', 'A', 1, 1, 1), ('b', 'B', 1, 1, 1)").run();
      old.prepare('INSERT INTO bundle_items (bundle_id, item_id, position) VALUES (1, ?, 0)').run(ids[0]);
      old.close();
      const db = openDb(path);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
      const revs = [...db.prepare('SELECT rev FROM items').all(), ...db.prepare('SELECT rev FROM bundles').all()].map((r) => r.rev);
      assert.equal(revs.length, 5);
      assert.ok(revs.every((r) => Number.isInteger(r) && r > 0));
      assert.equal(new Set(revs).size, 5, 'no two rows share a number');
      assert.equal(Y.currentRev(db), Math.max(...revs));
      const got = pull(db);
      assert.deepEqual([...got.items.keys()].sort(), ids);
      assert.deepEqual(got.bundles.get(1).item_ids, [ids[0]]);
      // and it counts on from there
      const more = text(db, 'Saved after the upgrade');
      assert.equal(revOf(db, 'items', more), Y.currentRev(db));
      assert.ok(revOf(db, 'items', more) > Math.max(...revs));
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every kind of write stamps a new number, whoever makes it', () => {
    const db = openDb(':memory:');
    const a = text(db, 'First thing worth keeping');
    const b = text(db, 'Second thing worth keeping');
    let last = Y.currentRev(db);
    const bumped = (table, id, why) => {
      const r = revOf(db, table, id);
      assert.ok(r > last, `${why}: ${r} > ${last}`);
      assert.equal(r, Y.currentRev(db), `${why}: the row holds the newest number`);
      last = r;
    };
    // plain SQL, the way the CLI and the background workers write
    db.prepare("UPDATE items SET state = 'archived' WHERE id = ?").run(a); bumped('items', a, 'state');
    db.prepare('UPDATE items SET likes = 5 WHERE id = ?').run(a); bumped('items', a, 'worker update');
    tx(db, () => O.applyItemMeta(db, [a], { add_tags: ['idea'] })); bumped('items', a, 'tag added');
    tx(db, () => O.applyItemMeta(db, [a], { remove_tags: ['idea'] })); bumped('items', a, 'tag removed');
    const untouched = revOf(db, 'items', b);
    // one statement over two rows gives each its own number
    db.prepare('UPDATE items SET priority = 2').run();
    assert.notEqual(revOf(db, 'items', a), revOf(db, 'items', b));
    assert.ok(revOf(db, 'items', b) > untouched);
    last = Y.currentRev(db);

    const bid = Number(db.prepare("INSERT INTO bundles (slug, title, created_at, updated_at, version) VALUES ('m', 'M', 1, 1, 1)").run().lastInsertRowid);
    bumped('bundles', bid, 'merge made');
    db.prepare('INSERT INTO bundle_items (bundle_id, item_id, position) VALUES (?, ?, 0)').run(bid, a); bumped('bundles', bid, 'item added');
    db.prepare('UPDATE bundle_items SET position = 3 WHERE bundle_id = ?').run(bid); bumped('bundles', bid, 'reordered');
    tx(db, () => O.setBundleMeta(db, bid, { tags: ['later'] })); bumped('bundles', bid, 'merge tagged');
    db.prepare("UPDATE bundles SET title = 'M2' WHERE id = ?").run(bid); bumped('bundles', bid, 'renamed');
    db.prepare('DELETE FROM bundle_items WHERE bundle_id = ?').run(bid); bumped('bundles', bid, 'item removed');

    db.prepare('DELETE FROM bundles WHERE id = ?').run(bid);
    db.prepare('DELETE FROM items WHERE id = ?').run(b);
    const gone = db.prepare('SELECT kind, id, rev FROM sync_deleted ORDER BY rev').all().map((r) => ({ ...r }));
    assert.deepEqual(gone.map((g) => [g.kind, g.id]), [['bundle', bid], ['item', b]]);
    assert.ok(gone[0].rev > last && gone[1].rev > gone[0].rev);
    assert.equal(Y.currentRev(db), gone[1].rev);
    db.close();
  });

  test('ids from an insert are still reported correctly with the triggers in place', () => {
    const db = openDb(':memory:');
    const id = text(db, 'An id check');
    assert.equal(byId(db, id).text, 'An id check');
    const r = db.prepare("UPDATE items SET state = 'archived' WHERE id = ?").run(id);
    assert.equal(Number(r.changes), 1, 'changes counts the statement, not the trigger');
    db.close();
  });
});

describe('sync pages', () => {
  test('a first copy pages through the whole vault and matches the database', () => {
    const db = openDb(':memory:');
    const ids = Array.from({ length: 23 }, (_, i) => text(db, `Item ${i} with enough words to be a saved thought`));
    tx(db, () => O.applyItemMeta(db, [ids[0], ids[1]], { add_tags: ['alpha', 'beta'], priority: 2 }));
    const cat = tx(db, () => O.createCategory(db, 'Reading'));
    for (let i = 0; i < 4; i++) {
      const bid = Number(db.prepare('INSERT INTO bundles (slug, title, created_at, updated_at, version) VALUES (?, ?, 1, 1, 1)').run(`m${i}`, `Merge ${i}`).lastInsertRowid);
      db.prepare('INSERT INTO bundle_items (bundle_id, item_id, position) VALUES (?, ?, 0), (?, ?, 1)').run(bid, ids[i * 2 + 1], bid, ids[i * 2]);
    }
    for (const limit of [200, 5, 1]) {
      const got = pull(db, 0, limit);
      assert.equal(got.items.size, 23, `limit ${limit}`);
      assert.equal(got.bundles.size, 4);
      if (limit < 23) assert.ok(got.pages > 1, 'more than one page');
      assert.equal(got.rev, Y.currentRev(db));
      assert.deepEqual(got.deletedItems, []);
      assert.deepEqual(got.items.get(ids[0]).tags, ['alpha', 'beta']);
      assert.equal(got.items.get(ids[0]).priority, 2);
      assert.deepEqual(got.bundles.get(1).item_ids, [ids[1], ids[0]], 'in the merge order');
      assert.deepEqual(got.categories.map((c) => c.name), ['Reading']);
      assert.equal(got.categories[0].id, cat);
      assert.deepEqual(got.tags, ['alpha', 'beta']);
      // a list row is a preview, never the whole text
      assert.equal(got.items.get(ids[3]).text, undefined);
      assert.ok(got.items.get(ids[3]).preview.startsWith('Item 3'));
    }
    db.close();
  });

  test('a second sync returns exactly what changed since, deletions included', () => {
    const db = openDb(':memory:');
    const ids = Array.from({ length: 8 }, (_, i) => text(db, `Thing ${i} to keep for later reading`));
    const bid = Number(db.prepare("INSERT INTO bundles (slug, title, created_at, updated_at, version) VALUES ('keep', 'Keep', 1, 1, 1)").run().lastInsertRowid);
    const drop = Number(db.prepare("INSERT INTO bundles (slug, title, created_at, updated_at, version) VALUES ('drop', 'Drop', 1, 1, 1)").run().lastInsertRowid);
    const first = pull(db);
    assert.deepEqual(pull(db, first.rev).items.size, 0, 'nothing changed: an empty page');
    assert.equal(Y.syncPage(db, { since: first.rev }).more, false);

    db.prepare("UPDATE items SET state = 'trashed' WHERE id = ?").run(ids[2]);
    tx(db, () => O.applyItemMeta(db, [ids[5]], { add_tags: ['new'] }));
    db.prepare('INSERT INTO bundle_items (bundle_id, item_id, position) VALUES (?, ?, 0)').run(bid, ids[6]);
    const added = text(db, 'A brand new saved thing');
    db.prepare('DELETE FROM items WHERE id = ?').run(ids[7]);
    db.prepare('DELETE FROM bundles WHERE id = ?').run(drop);

    const second = pull(db, first.rev, 2);
    assert.deepEqual([...second.items.keys()].sort((x, y) => x - y), [ids[2], ids[5], added].sort((x, y) => x - y));
    assert.equal(second.items.get(ids[2]).state, 'trashed');
    assert.deepEqual(second.items.get(ids[5]).tags, ['new']);
    assert.deepEqual([...second.bundles.keys()], [bid]);
    assert.deepEqual(second.bundles.get(bid).item_ids, [ids[6]]);
    assert.deepEqual(second.deletedItems, [ids[7]]);
    assert.deepEqual(second.deletedBundles, [drop]);
    assert.equal(second.reset, false);
    assert.deepEqual(second.tags, ['new']);

    // SQLite hands the highest id out again after its row is deleted. The phone then gets the new row
    // under that id and no deletion for it, so it replaces its copy instead of dropping the new item.
    db.prepare('DELETE FROM items WHERE id = ?').run(added);
    const reused = text(db, 'Saved right after, under a freed id');
    assert.equal(reused, ids[7], 'the id deleted earlier is in use again');
    const third = pull(db, second.rev);
    assert.deepEqual(third.deletedItems, [added]);
    assert.ok(third.items.get(reused).preview.startsWith('Saved right after'));
    // and a phone that missed both steps is not told to delete the id that now holds a new item
    const late = pull(db, first.rev);
    assert.deepEqual(late.deletedItems, [added]);
    assert.ok(late.items.has(reused));
    db.close();
  });

  test('a number from the future, or from before the remembered deletions, starts the copy again', () => {
    const db = openDb(':memory:');
    const a = text(db, 'Stays in the vault for good');
    const b = text(db, 'Will be deleted and forgotten');
    const early = Y.currentRev(db);
    // restored from an older backup: the phone is ahead of the vault
    const ahead = Y.syncPage(db, { since: early + 500 });
    assert.equal(ahead.reset, true);
    assert.deepEqual(ahead.items.map((i) => i.id), [a, b]);

    db.prepare('DELETE FROM items WHERE id = ?').run(b);
    db.prepare("UPDATE sync_deleted SET at = ? WHERE kind = 'item' AND id = ?").run(now() - Y.DELETED_KEEP - 10, b);
    const r = Y.pruneSync(db);
    assert.equal(r.deleted, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_deleted').get().n, 0);
    // a phone that last synced before that deletion can no longer be told about it: full copy again
    const stale = Y.syncPage(db, { since: early });
    assert.equal(stale.reset, true);
    assert.deepEqual(stale.items.map((i) => i.id), [a]);
    assert.deepEqual(stale.deleted.items, []);
    // a phone that is up to date carries on normally
    assert.equal(Y.syncPage(db, { since: Y.currentRev(db) }).reset, false);
    // odd input counts as "from the start", never an error
    for (const bad of [-5, 'abc', null, 1.5]) assert.equal(Y.syncPage(db, { since: bad }).items.length, 1, String(bad));
    db.close();
  });

  test('housekeeping forgets old answered changes and keeps recent ones', () => {
    const db = openDb(':memory:');
    Y.finishOp(db, 1, 'op-old-00001', 200, { ok: true });
    Y.finishOp(db, 1, 'op-new-00001', 201, { slug: 'x' });
    db.prepare("UPDATE ops_seen SET at = ? WHERE client_id = 'op-old-00001'").run(now() - Y.OPS_KEEP - 10);
    // a claim whose request died long ago goes too
    assert.equal(Y.claimOp(db, 1, 'op-dead-00001'), 'new');
    db.prepare("UPDATE ops_seen SET at = ? WHERE client_id = 'op-dead-00001'").run(now() - Y.CLAIM_SECONDS - 10);
    assert.equal(housekeeping(db).sync.ops, 2);
    assert.equal(Y.claimOp(db, 1, 'op-old-00001'), 'new', 'forgotten: it would run again');
    assert.deepEqual(Y.claimOp(db, 1, 'op-new-00001'), { status: 201, body: { slug: 'x' } });
    assert.equal(Y.claimOp(db, 2, 'op-new-00001'), 'new', 'another phone with the same id is a different change');
    db.close();
  });
});

describe('typed notes', () => {
  test('a note is saved exactly as written, whatever it looks like', () => {
    const db = openDb(':memory:');
    const link = Y.createNote(db, { text: 'https://x.com/someone/status/1234567890' });
    const it = byId(db, link);
    assert.equal(it.kind, 'text');
    assert.equal(it.fetch_status, 'n/a', 'never fetched as a post');
    assert.equal(it.text, 'https://x.com/someone/status/1234567890');
    assert.equal(it.source_app, 'note');
    assert.equal(it.state, 'inbox');
    // the same words twice are two notes (no folding into an earlier save)
    const one = Y.createNote(db, { title: '  Plan   for Friday ', text: '  Ship it.\r\nThen rest.  ' });
    const two = Y.createNote(db, { title: 'Plan for Friday', text: 'Ship it.\nThen rest.' });
    assert.notEqual(one, two);
    assert.equal(byId(db, one).article_title, 'Plan for Friday');
    assert.equal(byId(db, one).text, 'Ship it.\nThen rest.');
    assert.equal(byId(db, one).text_hash, textHash('Ship it.\nThen rest.'));
    db.close();
  });

  test('validation', () => {
    const db = openDb(':memory:');
    for (const bad of [{}, { text: '' }, { text: '   \n ' }, { text: 5 }, { text: 'ok', title: 7 }, { text: 'ok', title: 'x'.repeat(Y.NOTE_TITLE_MAX + 1) }]) {
      assert.throws(() => Y.createNote(db, bad), (e) => e.status === 400 && e.expose === true, JSON.stringify(bad).slice(0, 60));
    }
    assert.throws(() => Y.createNote(db, { text: 'x'.repeat(Y.NOTE_TEXT_MAX + 1) }), (e) => e.status === 413);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
    db.close();
  });

  test('only your own notes can be edited; a stale edit is refused with the current note', () => {
    const db = openDb(':memory:');
    const id = Y.createNote(db, { title: 'Draft', text: 'First version' });
    const h1 = Y.noteVersion(byId(db, id));
    const before = revOf(db, 'items', id);
    Y.editNote(db, id, { title: 'Draft 2', text: 'Second version', base_version: h1 });
    assert.equal(byId(db, id).text, 'Second version');
    assert.equal(byId(db, id).article_title, 'Draft 2');
    assert.ok(revOf(db, 'items', id) > before, 'an edit is a change the phone will get');
    // the other device still has the first version
    assert.throws(() => Y.editNote(db, id, { text: 'From the other device', base_version: h1 }), (e) => {
      assert.equal(e.status, 409);
      assert.deepEqual(e.extra.current, { title: 'Draft 2', text: 'Second version', note_version: Y.noteVersion(byId(db, id)) });
      return true;
    });
    assert.equal(byId(db, id).text, 'Second version');
    // no base_version: the editor chose to overwrite
    Y.editNote(db, id, { text: 'Third version' });
    assert.equal(byId(db, id).article_title, null, 'a title left out is cleared');

    const saved = text(db, 'A saved quote from somebody else');
    assert.throws(() => Y.editNote(db, saved, { text: 'rewritten' }), (e) => e.status === 400);
    assert.equal(byId(db, saved).text, 'A saved quote from somebody else');
    db.prepare("UPDATE items SET voice_id = 9 WHERE id = ?").run(id);
    assert.throws(() => Y.editNote(db, id, { text: 'no' }), (e) => e.status === 400, 'a voice note is not hand-edited');
    assert.throws(() => Y.editNote(db, 9999, { text: 'no' }), (e) => e.status === 404);
    db.close();
  });

  test('a merged text names the note by its title', () => {
    const db = openDb(':memory:');
    const titled = Y.createNote(db, { title: 'Why this matters', text: 'Because it compounds.' });
    const plain = Y.createNote(db, { text: 'No title here.' });
    const saved = text(db, 'Somebody else said this');
    const r = renderItems(db, loadItemsInOrder(db, [titled, plain, saved]), { title: 'T' });
    assert.match(r.text, /## Note 1: Why this matters\nBecause it compounds\./);
    assert.match(r.text, /## Note 2\nNo title here\./);
    assert.match(r.text_sources, /\[Note 1\] My note · Why this matters · /);
    assert.match(r.text_sources, /\[Note 2\] My note · /);
    assert.match(r.text_sources, /\[Note 3\] Saved text/);
    db.close();
  });
});

// ======================================================================
async function boot() {
  const app = createApp({
    dbPath: ':memory:', passwordHash: await A.makePasswordHash(PW, 100000), secret: 's'.repeat(40),
    origins: 'http://vault.test', cookieSecure: false, startWorker: false,
    fetchFn: async () => new Response('{}', { status: 404 }), paceMs: 0, log: () => {},
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
    const body2 = await res.text();
    let json = null;
    try { json = JSON.parse(body2); } catch { /* text */ }
    return { status: res.status, text: body2, json };
  }
  assert.equal((await req('POST', '/api/login', { body: { password: PW } })).status, 200);
  const s = await req('POST', '/api/mfa/setup', { body: {} });
  advance(30);
  const c = await req('POST', '/api/mfa/confirm', { body: { code: totp(base32Decode(s.json.secret), now()) } });
  assert.equal(c.status, 200, c.text);
  return { app, db: app.db, req };
}

describe('the phone over HTTP', () => {
  let env; let phone; let saver; let reader; let ids;
  const as = (token) => (method, path, body, op) => env.req(method, path, { body, bearer: token, cookies: false, op });
  let P;   // the phone that may organize

  before(async () => {
    env = await boot();
    phone = A.createDeviceToken(env.db, 'Galaxy', 'capture,organize').token;
    saver = A.createDeviceToken(env.db, 'Save-only phone', 'capture').token;
    reader = A.createDeviceToken(env.db, 'Claude Code', 'read').token;
    P = as(phone);
    ids = Array.from({ length: 6 }, (_, i) => text(env.db, `Phone test item ${i} with a few more words`));
  });
  after(async () => { await env.app.close(); });

  test('who may sync', async () => {
    assert.equal((await as(saver)('GET', '/api/sync')).status, 403);
    assert.equal((await env.req('GET', '/api/sync', { cookies: false })).status, 401);
    const r = await P('GET', '/api/sync?since=0&limit=4');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.items.length, 4);
    assert.equal(r.json.more, true);
    // a read-only Claude key reads through /mcp (which logs every read), never through these routes
    assert.equal((await as(reader)('GET', '/api/sync')).status, 403);
    assert.equal((await as(reader)('GET', `/api/items/${ids[0]}`)).status, 403);
    assert.equal((await as(saver)('GET', `/api/items/${ids[0]}`)).status, 403);
    const web = await env.req('GET', '/api/sync');
    assert.equal(web.status, 200);
    assert.equal(web.json.items.length, 6);
    assert.equal(web.json.more, false);
    // a read-only key still cannot change anything
    assert.equal((await as(reader)('PATCH', `/api/items/${ids[0]}`, { state: 'archived' })).status, 403);
    assert.equal((await as(reader)('POST', '/api/notes', { text: 'no' })).status, 403);
    assert.equal((await as(saver)('POST', '/api/notes', { text: 'no' })).status, 403);
  });

  test('the phone copies the vault, changes it, and the next sync shows exactly those changes', async () => {
    // copy
    let since = 0; const have = new Map();
    for (;;) {
      const r = (await P('GET', `/api/sync?since=${since}&limit=3`)).json;
      for (const it of r.items) have.set(it.id, it);
      since = r.rev;
      if (!r.more) break;
    }
    assert.deepEqual([...have.keys()].sort((a, b) => a - b), ids);

    // change: archive one, tag and note another, trash a third, write a note, make and edit a merge
    assert.equal((await P('PATCH', `/api/items/${ids[0]}`, { state: 'archived' })).status, 200);
    assert.equal((await P('PATCH', `/api/items/${ids[1]}`, { add_tags: ['phone'], priority: 3, my_note: 'why I kept it' })).status, 200);
    assert.equal((await P('POST', '/api/items/bulk', { ids: [ids[2]], state: 'trashed' })).status, 200);
    const note = await P('POST', '/api/notes', { title: 'On the train', text: 'An idea I had.' });
    assert.equal(note.status, 201, note.text);
    assert.equal(note.json.item.own_note, true);
    assert.equal(note.json.item.title, 'On the train');
    assert.equal(note.json.item.text, 'An idea I had.');
    const noteId = note.json.item.id;
    const made = await P('POST', '/api/bundles', { title: 'Phone merge', item_ids: [ids[3], ids[4]] });
    assert.equal(made.status, 201, made.text);
    const slug = made.json.slug;
    const added = await P('POST', `/api/bundles/${slug}/add`, { item_ids: [noteId] });
    assert.equal(added.status, 200, added.text);

    const r = (await P('GET', `/api/sync?since=${since}`)).json;
    assert.equal(r.more, false);
    const got = new Map(r.items.map((i) => [i.id, i]));
    assert.equal(got.get(ids[0]).state, 'archived');
    assert.deepEqual(got.get(ids[1]).tags, ['phone']);
    assert.equal(got.get(ids[1]).my_note, 'why I kept it');
    assert.equal(got.get(ids[1]).priority, 3);
    assert.equal(got.get(ids[2]).state, 'trashed');
    assert.equal(got.get(noteId).own_note, true);
    assert.ok(!got.has(ids[5]), 'an untouched item is not sent again');
    assert.equal(r.bundles.length, 1);
    assert.equal(r.bundles[0].slug, slug);
    assert.deepEqual(r.bundles[0].item_ids, [ids[3], ids[4], noteId]);
    assert.equal(r.bundles[0].version, added.json.version);
    assert.deepEqual(r.tags, ['phone']);
    // full text comes from the item and the merge
    const full = await P('GET', `/api/items/${noteId}`);
    assert.equal(full.status, 200);
    assert.equal(full.json.item.text, 'An idea I had.');
    const merge = await P('GET', `/api/bundles/${slug}`);
    assert.equal(merge.status, 200);
    assert.match(merge.json.text, /## Note 3: On the train\nAn idea I had\./);
  });

  test('editing a merge from the phone: reorder, rename, stale version, combine, unmerge', async () => {
    const slug = 'phone-merge';
    const cur = (await P('GET', `/api/bundles/${slug}`)).json;
    const order = cur.items.map((i) => i.id);
    const re = await P('PUT', `/api/bundles/${slug}`, { version: cur.bundle.version, title: 'Renamed on the phone', item_ids: [order[2], order[0], order[1]] });
    assert.equal(re.status, 200, re.text);
    assert.equal(re.json.version, cur.bundle.version + 1);
    const after = (await P('GET', `/api/bundles/${slug}`)).json;
    assert.equal(after.bundle.title, 'Renamed on the phone');
    assert.deepEqual(after.items.map((i) => i.id), [order[2], order[0], order[1]]);
    // the website changed it meanwhile: the phone's older version is refused, nothing is overwritten
    const stale = await P('PUT', `/api/bundles/${slug}`, { version: cur.bundle.version, title: 'Lost update' });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error, 'stale');
    assert.equal((await P('GET', `/api/bundles/${slug}`)).json.bundle.title, 'Renamed on the phone');

    const other = await P('POST', '/api/bundles', { title: 'Second', item_ids: [ids[5]] });
    const comb = await P('POST', `/api/bundles/${slug}/combine`, { from: other.json.slug });
    assert.equal(comb.status, 200, comb.text);
    assert.equal((await P('GET', `/api/bundles/${other.json.slug}`)).status, 404);
    const before = Y.currentRev(env.db);
    const un = await P('DELETE', `/api/bundles/${slug}`);
    assert.equal(un.status, 200, un.text);
    assert.equal(un.json.returned, 4);
    const r = (await P('GET', `/api/sync?since=${before}`)).json;
    assert.equal(r.deleted.bundles.length, 1);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM bundles').get().n, 0);
  });

  test('a resent change is answered again and not run twice', async () => {
    const n = () => env.db.prepare("SELECT COUNT(*) AS n FROM items WHERE source_app = 'note'").get().n;
    const start = n();
    const first = await P('POST', '/api/notes', { text: 'Sent in a tunnel' }, 'op-note-0001');
    assert.equal(first.status, 201);
    const again = await P('POST', '/api/notes', { text: 'Sent in a tunnel' }, 'op-note-0001');
    assert.equal(again.status, 201);
    assert.deepEqual(again.json, first.json);
    assert.equal(n(), start + 1);
    // the same for a merge
    const m1 = await P('POST', '/api/bundles', { title: 'Once', item_ids: [ids[0]] }, 'op-merge-0001');
    const m2 = await P('POST', '/api/bundles', { title: 'Once', item_ids: [ids[0]] }, 'op-merge-0001');
    assert.equal(m1.status, 201);
    assert.deepEqual(m2.json, m1.json);
    assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM bundles WHERE title = 'Once'").get().n, 1);
    // a change that failed is not remembered: fixing it and sending again works
    const bad = await P('POST', '/api/notes', { text: '   ' }, 'op-note-0002');
    assert.equal(bad.status, 400);
    assert.equal((await P('POST', '/api/notes', { text: 'Now with words' }, 'op-note-0002')).status, 201);
    // without an id every send is a new change; a malformed id is refused
    await P('POST', '/api/notes', { text: 'No id' });
    await P('POST', '/api/notes', { text: 'No id' });
    assert.equal(n(), start + 4);
    assert.equal((await P('POST', '/api/notes', { text: 'x' }, 'short')).status, 400);
    // another phone using the same id is a separate change
    const other = A.createDeviceToken(env.db, 'Tablet', 'capture,organize').token;
    assert.equal((await as(other)('POST', '/api/notes', { text: 'From the tablet' }, 'op-note-0001')).json.item.text, 'From the tablet');
    // the website sends no id and is never replayed
    assert.equal((await env.req('POST', '/api/notes', { body: { text: 'From the website' }, op: 'op-note-0001' })).json.item.text, 'From the website');
  });

  test('editing a note over HTTP, with the stale answer carrying the current note', async () => {
    const made = (await P('POST', '/api/notes', { title: 'T', text: 'v1' })).json.item;
    assert.equal(made.note_version, Y.noteVersion(byId(env.db, made.id)));
    const web = await env.req('PATCH', `/api/notes/${made.id}`, { body: { title: 'T', text: 'v2 from the website', base_version: made.note_version } });
    assert.equal(web.status, 200, web.text);
    const stale = await P('PATCH', `/api/notes/${made.id}`, { title: 'T', text: 'v2 from the phone', base_version: made.note_version });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error, 'stale');
    assert.equal(stale.json.current.text, 'v2 from the website');
    const ok = await P('PATCH', `/api/notes/${made.id}`, { title: 'T', text: 'both edits, joined by hand', base_version: stale.json.current.note_version });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.item.text, 'both edits, joined by hand');
    // a saved item is never editable this way
    assert.equal((await P('PATCH', `/api/notes/${ids[0]}`, { text: 'rewrite someone else' })).status, 400);
    assert.equal((await P('PATCH', '/api/notes/99999', { text: 'x' })).status, 404);
    assert.equal(byId(env.db, ids[0]).text, 'Phone test item 0 with a few more words');
  });

  test('a phone changes at most 200 items in one request', async () => {
    const many = Array.from({ length: 201 }, (_, i) => i + 1);
    const over = await P('POST', '/api/items/bulk', { ids: many, priority: 1 });
    assert.equal(over.status, 400);
    assert.match(over.json.message, /At most 200 items/);
    assert.match((await P('POST', '/api/items/bulk', { ids: 'x', priority: 1 })).json.message, /must be a list/);
    assert.equal((await P('POST', '/api/items/bulk', { ids: many.slice(0, 200), priority: 1 })).status, 200);
    assert.equal((await env.req('POST', '/api/items/bulk', { body: { ids: many, priority: 1 } })).status, 200);
  });
});
