// "Get full thread" (pass 1, feature 1.2): the v2 mapper, the worker job and the API routes.
// The worker runs against the real FxTwitter v2 thread fixture through a fake fetchFn; nothing touches the network.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { openDb, now } from '../src/db.js';
import { byTweetId, byId } from '../src/items.js';
import { createFetcher } from '../src/fetcher.js';
import { fxV2ToFields, fxTweetToFields } from '../src/fx.js';
import { interpretThread, pickParts, threadPartIds, MAX_PARTS, RETRY_MARK, THREAD_RETRY_S } from '../src/thread.js';
import { buildInbox } from '../src/tree.js';
import { renderItems, loadItemsInOrder, normaliseOrder } from '../src/render.js';
import { createApp } from '../src/server.js';
import * as A from '../src/auth.js';
import { totp, base32Decode } from '../src/totp.js';

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const THREAD = fixture('v2thread-multi.json');
const T = JSON.parse(THREAD);
const IDS = T.thread.map((p) => p.id);
const FIRST = IDS[0];
const MIDDLE = '2007179838864666847';   // part "3/", the post the fixture was fetched from
const clone = () => JSON.parse(THREAD);

// ---------- fake network ----------
// thread: Map tweetId -> body string | (callIndex) => Response; anything else under /status/ is a 404
function makeNet({ thread = new Map(), status = new Map() } = {}) {
  const calls = [];
  const counts = new Map();
  const fetchFn = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    if (u.hostname === 'publish.twitter.com') return new Response('', { status: 404 });
    if (u.hostname !== 'api.fxtwitter.com') throw new Error(`unexpected host ${u.hostname}`);
    const tm = u.pathname.match(/^\/2\/thread\/(\d+)$/);
    if (tm) {
      const n = (counts.get(tm[1]) || 0) + 1;
      counts.set(tm[1], n);
      const w = thread.get(tm[1]);
      if (typeof w === 'function') return w(n);
      if (typeof w === 'string') return new Response(w, { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('{"code":404,"message":"NOT_FOUND"}', { status: 404 });
    }
    const sm = u.pathname.match(/status\/(\d+)/);
    if (sm && status.has(sm[1])) return new Response(status.get(sm[1]), { status: 200 });
    return new Response('{"code":404,"message":"NOT_FOUND"}', { status: 404 });
  };
  return { fetchFn, calls };
}

function setup(netOpts) {
  const db = openDb(':memory:');
  const clock = { t: 1794000000 };
  const n = makeNet(netOpts);
  const f = createFetcher(db, { fetchFn: n.fetchFn, paceMs: 0, nowFn: () => clock.t });
  return { db, clock, net: n, f };
}

function ins(db, f) {
  const row = { kind: 'tweet', saved: 1, state: 'inbox', fetch_status: 'ok', first_saved_at: 1, last_saved_at: 1, ...f };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid);
}
const queue = (db, id) => db.prepare("UPDATE items SET thread_status = 'queued', thread_error = NULL, thread_at = NULL WHERE id = ?").run(id);
// a saved post with its thread job queued, as the route leaves it
function requested(db, tweetId = MIDDLE, extra = {}) {
  const id = ins(db, { tweet_id: tweetId, author_handle: 'bcherny', url: `https://x.com/bcherny/status/${tweetId}`, text: 'saved earlier', ...extra });
  queue(db, id);
  return id;
}
const count = (db, sql = 'SELECT COUNT(*) AS n FROM items') => db.prepare(sql).get().n;

function renderAll(db) {
  const ids = db.prepare('SELECT id FROM items WHERE saved = 1 ORDER BY id').all().map((r) => r.id);
  return renderItems(db, loadItemsInOrder(db, normaliseOrder(loadItemsInOrder(db, ids), db))).text;
}

