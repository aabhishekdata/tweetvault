// Adversarial correctness review of grouping, merge order, rendering, the bundle edit flow,
// the t.co merge path, housekeeping and CLI matching. In-memory DB, fake fetchFn, no network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { capture, byTweetId, byId } from '../src/items.js';
import { createFetcher } from '../src/fetcher.js';
import { buildInbox, itemDto } from '../src/tree.js';
import { renderItems, normaliseOrder, loadItemsInOrder } from '../src/render.js';
import { housekeeping } from '../src/audit.js';
import { findBundle } from '../src/cli.js';
import { classifyInput } from '../src/urls.js';

let cid = 0;
const nextCid = () => `review-${String(++cid).padStart(6, '0')}`;
const save = (db, input, extra = {}) => capture(db, { input, client_id: nextCid(), ...extra });

function fxBody({ id, h, text = '', pid = null, ph = null, ts = 1793700000 }) {
  return JSON.stringify({ code: 200, message: 'OK', tweet: {
    id, url: `https://x.com/${h}/status/${id}`, text, author: { screen_name: h, name: h },
    replying_to: ph, replying_to_status: pid, created_timestamp: ts, likes: 1, replies: 0, retweets: 0, views: 1 } });
}
function makeNet(world, tco = () => null) {
  return async (url) => {
    const u = new URL(url);
    if (u.hostname === 'api.fxtwitter.com') {
      const id = u.pathname.match(/status\/(\d+)/)[1];
      const w = world.get(id);
      if (w) return new Response(w, { status: 200 });
      return new Response('{"code":404,"message":"NOT_FOUND"}', { status: 404 });
    }
    if (u.hostname === 'publish.twitter.com') return new Response('{}', { status: 404 });
    if (u.hostname === 't.co') return tco(u) || new Response('', { status: 404 });
    throw new Error(`unexpected host ${u.hostname}`);
  };
}
function ins(db, f) {
  const row = { kind: 'tweet', saved: 1, state: 'inbox', fetch_status: 'ok', ...f };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid);
}

// Pull groupsFromItems out of the browser script so the real code is exercised.
const APP = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8');
const gfiSrc = APP.match(/function groupsFromItems\(items\) \{[\s\S]*?\n {2}\}\n/)[0];
const groupsFromItems = new Function(`${gfiSrc}; return groupsFromItems;`)();
const mergeOrder = (groups) => groups.flatMap((g) => [...g.fixed, ...g.replies].map((x) => x.id));

describe('fetcher grouping', () => {
  test('reply-to-reply saved first, then root arrives late: one conversation, nested', async () => {
    const db = openDb(':memory:');
    const world = new Map([
      ['1000300', fxBody({ id: '1000300', h: 'alice', text: 'root' })],
      ['1000301', fxBody({ id: '1000301', h: 'bob', text: 'r1', pid: '1000300', ph: 'alice' })],
      ['1000302', fxBody({ id: '1000302', h: 'cat', text: 'r2', pid: '1000301', ph: 'bob' })],
    ]);
    const f = createFetcher(db, { fetchFn: makeNet(world), paceMs: 0 });
    save(db, 'https://x.com/cat/status/1000302');
    await f.drain();
    let g = buildInbox(db);
    assert.equal(g.length, 1);
    assert.equal(g[0].key, '1000300');
    assert.equal(g[0].root.saved, false);
    save(db, 'https://x.com/alice/status/1000300');
    await f.drain();
    g = buildInbox(db);
    assert.equal(g.length, 1);
    assert.equal(g[0].root.saved, true);
    assert.deepEqual(g[0].replies.map((r) => [r.tweet_id, r.depth]), [['1000301', 1], ['1000302', 2]]);
  });

  test('t.co resolving to an existing tweet re-points captures and bundle rows', async () => {
    const db = openDb(':memory:');
    const world = new Map([['1000400', fxBody({ id: '1000400', h: 'alice', text: 'hi' })]]);
    const tco = () => new Response('', { status: 301, headers: { location: 'https://x.com/alice/status/1000400' } });
    const f = createFetcher(db, { fetchFn: makeNet(world, tco), paceMs: 0 });
    const a = save(db, 'https://x.com/alice/status/1000400');
    await f.drain();
    const l = save(db, 'https://t.co/abc123');
    db.prepare("INSERT INTO bundles (slug,title) VALUES ('b1','B1'),('b2','B2')").run();
    db.prepare('INSERT INTO bundle_items VALUES (1, ?, 0), (1, ?, 1), (2, ?, 0)').run(l.item_id, a.item_id, l.item_id);
    await f.drain();
    assert.equal(byId(db, l.item_id), undefined);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM captures WHERE item_id = ?').get(a.item_id).n, 2);
    assert.deepEqual(db.prepare('SELECT bundle_id, item_id FROM bundle_items ORDER BY bundle_id').all().map((r) => [r.bundle_id, r.item_id]),
      [[1, a.item_id], [2, a.item_id]]);
  });
});

