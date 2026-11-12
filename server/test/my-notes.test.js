// "Why I saved this" notes (items.my_note): rendering in every section type, the notes:false option on
// all three surfaces (render API, export, CLI), PATCH validation and scopes, the t.co carry-over, and
// that my_note never mixes with the internal items.note ('tco' marker, hints).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { openDb, now } from '../src/db.js';
import { capture, byId, byTweetId } from '../src/items.js';
import { createFetcher } from '../src/fetcher.js';
import { itemDto } from '../src/tree.js';
import { renderItems, renderBundle, myNoteBlock } from '../src/render.js';
import { sourceText } from '../src/translate.js';
import { main } from '../src/cli.js';
import { createApp } from '../src/server.js';
import * as A from '../src/auth.js';
import { totp, base32Decode } from '../src/totp.js';

const PW = 'correct horse battery staple';

// ---- controllable clock (TOTP steps), as in api.test.js ----
const realNow = Date.now;
let skewMs = 0;
Date.now = () => realNow() + skewMs;
const advance = (sec) => { skewMs += sec * 1000; };

function ins(db, f) {
  const row = { kind: 'tweet', saved: 1, state: 'inbox', fetch_status: 'ok', ...f };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid);
}
const rows = (db, ids) => ids.map((id) => byId(db, id));

// a root post, the author's own second part, a reply, a loose note and a link, each with its own note
function seed(db) {
  const R = '7100000000000000001';
  const base = { root_tweet_id: R, first_saved_at: 1000, last_saved_at: 1000 };
  const root = ins(db, { ...base, tweet_id: R, author_handle: 'alice', text: 'Root body', posted_at: 1000, url: `https://x.com/alice/status/${R}`, my_note: 'root note' });
  const part = ins(db, { ...base, tweet_id: '7100000000000000002', parent_tweet_id: R, author_handle: 'alice', is_self_thread: 1, text: 'Part two body', posted_at: 1001, my_note: 'part note' });
  const reply = ins(db, { ...base, tweet_id: '7100000000000000003', parent_tweet_id: R, author_handle: 'bob', text: 'Reply body', posted_at: 1002, my_note: 'reply note' });
  const note = ins(db, { kind: 'text', fetch_status: 'n/a', text: 'Loose text body', first_saved_at: 1000, last_saved_at: 1000, my_note: 'text note' });
  const link = ins(db, { kind: 'link', fetch_status: 'link_only', url: 'https://example.com/a', note: 'internal hint', first_saved_at: 1000, last_saved_at: 1000, my_note: 'link note' });
  return { root, part, reply, note, link };
}