// a long self-thread in the v2 shape: n posts by `h`, each replying to the one before
function chain(n, h = 'longposter', start = 3000000000000000000n) {
  const thread = [];
  for (let i = 0; i < n; i++) {
    const id = String(start + BigInt(i));
    thread.push({
      id, text: `Part ${i + 1}`, author: { screen_name: h, name: h }, created_timestamp: 1790000000 + i,
      replying_to: i ? { screen_name: h, status: String(start + BigInt(i - 1)) } : null, likes: i, replies: 0, reposts: 0, views: 1, media: {},
    });
  }
  return { code: 200, status: thread[0], thread };
}

// ======================================================================
describe('fxV2ToFields (v2 post shape)', () => {
  test('maps the real fixture: ids, parent, author, counts and photos', () => {
    const f0 = fxV2ToFields(T.thread[0]);
    assert.equal(f0.tweet_id, FIRST);
    assert.equal(f0.parent_tweet_id, null);
    assert.equal(f0.author_handle, 'bcherny');
    assert.equal(f0.author_name, T.thread[0].author.name);
    assert.equal(f0.url, `https://x.com/bcherny/status/${FIRST}`);
    assert.equal(f0.posted_at, T.thread[0].created_timestamp);
    assert.equal(f0.likes, T.thread[0].likes);
    assert.equal(f0.reposts, T.thread[0].reposts);
    assert.equal(f0.views, T.thread[0].views);
    assert.equal(f0.kind, 'tweet');
    assert.ok(f0.text.startsWith("I'm Boris"));
    const f1 = fxV2ToFields(T.thread[1]);
    assert.equal(f1.parent_tweet_id, FIRST);
    // the photo comes once, even though media.all and media.photos both list it
    const imgs = f1.text.split('\n').filter((l) => l.startsWith('[Image: '));
    assert.deepEqual(imgs, [`[Image: ${T.thread[1].media.photos[0].url}]`]);
  });

  test('media.all with a video and a gif, and media.photos/videos when there is no media.all', () => {
    const base = { id: '5', text: 'hi', author: { screen_name: 'a' } };
    const all = fxV2ToFields({ ...base, media: { all: [
      { type: 'photo', url: 'https://pbs.twimg.com/p.jpg' }, { type: 'video', url: 'https://video.twimg.com/v.mp4' },
      { type: 'gif', url: 'https://video.twimg.com/g.mp4' }, { type: 'photo' }, null] } });
    assert.equal(all.text, 'hi\n[Image: https://pbs.twimg.com/p.jpg]\n[Video: https://video.twimg.com/v.mp4]\n[Video: https://video.twimg.com/g.mp4]');
    const old = fxV2ToFields({ ...base, media: { photos: [{ url: 'https://pbs.twimg.com/q.jpg' }], videos: [{ url: 'https://video.twimg.com/w.mp4' }] } });
    assert.equal(old.text, 'hi\n[Image: https://pbs.twimg.com/q.jpg]\n[Video: https://video.twimg.com/w.mp4]');
    assert.equal(fxV2ToFields({ ...base, media: null }).text, 'hi');
    assert.equal(fxV2ToFields({ ...base }).text, 'hi');
  });

  test('quote and article come through the same way as v1', () => {
    const q = fxV2ToFields({ id: '7', text: 'look', author: { screen_name: 'a', name: 'A' }, replying_to: { screen_name: 'a', status: '6' },
      quote: { id: '9', text: 'quoted text', author: { screen_name: 'b', name: 'B' } } });
    assert.equal(q.parent_tweet_id, '6');
    assert.equal(q.quote_tweet_id, '9');
    assert.deepEqual(JSON.parse(q.quote_json), { handle: 'b', name: 'B', text: 'quoted text', url: 'https://x.com/b/status/9' });
    const a = fxV2ToFields({ id: '8', text: 'https://x.com/i/article/123', author: { screen_name: 'a' },
      article: { title: 'Big idea', preview_text: 'Just the start' } });
    assert.equal(a.kind, 'article');
    assert.equal(a.article_title, 'Big idea');
    assert.match(a.article_md, /Just the start/);
    assert.equal(a.text, '');
  });

  test('the v1 mapper is unchanged: it reads replying_to_status and retweets, not the v2 fields', () => {
    const v1 = fxTweetToFields({ id: '3', text: 't', author: { screen_name: 'a' }, replying_to: 'a', replying_to_status: '2', retweets: 4,
      media: { photos: [{ url: 'https://pbs.twimg.com/x.jpg' }] } });
    assert.equal(v1.parent_tweet_id, '2');
    assert.equal(v1.reposts, 4);
    assert.equal(v1.text, 't\n[Image: https://pbs.twimg.com/x.jpg]');
    // a v2 post fed to the v1 mapper loses its parent: that is why fxV2ToFields exists
    assert.equal(fxTweetToFields(T.thread[1]).parent_tweet_id, null);
  });
});

