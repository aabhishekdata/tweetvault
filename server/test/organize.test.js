// Organizing and merge-lifecycle tests: v1 -> v2 migration, merges hiding items from the Inbox,
// adding to a merge, categories, tags, priority, filters and sorts.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import * as A from '../src/auth.js';
import * as O from '../src/organize.js';
import { totp, base32Decode } from '../src/totp.js';
import { openDb, now } from '../src/db.js';

// the schema version a fresh database reaches (one per migration in db.js)
const LATEST = openDb(':memory:').prepare('PRAGMA user_version').get().user_version;

const HERE = dirname(fileURLToPath(import.meta.url));
const PW = 'correct horse battery staple';

// ---- controllable clock (TOTP steps) ----
const realNow = Date.now;
let skewMs = 0;
Date.now = () => realNow() + skewMs;
const advance = (sec) => { skewMs += sec * 1000; };

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function fakeFetch() {
  return new Response('', { status: 404 });
}

async function boot() {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const app = createApp({
    dbPath: ':memory:', passwordHash: await A.makePasswordHash(PW, 100000), secret: 'x'.repeat(40),
    origins: origin, cookieSecure: false, trustProxy: false, startWorker: false, fetchFn: fakeFetch, paceMs: 0,
    log: () => {},
  });
  await app.listen(port, '127.0.0.1');
  const jar = new Map();
  async function req(method, path, body) {
    const headers = { Origin: origin };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const res = await fetch(origin + path, { method, headers, body: payload });
    for (const sc of res.headers.getSetCookie()) {
      const [kv, ...attrs] = sc.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i).trim();
      const v = decodeURIComponent(kv.slice(i + 1).trim());
      const maxAge = attrs.map((a) => a.trim()).find((a) => a.startsWith('Max-Age='));
      if (!v || maxAge === 'Max-Age=0') jar.delete(k); else jar.set(k, v);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, text, json };
  }
  // sign in and set up two-step
  const lg = await req('POST', '/api/login', { password: PW });
  assert.equal(lg.status, 200, lg.text);
  const s = await req('POST', '/api/mfa/setup', {});
  assert.equal(s.status, 200, s.text);
  const secret = base32Decode(s.json.secret);
  advance(30);
  const c = await req('POST', '/api/mfa/confirm', { code: totp(secret, now()) });
  assert.equal(c.status, 200, c.text);
  const me = await req('GET', '/api/me');
  assert.equal(me.json.signed_in, true);
  return { app, db: app.db, req };
}

function insertItem(db, f) {
  const cols = Object.keys(f);
  return Number(db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => f[c])).lastInsertRowid);
}

function wipe(db) {
  db.exec(`DELETE FROM bundle_tags; DELETE FROM item_tags; DELETE FROM bundle_items; DELETE FROM bundles;
    DELETE FROM tags; DELETE FROM captures; DELETE FROM raw_fetches; DELETE FROM items; DELETE FROM categories;`);
}

// An article with the author's follow-up, a reply and a reply to that reply; a second conversation; a note.
const RA = '1910000000000000001';
const RB = '1920000000000000001';
function seed(db) {
  const t = now() - 1000;
  const base = { kind: 'tweet', fetch_status: 'ok', saved: 1, state: 'inbox', first_saved_at: t, last_saved_at: t };
  const root = insertItem(db, { ...base, kind: 'article', tweet_id: RA, root_tweet_id: RA, author_handle: 'alice', article_title: 'Big article', article_md: 'Body', posted_at: 1000 });
  const self = insertItem(db, { ...base, tweet_id: '1910000000000000002', root_tweet_id: RA, parent_tweet_id: RA, is_self_thread: 1, author_handle: 'alice', text: 'Part two', posted_at: 1001 });
  const r1 = insertItem(db, { ...base, tweet_id: '1910000000000000003', root_tweet_id: RA, parent_tweet_id: RA, author_handle: 'bob', text: 'Reply from bob', posted_at: 1002 });
  const r2 = insertItem(db, { ...base, tweet_id: '1910000000000000004', root_tweet_id: RA, parent_tweet_id: '1910000000000000003', author_handle: 'carol', text: 'Reply to bob', posted_at: 1003 });
  const bRoot = insertItem(db, { ...base, tweet_id: RB, root_tweet_id: RB, author_handle: 'dave', text: 'Other convo', posted_at: 2000 });
  const bReply = insertItem(db, { ...base, tweet_id: '1920000000000000002', root_tweet_id: RB, parent_tweet_id: RB, author_handle: 'erin', text: 'Other reply', posted_at: 2001 });
  const note = insertItem(db, { kind: 'text', fetch_status: 'n/a', saved: 1, state: 'inbox', text: 'A loose note', first_saved_at: t, last_saved_at: t });
  return { root, self, r1, r2, bRoot, bReply, note };
}
const lateReply = (db) => insertItem(db, {
  kind: 'tweet', fetch_status: 'ok', saved: 1, state: 'inbox', tweet_id: '1910000000000000009', root_tweet_id: RA, parent_tweet_id: RA,
  author_handle: 'frank', text: 'Late reply', posted_at: 1100, first_saved_at: now(), last_saved_at: now(),
});

