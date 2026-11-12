// Regression tests for review findings on merges (bundles) and the short-link worker:
// versions after Unmerge, short links resolving into a merged tweet, member-based filters and the GET render cap.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createApp } from '../src/server.js';
import * as A from '../src/auth.js';
import { totp, base32Decode } from '../src/totp.js';
import { openDb, now } from '../src/db.js';
import { capture } from '../src/items.js';
import { createFetcher } from '../src/fetcher.js';

const PW = 'correct horse battery staple';
const TWEET = '1790000000000000001';
const realNow = Date.now;
let skewMs = 0;
Date.now = () => realNow() + skewMs;

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

// every t.co hop redirects to the same tweet; nothing else answers
const redirectToTweet = async (u) => (new URL(u).hostname === 't.co'
  ? new Response('', { status: 301, headers: { location: `https://x.com/jack/status/${TWEET}` } })
  : new Response('', { status: 404 }));

async function boot() {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const app = createApp({
    dbPath: ':memory:', passwordHash: await A.makePasswordHash(PW, 100000), secret: 'x'.repeat(40),
    origins: origin, cookieSecure: false, trustProxy: false, startWorker: false, fetchFn: redirectToTweet, paceMs: 0,
    log: () => {},
  });
  await app.listen(port, '127.0.0.1');
  const jar = new Map();
  async function req(method, path, body, { bearer } = {}) {
    const headers = { Origin: origin };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    else if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const res = await fetch(origin + path, { method, headers, body: payload });
    for (const sc of res.headers.getSetCookie()) {
      const [kv, ...attrs] = sc.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i).trim();
      const v = decodeURIComponent(kv.slice(i + 1).trim());
      if (!v || attrs.some((a) => a.trim() === 'Max-Age=0')) jar.delete(k); else jar.set(k, v);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, json };
  }
  assert.equal((await req('POST', '/api/login', { password: PW })).status, 200);
  const s = await req('POST', '/api/mfa/setup', {});
  skewMs += 30_000;
  assert.equal((await req('POST', '/api/mfa/confirm', { code: totp(base32Decode(s.json.secret), now()) })).status, 200);
  return { app, db: app.db, req };
}

const note = (db, text) => {
  const t = now();
  return Number(db.prepare("INSERT INTO items (kind, fetch_status, saved, state, text, first_saved_at, last_saved_at) VALUES ('text', 'n/a', 1, 'inbox', ?, ?, ?)")
    .run(text, t, t).lastInsertRowid);
};
const bundleIds = (db, slug) => db.prepare(`SELECT bi.item_id FROM bundle_items bi JOIN bundles b ON b.id = bi.bundle_id
    WHERE b.slug = ? ORDER BY bi.position`).all(slug).map((r) => r.item_id);

