// Data layer tests: capture, fetcher, inbox tree, renderer, housekeeping and the CLI.
// In-memory DB, fake fetchFn built from the fixtures; never touches the network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, now } from '../src/db.js';
import { capture, MAX_INPUT, byTweetId, byId } from '../src/items.js';
import { createFetcher, BACKOFF } from '../src/fetcher.js';
import { fxTweetToFields } from '../src/fx.js';
import { buildInbox } from '../src/tree.js';
import { renderItems, normaliseOrder, loadItemsInOrder } from '../src/render.js';
import { housekeeping } from '../src/audit.js';
import { main } from '../src/cli.js';

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const ARTICLE = fixture('article.json');
const MISSING_HTML = fixture('missing.json');
const OEMBED = fixture('oembed.json');
const ARTICLE_ID = '2117512471930167377';
const ARTICLE_URL = `https://x.com/addyosmani/status/${ARTICLE_ID}`;

let cid = 0;
const nextCid = () => `client-${String(++cid).padStart(6, '0')}`;
const save = (db, input, extra = {}) => capture(db, { input, client_id: nextCid(), ...extra });

// ---------- fake network ----------
function fxBody({ id, h, name, text = '', pid = null, ph = null, ts = 1793700000, likes = 0, replies = 0 }) {
  return JSON.stringify({
    code: 200, message: 'OK',
    tweet: {
      id, url: `https://x.com/${h}/status/${id}`, text, author: { screen_name: h, name: name || h },
      replying_to: ph, replying_to_status: pid, created_timestamp: ts, likes, replies, retweets: 0, views: 10,
    },
  });
}

// world: Map tweetId -> body string | (callIndex) => Response. Unknown ids -> 404 JSON.
function makeNet({ world = new Map(), oembed = () => new Response('{"error":"nope"}', { status: 404 }), tco = () => null } = {}) {
  const calls = [];
  const counts = new Map();
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    const u = new URL(url);
    if (u.hostname === 'api.fxtwitter.com') {
      const id = u.pathname.match(/status\/(\d+)/)[1];
      const n = (counts.get(id) || 0) + 1;
      counts.set(id, n);
      const w = world.get(id);
      if (typeof w === 'function') return w(n);
      if (typeof w === 'string') return new Response(w, { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('{"code":404,"message":"NOT_FOUND"}', { status: 404 });
    }
    if (u.hostname === 'publish.twitter.com') return oembed(u);
    if (u.hostname === 't.co') {
      const r = tco(u);
      if (r) return r;
      return new Response('', { status: 404 });
    }
    throw new Error(`unexpected host ${u.hostname}`);
  };
  return { fetchFn, calls };
}

function setup(netOpts) {
  const db = openDb(':memory:');
  const clock = { t: 1794000000 };
  const net = makeNet(netOpts);
  const f = createFetcher(db, { fetchFn: net.fetchFn, paceMs: 0, nowFn: () => clock.t });
  return { db, clock, net, f };
}

// direct insert helper for tree / render / housekeeping tests
function ins(db, f) {
  const row = { kind: 'tweet', saved: 1, state: 'inbox', fetch_status: 'ok', ...f };
  const cols = Object.keys(row);
  const r = db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c]));
  return Number(r.lastInsertRowid);
}