describe('bundle edit flow: groupsFromItems matches the server order', () => {
  test('unsaved context root, thread, intermediate context, notes, two groups', () => {
    const db = openDb(':memory:');
    const root = ins(db, { tweet_id: '500', author_handle: 'alice', text: 'root', saved: 0, root_tweet_id: '500' });
    const th = ins(db, { tweet_id: '501', author_handle: 'alice', text: 'part 2', parent_tweet_id: '500', root_tweet_id: '500', is_self_thread: 1, posted_at: 2 });
    const mid = ins(db, { tweet_id: '502', author_handle: 'bob', text: 'mid', saved: 0, parent_tweet_id: '500', root_tweet_id: '500' });
    const r1 = ins(db, { tweet_id: '503', author_handle: 'cat', text: 'r1', parent_tweet_id: '502', root_tweet_id: '500' });
    const r2 = ins(db, { tweet_id: '504', author_handle: 'dan', text: 'r2', parent_tweet_id: '500', root_tweet_id: '500' });
    const note = ins(db, { kind: 'text', text: 'a note', fetch_status: 'n/a' });
    const solo = ins(db, { tweet_id: '600', author_handle: 'eve', text: 'solo', root_tweet_id: '600' });
    // user order: r2 before r1, note between, root placed late
    const sent = [r2, note, r1, solo, mid, th, root];
    const order = normaliseOrder(loadItemsInOrder(db, sent));
    const dtos = loadItemsInOrder(db, order).map((x) => itemDto(x));
    const groups = groupsFromItems(dtos);
    assert.deepEqual(mergeOrder(groups), order);
    assert.deepEqual(groups[0].fixed.map((x) => x.id), [root, th]);
    assert.deepEqual(groups[0].replies.map((x) => x.id), [r2, r1, mid]);
    const rendered = renderItems(db, loadItemsInOrder(db, order));
    assert.deepEqual(rendered.sections.map((s) => s.item_id), order);
  });
});

