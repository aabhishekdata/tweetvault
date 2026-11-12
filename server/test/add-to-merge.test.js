// Adding to merged items without unmerging: the "Add items" picker (GET /api/items/pick), adding an item
// that is already in another merge (POST /api/bundles/:slug/add) and combining two merges
// (POST /api/bundles/:slug/combine). Real createApp over HTTP, in-memory DB, no network.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/server.js';
import * as A from '../src/auth.js';
import { totp, base32Decode } from '../src/totp.js';
import { now } from '../src/db.js';

const PW = 'correct horse battery staple';
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

async function boot(extra = {}) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const app = createApp({
    dbPath: ':memory:', passwordHash: await A.makePasswordHash(PW, 100000), secret: 'x'.repeat(40),
    origins: origin, cookieSecure: false, trustProxy: false, startWorker: false,
    fetchFn: async () => new Response('', { status: 404 }), paceMs: 0, log: () => {}, ...extra,
  });
  await app.listen(port, '127.0.0.1');
  const jar = new Map();
  // a signed-in browser (cookies), or a device token with { bearer }; { origin: null } leaves the header out
  async function req(method, path, body, { bearer, origin: o = origin, cookies = !bearer } = {}) {
    const headers = {};
    if (o) headers.Origin = o;
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (cookies && jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
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
  return { app, db: app.db, req, origin };
}

let tick = 1_800_000_000;
function ins(db, f) {
  tick += 10;
  const row = { kind: 'text', fetch_status: 'n/a', saved: 1, state: 'inbox', first_saved_at: tick, last_saved_at: tick, ...f };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid);
}
const tweet = (db, f) => ins(db, { kind: 'tweet', fetch_status: 'ok', ...f });

async function merge(env, title, ids) {
  const r = await env.req('POST', '/api/bundles', { title, item_ids: ids });
  assert.equal(r.status, 201, r.text);
  return r.json.slug;
}
const bundleIds = async (env, slug) => (await env.req('GET', `/api/bundles/${slug}`)).json.items.map((x) => x.id);
const inboxIds = async (env, state = 'inbox') => {
  const r = await env.req('GET', `/api/inbox?state=${state}`);
  assert.equal(r.status, 200, r.text);
  return r.json.groups.flatMap((g) => [g.root, ...g.thread, ...g.replies]).filter((x) => x && !x.context).map((x) => x.id);
};
const pick = async (env, qs = '') => {
  const r = await env.req('GET', `/api/items/pick${qs}`);
  assert.equal(r.status, 200, r.text);
  return r.json;
};