describe('interpretThread and pickParts', () => {
  test('answers from FxTwitter', () => {
    assert.equal(interpretThread(200, THREAD).ok.length, 15);
    assert.ok(interpretThread(429, '').retry);
    assert.ok(interpretThread(503, '<html>').retry);
    assert.ok(interpretThread(200, '{"code":500}').retry);
    assert.match(interpretThread(404, '{"code":404,"message":"NOT_FOUND"}').fail, /deleted or could not be found/);
    assert.match(interpretThread(200, '{"code":401}').fail, /private/);
    assert.match(interpretThread(200, '<html>not json</html>').fail, /could not read/);
    assert.match(interpretThread(200, '{"code":200,"thread":"nope"}').fail, /did not send a thread/);
    assert.match(interpretThread(200, '{"code":200,"thread":[{"id":"../../x"}]}').fail, /did not send a thread/);
    // the post asked about is added from `status` when thread[] leaves it out
    const j = clone();
    j.thread = j.thread.filter((p) => p.id !== MIDDLE);
    assert.ok(interpretThread(200, JSON.stringify(j)).ok.some((p) => p.id === MIDDLE));
  });

  test('keeps the author, orders parents first, and caps at 100', () => {
    const j = clone();
    j.thread[5].author = { screen_name: 'someone_else', name: 'Other' };
    const shuffled = [...j.thread].reverse();
    const { parts, capped } = pickParts({ author_handle: 'BCHERNY', tweet_id: MIDDLE }, shuffled);
    assert.equal(capped, false);
    assert.deepEqual(parts.map((p) => p.id), IDS.filter((_, i) => i !== 5));
    const long = chain(MAX_PARTS + 7);
    const r = pickParts({ author_handle: 'longposter', tweet_id: long.thread[0].id }, long.thread);
    assert.equal(r.parts.length, MAX_PARTS);
    assert.equal(r.capped, true);
    assert.equal(r.parts[MAX_PARTS - 1].id, long.thread[MAX_PARTS - 1].id);
  });

  test('falls back only to the post with the same id (never another account), and refuses odd handles', () => {
    // a renamed account: the saved handle matches nothing
    assert.equal(pickParts({ author_handle: 'old_name', tweet_id: MIDDLE }, T.thread).parts.length, 15);
    // no handle and no post with the saved id: nothing, rather than guessing the first post's author
    assert.equal(pickParts({ author_handle: null, tweet_id: '1' }, T.thread).parts.length, 0);
    const bad = clone();
    for (const p of bad.thread) p.author.screen_name = 'evil/../x';
    assert.equal(pickParts({ author_handle: null, tweet_id: MIDDLE }, bad.thread).parts.length, 0);
  });
});