describe('merges over HTTP', () => {
  let env;
  before(async () => { env = await boot(); });
  after(async () => { await env.app.close(); });

  // finding 1
  test('after Unmerge and a re-merge with the same slug, a stale tab gets 409 instead of overwriting', async () => {
    const [i1, i2, i3] = [note(env.db, 'one'), note(env.db, 'two'), note(env.db, 'three')];
    const c1 = await env.req('POST', '/api/bundles', { title: 'Foo', item_ids: [i1, i2] });
    assert.equal(c1.status, 201, c1.text);
    const tabA = (await env.req('GET', `/api/bundles/${c1.json.slug}`)).json.bundle;

    assert.equal((await env.req('DELETE', `/api/bundles/${c1.json.slug}`)).status, 200);
    const c2 = await env.req('POST', '/api/bundles', { title: 'Foo', item_ids: [i3, i1] });
    assert.equal(c2.json.slug, c1.json.slug, 'the slug is reused');
    const fresh = (await env.req('GET', `/api/bundles/${c2.json.slug}`)).json.bundle;
    assert.ok(fresh.version > tabA.version, 'the new merge starts above the old one');

    const stale = await env.req('PUT', `/api/bundles/${c2.json.slug}`, { title: 'Foo old', item_ids: [i1, i2], version: tabA.version });
    assert.equal(stale.status, 409, stale.text);
    assert.deepEqual(bundleIds(env.db, c2.json.slug), [i3, i1], 'the new merge kept its items');
    // the page with the current version still saves
    const ok = await env.req('PUT', `/api/bundles/${c2.json.slug}`, { title: 'Foo', item_ids: [i1, i3], version: fresh.version });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.version, fresh.version + 1);
  });

  test('a fresh slug still starts at version 1', async () => {
    const c = await env.req('POST', '/api/bundles', { title: 'Brand new name', item_ids: [note(env.db, 'x')] });
    assert.equal((await env.req('GET', `/api/bundles/${c.json.slug}`)).json.bundle.version, 1);
  });

  // finding 0
  test('a short link resolving into a saved tweet bumps the merge version, so a stale save gets 409', async () => {
    const n = note(env.db, 'just a note');
    const E = capture(env.db, { input: `https://x.com/jack/status/${TWEET}`, client_id: 'rfb-000001' }).item_id;
    env.db.prepare("UPDATE items SET fetch_status = 'ok', text = 'tweet E' WHERE id = ?").run(E);
    const L = capture(env.db, { input: 'https://t.co/abcdEFG123', client_id: 'rfb-000002' }).item_id;
    const c = await env.req('POST', '/api/bundles', { title: 'Short link merge', item_ids: [n, L] });
    const page = await env.req('GET', `/api/bundles/${c.json.slug}`);
    const ids = page.json.items.map((x) => x.id);
    assert.deepEqual(ids, [n, L]);

    await createFetcher(env.db, { fetchFn: redirectToTweet, paceMs: 0 }).runOnce();
    assert.deepEqual(bundleIds(env.db, c.json.slug), [n, E], 'the short link became the real tweet');

    const stale = await env.req('PUT', `/api/bundles/${c.json.slug}`, { title: 'T2', item_ids: ids, version: page.json.bundle.version });
    assert.equal(stale.status, 409, stale.text);
    assert.deepEqual(bundleIds(env.db, c.json.slug), [n, E], 'the tweet is still in the merge');
  });

  // finding 2
  test('merged-item filters follow the merged item, not the old values on its items', async () => {
    const work = env.db.prepare("INSERT INTO categories (name) VALUES ('Work')").run().lastInsertRowid;
    const home = env.db.prepare("INSERT INTO categories (name) VALUES ('Home')").run().lastInsertRowid;
    const a = note(env.db, 'filter me');
    const p = await env.req('PATCH', `/api/items/${a}`, { category_id: Number(work), priority: 3, add_tags: ['ai'] });
    assert.equal(p.status, 200, p.text);
    const c = await env.req('POST', '/api/bundles', { title: 'Filter merge', item_ids: [a] });
    const slugs = async (qs) => (await env.req('GET', `/api/bundles?${qs}`)).json.bundles.map((b) => b.slug);
    assert.ok((await slugs('tag=ai')).includes(c.json.slug), 'inherited tag matches at first');

    const cur = (await env.req('GET', `/api/bundles/${c.json.slug}`)).json.bundle;
    const put = await env.req('PUT', `/api/bundles/${c.json.slug}`, { category_id: Number(home), priority: 1, tags: [], version: cur.version });
    assert.equal(put.status, 200, put.text);
    assert.ok(!(await slugs('tag=ai')).includes(c.json.slug), 'tag filter');
    assert.ok(!(await slugs('priority=3')).includes(c.json.slug), 'priority filter');
    assert.ok(!(await slugs(`category=${work}`)).includes(c.json.slug), 'category filter');
    assert.ok((await slugs(`category=${home}`)).includes(c.json.slug), 'its own category still matches');
  });

  // finding 13
  test('GET a merge over the render cap sends its items but not its full text, also to a read token', async () => {
    const big = 'x'.repeat(1_000_000);
    const ids = Array.from({ length: 6 }, () => note(env.db, big));
    const c = await env.req('POST', '/api/bundles', { title: 'Huge', item_ids: ids });
    assert.equal(c.status, 201, c.text);
    const { token } = A.createDeviceToken(env.db, 'phone', 'read');
    for (const opts of [{}, { bearer: token }]) {
      const g = await env.req('GET', `/api/bundles/${c.json.slug}`, undefined, opts);
      assert.equal(g.status, 200, g.text.slice(0, 200));
      assert.equal(g.json.items.length, 6, 'the items are listed so the merge can be trimmed');
      assert.equal(g.json.text, null);
      assert.equal(g.json.text_sources, null);
      assert.match(g.json.too_big, /too much text/);
      assert.ok(g.text.length < 1_000_000, `body is small (${g.text.length})`);
    }
    const ex = await env.req('GET', `/api/bundles/${c.json.slug}/export?sources=1`);
    assert.equal(ex.status, 413);
    // a merge under the cap still comes with its text
    const small = await env.req('POST', '/api/bundles', { title: 'Small', item_ids: [note(env.db, 'tiny note')] });
    const gs = await env.req('GET', `/api/bundles/${small.json.slug}`);
    assert.match(gs.json.text, /tiny note/);
    assert.equal(gs.json.too_big, undefined);
  });
});

// finding 4
test('organizing set on a short link while its redirect is in flight survives the merge into the saved tweet', async () => {
  const db = openDb(':memory:');
  const x = capture(db, { input: `https://x.com/jack/status/${TWEET}`, client_id: 'rfb-000010' }).item_id;
  db.prepare("UPDATE items SET fetch_status = 'ok' WHERE id = ?").run(x);
  const t = capture(db, { input: 'https://t.co/abcdEFG123', client_id: 'rfb-000011' }).item_id;
  const cat = Number(db.prepare("INSERT INTO categories (name) VALUES ('Work')").run().lastInsertRowid);
  const fetchFn = async (u) => {
    // the owner organizes the short-link row while the worker waits for the redirect
    db.prepare('UPDATE items SET category_id = ?, priority = 3 WHERE id = ?').run(cat, t);
    return redirectToTweet(u);
  };
  await createFetcher(db, { fetchFn, paceMs: 0 }).runOnce();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE id = ?').get(t).n, 0, 'short-link row merged away');
  const row = db.prepare('SELECT category_id, priority FROM items WHERE id = ?').get(x);
  assert.equal(row.category_id, cat, 'category kept');
  assert.equal(row.priority, 3, 'priority kept');
  db.close();
});