// every item id shown in the inbox, split into visible and context
function inboxIds(groups) {
  const vis = new Set();
  const ctx = new Set();
  const all = [];
  for (const g of groups) {
    for (const it of [g.root, ...g.thread, ...g.replies].filter(Boolean)) {
      (it.context ? ctx : vis).add(it.id);
      all.push(it);
    }
  }
  return { vis, ctx, all };
}

// ======================================================================
describe('migration v1 -> v2 on an existing database', () => {
  const v1Sql = () => {
    const src = readFileSync(join(HERE, '..', 'src', 'db.js'), 'utf8');
    const start = src.indexOf('`', src.indexOf('// v1'));
    const end = src.indexOf('`,', start);
    assert.ok(start > 0 && end > start, 'found the v1 migration');
    return src.slice(start + 1, end);
  };
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'tv-mig-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('data survives and new columns default to priority 0 / category null', () => {
    const path = join(dir, 'v1.db');
    const old = new DatabaseSync(path);
    old.exec('PRAGMA foreign_keys=ON;');
    old.exec(v1Sql());
    old.exec('PRAGMA user_version = 1');
    assert.equal(old.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(old.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('items') WHERE name = 'priority'").get().n, 0);
    const a = insertItem(old, { kind: 'tweet', tweet_id: '1930000000000000001', root_tweet_id: '1930000000000000001', text: 'Old tweet', fetch_status: 'ok', state: 'archived', likes: 7 });
    const b = insertItem(old, { kind: 'text', text: 'Old note', fetch_status: 'n/a' });
    old.prepare("INSERT INTO bundles (slug, title, created_at, updated_at, version) VALUES ('old', 'Old merge', 1, 2, 5)").run();
    old.prepare('INSERT INTO bundle_items (bundle_id, item_id, position) VALUES (1, ?, 0), (1, ?, 1)').run(b, a);
    old.prepare("INSERT INTO kv (key, value) VALUES ('k', 'v')").run();
    old.close();

    const db = openDb(path);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, LATEST);
      const items = db.prepare('SELECT * FROM items ORDER BY id').all();
      assert.equal(items.length, 2);
      assert.equal(items[0].text, 'Old tweet');
      assert.equal(items[0].tweet_id, '1930000000000000001');
      assert.equal(items[0].state, 'archived');
      assert.equal(items[0].likes, 7);
      assert.equal(items[1].text, 'Old note');
      for (const it of items) { assert.equal(it.priority, 0); assert.equal(it.category_id, null); }
      const bun = db.prepare('SELECT * FROM bundles').get();
      assert.equal(bun.title, 'Old merge');
      assert.equal(bun.version, 5);
      assert.equal(bun.priority, 0);
      assert.equal(bun.category_id, null);
      assert.deepEqual(db.prepare('SELECT item_id FROM bundle_items ORDER BY position').all().map((r) => r.item_id), [b, a]);
      assert.equal(db.prepare("SELECT value FROM kv WHERE key = 'k'").get().value, 'v');
      for (const t of ['categories', 'tags', 'item_tags', 'bundle_tags']) {
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
      }
      // the new foreign key works on the migrated columns
      const c = O.createCategory(db, 'Reading');
      db.prepare('UPDATE items SET category_id = ? WHERE id = ?').run(c, a);
      db.prepare('UPDATE bundles SET category_id = ? WHERE id = 1').run(c);
      db.prepare('DELETE FROM categories WHERE id = ?').run(c);
      assert.equal(db.prepare('SELECT category_id FROM items WHERE id = ?').get(a).category_id, null);
      assert.equal(db.prepare('SELECT category_id FROM bundles WHERE id = 1').get().category_id, null);
      // NOT NULL default holds for rows inserted after the migration
      const n = insertItem(db, { kind: 'text', text: 'new', fetch_status: 'n/a' });
      assert.equal(db.prepare('SELECT priority FROM items WHERE id = ?').get(n).priority, 0);
    } finally { db.close(); }

    // opening again does not re-run anything
    const again = openDb(path);
    try {
      assert.equal(again.prepare('PRAGMA user_version').get().user_version, LATEST);
      assert.equal(again.prepare('SELECT COUNT(*) AS n FROM items').get().n, 3);
    } finally { again.close(); }
  });

  test('a fresh database comes up at the latest version', () => {
    const db = openDb(':memory:');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12, "bump this when a migration is added");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('bundles') WHERE name IN ('priority','category_id')").get().n, 2);
    db.close();
  });
});