// ======================================================================
describe('the worker job', () => {
  const world = () => ({ thread: new Map([[MIDDLE, THREAD], [FIRST, THREAD]]) });

  function assertWholeThread(db, rootTid = FIRST) {
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM items WHERE saved = 1'), 15);
    for (const tid of IDS) {
      const it = byTweetId(db, tid);
      assert.ok(it, tid);
      assert.equal(it.saved, 1);
      assert.equal(it.fetch_status, 'ok');
      assert.equal(it.state, 'inbox');
      assert.equal(it.root_tweet_id, rootTid);
      assert.equal(it.is_self_thread, tid === rootTid ? 0 : 1, tid);
    }
    const groups = buildInbox(db);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].root.tweet_id, FIRST);
    assert.deepEqual(groups[0].thread.map((x) => x.tweet_id), IDS.slice(1));
    const text = renderAll(db);
    for (let n = 2; n <= 15; n++) assert.ok(text.includes(`### Thread, part ${n}\n`), `part ${n}`);
    assert.ok(!text.includes('Thread, part 16'));
    assert.ok(text.indexOf('Thread, part 2') < text.indexOf('Thread, part 15'));
  }

  test('from the middle post: all 15 parts saved, grouped, and the job done', async () => {
    const { db, f, net: n, clock } = setup(world());
    const id = requested(db, MIDDLE);
    assert.equal(await f.runOnce(), true);
    assert.deepEqual(n.calls, [`https://api.fxtwitter.com/2/thread/${MIDDLE}`]);
    assertWholeThread(db);
    const it = byId(db, id);
    assert.equal(it.thread_status, 'done');
    assert.equal(it.thread_at, clock.t);
    assert.equal(it.thread_error, null);
    // the saved post keeps its own row (no duplicate) and its text stays, because it was already 'ok'
    assert.equal(it.text, 'saved earlier');
    const raw = db.prepare("SELECT * FROM raw_fetches WHERE source = 'fxthread'").all();
    assert.equal(raw.length, 1);
    assert.equal(raw[0].item_id, id);
    assert.equal(raw[0].body, THREAD);
    // a new part has the mapped fields
    const p2 = byTweetId(db, IDS[1]);
    assert.equal(p2.parent_tweet_id, FIRST);
    assert.equal(p2.author_handle, 'bcherny');
    assert.equal(p2.first_saved_at, clock.t);
    assert.ok(p2.render_version);
    assert.match(p2.text, /\[Image: https:\/\/pbs\.twimg\.com\//);
    assert.deepEqual(threadPartIds(db, byId(db, id)), IDS.map((tid) => byTweetId(db, tid).id));
    // nothing else to do
    assert.equal(await f.runOnce(), false);
  });

  test('from the first post', async () => {
    const { db, f, net: n } = setup(world());
    const id = requested(db, FIRST);
    await f.runOnce();
    assert.deepEqual(n.calls, [`https://api.fxtwitter.com/2/thread/${FIRST}`]);
    assertWholeThread(db);
    assert.equal(byId(db, id).thread_status, 'done');
  });

  test('context rows (saved = 0) become saved parts and get their text', async () => {
    const { db, f, clock } = setup(world());
    // parts 1 and 2 were added as context above the saved part 3, waiting for their own fetch
    // (part 1 waits out a back-off, so the thread job is what runs now)
    const c1 = ins(db, { tweet_id: IDS[0], author_handle: 'bcherny', saved: 0, ctx_depth: 2, fetch_status: 'pending', next_fetch_at: clock.t + 600, first_saved_at: null, last_saved_at: null });
    const c2 = ins(db, { tweet_id: IDS[1], parent_tweet_id: IDS[0], author_handle: 'bcherny', saved: 0, ctx_depth: 1, fetch_status: 'failed', fetch_attempts: 6, first_saved_at: null, last_saved_at: null });
    requested(db, MIDDLE, { parent_tweet_id: IDS[2] });
    await f.runOnce();
    assertWholeThread(db);
    for (const cid of [c1, c2]) {
      const it = byId(db, cid);
      assert.equal(it.saved, 1);
      assert.equal(it.ctx_depth, 0);
      assert.equal(it.fetch_status, 'ok');
      assert.equal(it.fetch_attempts, 0);
      assert.equal(it.next_fetch_at, null);
      assert.equal(it.first_saved_at, clock.t);
      assert.ok(it.text && it.text.length > 20);
    }
    assert.equal(count(db), 15, 'no duplicate rows');
  });

  test('a second run makes no duplicates', async () => {
    const { db, f, clock } = setup(world());
    const id = requested(db, MIDDLE);
    await f.runOnce();
    const before = db.prepare('SELECT id, tweet_id FROM items ORDER BY id').all();
    clock.t += 100;
    queue(db, id);
    await f.runOnce();
    assert.deepEqual(db.prepare('SELECT id, tweet_id FROM items ORDER BY id').all(), before);
    assertWholeThread(db);
    assert.equal(byId(db, id).thread_status, 'done');
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM raw_fetches WHERE source = 'fxthread'"), 1);
  });

  test('posts by other authors are never saved or touched', async () => {
    const j = clone();
    // a reply by someone else in the middle of thread[], and one more pretending to be a later part
    j.thread[4].author = { screen_name: 'intruder', name: 'Intruder' };
    j.thread.push({ ...j.thread[14], id: '2007179899999999999', author: { screen_name: 'other', name: 'Other' },
      replying_to: { screen_name: 'bcherny', status: IDS[14] }, text: 'not mine' });
    // the intruder's post is already in the vault as an unsaved context row
    const { db, f, clock } = setup({ thread: new Map([[MIDDLE, JSON.stringify(j)]]) });
    const other = ins(db, { tweet_id: IDS[4], author_handle: 'intruder', saved: 0, fetch_status: 'pending', next_fetch_at: clock.t + 600, text: null, first_saved_at: null, last_saved_at: null });
    requested(db, MIDDLE);
    await f.runOnce();
    assert.equal(byTweetId(db, '2007179899999999999'), undefined);
    const o = byId(db, other);
    assert.equal(o.saved, 0);
    assert.equal(o.fetch_status, 'pending');
    assert.equal(o.next_fetch_at, clock.t + 600);
    assert.equal(o.text, null);
    assert.equal(o.author_handle, 'intruder');
    assert.equal(o.parent_tweet_id, null);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM items WHERE saved = 1'), 14);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM items WHERE saved = 1 AND author_handle != 'bcherny'"), 0);
  });

  test('the 100-part cap: the first 100 saved, the job done with a note', async () => {
    const long = chain(MAX_PARTS + 5);
    const { db, f } = setup({ thread: new Map([[long.thread[0].id, JSON.stringify(long)]]) });
    const id = requested(db, long.thread[0].id, { author_handle: 'longposter' });
    await f.runOnce();
    assert.equal(count(db), MAX_PARTS);
    const it = byId(db, id);
    assert.equal(it.thread_status, 'done');
    assert.match(it.thread_error, /more than 100 parts\. Saved the first 100\./);
    assert.equal(byTweetId(db, long.thread[MAX_PARTS].id), undefined);
    // all 100 group under the first part, even past recomputeRoots' old 40-level walk
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM items WHERE root_tweet_id = '${long.thread[0].id}'`), MAX_PARTS);
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM items WHERE is_self_thread = 1'), MAX_PARTS - 1);
    const text = renderAll(db);
    assert.ok(text.includes('### Thread, part 100\nPart 100'));
    assert.ok(!text.includes('Thread, part 101'));
    assert.deepEqual(threadPartIds(db, it).length, MAX_PARTS);
  });

  test('busy (503) once: retried after 120 s; busy again: failed with a plain message', async () => {
    const { db, f, clock, net: n } = setup({ thread: new Map([[MIDDLE, () => new Response('busy', { status: 503 })]]) });
    const id = requested(db, MIDDLE);
    await f.runOnce();
    let it = byId(db, id);
    assert.equal(it.thread_status, 'queued');
    assert.equal(it.thread_error, RETRY_MARK);
    assert.equal(it.thread_at, clock.t + THREAD_RETRY_S);
    // not due yet: nothing runs
    assert.equal(await f.runOnce(), false);
    clock.t += THREAD_RETRY_S;
    assert.equal(await f.runOnce(), true);
    it = byId(db, id);
    assert.equal(it.thread_status, 'failed');
    assert.match(it.thread_error, /busy/i);
    assert.notEqual(it.thread_error, RETRY_MARK);
    assert.equal(n.calls.length, 2);
    assert.equal(count(db), 1, 'nothing saved');
  });

  test('429 once, then the thread comes through', async () => {
    const { db, f, clock } = setup({ thread: new Map([[MIDDLE, (k) => (k === 1
      ? new Response('{"code":429}', { status: 429 })
      : new Response(THREAD, { status: 200 }))]]) });
    const id = requested(db, MIDDLE);
    await f.runOnce();
    assert.equal(byId(db, id).thread_error, RETRY_MARK);
    clock.t += THREAD_RETRY_S;
    await f.runOnce();
    assert.equal(byId(db, id).thread_status, 'done');
    assert.equal(byId(db, id).thread_error, null);
    assertWholeThread(db);
  });

  test('a network error counts as busy', async () => {
    const { db, f } = setup({ thread: new Map([[MIDDLE, () => { throw new Error('socket hang up'); }]]) });
    const id = requested(db, MIDDLE);
    await f.runOnce();
    assert.equal(byId(db, id).thread_status, 'queued');
    assert.equal(byId(db, id).thread_error, RETRY_MARK);
  });

  test('404, private and unreadable answers fail at once', async () => {
    for (const [resp, re] of [
      [() => new Response('{"code":404,"message":"NOT_FOUND"}', { status: 404 }), /deleted or could not be found/],
      [() => new Response('{"code":401,"message":"PRIVATE_TWEET"}', { status: 401 }), /private/],
      [() => new Response('<html>oops</html>', { status: 200 }), /could not read/],
    ]) {
      const { db, f } = setup({ thread: new Map([[MIDDLE, resp]]) });
      const id = requested(db, MIDDLE);
      await f.runOnce();
      const it = byId(db, id);
      assert.equal(it.thread_status, 'failed');
      assert.match(it.thread_error, re);
      assert.equal(count(db), 1);
    }
  });

  test('normal fetches go first; the thread job runs when nothing else is due', async () => {
    const { db, f, net: n } = setup(world());
    requested(db, MIDDLE);
    ins(db, { tweet_id: '1111', author_handle: 'x', fetch_status: 'pending' });
    await f.runOnce();
    assert.ok(n.calls.length >= 1 && n.calls.every((u) => !u.includes('/2/thread/')), n.calls.join(' '));
    assert.equal(byTweetId(db, '1111').fetch_status, 'unavailable');
    await f.runOnce();
    assert.equal(n.calls.at(-1), `https://api.fxtwitter.com/2/thread/${MIDDLE}`);
  });

  test('a job whose item was deleted while fetching does nothing', async () => {
    let db;
    const { db: d, f } = setup({ thread: new Map([[MIDDLE, () => {
      db.prepare('DELETE FROM items').run();
      return new Response(THREAD, { status: 200 });
    }]]) });
    db = d;
    requested(db, MIDDLE);
    await f.runOnce();
    assert.equal(count(db), 0);
  });
});