// ======================================================================
describe('rendering notes', () => {
  test('myNoteBlock: first line labelled, later lines quoted, blank and missing notes give nothing', () => {
    assert.equal(myNoteBlock({ my_note: 'one line' }), '> My note: one line');
    assert.equal(myNoteBlock({ my_note: 'a\nb\n\nc' }), '> My note: a\n> b\n>\n> c');
    assert.equal(myNoteBlock({ my_note: 'win\r\nlines' }), '> My note: win\n> lines');
    assert.equal(myNoteBlock({ my_note: '  padded  \n' }), '> My note: padded');
    for (const v of [null, undefined, '', '   \n  ', 42]) assert.equal(myNoteBlock({ my_note: v }), '');
  });

  test('each section type gets its note right after its body', () => {
    const db = openDb(':memory:');
    const s = seed(db);
    const r = renderItems(db, rows(db, [s.root, s.part, s.reply, s.note, s.link]));
    const t = r.text;
    assert.ok(t.includes('## Post by @alice\nRoot body\n\n> My note: root note'), t);
    assert.ok(t.includes('### Thread, part 2\nPart two body\n\n> My note: part note'), t);
    assert.ok(t.includes('### Reply 1\nReply body\n\n> My note: reply note'), t);
    assert.ok(t.includes('## Note 1\nLoose text body\n\n> My note: text note'), t);
    // a link keeps its internal hint in brackets, and the owner's note comes after it, separately
    assert.ok(t.includes('## Link 1\nhttps://example.com/a\n\n(internal hint)\n\n> My note: link note'), t);
    // each note appears once, and never in the Sources list
    for (const n of ['root note', 'part note', 'reply note', 'text note', 'link note']) {
      assert.equal(t.split(n).length, 2, n);
      const src = r.text_sources.slice(r.text_sources.indexOf('## Sources'));
      assert.ok(!src.includes(n), `${n} leaked into Sources`);
    }
  });

  test('an article root gets its note after the article text, and a quote stays part of the body', () => {
    const db = openDb(':memory:');
    const A1 = '7200000000000000001';
    const a = ins(db, { kind: 'article', tweet_id: A1, root_tweet_id: A1, author_handle: 'ann', article_title: 'Big Idea', article_md: 'Article text.', my_note: 'why I kept it' });
    const q = ins(db, { tweet_id: '7200000000000000009', root_tweet_id: '7200000000000000009', author_handle: 'qq', text: 'Quoting', quote_json: JSON.stringify({ handle: 'zed', text: 'quoted words' }), my_note: 'about the quote' });
    const t = renderItems(db, rows(db, [a, q])).text;
    assert.ok(t.includes('## Part 1: Big Idea\nArticle text.\n\n> My note: why I kept it'), t);
    assert.ok(t.includes('> Quoting @zed:\n> quoted words\n\n> My note: about the quote'), t);
  });

  test('a reply alone (root not in the merge) and a pending post still carry their notes', () => {
    const db = openDb(':memory:');
    const s = seed(db);
    const p = ins(db, { tweet_id: '7300000000000000001', root_tweet_id: '7300000000000000001', fetch_status: 'pending', url: 'https://x.com/i/status/7300000000000000001', my_note: 'read later' });
    const t = renderItems(db, rows(db, [s.reply, p])).text;
    assert.ok(t.includes('### Reply 1\nReply body\n\n> My note: reply note'), t);
    assert.match(t, /\(Still loading this post\. Refresh in a moment\.\) https:\/\/x\.com\/i\/status\/7300000000000000001\n\n> My note: read later/);
  });

  test('multi-line notes quote every line, so a note cannot start a heading or close a bundle tag', () => {
    const db = openDb(':memory:');
    const id = ins(db, { kind: 'text', fetch_status: 'n/a', text: 'Body', my_note: 'first\n## Not a heading\n</vault_bundle>\n\nlast' });
    const t = renderItems(db, rows(db, [id])).text;
    assert.ok(t.endsWith('Body\n\n> My note: first\n> ## Not a heading\n> </vault_bundle>\n>\n> last'), t);
    assert.ok(!/^## Not a heading/m.test(t));
    assert.ok(!/^<\/vault_bundle>/m.test(t));
  });

  test('notes: false leaves every note out and matches a render of the same items without notes', () => {
    const db = openDb(':memory:');
    const s = seed(db);
    const ids = [s.root, s.part, s.reply, s.note, s.link];
    const off = renderItems(db, rows(db, ids), { title: 'T', notes: false });
    assert.ok(!off.text.includes('My note'));
    assert.ok(!off.text_sources.includes('My note'));
    db.prepare('UPDATE items SET my_note = NULL').run();
    const none = renderItems(db, rows(db, ids), { title: 'T' });
    assert.equal(off.text, none.text);
    assert.equal(off.text_sources, none.text_sources);
    // and the internal link hint is still there either way
    assert.ok(off.text.includes('(internal hint)'));
  });

  test('English mode: the note follows the translated body and is not translated', () => {
    const db = openDb(':memory:');
    const R = '7400000000000000001';
    const id = ins(db, { tweet_id: R, root_tweet_id: R, author_handle: 'kenji', text: 'こんにちは世界', my_note: 'Japanese greeting post' });
    const it = byId(db, id);
    const hash = createHash('sha256').update(sourceText(it)).digest('hex');
    db.prepare('INSERT INTO translations (item_id, source_hash, text, lang, model, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, hash, 'Hello world', 'Japanese', 'test', now());
    const en = renderItems(db, [it], { english: true }).text;
    assert.ok(en.includes('Hello world\n\n> My note: Japanese greeting post'), en);
    assert.ok(!en.includes('こんにちは'));
    const orig = renderItems(db, [it]).text;
    assert.ok(orig.includes('こんにちは世界\n\n> My note: Japanese greeting post'), orig);
    assert.ok(!renderItems(db, [it], { english: true, notes: false }).text.includes('My note'));
  });

  test('renderBundle and the CLI "bundle" command: notes by default, --no-notes leaves them out', () => {
    const db = openDb(':memory:');
    const s = seed(db);
    const out = [];
    assert.equal(main(['make-bundle', 'Note test', String(s.root), String(s.reply), String(s.note)], { db, out: (x) => out.push(x) }), 0);
    const b = db.prepare('SELECT * FROM bundles').get();
    assert.ok(renderBundle(db, b).text.includes('> My note: root note'));
    assert.ok(!renderBundle(db, b, { notes: false }).text.includes('My note'));

    const run = (...args) => { const o = []; assert.equal(main(['bundle', 'note-test', ...args], { db, out: (x) => o.push(x) }), 0); return o.join('\n'); };
    const on = run();
    assert.ok(on.includes('> My note: root note') && on.includes('> My note: reply note') && on.includes('> My note: text note'), on);
    const offText = run('--no-notes');
    assert.ok(!offText.includes('My note'), offText);
    assert.ok(offText.includes('Root body'));
    const offSrc = run('--sources', '--no-notes');
    assert.ok(!offSrc.includes('My note') && offSrc.includes('## Sources'));
    assert.ok(run('--sources').includes('> My note: root note'));
    // the flag is not taken as part of the bundle name
    const o = [];
    main(['help'], { db, out: (x) => o.push(x) });
    assert.match(o.join('\n'), /--no-notes/);
  });

  test('itemDto returns my_note apart from the internal note, which still hides the tco marker', () => {
    const dto = itemDto({ id: 1, kind: 'link', url: 'https://t.co/x', note: 'tco', my_note: 'mine', fetch_status: 'pending', state: 'inbox' });
    assert.equal(dto.my_note, 'mine');
    assert.equal(dto.note, null);
    const dto2 = itemDto({ id: 2, kind: 'link', url: 'https://e.com', note: 'hint', my_note: null, fetch_status: 'link_only', state: 'inbox' });
    assert.equal(dto2.my_note, null);
    assert.equal(dto2.note, 'hint');
  });
});

// ======================================================================
describe('short links carry the note over', () => {
  function fxBody({ id, h, text = '' }) {
    return JSON.stringify({ code: 200, message: 'OK', tweet: {
      id, url: `https://x.com/${h}/status/${id}`, text, author: { screen_name: h, name: h },
      replying_to: null, replying_to_status: null, created_timestamp: 1793700000, likes: 1, replies: 0, retweets: 0, views: 1 } });
  }
  function setup(world, location) {
    const db = openDb(':memory:');
    const fetchFn = async (url) => {
      const u = new URL(url);
      if (u.hostname === 'api.fxtwitter.com') {
        const id = u.pathname.match(/status\/(\d+)/)[1];
        return world.has(id) ? new Response(world.get(id), { status: 200 }) : new Response('{"code":404,"message":"NOT_FOUND"}', { status: 404 });
      }
      if (u.hostname === 'publish.twitter.com') return new Response('{}', { status: 404 });
      if (u.hostname === 't.co') return location ? new Response(null, { status: 301, headers: { Location: location } }) : new Response('', { status: 404 });
      throw new Error(`unexpected host ${u.hostname}`);
    };
    return { db, f: createFetcher(db, { fetchFn, paceMs: 0 }) };
  }
  let cid = 0;
  const save = (db, input) => capture(db, { input, client_id: `mynote-${String(++cid).padStart(6, '0')}` });

  test('into an existing tweet with no note: the tweet takes the short link\'s note', async () => {
    const { db, f } = setup(new Map([['8100001', fxBody({ id: '8100001', h: 'bob', text: 'known' })]]), 'https://x.com/bob/status/8100001');
    const tw = save(db, 'https://x.com/bob/status/8100001');
    await f.drain();
    const short = save(db, 'https://t.co/carry1');
    assert.equal(byId(db, short.item_id).note, 'tco');
    db.prepare('UPDATE items SET my_note = ? WHERE id = ?').run('from the short link', short.item_id);
    await f.drain();
    assert.equal(byId(db, short.item_id), undefined);
    const it = byId(db, tw.item_id);
    assert.equal(it.my_note, 'from the short link');
    assert.equal(it.note, null, 'the tco marker never lands on the tweet');
  });

  test('into an existing tweet that has a note: both are kept, joined by a blank line', async () => {
    const { db, f } = setup(new Map([['8100002', fxBody({ id: '8100002', h: 'bob', text: 'known' })]]), 'https://x.com/bob/status/8100002');
    const tw = save(db, 'https://x.com/bob/status/8100002');
    await f.drain();
    db.prepare('UPDATE items SET my_note = ? WHERE id = ?').run('tweet note', tw.item_id);
    const short = save(db, 'https://t.co/carry2');
    db.prepare('UPDATE items SET my_note = ? WHERE id = ?').run('short note', short.item_id);
    await f.drain();
    assert.equal(byId(db, tw.item_id).my_note, 'tweet note\n\nshort note');
  });

  test('a short link without a note leaves the tweet\'s note alone', async () => {
    const { db, f } = setup(new Map([['8100003', fxBody({ id: '8100003', h: 'bob', text: 'known' })]]), 'https://x.com/bob/status/8100003');
    const tw = save(db, 'https://x.com/bob/status/8100003');
    await f.drain();
    db.prepare('UPDATE items SET my_note = ? WHERE id = ?').run('keep me', tw.item_id);
    save(db, 'https://t.co/carry3');
    await f.drain();
    assert.equal(byId(db, tw.item_id).my_note, 'keep me');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n, 1);
  });

  test('a short link that becomes a new tweet keeps its note while the internal marker is cleared', async () => {
    const { db, f } = setup(new Map([['8100004', fxBody({ id: '8100004', h: 'carol', text: 'fresh post' })]]), 'https://x.com/carol/status/8100004');
    const short = save(db, 'https://t.co/carry4');
    db.prepare('UPDATE items SET my_note = ? WHERE id = ?').run('saved for the hook', short.item_id);
    await f.runOnce();
    let it = byId(db, short.item_id);
    assert.equal(it.kind, 'tweet');
    assert.equal(it.note, null);
    assert.equal(it.my_note, 'saved for the hook');
    await f.drain();   // the tweet fetch itself must not touch the note either
    it = byId(db, short.item_id);
    assert.equal(it.fetch_status, 'ok');
    assert.equal(it.text, 'fresh post');
    assert.equal(it.my_note, 'saved for the hook');
    assert.ok(byTweetId(db, '8100004'));
  });

  test('a short link to an ordinary page, or one that cannot be expanded, keeps its note', async () => {
    for (const loc of ['https://example.com/story', null]) {
      const { db, f } = setup(new Map(), loc);
      const short = save(db, 'https://t.co/carry5');
      db.prepare('UPDATE items SET my_note = ? WHERE id = ?').run('page note', short.item_id);
      await f.drain();
      const it = byId(db, short.item_id);
      assert.equal(it.fetch_status, 'link_only');
      assert.equal(it.note, null);
      assert.equal(it.my_note, 'page note');
    }
  });
});

// ======================================================================
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

async function boot() {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const app = createApp({
    dbPath: ':memory:', passwordHash: await A.makePasswordHash(PW, 100000), secret: 'x'.repeat(40),
    origins: origin, cookieSecure: false, trustProxy: false, startWorker: false,
    fetchFn: async () => new Response('', { status: 404 }), paceMs: 0, log: () => {},
  });
  await app.listen(port, '127.0.0.1');
  const jar = new Map();
  async function req(method, path, { body, bearer, cookies = true } = {}) {
    const headers = { Origin: origin };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (cookies && jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const res = await fetch(origin + path, { method, headers, body: payload });
    if (cookies) {
      for (const sc of res.headers.getSetCookie()) {
        const [kv] = sc.split(';');
        const i = kv.indexOf('=');
        const v = decodeURIComponent(kv.slice(i + 1).trim());
        if (v) jar.set(kv.slice(0, i).trim(), v); else jar.delete(kv.slice(0, i).trim());
      }
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, text, json };
  }
  // password, then two-step setup and confirm: a full session
  const lg = await req('POST', '/api/login', { body: { password: PW } });
  assert.equal(lg.status, 200, lg.text);
  const s = await req('POST', '/api/mfa/setup', { body: {} });
  assert.equal(s.status, 200, s.text);
  advance(30);
  const c = await req('POST', '/api/mfa/confirm', { body: { code: totp(base32Decode(s.json.secret), now()) } });
  assert.equal(c.status, 200, c.text);
  return { app, db: app.db, req };
}

describe('API: PATCH /api/items/:id my_note', () => {
  let env;
  let ids;
  before(async () => { env = await boot(); ids = seed(env.db); });
  after(async () => { await env.app.close(); });
  const noteOf = (id) => byId(env.db, id).my_note;
  const patch = (id, body, opts) => env.req('PATCH', `/api/items/${id}`, { body, ...opts });

  test('trims, stores and returns the note; GET item and the inbox show it', async () => {
    const r = await patch(ids.note, { my_note: '  why I saved this  \n' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { ok: true, my_note: 'why I saved this' });
    assert.equal(noteOf(ids.note), 'why I saved this');
    const g = await env.req('GET', `/api/items/${ids.note}`);
    assert.equal(g.json.item.my_note, 'why I saved this');
    const inbox = await env.req('GET', '/api/inbox?state=inbox');
    const all = inbox.json.groups.flatMap((x) => [x.root, ...x.thread, ...x.replies]).filter(Boolean);
    assert.equal(all.find((x) => x.id === ids.note).my_note, 'why I saved this');
    assert.equal(all.find((x) => x.id === ids.reply).my_note, 'reply note');
  });

  test('multi-line notes keep their inner lines', async () => {
    const r = await patch(ids.note, { my_note: 'line one\n\nline three' });
    assert.equal(r.json.my_note, 'line one\n\nline three');
  });

  test('an empty or blank string clears it to NULL, and so does null', async () => {
    await patch(ids.note, { my_note: 'something' });
    for (const v of ['', '   \n\t ', null]) {
      await patch(ids.note, { my_note: 'something' });
      const r = await patch(ids.note, { my_note: v });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.my_note, null);
      assert.equal(noteOf(ids.note), null);
    }
  });

  test('2000 characters is fine (counted after trimming); 2001 is refused with a plain message', async () => {
    const ok = await patch(ids.note, { my_note: `   ${'a'.repeat(2000)}   ` });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(noteOf(ids.note).length, 2000);
    const bad = await patch(ids.note, { my_note: 'b'.repeat(2001) });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.message, 'A note can be up to 2000 characters');
    assert.equal(noteOf(ids.note), 'a'.repeat(2000), 'nothing changed');
  });

  test('a note that is not text is refused', async () => {
    await patch(ids.note, { my_note: 'before' });
    for (const v of [42, true, ['x'], { text: 'x' }]) {
      const r = await patch(ids.note, { my_note: v });
      assert.equal(r.status, 400, JSON.stringify(v));
      assert.equal(r.json.message, 'A note must be text');
    }
    assert.equal(noteOf(ids.note), 'before');
  });

  test('an unknown item is a 404', async () => {
    const r = await patch(999999, { my_note: 'x' });
    assert.equal(r.status, 404);
  });

  test('a note can come with other changes; a bad change is refused and the note is not written', async () => {
    const r = await patch(ids.link, { my_note: 'together', state: 'archived', priority: 2 });
    assert.equal(r.status, 200, r.text);
    let it = byId(env.db, ids.link);
    assert.equal(it.my_note, 'together');
    assert.equal(it.state, 'archived');
    assert.equal(it.priority, 2);
    const bad = await patch(ids.link, { my_note: 'should not land', state: 'nowhere' });
    assert.equal(bad.status, 400);
    const bad2 = await patch(ids.link, { my_note: 'should not land', category_id: 424242 });
    assert.equal(bad2.status >= 400, true);
    it = byId(env.db, ids.link);
    assert.equal(it.my_note, 'together');
    assert.equal(it.state, 'archived');
    await patch(ids.link, { state: 'inbox' });
  });

  test('the old PATCH body without a note still works, and still needs something to change', async () => {
    assert.equal((await patch(ids.root, { priority: 1 })).status, 200);
    assert.equal(byId(env.db, ids.root).my_note, 'root note', 'organizing leaves the note alone');
    assert.equal((await patch(ids.root, {})).status, 400);
  });

  test('bulk changes refuse notes (they are per item) and change nothing', async () => {
    const before = [ids.root, ids.reply].map((id) => byId(env.db, id));
    const r = await env.req('POST', '/api/items/bulk', { body: { ids: [ids.root, ids.reply], my_note: 'everyone', state: 'archived' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.message, 'Notes are saved one item at a time');
    for (const b of before) {
      const now2 = byId(env.db, b.id);
      assert.equal(now2.my_note, b.my_note);
      assert.equal(now2.state, b.state);
    }
    // a plain bulk change still works and leaves notes alone
    const ok = await env.req('POST', '/api/items/bulk', { body: { ids: [ids.root, ids.reply], priority: 3 } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(byId(env.db, ids.root).my_note, 'root note');
    assert.equal(byId(env.db, ids.reply).my_note, 'reply note');
  });

  test('device tokens (capture or read) cannot set notes', async () => {
    for (const scopes of ['capture', 'read', 'capture,read']) {
      const d = A.createDeviceToken(env.db, `phone-${scopes}`, scopes);
      const r = await patch(ids.reply, { my_note: 'from a phone' }, { bearer: d.token, cookies: false });
      assert.equal(r.status, 403, `${scopes}: ${r.text}`);
      const b = await env.req('POST', '/api/items/bulk', { body: { ids: [ids.reply], my_note: 'x' }, bearer: d.token, cookies: false });
      assert.equal(b.status, 403);
    }
    // signed out: no session, no token
    const anon = await patch(ids.reply, { my_note: 'anon' }, { cookies: false });
    assert.equal(anon.status, 401);
    assert.equal(noteOf(ids.reply), 'reply note');
  });

  test('my_note never touches the internal note: a pending short link keeps its tco marker', async () => {
    const t = now();
    const tco = ins(env.db, { kind: 'link', url: 'https://t.co/abc', note: 'tco', fetch_status: 'pending', first_saved_at: t, last_saved_at: t });
    await patch(tco, { my_note: 'my words' });
    let it = byId(env.db, tco);
    assert.equal(it.note, 'tco');
    assert.equal(it.my_note, 'my words');
    await patch(tco, { my_note: null });
    it = byId(env.db, tco);
    assert.equal(it.note, 'tco');
    assert.equal(it.my_note, null);
    // a body that names the internal field is not a way to write it
    const r = await patch(tco, { note: 'hacked' });
    assert.equal(r.status, 400);
    const r2 = await patch(tco, { note: 'hacked', my_note: 'fine' });
    assert.equal(r2.status, 200);
    assert.equal(byId(env.db, tco).note, 'tco');
    const dto = (await env.req('GET', `/api/items/${tco}`)).json.item;
    assert.equal(dto.note, null);
    assert.equal(dto.my_note, 'fine');
    env.db.prepare('DELETE FROM items WHERE id = ?').run(tco);
  });
});

describe('API: notes in the render, export and size cap', () => {
  let env;
  let ids;
  let slug;
  before(async () => {
    env = await boot();
    ids = seed(env.db);
    const r = await env.req('POST', '/api/bundles', { body: { title: 'Notes bundle', item_ids: [ids.root, ids.part, ids.reply, ids.note] } });
    assert.equal(r.status, 201, r.text);
    slug = r.json.slug;
  });
  after(async () => { await env.app.close(); });
  const render = (body) => env.req('POST', '/api/render', { body: { item_ids: [ids.root, ids.part, ids.reply, ids.note, ids.link], ...body } });

  test('POST /api/render includes notes by default and leaves them out only for notes: false', async () => {
    const on = await render({});
    assert.equal(on.status, 200, on.text);
    for (const n of ['root note', 'part note', 'reply note', 'text note', 'link note']) {
      assert.ok(on.json.text.includes(`> My note: ${n}`), n);
      assert.ok(on.json.text_sources.includes(`> My note: ${n}`), n);
    }
    const off = await render({ notes: false });
    assert.ok(!off.json.text.includes('My note'));
    assert.ok(!off.json.text_sources.includes('My note'));
    // only a real false turns them off
    for (const v of [true, 'false', 0, null]) assert.ok((await render({ notes: v })).json.text.includes('My note'), String(v));
  });

  test('a note saved through PATCH shows up in the next render (what the copy buttons use)', async () => {
    await env.req('PATCH', `/api/items/${ids.note}`, { body: { my_note: 'fresh\nsecond line' } });
    const r = await render({});
    assert.ok(r.json.text.includes('## Note 1\nLoose text body\n\n> My note: fresh\n> second line'), r.json.text);
    await env.req('PATCH', `/api/items/${ids.note}`, { body: { my_note: 'text note' } });
  });

  test('GET /api/bundles/:slug and its export: notes by default, ?notes=0 leaves them out', async () => {
    const b = await env.req('GET', `/api/bundles/${slug}`);
    assert.ok(b.json.text.includes('> My note: root note'));
    assert.equal(b.json.items.find((x) => x.id === ids.reply).my_note, 'reply note');
    const ex = await env.req('GET', `/api/bundles/${slug}/export`);
    assert.equal(ex.status, 200);
    assert.ok(ex.text.includes('> My note: part note') && ex.text.includes('## Sources'));
    const exOff = await env.req('GET', `/api/bundles/${slug}/export?notes=0`);
    assert.ok(!exOff.text.includes('My note') && exOff.text.includes('## Sources'));
    const exOffText = await env.req('GET', `/api/bundles/${slug}/export?notes=0&sources=0`);
    assert.ok(!exOffText.text.includes('My note') && !exOffText.text.includes('## Sources'));
    assert.ok((await env.req('GET', `/api/bundles/${slug}/export?notes=1&sources=0`)).text.includes('> My note: reply note'));
  });

  test('a read-only device can export, with or without notes', async () => {
    const d = A.createDeviceToken(env.db, 'claude', 'read');
    const on = await env.req('GET', `/api/bundles/${slug}/export`, { bearer: d.token, cookies: false });
    assert.equal(on.status, 200, on.text);
    assert.ok(on.text.includes('> My note: root note'));
    const off = await env.req('GET', `/api/bundles/${slug}/export?notes=0`, { bearer: d.token, cookies: false });
    assert.ok(!off.text.includes('My note'));
  });

  test('note length counts toward the render size cap', async () => {
    const t = now();
    const big = ins(env.db, { kind: 'text', fetch_status: 'n/a', text: 'tiny', first_saved_at: t, last_saved_at: t, my_note: 'n'.repeat(5_000_001) });
    const r = await env.req('POST', '/api/render', { body: { item_ids: [big] } });
    assert.equal(r.status, 413);
    env.db.prepare('DELETE FROM items WHERE id = ?').run(big);
  });
});

describe('phase 1 review fixes: notes', () => {
  test('a note cannot be added to a context post you did not save', async () => {
    const env = await boot();
    try {
      const ctxId = ins(env.db, { tweet_id: '777000111', text: 'someone else', saved: 0, ctx_depth: 1 });
      const r = await env.req('PATCH', `/api/items/${ctxId}`, { body: { my_note: 'mine' } });
      assert.equal(r.status, 400, r.text);
      assert.equal(byId(env.db, ctxId).my_note, null);
    } finally { await env.app.close(); }
  });
});