// ======================================================================
describe('over HTTP', () => {
  let env;
  let S;
  before(async () => { env = await boot(); });
  after(async () => { await env.app.close(); });
  beforeEach(() => { wipe(env.db); S = seed(env.db); });

  const inbox = async (qs = '') => {
    const r = await env.req('GET', `/api/inbox${qs}`);
    assert.equal(r.status, 200, r.text);
    return r.json.groups;
  };
  const merge = async (ids, title = 'My merge') => {
    const r = await env.req('POST', '/api/bundles', { title, item_ids: ids });
    assert.equal(r.status, 201, r.text);
    return r.json.slug;
  };
  const bundleIds = (slug) => env.db.prepare(`SELECT bi.item_id FROM bundle_items bi JOIN bundles b ON b.id = bi.bundle_id
      WHERE b.slug = ? ORDER BY bi.position`).all(slug).map((r) => r.item_id);
  const itemCount = () => env.db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  const tagsOf = (id) => env.db.prepare('SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = ? ORDER BY t.name').all(id).map((r) => r.name);
  const allTags = () => env.db.prepare('SELECT name FROM tags ORDER BY name').all().map((r) => r.name);

  // ---------------- merge visibility ----------------
  describe('merging hides items from the Inbox and unmerging brings them back', () => {
    test('merged items leave the Inbox; others stay', async () => {
      const before = inboxIds(await inbox());
      for (const id of Object.values(S)) assert.ok(before.vis.has(id), `item ${id} visible before`);
      await merge([S.root, S.self, S.r1, S.r2]);
      const after = inboxIds(await inbox());
      for (const id of [S.root, S.self, S.r1, S.r2]) {
        assert.ok(!after.vis.has(id), `item ${id} hidden`);
        assert.ok(!after.ctx.has(id), `item ${id} not even shown as context`);
      }
      for (const id of [S.bRoot, S.bReply, S.note]) assert.ok(after.vis.has(id));
      const org = await env.req('GET', '/api/organize');
      assert.equal(org.json.counts.inbox, 3);
      assert.equal(org.json.counts.merged, 1);
    });

    test('merged items are hidden from the Archived list too', async () => {
      env.db.prepare("UPDATE items SET state = 'archived' WHERE id IN (?, ?)").run(S.bRoot, S.bReply);
      assert.ok(inboxIds(await inbox('?state=archived')).vis.has(S.bReply));
      await merge([S.bRoot, S.bReply]);
      assert.equal((await inbox('?state=archived')).length, 0);
    });

    test('removing an item from the merge (PUT with fewer item_ids) brings it back', async () => {
      const slug = await merge([S.root, S.self, S.r1, S.r2]);
      const r = await env.req('PUT', `/api/bundles/${slug}`, { item_ids: [S.root, S.self, S.r1] });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(bundleIds(slug), [S.root, S.self, S.r1]);
      const { vis, ctx, all } = inboxIds(await inbox());
      assert.ok(vis.has(S.r2));
      // its parent chain is still in the merge, so it is shown only as context
      assert.ok(ctx.has(S.r1) && ctx.has(S.root));
      assert.ok(!vis.has(S.r1) && !vis.has(S.root) && !vis.has(S.self));
      assert.equal(all.find((x) => x.id === S.r1).merged_in[0].slug, slug);
    });

    test('PUT with no remaining items -> 400 and the merge is unchanged', async () => {
      const slug = await merge([S.root, S.r1]);
      const r = await env.req('PUT', `/api/bundles/${slug}`, { item_ids: [] });
      assert.equal(r.status, 400);
      assert.deepEqual(bundleIds(slug), [S.root, S.r1]);
      const r2 = await env.req('PUT', `/api/bundles/${slug}`, { item_ids: [999999] });
      assert.equal(r2.status, 400);
      assert.deepEqual(bundleIds(slug), [S.root, S.r1]);
    });

    test('DELETE (unmerge) brings every item back and deletes no items', async () => {
      const slug = await merge([S.root, S.self, S.r1, S.r2], 'Gone soon');
      const n = itemCount();
      const r = await env.req('DELETE', `/api/bundles/${slug}`);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.returned, 4);
      assert.equal(itemCount(), n);
      assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM bundle_items').get().n, 0);
      assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM bundles').get().n, 0);
      const { vis, ctx } = inboxIds(await inbox());
      for (const id of Object.values(S)) assert.ok(vis.has(id), `item ${id} back`);
      assert.equal(ctx.size, 0);
      assert.equal((await env.req('GET', `/api/bundles/${slug}`)).status, 404);
      assert.equal((await env.req('DELETE', `/api/bundles/${slug}`)).status, 404);
    });

    test('an item in two merges stays hidden until it is out of both', async () => {
      const a = await merge([S.bRoot, S.bReply], 'A');
      const b = await merge([S.bReply, S.note], 'B');
      assert.ok(!inboxIds(await inbox()).vis.has(S.bReply));
      const row = env.db.prepare('SELECT 1 FROM items WHERE id = ?').get(S.bReply);
      assert.ok(row);
      await env.req('PUT', `/api/bundles/${a}`, { item_ids: [S.bRoot] });
      let ids = inboxIds(await inbox());
      assert.ok(!ids.vis.has(S.bReply), 'still in B');
      await env.req('DELETE', `/api/bundles/${b}`);
      ids = inboxIds(await inbox());
      assert.ok(ids.vis.has(S.bReply), 'back once out of both');
      assert.ok(ids.vis.has(S.note));
      assert.ok(ids.ctx.has(S.bRoot), 'root still merged in A, shown as context');
    });

    test('a stale editor cannot push items out of a merge (version check), and merged items become live again', async () => {
      const slug = await merge([S.root, S.r1]);
      const v1 = (await env.req('GET', `/api/bundles/${slug}`)).json.bundle.version;
      // somewhere else, a late reply is added to the merge
      const add = await env.req('POST', `/api/bundles/${slug}/add`, { item_ids: [S.r2] });
      assert.equal(add.status, 200, add.text);
      assert.ok(add.json.version > v1);
      // the old editor still thinks the merge is [root, r1] and saves with its old version: refused
      const stale = await env.req('PUT', `/api/bundles/${slug}`, { title: 'x', item_ids: [S.root, S.r1], version: v1 });
      assert.equal(stale.status, 409, stale.text);
      assert.deepEqual(bundleIds(slug).sort(), [S.root, S.r1, S.r2].sort(), 'nothing was pushed out');
      // with the current version it saves, and the reply returned to the Inbox is live (not archived/trashed)
      env.db.prepare("UPDATE items SET state = 'trashed', trashed_at = 1 WHERE id = ?").run(S.r2);
      const ok = await env.req('PUT', `/api/bundles/${slug}`, { item_ids: [S.root, S.r1], version: add.json.version });
      assert.equal(ok.status, 200, ok.text);
      const row = env.db.prepare('SELECT state, trashed_at FROM items WHERE id = ?').get(S.r2);
      assert.equal(row.state, 'inbox');
      assert.equal(row.trashed_at, null);
      // unmerging also leaves every item live in the Inbox
      env.db.prepare("UPDATE items SET state = 'archived' WHERE id = ?").run(S.r1);
      await env.req('DELETE', `/api/bundles/${slug}`);
      assert.equal(env.db.prepare('SELECT state FROM items WHERE id = ?').get(S.r1).state, 'inbox');
    });
  });

  // ---------------- add to merge ----------------
  describe('POST /api/bundles/:slug/add', () => {
    test('late reply lands after existing replies in its conversation; new conversation goes last; dedupes', async () => {
      const slug = await merge([S.root, S.self, S.r1, S.r2, S.note]);
      assert.deepEqual(bundleIds(slug), [S.root, S.self, S.r1, S.r2, S.note]);
      const v0 = env.db.prepare('SELECT version FROM bundles WHERE slug = ?').get(slug).version;
      const late = lateReply(env.db);
      const r = await env.req('POST', `/api/bundles/${slug}/add`, { item_ids: [S.bRoot, late, S.r1, late] });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.added, 2);
      assert.equal(r.json.already, 1);
      assert.deepEqual(bundleIds(slug), [S.root, S.self, S.r1, S.r2, late, S.note, S.bRoot]);
      assert.equal(env.db.prepare('SELECT version FROM bundles WHERE slug = ?').get(slug).version, v0 + 1);
      // and the rendered text has the late reply under the article
      const g = await env.req('GET', `/api/bundles/${slug}`);
      const txt = g.json.text;
      assert.ok(txt.indexOf('Late reply') > txt.indexOf('Reply to bob'));
      assert.ok(txt.indexOf('Late reply') < txt.indexOf('Other convo'));
    });

    test('adding only items already in the merge changes nothing', async () => {
      const slug = await merge([S.root, S.r1]);
      const r = await env.req('POST', `/api/bundles/${slug}/add`, { item_ids: [S.r1, S.root] });
      assert.equal(r.status, 200);
      assert.equal(r.json.added, 0);
      assert.equal(r.json.already, 2);
      assert.deepEqual(bundleIds(slug), [S.root, S.r1]);
    });

    test('tags of added items are added to the merge', async () => {
      const slug = await merge([S.root]);
      await env.req('PATCH', `/api/items/${S.bRoot}`, { add_tags: ['later', 'AI'] });
      const r = await env.req('POST', `/api/bundles/${slug}/add`, { item_ids: [S.bRoot] });
      assert.equal(r.status, 200);
      const g = await env.req('GET', `/api/bundles/${slug}`);
      assert.deepEqual(g.json.bundle.tags, ['AI', 'later']);
    });

    test('404 for an unknown merge, 400 for empty / unknown / malformed item lists', async () => {
      const slug = await merge([S.root]);
      assert.equal((await env.req('POST', '/api/bundles/nope/add', { item_ids: [S.r1] })).status, 404);
      assert.equal((await env.req('POST', `/api/bundles/${slug}/add`, { item_ids: [] })).status, 400);
      assert.equal((await env.req('POST', `/api/bundles/${slug}/add`, { item_ids: [987654] })).status, 400);
      assert.equal((await env.req('POST', `/api/bundles/${slug}/add`, { item_ids: 'x' })).status, 400);
      assert.equal((await env.req('POST', `/api/bundles/${slug}/add`, {})).status, 400);
      assert.deepEqual(bundleIds(slug), [S.root]);
    });

    test('added items leave the Inbox', async () => {
      const slug = await merge([S.root, S.self, S.r1, S.r2]);
      const late = lateReply(env.db);
      assert.ok(inboxIds(await inbox()).vis.has(late));
      await env.req('POST', `/api/bundles/${slug}/add`, { item_ids: [late] });
      const { vis, ctx } = inboxIds(await inbox());
      assert.ok(!vis.has(late) && !ctx.has(late));
      assert.ok(!ctx.has(S.root), 'nothing of the article left to show');
    });
  });

  // ---------------- inbox context ----------------
  test('a merged root shows as context with merged_in when a new unmerged reply exists', async () => {
    const slug = await merge([S.root, S.self, S.r1, S.r2], 'Article merge');
    const late = lateReply(env.db);
    const groups = await inbox();
    const g = groups.find((x) => x.key === RA);
    assert.ok(g, 'article group present');
    assert.equal(g.root.id, S.root);
    assert.equal(g.root.context, true);
    assert.deepEqual(g.root.merged_in, [{ slug, title: 'Article merge' }]);
    assert.equal(g.root.in_bundles, 1);
    assert.deepEqual(g.replies.map((r) => r.id), [late]);
    assert.equal(g.replies[0].context, false);
    assert.deepEqual(g.replies[0].merged_in, []);
    assert.deepEqual(g.thread, [], 'merged thread parts are not ancestors of the late reply');
  });

  // ---------------- categories ----------------
  describe('categories', () => {
    test('create, duplicate (case-insensitive), empty name', async () => {
      const a = await env.req('POST', '/api/categories', { name: '  Reading   list ' });
      assert.equal(a.status, 201, a.text);
      assert.ok(Number.isInteger(a.json.id));
      assert.equal(env.db.prepare('SELECT name FROM categories WHERE id = ?').get(a.json.id).name, 'Reading list');
      assert.equal((await env.req('POST', '/api/categories', { name: 'READING LIST' })).status, 400);
      assert.equal((await env.req('POST', '/api/categories', { name: '   ' })).status, 400);
      assert.equal((await env.req('POST', '/api/categories', {})).status, 400);
      const b = await env.req('POST', '/api/categories', { name: 'Work' });
      const org = await env.req('GET', '/api/organize');
      assert.deepEqual(org.json.categories.map((c) => [c.id, c.name, c.position]), [[a.json.id, 'Reading list', 0], [b.json.id, 'Work', 1]]);
    });

    test('rename: clash -> 400, own name in another case -> ok, unknown -> 404', async () => {
      const a = (await env.req('POST', '/api/categories', { name: 'Reading' })).json.id;
      const b = (await env.req('POST', '/api/categories', { name: 'Work' })).json.id;
      assert.equal((await env.req('PATCH', `/api/categories/${b}`, { name: 'reading' })).status, 400);
      assert.equal((await env.req('PATCH', `/api/categories/${a}`, { name: 'READING' })).status, 200);
      assert.equal(env.db.prepare('SELECT name FROM categories WHERE id = ?').get(a).name, 'READING');
      assert.equal((await env.req('PATCH', `/api/categories/${b}`, { name: '' })).status, 400);
      assert.equal((await env.req('PATCH', '/api/categories/99999', { name: 'New' })).status, 404);
      assert.equal((await env.req('PATCH', '/api/categories/abc', { name: 'New' })).status, 404);
    });

    test('delete uncategorises items and merges, deletes nothing else', async () => {
      const c = (await env.req('POST', '/api/categories', { name: 'Reading' })).json.id;
      assert.equal((await env.req('PATCH', `/api/items/${S.note}`, { category_id: c })).status, 200);
      const slug = await merge([S.bRoot]);
      assert.equal((await env.req('PUT', `/api/bundles/${slug}`, { category_id: c })).status, 200);
      const n = itemCount();
      assert.equal((await env.req('DELETE', `/api/categories/${c}`)).status, 200);
      assert.equal(env.db.prepare('SELECT category_id FROM items WHERE id = ?').get(S.note).category_id, null);
      assert.equal(env.db.prepare('SELECT category_id FROM bundles WHERE slug = ?').get(slug).category_id, null);
      assert.equal(itemCount(), n);
      assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM bundles').get().n, 1);
      assert.equal((await env.req('DELETE', `/api/categories/${c}`)).status, 404);
    });
  });

  // ---------------- item meta ----------------
  describe('item category / priority / tags', () => {
    test('bulk sets category, priority and tags; skips unknown ids', async () => {
      const c = (await env.req('POST', '/api/categories', { name: 'Reading' })).json.id;
      const r = await env.req('POST', '/api/items/bulk', { ids: [S.note, S.bRoot, 999999, 'x'], category_id: c, priority: 2, add_tags: ['#AI', '  deep   learning ', 'ai'] });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.changed, 2);
      for (const id of [S.note, S.bRoot]) {
        const row = env.db.prepare('SELECT category_id, priority FROM items WHERE id = ?').get(id);
        assert.equal(row.category_id, c);
        assert.equal(row.priority, 2);
        assert.deepEqual(tagsOf(id), ['AI', 'deep learning']);
      }
      assert.equal(env.db.prepare('SELECT priority FROM items WHERE id = ?').get(S.r1).priority, 0);
      // same tag in another case reuses the existing tag
      await env.req('PATCH', `/api/items/${S.r1}`, { add_tags: ['ai', '##Ai'] });
      assert.deepEqual(tagsOf(S.r1), ['AI']);
      assert.deepEqual(allTags(), ['AI', 'deep learning']);
    });

    test('remove_tags (any case, with #) and unused tags are pruned', async () => {
      await env.req('POST', '/api/items/bulk', { ids: [S.note, S.bRoot], add_tags: ['AI', 'keep'] });
      let r = await env.req('POST', '/api/items/bulk', { ids: [S.note], remove_tags: ['#ai'] });
      assert.equal(r.status, 200);
      assert.deepEqual(tagsOf(S.note), ['keep']);
      assert.deepEqual(allTags(), ['AI', 'keep'], 'still used by bRoot');
      r = await env.req('PATCH', `/api/items/${S.bRoot}`, { remove_tags: ['AI'] });
      assert.equal(r.status, 200);
      assert.deepEqual(allTags(), ['keep']);
      // remove a tag nobody has: fine
      assert.equal((await env.req('PATCH', `/api/items/${S.bRoot}`, { remove_tags: ['never'] })).status, 200);
    });

    test('tag kept while a merge uses it, pruned when the merge drops it', async () => {
      const slug = await merge([S.note]);
      await env.req('PUT', `/api/bundles/${slug}`, { tags: ['#Merged', 'merged', ' two  words '] });
      assert.deepEqual((await env.req('GET', `/api/bundles/${slug}`)).json.bundle.tags, ['Merged', 'two words']);
      await env.req('PUT', `/api/bundles/${slug}`, { tags: ['two words'] });
      assert.deepEqual(allTags(), ['two words']);
    });

    test('category null / "none" uncategorises', async () => {
      const c = (await env.req('POST', '/api/categories', { name: 'Reading' })).json.id;
      await env.req('PATCH', `/api/items/${S.note}`, { category_id: c });
      assert.equal((await env.req('PATCH', `/api/items/${S.note}`, { category_id: null })).status, 200);
      assert.equal(env.db.prepare('SELECT category_id FROM items WHERE id = ?').get(S.note).category_id, null);
      await env.req('PATCH', `/api/items/${S.note}`, { category_id: c });
      assert.equal((await env.req('PATCH', `/api/items/${S.note}`, { category_id: 'none' })).status, 200);
      assert.equal(env.db.prepare('SELECT category_id FROM items WHERE id = ?').get(S.note).category_id, null);
    });

    test('invalid priority / category / tags -> 400 and nothing changes', async () => {
      const bad = [
        { priority: 5 }, { priority: -1 }, { priority: 'high' }, { priority: 1.5 },
        { category_id: 99999 }, { category_id: 'abc' }, { category_id: 1.5 },
        { add_tags: 'ai' }, { remove_tags: { a: 1 } }, { add_tags: Array.from({ length: 51 }, (_, i) => `t${i}`) },
      ];
      for (const b of bad) {
        const r = await env.req('POST', '/api/items/bulk', { ids: [S.note], add_tags: b.add_tags ? undefined : ['x'], ...b });
        assert.equal(r.status, 400, JSON.stringify(b));
        const p = await env.req('PATCH', `/api/items/${S.note}`, b);
        assert.equal(p.status, 400, `PATCH ${JSON.stringify(b)}`);
      }
      assert.deepEqual(tagsOf(S.note), []);
      assert.equal(env.db.prepare('SELECT priority FROM items WHERE id = ?').get(S.note).priority, 0);
      assert.equal((await env.req('POST', '/api/items/bulk', { ids: 'x', priority: 1 })).status, 400);
      assert.equal((await env.req('POST', '/api/items/bulk', { ids: [S.note] })).status, 400, 'nothing to change');
      assert.equal((await env.req('PATCH', '/api/items/999999', { priority: 1 })).status, 404);
    });

    test('PATCH with state and an invalid priority changes nothing', async () => {
      const r = await env.req('PATCH', `/api/items/${S.note}`, { state: 'archived', priority: 9 });
      assert.equal(r.status, 400);
      assert.equal(env.db.prepare('SELECT state FROM items WHERE id = ?').get(S.note).state, 'inbox');
    });

    test('tag "# ai" (hash then space) normalises to "ai"', async () => {
      await env.req('PATCH', `/api/items/${S.note}`, { add_tags: ['ai'] });
      await env.req('PATCH', `/api/items/${S.bRoot}`, { add_tags: ['# ai'] });
      assert.deepEqual(tagsOf(S.bRoot), ['ai']);
      assert.deepEqual(allTags(), ['ai']);
    });

    test('DELETE /api/tags/:name removes it everywhere; unknown -> 404', async () => {
      const slug = await merge([S.r1]);
      await env.req('PATCH', `/api/items/${S.note}`, { add_tags: ['AI', 'keep'] });
      await env.req('PUT', `/api/bundles/${slug}`, { tags: ['ai'] });
      const r = await env.req('DELETE', `/api/tags/${encodeURIComponent('#ai')}`);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(tagsOf(S.note), ['keep']);
      assert.deepEqual((await env.req('GET', `/api/bundles/${slug}`)).json.bundle.tags, []);
      assert.equal((await env.req('DELETE', '/api/tags/nope')).status, 404);
    });

    test('unmerging hands the merge tags to its items; tags nobody uses are pruned', async () => {
      const slug = await merge([S.note]);
      await env.req('PUT', `/api/bundles/${slug}`, { tags: ['only-merge'] });
      await env.req('DELETE', `/api/bundles/${slug}`);
      assert.deepEqual(tagsOf(S.note), ['only-merge'], 'the tag stays with the item');
      await env.req('PATCH', `/api/items/${S.note}`, { remove_tags: ['only-merge'] });
      assert.deepEqual(allTags(), []);
      const org = await env.req('GET', '/api/organize');
      assert.deepEqual(org.json.tags, []);
    });
  });

  // ---------------- merge meta ----------------
  describe('merge category / priority / tags', () => {
    test('a new merge inherits item tags, first category and highest priority', async () => {
      const c1 = (await env.req('POST', '/api/categories', { name: 'One' })).json.id;
      const c2 = (await env.req('POST', '/api/categories', { name: 'Two' })).json.id;
      await env.req('PATCH', `/api/items/${S.r1}`, { category_id: c1, priority: 1, add_tags: ['x'] });
      await env.req('PATCH', `/api/items/${S.r2}`, { category_id: c2, priority: 3, add_tags: ['y', 'X'] });
      // normalised order is root, r2, r1; root is uncategorised so the first category found is r2's
      const slug = await merge([S.r2, S.root, S.r1]);
      assert.deepEqual(bundleIds(slug), [S.root, S.r2, S.r1]);
      const g = await env.req('GET', `/api/bundles/${slug}`);
      assert.equal(g.json.bundle.category_id, c2);
      assert.equal(g.json.bundle.priority, 3);
      assert.deepEqual(g.json.bundle.tags, ['x', 'y']);
      // the items keep their own meta
      assert.deepEqual(tagsOf(S.r1), ['x']);
    });

    test('a merge of untagged, uncategorised items starts blank', async () => {
      const slug = await merge([S.note]);
      const g = await env.req('GET', `/api/bundles/${slug}`);
      assert.equal(g.json.bundle.category_id, null);
      assert.equal(g.json.bundle.priority, 0);
      assert.deepEqual(g.json.bundle.tags, []);
    });

    test('PUT meta: replaces tags, sets category/priority; invalid values -> 400 and roll back the whole PUT', async () => {
      const c = (await env.req('POST', '/api/categories', { name: 'One' })).json.id;
      const slug = await merge([S.note], 'Before');
      let r = await env.req('PUT', `/api/bundles/${slug}`, { category_id: c, priority: 2, tags: ['a', 'b'] });
      assert.equal(r.status, 200);
      r = await env.req('PUT', `/api/bundles/${slug}`, { tags: ['c'] });
      let b = (await env.req('GET', `/api/bundles/${slug}`)).json.bundle;
      assert.deepEqual(b.tags, ['c']);
      assert.equal(b.category_id, c, 'untouched when not sent');
      assert.equal(b.priority, 2);
      for (const bad of [{ priority: 7 }, { category_id: 424242 }, { tags: 'c' }]) {
        r = await env.req('PUT', `/api/bundles/${slug}`, { title: 'After', item_ids: [S.note, S.bRoot], ...bad });
        assert.equal(r.status, 400, JSON.stringify(bad));
      }
      b = (await env.req('GET', `/api/bundles/${slug}`)).json.bundle;
      assert.equal(b.title, 'Before');
      assert.deepEqual(bundleIds(slug), [S.note]);
      assert.equal(b.priority, 2);
      r = await env.req('PUT', `/api/bundles/${slug}`, { category_id: null });
      assert.equal((await env.req('GET', `/api/bundles/${slug}`)).json.bundle.category_id, null);
    });
  });

  // ---------------- filters & sorts ----------------
  describe('filters and sorts', () => {
    // three single-item conversations with distinct dates, likes, priority, category and tags
    async function spread() {
      wipe(env.db);
      const c = (await env.req('POST', '/api/categories', { name: 'Reading' })).json.id;
      const mk = (n, f) => insertItem(env.db, {
        kind: 'tweet', fetch_status: 'ok', saved: 1, state: 'inbox', tweet_id: `19400000000000000${n}`, root_tweet_id: `19400000000000000${n}`,
        author_handle: `u${n}`, text: `post ${n}`, ...f,
      });
      // saved order (latest): a newest, b, c oldest; first_saved: c earliest; posted: b newest; likes: c most
      const a = mk(10, { first_saved_at: 300, last_saved_at: 900, posted_at: 100, likes: 5 });
      const b = mk(11, { first_saved_at: 200, last_saved_at: 800, posted_at: 500, likes: 1 });
      const cc = mk(12, { first_saved_at: 100, last_saved_at: 700, posted_at: 300, likes: 50 });
      await env.req('PATCH', `/api/items/${a}`, { category_id: c, priority: 1, add_tags: ['AI'] });
      await env.req('PATCH', `/api/items/${b}`, { priority: 3, add_tags: ['news'] });
      await env.req('PATCH', `/api/items/${cc}`, { category_id: c, priority: 2, add_tags: ['ai', 'news'] });
      return { c, a, b, cc };
    }
    const keys = (groups) => groups.map((g) => g.root.id);

    test('inbox sorts', async () => {
      const { a, b, cc } = await spread();
      assert.deepEqual(keys(await inbox()), [a, b, cc]);
      assert.deepEqual(keys(await inbox('?sort=saved_desc')), [a, b, cc]);
      assert.deepEqual(keys(await inbox('?sort=saved_asc')), [cc, b, a]);
      assert.deepEqual(keys(await inbox('?sort=posted_desc')), [b, cc, a]);
      assert.deepEqual(keys(await inbox('?sort=priority')), [b, cc, a]);
      assert.deepEqual(keys(await inbox('?sort=likes')), [cc, a, b]);
      assert.deepEqual(keys(await inbox('?sort=bogus')), [a, b, cc]);
    });

    test('inbox filters: category, none, tag, priority min, combined', async () => {
      const { c, a, b, cc } = await spread();
      assert.deepEqual(keys(await inbox(`?category=${c}`)), [a, cc]);
      assert.deepEqual(keys(await inbox('?category=none')), [b]);
      assert.deepEqual(keys(await inbox('?category=99999')), []);
      assert.deepEqual(keys(await inbox('?tag=ai')), [a, cc]);
      assert.deepEqual(keys(await inbox(`?tag=${encodeURIComponent('#AI')}`)), [a, cc]);
      assert.deepEqual(keys(await inbox('?tag=news')), [b, cc]);
      assert.deepEqual(keys(await inbox('?tag=missing')), []);
      assert.deepEqual(keys(await inbox('?priority=2')), [b, cc]);
      assert.deepEqual(keys(await inbox('?priority=3')), [b]);
      assert.deepEqual(keys(await inbox('?priority=9')), [a, b, cc], 'invalid minimum is ignored');
      assert.deepEqual(keys(await inbox(`?category=${c}&tag=news&priority=2`)), [cc]);
      assert.deepEqual(keys(await inbox('?category=none&tag=ai')), []);
      assert.deepEqual(keys(await inbox(`?tag=news&sort=saved_asc`)), [cc, b]);
      // tags and category come back on the items
      const g = (await inbox()).find((x) => x.root.id === cc);
      assert.deepEqual(g.root.tags, ['AI', 'news'], 'existing tag name reused');
      assert.equal(g.root.category_id, c);
      assert.equal(g.root.priority, 2);
    });

    test('inbox filter keeps a matching reply and shows its non-matching root as context', async () => {
      await env.req('PATCH', `/api/items/${S.r2}`, { add_tags: ['hot'] });
      const groups = await inbox('?tag=hot');
      assert.equal(groups.length, 1);
      const { vis, ctx } = inboxIds(groups);
      assert.deepEqual([...vis], [S.r2]);
      assert.ok(ctx.has(S.root) && ctx.has(S.r1));
    });

    test('merges: filters and sorts', async () => {
      const c = (await env.req('POST', '/api/categories', { name: 'Reading' })).json.id;
      const s1 = await merge([S.root], 'First');
      const s2 = await merge([S.bRoot], 'Second');
      const s3 = await merge([S.note], 'Third');
      await env.req('PUT', `/api/bundles/${s1}`, { category_id: c, priority: 1, tags: ['AI'] });
      await env.req('PUT', `/api/bundles/${s2}`, { priority: 3, tags: ['news'] });
      await env.req('PUT', `/api/bundles/${s3}`, { category_id: c, priority: 2, tags: ['ai', 'news'] });
      const set = env.db.prepare('UPDATE bundles SET created_at = ?, updated_at = ? WHERE slug = ?');
      set.run(100, 900, s1); set.run(300, 800, s2); set.run(200, 700, s3);
      const list = async (qs = '') => {
        const r = await env.req('GET', `/api/bundles${qs}`);
        assert.equal(r.status, 200, r.text);
        return r.json.bundles.map((b) => b.slug);
      };
      assert.deepEqual(await list(), [s1, s2, s3], 'default: most recently changed first');
      assert.deepEqual(await list('?sort=saved_desc'), [s2, s3, s1], 'newest merged first');
      assert.deepEqual(await list('?sort=saved_asc'), [s1, s3, s2]);
      assert.deepEqual(await list('?sort=priority'), [s2, s3, s1]);
      for (const s of ['posted_desc', 'likes', 'junk']) assert.equal((await list(`?sort=${s}`)).length, 3, s);
      assert.deepEqual(await list(`?category=${c}`), [s1, s3]);
      assert.deepEqual(await list('?category=none'), [s2]);
      assert.deepEqual(await list('?tag=AI'), [s1, s3]);
      assert.deepEqual(await list(`?tag=${encodeURIComponent('#news')}`), [s2, s3]);
      assert.deepEqual(await list('?priority=2'), [s2, s3]);
      assert.deepEqual(await list(`?category=${c}&priority=2`), [s3]);
      assert.deepEqual(await list('?q=news'), [s2, s3], 'search matches tags');
      const one = (await env.req('GET', '/api/bundles')).json.bundles.find((b) => b.slug === s3);
      assert.equal(one.items, 1);
      assert.deepEqual(one.tags, ['AI', 'news'], 'existing tag name reused');
      assert.equal(one.category_id, c);
      assert.equal(one.priority, 2);
      assert.equal(one.id, undefined, 'internal id not exposed');
    });

    test('/api/organize counts', async () => {
      const c = (await env.req('POST', '/api/categories', { name: 'Reading' })).json.id;
      const w = (await env.req('POST', '/api/categories', { name: 'Work' })).json.id;
      await env.req('POST', '/api/items/bulk', { ids: [S.note, S.bReply], category_id: c, priority: 3, add_tags: ['AI'] });
      await env.req('PATCH', `/api/items/${S.r2}`, { category_id: c, add_tags: ['ai'] });
      await env.req('PATCH', `/api/items/${S.r1}`, { state: 'archived' });
      // the merge takes r2 (category c, tag AI) out of the loose counts and is itself in c with priority 3 via its own setting
      const slug = await merge([S.root, S.self, S.r2]);
      await env.req('PUT', `/api/bundles/${slug}`, { priority: 3 });
      const org = (await env.req('GET', '/api/organize')).json;
      // loose inbox: r?: r1 archived; root/self/r2 merged -> bRoot, bReply, note
      assert.equal(org.counts.inbox, 3);
      assert.equal(org.counts.archived, 1);
      assert.equal(org.counts.merged, 1);
      assert.equal(org.counts.high_items, 2);
      assert.equal(org.counts.high_merged, 1);
      const cat = Object.fromEntries(org.categories.map((x) => [x.id, x]));
      assert.equal(cat[c].items, 2);
      assert.equal(cat[c].merged, 1, 'merge inherited r2 category');
      assert.equal(cat[w].items, 0);
      assert.equal(cat[w].merged, 0);
      assert.deepEqual(org.tags.map((t) => [t.name, t.items, t.merged]), [['AI', 2, 1]]);
    });
  });
});