// ======================================================================
describe('API: /api/items/:id/thread', () => {
  const PW = 'correct horse battery staple';
  const realNow = Date.now;
  let skewMs = 0;
  let env;
  let owner;
  let fetchCalls;

  function freePort() {
    return new Promise((res, rej) => {
      const s = net.createServer();
      s.once('error', rej);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
  }

  function browser(base, origin) {
    const jar = new Map();
    return {
      async req(method, path, { body, origin: o = origin, bearer } = {}) {
        const headers = {};
        if (o) headers.Origin = o;
        if (bearer) headers.Authorization = `Bearer ${bearer}`;
        if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
        let payload;
        if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
        const res = await fetch(base + path, { method, headers, body: payload });
        for (const sc of res.headers.getSetCookie()) {
          const [kv, ...attrs] = sc.split(';');
          const i = kv.indexOf('=');
          const k = kv.slice(0, i).trim();
          const v = decodeURIComponent(kv.slice(i + 1).trim());
          if (!v || attrs.some((a) => a.trim() === 'Max-Age=0')) jar.delete(k); else jar.set(k, v);
        }
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* text */ }
        return { status: res.status, text, json };
      },
    };
  }

  before(async () => {
    Date.now = () => realNow() + skewMs;
    fetchCalls = [];
    const fetchFn = async (url) => {
      fetchCalls.push(String(url));
      if (String(url) === `https://api.fxtwitter.com/2/thread/${MIDDLE}`) return new Response(THREAD, { status: 200 });
      return new Response('{"code":404}', { status: 404 });
    };
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const app = createApp({
      dbPath: ':memory:', passwordHash: await A.makePasswordHash(PW, 100000), secret: 'x'.repeat(40),
      origins: origin, cookieSecure: false, trustProxy: false, startWorker: false, fetchFn, paceMs: 0, log: () => {},
    });
    await app.listen(port, '127.0.0.1');
    env = { app, db: app.db, base: origin, origin };
    // password, then a real two-step set-up with a TOTP code
    owner = browser(env.base, env.origin);
    const lg = await owner.req('POST', '/api/login', { body: { password: PW } });
    assert.equal(lg.status, 200, lg.text);
    const s = await owner.req('POST', '/api/mfa/setup', { body: {} });
    assert.equal(s.status, 200, s.text);
    skewMs += 30_000;
    const c = await owner.req('POST', '/api/mfa/confirm', { body: { code: totp(base32Decode(s.json.secret), now()) } });
    assert.equal(c.status, 200, c.text);
  });
  after(async () => { await env.app.close(); Date.now = realNow; });
  beforeEach(() => A._resetLockouts());

  const post = (id, opts) => owner.req('POST', `/api/items/${id}/thread`, { body: {}, ...opts });

  test('refuses what has no thread, with a plain message', async () => {
    const db = env.db;
    assert.equal((await post(999999)).status, 404);
    assert.equal((await post('abc')).status, 404);
    assert.equal((await owner.req('GET', '/api/items/999999/thread')).status, 404);
    const note = ins(db, { kind: 'text', text: 'a note', fetch_status: 'n/a' });
    const link = ins(db, { kind: 'link', url: 'https://example.com', fetch_status: 'link_only' });
    for (const id of [note, link]) {
      const r = await post(id);
      assert.equal(r.status, 400);
      assert.match(r.json.message, /Only posts and articles/);
    }
    for (const st of ['pending', 'failed', 'unavailable']) {
      const id = ins(db, { tweet_id: `77${st.length}${Math.floor(Math.random() * 1e6)}`, author_handle: 'a', fetch_status: st });
      const r = await post(id);
      assert.equal(r.status, 400, st);
      assert.match(r.json.message, /Wait until this post has loaded/);
      assert.equal(byId(db, id).thread_status, null);
    }
    // the request must come from the page's own origin and be JSON
    const ok = ins(db, { tweet_id: '880001', author_handle: 'a' });
    assert.equal((await post(ok, { origin: 'https://evil.example' })).status, 403);
    assert.equal(byId(db, ok).thread_status, null);
  });

  test('device tokens (capture or read) and signed-out browsers cannot queue or read jobs', async () => {
    const db = env.db;
    const id = ins(db, { tweet_id: '880002', author_handle: 'a', fetch_status: 'oembed' });
    const anon = browser(env.base, env.origin);
    for (const scope of ['capture', 'read', 'capture,read']) {
      const tok = A.createDeviceToken(db, `tok-${scope}`, scope).token;
      assert.equal((await anon.req('POST', `/api/items/${id}/thread`, { body: {}, bearer: tok, origin: null })).status, 403, scope);
      assert.equal((await anon.req('GET', `/api/items/${id}/thread`, { bearer: tok, origin: null })).status, 403, scope);
    }
    assert.equal((await anon.req('POST', `/api/items/${id}/thread`, { body: {} })).status, 401);
    assert.equal((await anon.req('GET', `/api/items/${id}/thread`)).status, 401);
    assert.equal(byId(db, id).thread_status, null);
  });

  test('queues once, the worker saves the thread, GET reports it', async () => {
    const db = env.db;
    const id = ins(db, { tweet_id: MIDDLE, author_handle: 'bcherny', url: `https://x.com/bcherny/status/${MIDDLE}`, text: '3/ I use Opus' });
    const g0 = await owner.req('GET', `/api/items/${id}/thread`);
    assert.equal(g0.status, 200);
    assert.deepEqual(g0.json, { status: null, error: null, part_ids: [id] });

    const r = await post(id);
    assert.equal(r.status, 202, r.text);
    assert.deepEqual(r.json, { queued: true });
    let it = byId(db, id);
    assert.equal(it.thread_status, 'queued');
    assert.equal(it.thread_at, null);
    // already queued: answered the same, and the job is not reset
    db.prepare('UPDATE items SET thread_at = 123, thread_error = ? WHERE id = ?').run(RETRY_MARK, id);
    const again = await post(id);
    assert.equal(again.status, 202);
    assert.deepEqual(again.json, { queued: true });
    it = byId(db, id);
    assert.equal(it.thread_at, 123);
    assert.equal(it.thread_error, RETRY_MARK);
    // the retry marker is never shown to the page
    assert.deepEqual((await owner.req('GET', `/api/items/${id}/thread`)).json, { status: 'queued', error: null, part_ids: [id] });

    // the inbox shows the job on the card
    const inbox = await owner.req('GET', '/api/inbox');
    const card = inbox.json.groups.flatMap((g) => [g.root, ...g.thread, ...g.replies]).find((x) => x && x.id === id);
    assert.equal(card.thread_status, 'queued');

    db.prepare('UPDATE items SET thread_at = NULL WHERE id = ?').run(id);
    await env.app.fetcher.drain();
    assert.ok(fetchCalls.includes(`https://api.fxtwitter.com/2/thread/${MIDDLE}`));
    const g = await owner.req('GET', `/api/items/${id}/thread`);
    assert.equal(g.json.status, 'done');
    assert.equal(g.json.error, null);
    assert.equal(g.json.part_ids.length, 15);
    assert.deepEqual(g.json.part_ids, IDS.map((tid) => byTweetId(db, tid).id), 'root first, then the parts in order');
    assert.ok(g.json.part_ids.includes(id));

    // done: asking again queues a fresh job
    const third = await post(id);
    assert.equal(third.status, 202);
    assert.equal(byId(db, id).thread_status, 'queued');
    assert.equal(byId(db, id).thread_error, null);
    await env.app.fetcher.drain();
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM items WHERE author_handle = 'bcherny'`), 15);
  });

  test('a failed job reports its plain error', async () => {
    const db = env.db;
    const id = ins(db, { tweet_id: '880003', author_handle: 'gone' });
    assert.equal((await post(id)).status, 202);
    await env.app.fetcher.drain();
    const g = await owner.req('GET', `/api/items/${id}/thread`);
    assert.equal(g.json.status, 'failed');
    assert.match(g.json.error, /deleted or could not be found/);
  });
});