// ======================================================================
describe('GET /api/items/pick', () => {
  let env;
  let I;
  let slugX;
  before(async () => {
    env = await boot();
    const db = env.db;
    const R = '1950000000000000001';
    I = {};
    I.root = tweet(db, { tweet_id: R, root_tweet_id: R, author_handle: 'alice', author_name: 'Alice A', text: 'Agents are 100% here', url: `https://x.com/alice/status/${R}` });
    I.reply = tweet(db, { tweet_id: '1950000000000000002', root_tweet_id: R, parent_tweet_id: R, author_handle: 'bob', text: 'agree with this_one' });
    I.arch = ins(db, { text: 'An archived thought about agents', state: 'archived' });
    I.trash = ins(db, { text: 'agents in the trash', state: 'trashed', trashed_at: tick });
    I.unsaved = ins(db, { text: 'agents never saved', saved: 0 });
    I.sale = ins(db, { text: 'Half price: 50 off today' });
    I.noted = ins(db, { text: 'plain words', my_note: 'remember the zebra idea' });
    I.inX = ins(db, { text: 'merged agents note' });
    I.newest = ins(db, { text: 'newest of all' });
    slugX = await merge(env, 'Collection X', [I.inX]);
  });
  after(async () => { await env.app.close(); });

  test('lists saved items that are not in Trash, newest saved first, merged and archived ones included', async () => {
    const r = await pick(env);
    const ids = r.items.map((x) => x.id);
    assert.deepEqual(ids, [I.newest, I.inX, I.noted, I.sale, I.arch, I.reply, I.root]);
    assert.ok(!ids.includes(I.trash) && !ids.includes(I.unsaved));
    const arch = r.items.find((x) => x.id === I.arch);
    assert.equal(arch.state, 'archived');
    assert.deepEqual(arch.merged_in, []);
    const merged = r.items.find((x) => x.id === I.inX);
    assert.deepEqual(merged.merged_in, [{ slug: slugX, title: 'Collection X' }]);
    assert.equal(r.limit, 50);
  });

  test('rows carry the grouping fields, and a reply names the post it answers', async () => {
    const r = await pick(env, '?q=agree');
    assert.equal(r.items.length, 1);
    const x = r.items[0];
    assert.equal(x.group_key, '1950000000000000001');
    assert.equal(x.parent_tweet_id, '1950000000000000001');
    assert.equal(x.is_self_thread, false);
    assert.equal(x.reply_to.id, I.root);
    assert.equal(x.reply_to.author_handle, 'alice');
    assert.equal(x.reply_to.preview, 'Agents are 100% here');
    assert.equal((await pick(env, '?q=100')).items[0].reply_to, null);
  });

  test('every word must match, in any field, ignoring case', async () => {
    assert.deepEqual((await pick(env, '?q=AGENTS')).items.map((x) => x.id).sort(), [I.root, I.arch, I.inX].sort());
    assert.deepEqual((await pick(env, '?q=agents%20alice')).items.map((x) => x.id), [I.root]);   // text + handle
    assert.deepEqual((await pick(env, '?q=Alice%20A')).items.map((x) => x.id), [I.root]);        // name
    assert.deepEqual((await pick(env, '?q=zebra')).items.map((x) => x.id), [I.noted]);           // my_note
    assert.deepEqual((await pick(env, '?q=x.com%2Falice')).items.map((x) => x.id), [I.root]);    // url
    assert.deepEqual((await pick(env, '?q=agents%20nothing-like-this')).items, []);
  });

  test('LIKE wildcards are matched literally', async () => {
    assert.deepEqual((await pick(env, '?q=%25')).items.map((x) => x.id), [I.root]);              // "%"
    assert.deepEqual((await pick(env, '?q=_')).items.map((x) => x.id), [I.reply]);
    assert.deepEqual((await pick(env, '?q=50%25')).items, []);                                   // "50%" is not "50 off"
    assert.deepEqual((await pick(env, '?q=%5C')).items, []);                                     // a backslash
  });

  test('a very long search is cut to 200 characters, not refused', async () => {
    const r = await env.req('GET', `/api/items/pick?q=${'a'.repeat(5000)}`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.items, []);
  });

  test('exclude leaves out the items already in that merge (an unknown one excludes nothing)', async () => {
    const ids = (await pick(env, `?q=agents&exclude=${slugX}`)).items.map((x) => x.id);
    assert.ok(!ids.includes(I.inX));
    assert.ok(ids.includes(I.root));
    assert.ok((await pick(env, '?q=agents&exclude=no-such-merge')).items.some((x) => x.id === I.inX));
  });

  test('limit is 1..100, default 50', async () => {
    let r = await pick(env, '?limit=2');
    assert.deepEqual(r.items.map((x) => x.id), [I.newest, I.inX]);
    assert.equal(r.limit, 2);
    assert.equal((await pick(env, '?limit=0')).limit, 50);
    assert.equal((await pick(env, '?limit=abc')).limit, 50);
    assert.equal((await pick(env, '?limit=-3')).limit, 50);
    r = await pick(env, '?limit=5000');
    assert.equal(r.limit, 100);
  });

  test('only a signed-in browser may search: device tokens are refused', async () => {
    for (const scope of ['read', 'capture']) {
      const { token } = A.createDeviceToken(env.db, `t-${scope}`, scope);
      const r = await env.req('GET', '/api/items/pick?q=agents', undefined, { bearer: token, origin: null });
      assert.equal(r.status, 403, `${scope}: ${r.text}`);
    }
    assert.equal((await env.req('GET', '/api/items/pick', undefined, { cookies: false })).status, 401);
  });

  test('"pick" does not shadow GET /api/items/:id', async () => {
    const r = await env.req('GET', `/api/items/${I.root}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.item.id, I.root);
  });
});

// ======================================================================
describe('POST /api/bundles/:slug/add with an item that is already merged', () => {
  let env;
  before(async () => { env = await boot(); });
  after(async () => { await env.app.close(); });

  test('the item ends up in both merges, neither loses it, and the Inbox still hides it', async () => {
    const a = ins(env.db, { text: 'shared idea' });
    const b = ins(env.db, { text: 'only in B' });
    const sA = await merge(env, 'Merge A', [a]);
    const sB = await merge(env, 'Merge B', [b]);
    const vB = (await env.req('GET', `/api/bundles/${sB}`)).json.bundle.version;
    const r = await env.req('POST', `/api/bundles/${sB}/add`, { item_ids: [a] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.added, 1);
    assert.equal(r.json.version, vB + 1);
    assert.deepEqual(await bundleIds(env, sA), [a]);
    assert.deepEqual(await bundleIds(env, sB), [b, a]);
    assert.ok(!(await inboxIds(env)).includes(a));
    // the picker shows both homes
    const row = (await pick(env, '?q=shared')).items[0];
    assert.deepEqual(row.merged_in.map((x) => x.slug).sort(), [sA, sB].sort());
    // and it is no longer offered for B
    assert.deepEqual((await pick(env, `?q=shared&exclude=${sB}`)).items, []);
  });

  test('an archived item added from the picker joins the merge', async () => {
    const x = ins(env.db, { text: 'from the archive', state: 'archived' });
    const s = await merge(env, 'Merge C', [ins(env.db, { text: 'c' })]);
    const r = await env.req('POST', `/api/bundles/${s}/add`, { item_ids: [x] });
    assert.equal(r.status, 200, r.text);
    assert.ok((await bundleIds(env, s)).includes(x));
    assert.ok(!(await inboxIds(env, 'archived')).includes(x));
  });
});

// ======================================================================
describe('POST /api/bundles/:slug/combine', () => {
  let env;
  before(async () => { env = await boot(); });
  after(async () => { await env.app.close(); });

  async function pair(tag) {
    const db = env.db;
    const R = `19600000000000${String(++pairN).padStart(5, '0')}`;
    const n1 = ins(db, { text: `${tag} first note` });
    const root = tweet(db, { tweet_id: R, root_tweet_id: R, author_handle: 'alice', text: `${tag} root post`, posted_at: 100 });
    const n3 = ins(db, { text: `${tag} other note` });
    const reply = tweet(db, { tweet_id: `${R}9`, root_tweet_id: R, parent_tweet_id: R, author_handle: 'bob', text: `${tag} late reply`, posted_at: 200 });
    const target = await merge(env, `${tag} target`, [n1, root]);
    const source = await merge(env, `${tag} source`, [n3, reply]);
    return { n1, root, n3, reply, target, source };
  }
  let pairN = 0;
  const meta = (slug) => env.db.prepare('SELECT * FROM bundles WHERE slug = ?').get(slug);

  test('moves every source in conversation order, carries tags, priority and category, and removes the source', async () => {
    const p = await pair('happy');
    const cat = await env.req('POST', '/api/categories', { name: 'Research' });
    assert.equal(cat.status, 201, cat.text);
    let r = await env.req('PUT', `/api/bundles/${p.target}`, { priority: 1, tags: ['alpha'], category_id: null });
    assert.equal(r.status, 200, r.text);
    r = await env.req('PUT', `/api/bundles/${p.source}`, { priority: 3, tags: ['beta', 'alpha'], category_id: cat.json.id });
    assert.equal(r.status, 200, r.text);
    const before = meta(p.target);
    const src = meta(p.source);

    r = await env.req('POST', `/api/bundles/${p.target}/combine`, { from: p.source });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { ok: true, slug: p.target, added: 2, version: before.version + 1 });

    // the late reply joins its post; the new conversation goes at the end
    assert.deepEqual(await bundleIds(env, p.target), [p.n1, p.root, p.reply, p.n3]);
    const g = (await env.req('GET', `/api/bundles/${p.target}`)).json.bundle;
    assert.deepEqual(g.tags, ['alpha', 'beta']);
    assert.equal(g.priority, 3);
    assert.equal(g.category_id, cat.json.id);
    assert.equal(g.version, before.version + 1);
    assert.ok(g.updated_at >= before.updated_at);

    // the source is gone, its items live in the target and are not back in the Inbox
    assert.equal((await env.req('GET', `/api/bundles/${p.source}`)).status, 404);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM bundle_items WHERE bundle_id = ?').get(src.id).n, 0);
    const inbox = await inboxIds(env);
    for (const id of [p.n1, p.root, p.n3, p.reply]) assert.ok(!inbox.includes(id), `item ${id} stays merged`);
    // the source slug's last version is remembered
    const floor = env.db.prepare('SELECT value FROM kv WHERE key = ?').get(`bundle_slug_floor:${p.source}`);
    assert.equal(Number(floor.value), src.version);
    // and it is in the activity log with both titles
    const a = env.db.prepare("SELECT * FROM audit_log WHERE event = 'bundle_combined' ORDER BY id DESC").get();
    assert.ok(a.detail.includes('happy source') && a.detail.includes('happy target'), a.detail);
  });

  test('a target that has a category and a higher priority keeps them', async () => {
    const p = await pair('keep');
    const c1 = (await env.req('POST', '/api/categories', { name: 'Keep one' })).json.id;
    const c2 = (await env.req('POST', '/api/categories', { name: 'Keep two' })).json.id;
    await env.req('PUT', `/api/bundles/${p.target}`, { priority: 3, category_id: c1 });
    await env.req('PUT', `/api/bundles/${p.source}`, { priority: 1, category_id: c2 });
    assert.equal((await env.req('POST', `/api/bundles/${p.target}/combine`, { from: p.source })).status, 200);
    const t = meta(p.target);
    assert.equal(t.priority, 3);
    assert.equal(t.category_id, c1);
  });

  test('an item already in both is not doubled', async () => {
    const shared = ins(env.db, { text: 'in both' });
    const t = await merge(env, 'dup target', [shared, ins(env.db, { text: 't only' })]);
    const s = await merge(env, 'dup source', [shared]);
    const r = await env.req('POST', `/api/bundles/${t}/combine`, { from: s });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.added, 0);
    assert.equal((await bundleIds(env, t)).filter((id) => id === shared).length, 1);
    assert.equal(meta(s), undefined);
  });

  test('a tab still open on the source gets 404, and 409 once its slug is reused', async () => {
    const p = await pair('stale');
    const old = (await env.req('GET', `/api/bundles/${p.source}`)).json.bundle;
    assert.equal((await env.req('POST', `/api/bundles/${p.target}/combine`, { from: p.source })).status, 200);
    let r = await env.req('PUT', `/api/bundles/${p.source}`, { version: old.version, item_ids: [p.n3], title: old.title });
    assert.equal(r.status, 404, r.text);
    // merging the same title again reuses the slug, and starts above the old version
    const again = await merge(env, old.title, [ins(env.db, { text: 'fresh' })]);
    assert.equal(again, p.source);
    assert.ok(meta(again).version > old.version);
    r = await env.req('PUT', `/api/bundles/${again}`, { version: old.version, item_ids: [p.n3], title: old.title });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error, 'stale');
  });

  test('versions the page sends are checked', async () => {
    const p = await pair('versions');
    const t = meta(p.target);
    const s = meta(p.source);
    let r = await env.req('POST', `/api/bundles/${p.target}/combine`, { from: p.source, from_version: s.version - 1 });
    assert.equal(r.status, 409, r.text);
    r = await env.req('POST', `/api/bundles/${p.target}/combine`, { from: p.source, version: t.version + 5 });
    assert.equal(r.status, 409, r.text);
    assert.ok(meta(p.source), 'nothing changed');
    r = await env.req('POST', `/api/bundles/${p.target}/combine`, { from: p.source, version: t.version, from_version: s.version });
    assert.equal(r.status, 200, r.text);
  });

  test('refuses itself (400), a missing name (400) and unknown merges (404)', async () => {
    const p = await pair('refuse');
    let r = await env.req('POST', `/api/bundles/${p.target}/combine`, { from: p.target });
    assert.equal(r.status, 400, r.text);
    assert.equal((await env.req('POST', `/api/bundles/${p.target}/combine`, {})).status, 400);
    assert.equal((await env.req('POST', `/api/bundles/${p.target}/combine`, { from: 7 })).status, 400);
    assert.equal((await env.req('POST', `/api/bundles/${p.target}/combine`, { from: 'no-such-merge' })).status, 404);
    assert.equal((await env.req('POST', '/api/bundles/no-such-merge/combine', { from: p.source })).status, 404);
    assert.ok(meta(p.target) && meta(p.source));
  });

  test('needs the page\'s Origin and a signed-in browser', async () => {
    const p = await pair('auth');
    let r = await env.req('POST', `/api/bundles/${p.target}/combine`, { from: p.source }, { origin: null });
    assert.equal(r.status, 403, r.text);
    r = await env.req('POST', `/api/bundles/${p.target}/combine`, { from: p.source }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403, r.text);
    const { token } = A.createDeviceToken(env.db, 'claude', 'read');
    r = await env.req('POST', `/api/bundles/${p.target}/combine`, { from: p.source }, { bearer: token, origin: null });
    assert.equal(r.status, 403, r.text);
    assert.equal((await env.req('POST', `/api/bundles/${p.target}/combine`, { from: p.source }, { cookies: false })).status, 401);
    assert.ok(meta(p.source), 'nothing changed');
  });
});

describe('combine respects the render cap', () => {
  let env;
  before(async () => { env = await boot({ maxRenderChars: 1000 }); });
  after(async () => { await env.app.close(); });

  test('413 when the combined text would be too big, and nothing changes', async () => {
    const t = await merge(env, 'big target', [ins(env.db, { text: 'a'.repeat(600) })]);
    const s = await merge(env, 'big source', [ins(env.db, { text: 'b'.repeat(600) })]);
    const v = env.db.prepare('SELECT version FROM bundles WHERE slug = ?').get(t).version;
    const r = await env.req('POST', `/api/bundles/${t}/combine`, { from: s });
    assert.equal(r.status, 413, r.text);
    assert.equal((await bundleIds(env, t)).length, 1);
    assert.equal((await bundleIds(env, s)).length, 1);
    assert.equal(env.db.prepare('SELECT version FROM bundles WHERE slug = ?').get(t).version, v);
    assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'bundle_combined'").get().n, 0);
  });
});

// ======================================================================
describe('the page (app.js)', () => {
  const APP = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  test('the selection bar has a visible "Add to merged…" button instead of the flat submenu', () => {
    assert.match(APP, /'data-fkey': 'addmerged', onclick: \(\) => addSelectedToMerged\(\) \}, icon\('layers', 'sm'\), 'Add to merged…'\)/);
    assert.ok(!APP.includes("label: 'Add to merged', icon: 'layers', tone: 'blue', sub:"));
  });

  test('items, the merge editor and Merged cards reach the pickers', () => {
    assert.match(APP, /onClick: \(\) => addOneToMerged\(x\)/);
    assert.match(APP, /'data-fkey': 'addsrc', onclick: \(\) => addItemsToMerge\(m\)/);
    assert.match(APP, /label: 'Combine into…', icon: 'layers', onClick: \(\) => combineInto\(b\)/);
    assert.match(APP, /label: 'Combine into…', icon: 'layers', onClick: \(\) => combineInto\(\{ slug: m\.slug, title: m\.title \}, srcCount\(\)\)/);
    assert.match(APP, /api\('GET', `\/api\/items\/pick\?q=\$\{encodeURIComponent\(q\)\}&exclude=\$\{encodeURIComponent\(m\.slug\)\}`\)/);
    assert.match(APP, /deb = setTimeout\(load, 250\)/);
    assert.match(APP, /bundle_combined: 'Merged items combined'/);
  });

  test('the picker writes text only through textContent (no innerHTML anywhere)', () => {
    assert.ok(!/\.innerHTML\s*=/.test(APP));
    assert.ok(!APP.includes('insertAdjacentHTML'));
  });
});