// =====================================================================
describe('items.capture', () => {
  test('same client_id is idempotent', () => {
    const db = openDb(':memory:');
    const a = capture(db, { input: 'hello world note', client_id: 'abcdefgh-1' });
    const b = capture(db, { input: 'something else entirely', client_id: 'abcdefgh-1' });
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.equal(b.item_id, a.item_id);
    assert.equal(b.capture_id, a.capture_id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM captures').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n, 1);
  });

  test('same tweet shared twice: one item, two captures, back to inbox', () => {
    const db = openDb(':memory:');
    const a = save(db, `https://twitter.com/bob/status/123456789?s=20&t=abc`);
    db.prepare("UPDATE items SET state = 'archived' WHERE id = ?").run(a.item_id);
    const b = save(db, `Look at this https://x.com/bob/status/123456789/photo/1`, { source_app: 'X' });
    assert.equal(b.item_id, a.item_id);
    assert.equal(b.duplicate, false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM captures WHERE item_id = ?').get(a.item_id).n, 2);
    const it = byId(db, a.item_id);
    assert.equal(it.state, 'inbox');
    assert.equal(it.tweet_id, '123456789');
    assert.equal(it.url, 'https://x.com/bob/status/123456789');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n, 1);
  });

  test('re-sharing a trashed tweet restores it and re-queues a failed fetch', () => {
    const db = openDb(':memory:');
    const a = save(db, 'https://x.com/bob/status/123456789');
    db.prepare("UPDATE items SET state='trashed', trashed_at=1, fetch_status='failed', fetch_attempts=6 WHERE id=?").run(a.item_id);
    save(db, 'https://x.com/bob/status/123456789');
    const it = byId(db, a.item_id);
    assert.equal(it.state, 'inbox');
    assert.equal(it.trashed_at, null);
    assert.equal(it.fetch_status, 'pending');
    assert.equal(it.fetch_attempts, 0);
  });

  test('text dedupe within 24h (whitespace/case-insensitive), not after', () => {
    const db = openDb(':memory:');
    const a = save(db, 'Some highlighted   text\nhere');
    const b = save(db, '  some HIGHLIGHTED text here ');
    assert.equal(b.item_id, a.item_id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM captures').get().n, 2);
    db.prepare('UPDATE items SET last_saved_at = ? WHERE id = ?').run(now() - 86401, a.item_id);
    const c = save(db, 'Some highlighted text here');
    assert.notEqual(c.item_id, a.item_id);
    assert.equal(byId(db, c.item_id).kind, 'text');
    assert.equal(byId(db, c.item_id).fetch_status, 'n/a');
  });

  test('link dedupe: same non-X link gives one link item', () => {
    const db = openDb(':memory:');
    const a = save(db, 'Example page https://example.com/a');
    const b = save(db, 'https://example.com/a');
    assert.equal(b.item_id, a.item_id);
    const it = byId(db, a.item_id);
    assert.equal(it.kind, 'link');
    assert.equal(it.fetch_status, 'pending');   // the page is read in the background (web.js)
    assert.equal(it.text, 'Example page');
    const c = save(db, 'https://example.com/b');
    assert.notEqual(c.item_id, a.item_id);
  });

  test('article page link becomes a link item with a note and dedupes', () => {
    const db = openDb(':memory:');
    const a = save(db, 'https://x.com/i/article/2116367635365695488');
    const b = save(db, 'https://x.com/i/article/2116367635365695488');
    assert.equal(a.item_id, b.item_id);
    assert.match(byId(db, a.item_id).note, /Share the post itself/);
  });

  test('malformed or missing client_id is rejected with 400', () => {
    const db = openDb(':memory:');
    for (const bad of [undefined, '', 'short', 'has space in it', 'x'.repeat(81), 'bad/slash!!']) {
      assert.throws(() => capture(db, { input: 'hello', client_id: bad }), (e) => e.status === 400, String(bad));
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM captures').get().n, 0);
  });

  test('empty input -> 400, oversized input -> 413', () => {
    const db = openDb(':memory:');
    assert.throws(() => capture(db, { input: '   \n ', client_id: nextCid() }), (e) => e.status === 400);
    assert.throws(() => capture(db, { input: null, client_id: nextCid() }), (e) => e.status === 400);
    assert.throws(() => capture(db, { input: 'a'.repeat(MAX_INPUT + 1), client_id: nextCid() }), (e) => e.status === 413);
    const ok = capture(db, { input: 'a'.repeat(MAX_INPUT), client_id: nextCid() });
    assert.equal(byId(db, ok.item_id).kind, 'text');
  });

  test('tweet ids stay exact strings', () => {
    const db = openDb(':memory:');
    const a = save(db, 'https://x.com/addyosmani/status/2117512471930167377');
    assert.equal(byId(db, a.item_id).tweet_id, '2117512471930167377');
    assert.equal(typeof byId(db, a.item_id).tweet_id, 'string');
  });
});

// =====================================================================
describe('fetcher', () => {
  test('ok path stores fields, raw_fetches and stats', async () => {
    const { db, f, clock, net } = setup({ world: new Map([[ARTICLE_ID, ARTICLE]]) });
    const a = save(db, `https://x.com/addyosmani/status/${ARTICLE_ID}`);
    assert.equal(await f.drain(), 1);
    const it = byId(db, a.item_id);
    assert.equal(it.fetch_status, 'ok');
    assert.equal(it.kind, 'article');
    assert.equal(it.article_title, 'Critical thinking when agents do the work');
    assert.equal(it.text, '');
    assert.ok(it.article_md.length > 1000);
    assert.equal(it.likes, 18930);
    assert.equal(it.replies, 555);
    assert.equal(it.stats_at, clock.t);
    assert.equal(it.author_name, 'Addy Osmani');
    assert.equal(it.root_tweet_id, ARTICLE_ID);
    const raw = db.prepare('SELECT * FROM raw_fetches WHERE item_id = ?').all(a.item_id);
    assert.equal(raw.length, 1);
    assert.equal(raw[0].source, 'fxtwitter');
    assert.equal(raw[0].http_status, 200);
    assert.equal(raw[0].body, ARTICLE);
    assert.equal(net.calls.length, 1);
    assert.equal(net.calls[0].url, `https://api.fxtwitter.com/addyosmani/status/${ARTICLE_ID}`);
    assert.match(net.calls[0].opts.headers['User-Agent'], /^TweetVault\/1\.0/);
  });

  test('429 backs off 30,120,600,3600,21600 then marks failed', async () => {
    const world = new Map([['999999', () => new Response('{"code":429}', { status: 429 })]]);
    const { db, f, clock } = setup({ world });
    const a = save(db, 'https://x.com/bob/status/999999');
    assert.deepEqual(BACKOFF, [30, 120, 600, 3600, 21600]);
    const delays = [];
    for (let i = 0; i < 5; i++) {
      assert.equal(await f.runOnce(), true);
      const it = byId(db, a.item_id);
      assert.equal(it.fetch_status, 'pending');
      assert.equal(it.fetch_attempts, i + 1);
      delays.push(it.next_fetch_at - clock.t);
      // not due yet
      assert.equal(await f.runOnce(), false);
      clock.t = it.next_fetch_at;
    }
    assert.deepEqual(delays, [30, 120, 600, 3600, 21600]);
    assert.equal(await f.runOnce(), true);
    const it = byId(db, a.item_id);
    assert.equal(it.fetch_status, 'failed');
    assert.equal(it.next_fetch_at, null);
    assert.match(it.fetch_error, /429/);
    assert.equal(await f.runOnce(), false);
  });

  test('5xx HTML body is retried too', async () => {
    const world = new Map([['999998', () => new Response('<html>oops</html>', { status: 503 })]]);
    const { db, f, clock } = setup({ world });
    const a = save(db, 'https://x.com/bob/status/999998');
    await f.runOnce();
    const it = byId(db, a.item_id);
    assert.equal(it.fetch_status, 'pending');
    assert.equal(it.next_fetch_at - clock.t, 30);
  });

  test('Retry-After header is honoured when longer than the backoff', async () => {
    const world = new Map([['999997', (n) => n === 1
      ? new Response('{"code":429}', { status: 429, headers: { 'Retry-After': '900' } })
      : new Response(fxBody({ id: '999997', h: 'bob', text: 'finally' }), { status: 200 })]]);
    const { db, f, clock } = setup({ world });
    const a = save(db, 'https://x.com/bob/status/999997');
    await f.runOnce();
    let it = byId(db, a.item_id);
    assert.equal(it.next_fetch_at - clock.t, 900);
    clock.t += 899;
    assert.equal(await f.runOnce(), false);
    clock.t += 1;
    assert.equal(await f.runOnce(), true);
    it = byId(db, a.item_id);
    assert.equal(it.fetch_status, 'ok');
    assert.equal(it.text, 'finally');
    assert.equal(it.fetch_attempts, 0);
  });

  test('Retry-After in HTTP-date form is honoured', async () => {
    const clockStart = 1794000000;
    const when = new Date((clockStart + 1800) * 1000).toUTCString();
    const world = new Map([['999996', () => new Response('{"code":429}', { status: 429, headers: { 'Retry-After': when } })]]);
    const { db, f, clock } = setup({ world });
    const a = save(db, 'https://x.com/bob/status/999996');
    await f.runOnce();
    assert.equal(byId(db, a.item_id).next_fetch_at - clock.t, 1800);
  });

  test('transient oEmbed failure (503) after a 404 is retried, not marked unavailable', async () => {
    const { db, f } = setup({ oembed: () => new Response('busy', { status: 503 }) });
    const a = save(db, 'https://x.com/gone/status/666667');
    await f.runOnce();
    assert.equal(byId(db, a.item_id).fetch_status, 'pending');
  });

  test('404 -> oEmbed fallback -> oembed status', async () => {
    const { db, f, net } = setup({ oembed: () => new Response(OEMBED, { status: 200 }) });
    const a = save(db, `https://x.com/addyosmani/status/${ARTICLE_ID}`);
    await f.drain();
    const it = byId(db, a.item_id);
    assert.equal(it.fetch_status, 'oembed');
    assert.equal(it.author_name, 'Addy Osmani');
    assert.equal(it.author_handle, 'addyosmani');
    assert.equal(it.text, 'https://t.co/2gyp2Erpxx');
    assert.equal(it.likes, null);
    const raw = db.prepare('SELECT source, http_status FROM raw_fetches WHERE item_id = ?').all(a.item_id);
    assert.deepEqual(raw.map((r) => ({ ...r })), [{ source: 'oembed', http_status: 200 }]);
    assert.ok(net.calls[1].url.startsWith('https://publish.twitter.com/oembed?url='));
    assert.ok(net.calls[1].url.includes(encodeURIComponent(ARTICLE_URL)));
  });

  test('401 private -> oEmbed fails -> unavailable (Private account)', async () => {
    const world = new Map([['777777', () => new Response('{"code":401,"message":"PRIVATE_TWEET"}', { status: 401 })]]);
    const { db, f } = setup({ world });
    const a = save(db, 'https://x.com/priv/status/777777');
    await f.drain();
    const it = byId(db, a.item_id);
    assert.equal(it.fetch_status, 'unavailable');
    assert.equal(it.fetch_error, 'Private account');
  });

  test('401 private -> oEmbed works -> oembed', async () => {
    const world = new Map([['777776', () => new Response('{"code":401}', { status: 401 })]]);
    const { db, f } = setup({ world, oembed: () => new Response(OEMBED, { status: 200 }) });
    const a = save(db, 'https://x.com/priv/status/777776');
    await f.drain();
    assert.equal(byId(db, a.item_id).fetch_status, 'oembed');
  });

  test('404 with no oEmbed -> unavailable (Deleted or not found)', async () => {
    const { db, f } = setup();
    const a = save(db, 'https://x.com/gone/status/666666');
    await f.drain();
    const it = byId(db, a.item_id);
    assert.equal(it.fetch_status, 'unavailable');
    assert.equal(it.fetch_error, 'Deleted or not found');
    assert.equal(await f.runOnce(), false);
  });

  test('HTML page with HTTP 200 is treated as not found (oEmbed then unavailable)', async () => {
    const world = new Map([['555000', () => new Response(MISSING_HTML, { status: 200, headers: { 'content-type': 'text/html' } })]]);
    const { db, f, net } = setup({ world });
    const a = save(db, 'https://x.com/nobody/status/555000');
    await f.drain();
    const it = byId(db, a.item_id);
    assert.equal(it.fetch_status, 'unavailable');
    assert.equal(it.fetch_error, 'Deleted or not found');
    assert.equal(net.calls.filter((c) => c.url.includes('publish.twitter.com')).length, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM raw_fetches').get().n, 0);
  });

  test('parent walk inserts saved=0 context rows; reply-to-reply chain', async () => {
    const world = new Map([
      ['900100', fxBody({ id: '900100', h: 'alice', text: 'root post', ts: 1793600000 })],
      ['900101', fxBody({ id: '900101', h: 'bob', text: 'reply', pid: '900100', ph: 'alice', ts: 1793600100 })],
      ['900102', fxBody({ id: '900102', h: 'carol', text: 'reply to reply', pid: '900101', ph: 'bob', ts: 1793600200 })],
    ]);
    const { db, f } = setup({ world });
    const a = save(db, 'https://x.com/carol/status/900102');
    await f.drain();
    const rr = byId(db, a.item_id);
    const r = byTweetId(db, '900101');
    const root = byTweetId(db, '900100');
    assert.equal(rr.saved, 1);
    assert.equal(r.saved, 0);
    assert.equal(root.saved, 0);
    assert.equal(r.author_handle, 'bob');
    assert.equal(r.fetch_status, 'ok');
    assert.equal(root.fetch_status, 'ok');
    for (const x of [rr, r, root]) assert.equal(byTweetId(db, x.tweet_id).root_tweet_id, '900100');
    assert.equal(rr.parent_tweet_id, '900101');
    assert.equal(r.parent_tweet_id, '900100');
    assert.equal(root.parent_tweet_id, null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n, 3);
  });

  test('parent walk stops at depth 10', async () => {
    const world = new Map();
    for (let i = 0; i < 15; i++) {
      world.set(String(9001000 + i), fxBody({ id: String(9001000 + i), h: `u${i}`, text: `t${i}`,
        pid: i ? String(9001000 + i - 1) : null, ph: i ? `u${i - 1}` : null, ts: 1793600000 + i }));
    }
    const { db, f } = setup({ world });
    save(db, 'https://x.com/u14/status/9001014');
    await f.drain();
    const n = db.prepare('SELECT COUNT(*) n FROM items').get().n;
    assert.ok(n <= 11, `expected at most the leaf + 10 ancestors, got ${n}`);
  });

  test('late-arriving root recomputes root_tweet_id down the chain', async () => {
    const world = new Map([
      ['900200', fxBody({ id: '900200', h: 'zed', text: 'true root', ts: 1793600000 })],
      ['900201', fxBody({ id: '900201', h: 'amy', text: 'middle', pid: '900200', ph: 'zed', ts: 1793600100 })],
      ['900202', fxBody({ id: '900202', h: 'ben', text: 'leaf', pid: '900201', ph: 'amy', ts: 1793600200 })],
    ]);
    const { db, f } = setup({ world });
    save(db, 'https://x.com/ben/status/900202');
    await f.runOnce(); // leaf only; 201 known as a pending context row
    assert.equal(byTweetId(db, '900202').root_tweet_id, '900201');
    await f.runOnce(); // 201 arrives and reveals 200
    assert.equal(byTweetId(db, '900202').root_tweet_id, '900200');
    assert.equal(byTweetId(db, '900201').root_tweet_id, '900200');
    await f.drain();
    assert.equal(byTweetId(db, '900200').root_tweet_id, '900200');
    assert.equal(byTweetId(db, '900202').root_tweet_id, '900200');
  });

  test('late save of a root that already exists as context keeps one row', async () => {
    const world = new Map([
      ['900300', fxBody({ id: '900300', h: 'alice', text: 'root' })],
      ['900301', fxBody({ id: '900301', h: 'bob', text: 'reply', pid: '900300', ph: 'alice' })],
    ]);
    const { db, f } = setup({ world });
    save(db, 'https://x.com/bob/status/900301');
    await f.drain();
    assert.equal(byTweetId(db, '900300').saved, 0);
    const r = save(db, 'https://x.com/alice/status/900300');
    assert.equal(r.item_id, byTweetId(db, '900300').id);
    assert.equal(byTweetId(db, '900300').saved, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n, 2);
  });

  test('self-thread detection: only an unbroken same-author chain', async () => {
    const world = new Map([
      ['900400', fxBody({ id: '900400', h: 'Alice', text: 'thread 1/3', ts: 1793600000 })],
      ['900401', fxBody({ id: '900401', h: 'alice', text: 'thread 2/3', pid: '900400', ph: 'Alice', ts: 1793600010 })],
      ['900402', fxBody({ id: '900402', h: 'alice', text: 'thread 3/3', pid: '900401', ph: 'alice', ts: 1793600020 })],
      ['900403', fxBody({ id: '900403', h: 'bob', text: 'bob replies', pid: '900401', ph: 'alice', ts: 1793600030 })],
      ['900404', fxBody({ id: '900404', h: 'alice', text: 'alice answers bob', pid: '900403', ph: 'bob', ts: 1793600040 })],
    ]);
    const { db, f } = setup({ world });
    for (const id of ['900402', '900404', '900400']) save(db, `https://x.com/x/status/${id}`);
    await f.drain();
    const flag = (id) => byTweetId(db, id).is_self_thread;
    assert.deepEqual(['900400', '900401', '900402', '900403', '900404'].map(flag), [0, 1, 1, 0, 0]);
    for (const id of ['900400', '900401', '900402', '900403', '900404']) assert.equal(byTweetId(db, id).root_tweet_id, '900400');
  });

  test('t.co 301 to a tweet becomes a tweet item and is then fetched', async () => {
    const world = new Map([['555555', fxBody({ id: '555555', h: 'bob', text: 'via short link' })]]);
    const { db, f, net } = setup({
      world,
      tco: (u) => (u.pathname === '/abc123'
        ? new Response(null, { status: 301, headers: { Location: 'https://twitter.com/bob/status/555555?s=20' } })
        : null),
    });
    const a = save(db, 'check https://t.co/abc123');
    assert.equal(byId(db, a.item_id).kind, 'link');
    assert.equal(byId(db, a.item_id).note, 'tco');
    await f.runOnce();
    let it = byId(db, a.item_id);
    assert.equal(it.kind, 'tweet');
    assert.equal(it.tweet_id, '555555');
    assert.equal(it.url, 'https://x.com/bob/status/555555');
    assert.equal(it.note, null);
    assert.equal(it.fetch_status, 'pending');
    assert.equal(net.calls[0].opts.redirect, 'manual');
    await f.drain();
    it = byId(db, a.item_id);
    assert.equal(it.fetch_status, 'ok');
    assert.equal(it.text, 'via short link');
  });

  test('t.co to a non-X page becomes link_only with the expanded url', async () => {
    const { db, f } = setup({
      tco: () => new Response(null, { status: 301, headers: { Location: 'https://example.com/story' } }),
    });
    const a = save(db, 'https://t.co/zzz999');
    await f.drain();
    const it = byId(db, a.item_id);
    assert.equal(it.kind, 'link');
    assert.equal(it.url, 'https://example.com/story');
    assert.equal(it.fetch_status, 'link_only');
  });

  test('t.co that resolves to an already saved tweet merges and moves captures', async () => {
    const world = new Map([['555556', fxBody({ id: '555556', h: 'bob', text: 'known' })]]);
    const { db, f } = setup({
      world,
      tco: () => new Response(null, { status: 301, headers: { Location: 'https://x.com/bob/status/555556' } }),
    });
    const first = save(db, 'https://x.com/bob/status/555556');
    await f.drain();
    db.prepare("UPDATE items SET state = 'archived' WHERE id = ?").run(first.item_id);
    const short = save(db, 'https://t.co/merge1');
    assert.notEqual(short.item_id, first.item_id);
    await f.drain();
    assert.equal(byId(db, short.item_id), undefined);
    const caps = db.prepare('SELECT item_id FROM captures ORDER BY id').all().map((r) => r.item_id);
    assert.deepEqual(caps, [first.item_id, first.item_id]);
    const it = byId(db, first.item_id);
    assert.equal(it.state, 'inbox');
    assert.equal(it.saved, 1);
    assert.equal(it.fetch_status, 'ok');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n, 1);
  });
});

// =====================================================================
describe('tree.buildInbox', () => {
  function conv(db) {
    const A = ins(db, { tweet_id: '10', root_tweet_id: '10', author_handle: 'alice', text: 'root', saved: 0, posted_at: 100 });
    const R1 = ins(db, { tweet_id: '11', parent_tweet_id: '10', root_tweet_id: '10', author_handle: 'bob', text: 'r1', posted_at: 110, last_saved_at: 1000, first_saved_at: 1000 });
    const R2 = ins(db, { tweet_id: '12', parent_tweet_id: '11', root_tweet_id: '10', author_handle: 'carol', text: 'r2', posted_at: 120, last_saved_at: 1001, first_saved_at: 1001 });
    const R3 = ins(db, { tweet_id: '13', parent_tweet_id: '10', root_tweet_id: '10', author_handle: 'dan', text: 'r3', posted_at: 105, last_saved_at: 1002, first_saved_at: 1002 });
    return { A, R1, R2, R3 };
  }

  test('groups by root; unsaved root shown as context; replies nested with depth', () => {
    const db = openDb(':memory:');
    const { A, R1, R2, R3 } = conv(db);
    const g = buildInbox(db);
    assert.equal(g.length, 1);
    assert.equal(g[0].key, '10');
    assert.equal(g[0].root.id, A);
    assert.equal(g[0].root.saved, false);
    assert.deepEqual(g[0].replies.map((r) => [r.id, r.depth]), [[R3, 1], [R1, 1], [R2, 2]]);
    assert.deepEqual(g[0].thread, []);
  });

  test('notes and links are their own groups with themselves as root', () => {
    const db = openDb(':memory:');
    const n = save(db, 'just a thought');
    const l = save(db, 'https://example.com/x');
    const g = buildInbox(db);
    assert.equal(g.length, 2);
    const byKey = new Map(g.map((x) => [x.key, x]));
    assert.equal(byKey.get(`item:${n.item_id}`).root.id, n.item_id);
    assert.equal(byKey.get(`item:${n.item_id}`).root.kind, 'text');
    assert.equal(byKey.get(`item:${l.item_id}`).root.kind, 'link');
    for (const x of g) { assert.deepEqual(x.replies, []); assert.deepEqual(x.thread, []); }
  });

  test('state filter: archived items move between views', () => {
    const db = openDb(':memory:');
    const { R1, R2, R3 } = conv(db);
    db.prepare("UPDATE items SET state='archived' WHERE id = ?").run(R3);
    const inbox = buildInbox(db, { state: 'inbox' });
    assert.deepEqual(inbox[0].replies.map((r) => r.id), [R1, R2]);
    const arch = buildInbox(db, { state: 'archived' });
    assert.equal(arch.length, 1);
    assert.equal(arch[0].root.saved, false);
    assert.deepEqual(arch[0].replies.map((r) => r.id), [R3]);
    assert.deepEqual(buildInbox(db, { state: 'trashed' }), []);
    // unknown state falls back to inbox
    assert.equal(buildInbox(db, { state: 'bogus' }).length, 1);
  });

  test('search q treats % and _ literally', () => {
    const db = openDb(':memory:');
    const a = save(db, 'I am 100% sure');
    save(db, 'I am 1000 sure');
    const c = save(db, 'use snake_case names');
    save(db, 'use snakeXcase names');
    const ids = (q) => buildInbox(db, { q }).map((g) => g.root.id).sort();
    assert.deepEqual(ids('100%'), [a.item_id]);
    assert.deepEqual(ids('e_c'), [c.item_id]);
    assert.deepEqual(ids('%'), [a.item_id]);
    assert.deepEqual(ids('_'), [c.item_id]);
    assert.equal(ids('SURE').length, 2);
  });

  test('context rows are kept only when they are ancestors of a saved member', () => {
    const db = openDb(':memory:');
    const { A, R1 } = conv(db);
    db.prepare("UPDATE items SET state='archived' WHERE tweet_id IN ('12','13')").run();
    const stray = ins(db, { tweet_id: '14', parent_tweet_id: '10', root_tweet_id: '10', author_handle: 'eve', text: 'ctx', saved: 0 });
    const g = buildInbox(db);
    const ids = [g[0].root.id, ...g[0].replies.map((r) => r.id)];
    assert.deepEqual(ids, [A, R1]);
    assert.ok(!ids.includes(stray));
  });

  test('unsaved middle parent appears as a context reply between root and leaf', () => {
    const db = openDb(':memory:');
    ins(db, { tweet_id: '20', root_tweet_id: '20', author_handle: 'a', text: 'root', posted_at: 1 });
    const mid = ins(db, { tweet_id: '21', parent_tweet_id: '20', root_tweet_id: '20', author_handle: 'b', text: 'mid', saved: 0, posted_at: 2 });
    const leaf = ins(db, { tweet_id: '22', parent_tweet_id: '21', root_tweet_id: '20', author_handle: 'c', text: 'leaf', posted_at: 3 });
    const g = buildInbox(db);
    assert.deepEqual(g[0].replies.map((r) => [r.id, r.depth, r.saved]), [[mid, 1, false], [leaf, 2, true]]);
  });
});

// =====================================================================
describe('render', () => {
  const AF = fxTweetToFields(JSON.parse(ARTICLE).tweet);
  const STATS_AT = 1794000000; // 2026-11-06

  function articleConv(db) {
    const A = ins(db, { ...AF, root_tweet_id: ARTICLE_ID, stats_at: STATS_AT, last_saved_at: 10, first_saved_at: 10 });
    const R1 = ins(db, { tweet_id: '3001', url: 'https://x.com/bob/status/3001', parent_tweet_id: ARTICLE_ID, root_tweet_id: ARTICLE_ID,
      author_handle: 'bob', author_name: 'Bob', text: 'Great piece', posted_at: 1793700000, likes: 12, replies: 3, stats_at: STATS_AT, last_saved_at: 11 });
    const R2 = ins(db, { tweet_id: '3002', url: 'https://x.com/carol/status/3002', parent_tweet_id: '3001', root_tweet_id: ARTICLE_ID,
      author_handle: 'carol', text: 'Agree with bob', posted_at: 1793710000, likes: 0, stats_at: STATS_AT, last_saved_at: 12 });
    const R3 = ins(db, { tweet_id: '3003', url: 'https://x.com/addyosmani/status/3003', parent_tweet_id: '3001', root_tweet_id: ARTICLE_ID,
      author_handle: 'addyosmani', author_name: 'Addy Osmani', text: 'Thanks Bob', posted_at: 1793720000, likes: 1, stats_at: STATS_AT, last_saved_at: 13 });
    return { A, R1, R2, R3 };
  }

  test('article + 3 replies in a user order that differs from save order: exact output', () => {
    const db = openDb(':memory:');
    const { A, R1, R2, R3 } = articleConv(db);
    const order = normaliseOrder(loadItemsInOrder(db, [R3, A, R1, R2]));
    assert.deepEqual(order, [A, R3, R1, R2]);
    const r = renderItems(db, loadItemsInOrder(db, order), { title: '  Agents bundle ' });
    const expectedText = [
      '# Agents bundle',
      `## Critical thinking when agents do the work\n${AF.article_md.trim()}`,
      '### Reply 1 (author) (replying to Reply 2)\nThanks Bob',
      '### Reply 2\nGreat piece',
      '### Reply 3 (replying to Reply 2)\nAgree with bob',
    ].join('\n\n');
    assert.equal(r.text, expectedText);
    const expectedSources = [
      '---',
      '## Sources',
      `[Article] @addyosmani (Addy Osmani) · 2026-11-03 · 18,930 likes · 555 replies · ${ARTICLE_URL}`,
      '[Reply 1] @addyosmani (Addy Osmani) · 2026-11-03 · 1 like · https://x.com/addyosmani/status/3003',
      '[Reply 2] @bob (Bob) · 2026-11-03 · 12 likes · https://x.com/bob/status/3001',
      '[Reply 3] @carol · 2026-11-03 · 0 likes · https://x.com/carol/status/3002',
      'Stats as of 2026-11-06.',
    ].join('\n');
    assert.equal(r.text_sources, `${expectedText}\n\n${expectedSources}`);
    assert.ok(!r.text.includes('## Sources'));
    assert.ok(!r.text.includes('---\n'));
    assert.deepEqual(r.sections.map((s) => [s.item_id, s.label]), [[A, 'Article'], [R3, 'Reply 1'], [R1, 'Reply 2'], [R2, 'Reply 3']]);
  });

  test("'> In reply to' line and 'Replies to the article' heading when root and parent are not selected", () => {
    const db = openDb(':memory:');
    const { R2 } = articleConv(db);
    const r = renderItems(db, loadItemsInOrder(db, [R2]));
    assert.equal(r.text, [
      '## Replies to the article "Critical thinking when agents do the work" by @addyosmani\n> Original post (not included): Critical thinking when agents do the work',
      '### Reply 1\n> In reply to @bob: Great piece\nAgree with bob',
    ].join('\n\n'));
  });

  test("tweet root not selected: 'Replies to a post by @h' with a one-line original", () => {
    const db = openDb(':memory:');
    ins(db, { tweet_id: '50', root_tweet_id: '50', author_handle: 'alice', text: 'line one\n\nline   two' });
    const r1 = ins(db, { tweet_id: '51', parent_tweet_id: '50', root_tweet_id: '50', author_handle: 'alice', text: 'me again' });
    const r = renderItems(db, loadItemsInOrder(db, [r1]));
    assert.equal(r.text, '## Replies to a post by @alice\n> Original post (not included): line one line two\n\n### Reply 1 (author)\nme again');
  });

  test('self-thread parts follow the root in posting order, not as replies', () => {
    const db = openDb(':memory:');
    const root = ins(db, { tweet_id: '60', root_tweet_id: '60', author_handle: 'al', text: '1/3', posted_at: 1 });
    const p3 = ins(db, { tweet_id: '62', parent_tweet_id: '61', root_tweet_id: '60', author_handle: 'al', text: '3/3', posted_at: 3, is_self_thread: 1 });
    const p2 = ins(db, { tweet_id: '61', parent_tweet_id: '60', root_tweet_id: '60', author_handle: 'al', text: '2/3', posted_at: 2, is_self_thread: 1 });
    const rep = ins(db, { tweet_id: '63', parent_tweet_id: '60', root_tweet_id: '60', author_handle: 'bo', text: 'nice', posted_at: 4 });
    assert.deepEqual(normaliseOrder(loadItemsInOrder(db, [rep, p3, p2, root])), [root, p2, p3, rep]);
    const r = renderItems(db, loadItemsInOrder(db, [rep, p3, p2, root]));
    assert.equal(r.text, '## Post by @al\n1/3\n\n### Thread, part 2\n2/3\n\n### Thread, part 3\n3/3\n\n### Reply 1\nnice');
  });

  test('notes and links numbered separately; sources lines; text-only has no Sources', () => {
    const db = openDb(':memory:');
    const n1 = save(db, 'First note text', { source_app: 'Chrome' });
    const l1 = save(db, 'Example page https://example.com/a');
    // a link whose page had nothing to read renders as the plain link
    db.prepare("UPDATE items SET fetch_status = 'link_only' WHERE id = ?").run(l1.item_id);
    const n2 = save(db, 'Second note text');
    const r = renderItems(db, loadItemsInOrder(db, [n1.item_id, l1.item_id, n2.item_id]));
    assert.equal(r.text, '## Note 1\nFirst note text\n\n## Link 1\nExample page\n\nhttps://example.com/a\n\n## Note 2\nSecond note text');
    const d = new Date(byId(db, n1.item_id).first_saved_at * 1000).toISOString().slice(0, 10);
    assert.equal(r.text_sources, `${r.text}\n\n---\n## Sources\n[Note 1] Saved text from Chrome · ${d}\n[Link 1] https://example.com/a\n[Note 2] Saved text · ${d}`);
    assert.ok(!r.text.includes('## Sources'));
  });

  test('groups render in first-appearance order', () => {
    const db = openDb(':memory:');
    const { A, R1 } = articleConv(db);
    const n = save(db, 'a note first');
    const order = normaliseOrder(loadItemsInOrder(db, [n.item_id, R1, A]));
    assert.deepEqual(order, [n.item_id, A, R1]);
    const r = renderItems(db, loadItemsInOrder(db, [n.item_id, R1, A]));
    const iNote = r.text.indexOf('## Note 1');
    const iArt = r.text.indexOf('## Critical thinking');
    const iRep = r.text.indexOf('### Reply 1');
    assert.ok(iNote === 0 && iArt > iNote && iRep > iArt, r.text.slice(0, 200));
  });

  test('pending / unavailable bodies and quote tweets', () => {
    const db = openDb(':memory:');
    const p = ins(db, { tweet_id: '70', root_tweet_id: '70', url: 'https://x.com/a/status/70', author_handle: 'a', fetch_status: 'pending' });
    const u = ins(db, { tweet_id: '71', root_tweet_id: '71', url: 'https://x.com/b/status/71', author_handle: 'b', fetch_status: 'unavailable', fetch_error: 'Deleted or not found' });
    const q = ins(db, { tweet_id: '72', root_tweet_id: '72', author_handle: 'c', text: 'look',
      quote_json: JSON.stringify({ handle: 'd', text: 'quoted\nline' }) });
    const r = renderItems(db, loadItemsInOrder(db, [p, u, q]));
    assert.equal(r.text, [
      '## Part 1: Post by @a\n(Still loading this post. Refresh in a moment.) https://x.com/a/status/70',
      "## Part 2: Post by @b (unavailable)\n(This post couldn't be loaded: Deleted or not found.) https://x.com/b/status/71",
      '## Part 3: Post by @c\nlook\n\n> Quoting @d:\n> quoted\n> line',
    ].join('\n\n'));
  });
});

// =====================================================================
describe('audit.housekeeping', () => {
  test('prunes audit rows, purges old unbundled trash, keeps bundled trash, removes orphan context', () => {
    const db = openDb(':memory:');
    const t = now();
    const D = 86400;
    db.prepare('INSERT INTO audit_log (at, event) VALUES (?, ?), (?, ?), (?, ?)').run(t - 31 * D, 'old', t - 29 * D, 'recent', t, 'now');
    const oldTrash = ins(db, { tweet_id: '80', root_tweet_id: '80', state: 'trashed', trashed_at: t - 31 * D });
    const freshTrash = ins(db, { tweet_id: '81', root_tweet_id: '81', state: 'trashed', trashed_at: t - 5 * D });
    const bundledTrash = ins(db, { kind: 'text', text: 'keep me', state: 'trashed', trashed_at: t - 40 * D });
    const parentTrash = ins(db, { tweet_id: '82', root_tweet_id: '82', state: 'trashed', trashed_at: t - 40 * D });
    const child = ins(db, { tweet_id: '83', parent_tweet_id: '82', root_tweet_id: '82' });
    const orphanCtx = ins(db, { tweet_id: '84', root_tweet_id: '84', saved: 0 });
    const usedCtx = ins(db, { tweet_id: '85', root_tweet_id: '85', saved: 0 });
    ins(db, { tweet_id: '86', parent_tweet_id: '85', root_tweet_id: '85' });
    const b = db.prepare("INSERT INTO bundles (slug, title) VALUES ('b', 'B')").run();
    db.prepare('INSERT INTO bundle_items (bundle_id, item_id, position) VALUES (?, ?, 0)').run(Number(b.lastInsertRowid), bundledTrash);
    db.prepare("INSERT INTO captures (client_id, item_id, raw_input) VALUES ('cap-oldtrash', ?, 'x')").run(oldTrash);

    const r = housekeeping(db);
    assert.equal(r.audit, 1);
    assert.deepEqual(db.prepare('SELECT event FROM audit_log ORDER BY at').all().map((x) => x.event), ['recent', 'now']);
    assert.equal(byId(db, oldTrash), undefined);
    assert.equal(db.prepare("SELECT item_id FROM captures WHERE client_id='cap-oldtrash'").get().item_id, null);
    assert.ok(byId(db, freshTrash));
    assert.equal(byId(db, bundledTrash).state, 'trashed');
    const pt = byId(db, parentTrash);
    assert.equal(pt.saved, 0);
    assert.equal(pt.state, 'inbox');
    assert.ok(byId(db, child));
    assert.equal(byId(db, orphanCtx), undefined);
    assert.ok(byId(db, usedCtx));
    assert.equal(r.purged, 2);
    assert.equal(r.orphans, 1);
  });

  test('orphan context chains are removed up the chain', () => {
    const db = openDb(':memory:');
    ins(db, { tweet_id: '90', root_tweet_id: '90', saved: 0 });
    ins(db, { tweet_id: '91', parent_tweet_id: '90', root_tweet_id: '90', saved: 0 });
    ins(db, { tweet_id: '92', parent_tweet_id: '91', root_tweet_id: '90', saved: 0 });
    const r = housekeeping(db);
    assert.equal(r.orphans, 3);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM items').get().n, 0);
  });
});

// =====================================================================
describe('cli.main', () => {
  function cliDb() {
    const db = openDb(':memory:');
    const A = ins(db, { tweet_id: '500', root_tweet_id: '500', author_handle: 'alice', text: 'agents post', url: 'https://x.com/alice/status/500', stats_at: 1794000000 });
    const R = ins(db, { tweet_id: '501', parent_tweet_id: '500', root_tweet_id: '500', author_handle: 'bob', text: 'a reply', url: 'https://x.com/bob/status/501' });
    const N = ins(db, { kind: 'text', text: 'rust note', fetch_status: 'n/a' });
    return { db, A, R, N };
  }
  const run = (db, ...argv) => { const lines = []; const code = main(argv, { db, out: (s) => lines.push(s) }); return { code, lines, all: lines.join('\n') }; };

  test('make-bundle normalises order, dedupes slugs, and bundles lists them', () => {
    const { db, A, R, N } = cliDb();
    const r1 = run(db, 'make-bundle', 'Agents at work', String(R), String(A));
    assert.equal(r1.code, 0);
    assert.deepEqual(r1.lines, ['agents-at-work']);
    const b = db.prepare("SELECT id FROM bundles WHERE slug='agents-at-work'").get();
    assert.deepEqual(db.prepare('SELECT item_id FROM bundle_items WHERE bundle_id=? ORDER BY position').all(b.id).map((x) => x.item_id), [A, R]);
    assert.deepEqual(run(db, 'make-bundle', 'Agents at work', String(N)).lines, ['agents-at-work-2']);
    assert.equal(run(db, 'make-bundle', 'Nothing').code, 2);
    assert.equal(run(db, 'make-bundle', 'Bad', '9999').code, 2);
    const ls = run(db, 'bundles');
    assert.equal(ls.lines.length, 2);
    assert.ok(ls.lines.some((l) => l.startsWith('agents-at-work\tAgents at work\t2 items\t')));
    assert.ok(ls.lines.some((l) => l.startsWith('agents-at-work-2\tAgents at work\t1 items\t')));
    assert.deepEqual(run(openDb(':memory:'), 'bundles').lines, ['No bundles yet.']);
  });

  test('bundle name matching: exact, prefix, multi-word substring, ambiguous, none; --sources', () => {
    const { db, A, R, N } = cliDb();
    run(db, 'make-bundle', 'Agents at work', String(A), String(R));
    run(db, 'make-bundle', 'Agent tooling notes', String(A));
    run(db, 'make-bundle', 'Rust tips', String(N));

    const exact = run(db, 'bundle', 'agents-at-work');
    assert.equal(exact.code, 0);
    assert.equal(exact.all, '# Agents at work\n\n## Post by @alice\nagents post\n\n### Reply 1\na reply');
    assert.equal(run(db, 'bundle', 'Agents', 'at', 'work').all, exact.all); // exact title, case-insensitive

    assert.equal(run(db, 'bundle', 'ru').all, '# Rust tips\n\n## Note 1\nrust note');

    const sub = run(db, 'bundle', 'tooling', 'notes');
    assert.equal(sub.code, 0);
    assert.ok(sub.all.startsWith('# Agent tooling notes'));

    const amb = run(db, 'bundle', 'agent');
    assert.equal(amb.code, 2);
    assert.equal(amb.lines[0], 'Several bundles match "agent":');
    assert.deepEqual(amb.lines.slice(1).sort(), ['  agent-tooling-notes\tAgent tooling notes', '  agents-at-work\tAgents at work']);

    const none = run(db, 'bundle', 'python');
    assert.equal(none.code, 2);
    assert.deepEqual(none.lines, ['No bundle matches "python".']);

    const src = run(db, 'bundle', 'agents-at-work', '--sources');
    assert.equal(src.code, 0);
    assert.ok(src.all.startsWith(exact.all));
    assert.ok(src.all.includes('\n---\n## Sources\n[Post] @alice · https://x.com/alice/status/500\n[Reply 1] @bob · https://x.com/bob/status/501\nStats as of 2026-11-06.'));
    assert.ok(!exact.all.includes('## Sources'));
  });

  test('rerender rebuilds item text from stored FxTwitter JSON', () => {
    const db = openDb(':memory:');
    const id = ins(db, { tweet_id: ARTICLE_ID, kind: 'tweet', text: 'stale', article_md: 'stale', render_version: 0 });
    db.prepare("INSERT INTO raw_fetches (item_id, source, fetched_at, http_status, body) VALUES (?, 'fxtwitter', 1, 200, ?)").run(id, ARTICLE);
    const other = ins(db, { tweet_id: '1', text: 'oembed stays' });
    db.prepare("INSERT INTO raw_fetches (item_id, source, fetched_at, http_status, body) VALUES (?, 'oembed', 1, 200, ?)").run(other, OEMBED);
    const r = run(db, 'rerender');
    assert.deepEqual(r.lines, ['Re-rendered 1 items.']);
    const it = byId(db, id);
    assert.equal(it.kind, 'article');
    assert.equal(it.article_title, 'Critical thinking when agents do the work');
    assert.equal(it.article_md, fxTweetToFields(JSON.parse(ARTICLE).tweet).article_md);
    assert.equal(it.render_version, 1);
    assert.equal(byId(db, other).text, 'oembed stays');
  });

  test('mfa-reset clears two-step sign-in, sessions and trusted browsers, and logs it', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO mfa (id, secret_enc, enabled, last_step, recovery_json) VALUES (1, 'enc', 1, 55, '[\"h\"]')").run();
    db.prepare("INSERT INTO sessions (id_hash, expires_at, mfa_ok) VALUES ('s1', 9999999999, 1)").run();
    db.prepare("INSERT INTO trusted_browsers (id_hash, expires_at) VALUES ('t1', 9999999999)").run();
    const r = run(db, 'mfa-reset');
    assert.equal(r.code, 0);
    assert.match(r.all, /reset/);
    const m = db.prepare('SELECT * FROM mfa WHERE id = 1').get();
    assert.equal(m.enabled, 0);
    assert.equal(m.secret_enc, null);
    assert.equal(m.recovery_json, '[]');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM trusted_browsers').get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE event = 'mfa_reset'").get().n, 1);
  });

  test('unknown command prints usage and exits 2', () => {
    const r = run(openDb(':memory:'), 'nope');
    assert.equal(r.code, 2);
    assert.match(r.all, /^Commands:/);
  });
});