describe('render output for Claude', () => {
  test('unavailable root that is not included does not print an empty context line', () => {
      const db = openDb(':memory:');
      ins(db, { tweet_id: '700', author_handle: 'alice', saved: 0, fetch_status: 'unavailable', fetch_error: 'Deleted or not found', root_tweet_id: '700' });
      const r = ins(db, { tweet_id: '701', author_handle: 'bob', text: 'reply', parent_tweet_id: '700', root_tweet_id: '700' });
      const { text } = renderItems(db, loadItemsInOrder(db, [r]));
      assert.doesNotMatch(text, /not included\): *\n/);
    });

  test('included unavailable root is headed "Post by @x (unavailable)" as PLAN.md says', () => {
      const db = openDb(':memory:');
      const root = ins(db, { tweet_id: '710', author_handle: 'alice', saved: 0, fetch_status: 'unavailable', root_tweet_id: '710' });
      const r = ins(db, { tweet_id: '711', author_handle: 'bob', text: 'reply', parent_tweet_id: '710', root_tweet_id: '710' });
      const { text } = renderItems(db, loadItemsInOrder(db, [root, r]));
      assert.match(text, /## Post by @alice \(unavailable\)/);
    });

  test('reply whose parent could not be loaded gets no empty "In reply to" line', () => {
      const db = openDb(':memory:');
      const root = ins(db, { tweet_id: '720', author_handle: 'alice', text: 'root', root_tweet_id: '720' });
      ins(db, { tweet_id: '721', author_handle: 'erin', saved: 0, fetch_status: 'unavailable', parent_tweet_id: '720', root_tweet_id: '720' });
      const r = ins(db, { tweet_id: '722', author_handle: 'fay', text: 'reply', parent_tweet_id: '721', root_tweet_id: '720' });
      const { text } = renderItems(db, loadItemsInOrder(db, [root, r]));
      assert.doesNotMatch(text, /In reply to @erin: *\n/);
    });

  test('source labels are unique when a bundle has several conversations', () => {
      const db = openDb(':memory:');
      const a = ins(db, { tweet_id: '730', author_handle: 'alice', text: 'A', root_tweet_id: '730' });
      const ar = ins(db, { tweet_id: '731', author_handle: 'bob', text: 'A1', parent_tweet_id: '730', root_tweet_id: '730' });
      const b = ins(db, { tweet_id: '740', author_handle: 'carol', text: 'B', root_tweet_id: '740' });
      const br = ins(db, { tweet_id: '741', author_handle: 'dan', text: 'B1', parent_tweet_id: '740', root_tweet_id: '740' });
      const { sections } = renderItems(db, loadItemsInOrder(db, [a, ar, b, br]));
      const labels = sections.map((s) => s.label);
      assert.equal(new Set(labels).size, labels.length, labels.join(','));
    });
});

describe('housekeeping vs bundles', () => {
  test('old trashed items: bundled kept, parent becomes context, orphan context removed', () => {
    const db = openDb(':memory:');
    const old = Math.floor(Date.now() / 1000) - 40 * 86400;
    const root = ins(db, { tweet_id: '800', text: 'root', root_tweet_id: '800', state: 'trashed', trashed_at: old });
    const kid = ins(db, { tweet_id: '801', text: 'kid', parent_tweet_id: '800', root_tweet_id: '800' });
    const bundled = ins(db, { tweet_id: '900', text: 'b', root_tweet_id: '900', state: 'trashed', trashed_at: old });
    db.prepare("INSERT INTO bundles (slug,title) VALUES ('k','K')").run();
    db.prepare('INSERT INTO bundle_items VALUES (1, ?, 0)').run(bundled);
    housekeeping(db);
    assert.equal(byId(db, bundled).state, 'trashed');
    assert.equal(byId(db, root).saved, 0);
    db.prepare("UPDATE items SET state='trashed', trashed_at=? WHERE id=?").run(old, kid);
    housekeeping(db);
    assert.equal(byId(db, kid), undefined);
    assert.equal(byTweetId(db, '800'), undefined);
  });
});

describe('CLI and capture parsing', () => {
  test('an exact slug wins over a duplicate title', () => {
      const db = openDb(':memory:');
      db.prepare("INSERT INTO bundles (slug,title,created_at,updated_at) VALUES ('agents','Agents',1,1),('agents-2','Agents',2,2)").run();
      assert.equal(findBundle(db, 'agents').bundle?.slug, 'agents');
    });

  test('highlighted text that merely contains a t.co link stays a note', () => {
      const c = classifyInput('A long highlighted paragraph about scaling teams, see https://t.co/AbC123xyz for the data, and it keeps going with more of the author argument that you wanted.');
      assert.equal(c.type, 'text');
    });
});
