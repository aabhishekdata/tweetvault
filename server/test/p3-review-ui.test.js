// Regression tests for the phase 3 review, UI group (findings 5, 7, 8 and 9): the MCP english race,
// the link card keeping its saved article during a re-read, "In English" after Add items, and the
// "Old text kept" chip. Browser functions are cut out of static/app.js and run with small stand-ins.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, now } from '../src/db.js';
import { createMcp } from '../src/mcp.js';
import { itemDto } from '../src/tree.js';

const APP = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const CSS = readFileSync(new URL('../static/app.css', import.meta.url), 'utf8');
const cut = (header) => {
  const i = APP.indexOf(header);
  assert.ok(i >= 0, `app.js should contain ${header}`);
  const end = APP.indexOf('\n  }\n', i);
  return APP.slice(i, end + 5);
};
const h = (tag, attrs = {}) => ({ tag, ...attrs });

describe('finding 5: MCP get_bundle english when the collection goes away while it translates', () => {
  function setup() {
    const db = openDb(':memory:');
    const t = now();
    const ins = (f) => {
      const row = { kind: 'tweet', fetch_status: 'ok', saved: 1, state: 'inbox', first_saved_at: t, last_saved_at: t, ...f };
      const c = Object.keys(row);
      return Number(db.prepare(`INSERT INTO items (${c.join(',')}) VALUES (${c.map(() => '?').join(',')})`).run(...c.map((k) => row[k])).lastInsertRowid);
    };
    const a = ins({ tweet_id: '1', url: 'https://x.com/a/status/1', text: 'Привет мир, это тест', author_handle: 'a' });
    const b = ins({ tweet_id: '2', url: 'https://x.com/a/status/2', text: 'Second post here', author_handle: 'a' });
    const bid = Number(db.prepare("INSERT INTO bundles (slug, title, created_at, updated_at, version) VALUES ('race', 'Race collection', ?, ?, 1)").run(t, t).lastInsertRowid);
    [a, b].forEach((id, i) => db.prepare('INSERT INTO bundle_items (bundle_id, item_id, position) VALUES (?, ?, ?)').run(bid, id, i));
    return { db, bid };
  }
  const req = (body) => {
    const buf = Buffer.from(JSON.stringify(body));
    return { headers: { authorization: 'Bearer x', 'content-type': 'application/json', 'content-length': String(buf.length) }, async *[Symbol.asyncIterator]() { yield buf; } };
  };
  const ctx = { device: { id: 1, name: 'k', scopeSet: new Set(['read']) } };
  const call = (mcp, args) => mcp.handlePost(req({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_bundle', arguments: args } }), ctx);
  const resultOf = (r) => r.result || (r.body && r.body.result) || (typeof r.body === 'string' ? JSON.parse(r.body).result : r);

  test('unmerged or combined during translation: a clear error, not an empty collection', async () => {
    const { db, bid } = setup();
    const mcp = createMcp({ db, origins: ['https://v.test'], englishFor: async () => {
      await new Promise((r) => setTimeout(r, 20));
      db.prepare('DELETE FROM bundles WHERE id = ?').run(bid);   // what unmerge and combine (source) run
      return new Map();
    } });
    const res = resultOf(await call(mcp, { name: 'race', english: true }));
    assert.equal(res.isError, true, JSON.stringify(res).slice(0, 400));
    assert.match(res.content[0].text, /combined into another or unmerged/);
    assert.match(res.content[0].text, /list_bundles/);
  });

  test('still there after translating: the sources come back as before', async () => {
    const { db } = setup();
    const mcp = createMcp({ db, origins: ['https://v.test'], englishFor: async () => new Map() });
    const res = resultOf(await call(mcp, { name: 'race', english: true }));
    assert.notEqual(res.isError, true);
    assert.match(res.content[0].text, /Second post here/);
  });
});

describe('finding 7: a link card keeps its saved article while a re-read is pending or failed', () => {
  const row = (f) => ({ id: 7, kind: 'link', link_type: 'web', url: 'https://example.com/essay', link_title: 'The Essay',
    link_md: 'This is the saved essay text with several words in it.', link_meta: JSON.stringify({ words: 160 }), fetch_status: 'ok', state: 'inbox', ...f });

  for (const status of ['ok', 'pending', 'failed']) {
    test(`fetch_status ${status}: title, preview and reader stay`, () => {
      const d = itemDto(row({ fetch_status: status }));
      assert.equal(d.link_has_text, true);
      assert.match(d.preview, /saved essay text/);
      assert.equal(d.words, 160);
      assert.equal(d.link_title, 'The Essay');
    });
  }

  test('no saved text, or a status that is not a read (link_only, unavailable): no article', () => {
    assert.equal(itemDto(row({ fetch_status: 'pending', link_md: null })).link_has_text, false);
    assert.equal(itemDto(row({ fetch_status: 'link_only' })).link_has_text, false);
    assert.equal(itemDto(row({ fetch_status: 'unavailable' })).link_has_text, false);
  });

  test('a YouTube transcript is never shown as a web article', () => {
    assert.equal(itemDto(row({ link_type: 'youtube', fetch_status: 'pending' })).link_has_text, false);
  });

  test('fetch_error is sent for links', () => {
    assert.equal(itemDto(row({ fetch_error: 'The site was too slow' })).fetch_error, 'The site was too slow');
  });
});

describe('finding 9: a failed re-read that kept the old text says so', () => {
  const statusChip = new Function('h', `${cut('function statusChip(')}; return statusChip;`)(h);
  const link = { kind: 'link', link_type: 'web', link_has_text: true };

  test('ok (or failed) with fetch_error and saved text: "Old text kept", the reason as its title', () => {
    for (const fetch_status of ['ok', 'failed']) {
      const c = statusChip({ ...link, fetch_status, fetch_error: 'The site was too slow' });
      assert.ok(c, fetch_status);
      assert.equal(c.text, 'Old text kept');
      assert.equal(c.title, 'The site was too slow');
      assert.match(c.class, /\bkept\b/);
    }
  });

  test('the other chips are unchanged', () => {
    assert.equal(statusChip({ ...link, fetch_status: 'ok', fetch_error: null }), null);
    assert.equal(statusChip({ ...link, fetch_status: 'pending' }).text, 'Loading…');
    assert.equal(statusChip({ ...link, link_has_text: false, fetch_status: 'link_only', fetch_error: 'Paywall' }).text, 'No article text');
    assert.equal(statusChip({ kind: 'tweet', fetch_status: 'failed' }).text, 'Failed');
  });

  test('the chip has a calm style of its own', () => {
    assert.match(CSS, /\.chip\.kept\s*\{/);
  });
});

describe('finding 8: "In English" after Add items translates the new sources', () => {
  function load(state, trCache, calls, trPending = new Set()) {
    const api = async (method, path) => {
      calls.push(path);
      const id = Number(path.split('/')[3]);
      return { text: `EN ${id}`, lang: 'ja' };
    };
    const toast = () => {};
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    return new Function('state', 'trCache', 'trPending', 'api', 'toast', 'plural',
      `${cut('async function translatePending(')}; return translatePending;`)(state, trCache, trPending, api, toast, plural);
  }

  test('only untranslated foreign sources are translated, then it reports the page is still there', async () => {
    const m = {};
    const state = { merge: m, inboxSeq: 3 };
    const trCache = new Map([[3, { text: 'cached' }]]);
    const calls = [];
    const translatePending = load(state, trCache, calls);
    const items = [{ id: 1, lang: 'ja' }, { id: 2, lang: 'ru', translation: { text: 'EN' } }, { id: 3, lang: 'ja' }];
    const sw = { disabled: false };
    const pre = { textContent: '', isConnected: true };
    assert.equal(await translatePending(m, () => items, sw, pre), true);
    assert.deepEqual(calls, ['/api/items/1/translate']);
    assert.deepEqual(items[0].translation, { text: 'EN 1', lang: 'ja' });
    assert.equal(trCache.get(1).seq, 3);
    assert.equal(sw.disabled, false);
  });

  test('a source already being translated (by an earlier loop) is not sent again', async () => {
    const m = {};
    const calls = [];
    const translatePending = load({ merge: m, inboxSeq: 1 }, new Map(), calls, new Set([1]));
    await translatePending(m, () => [{ id: 1, lang: 'ja' }, { id: 2, lang: 'ja' }], { disabled: false }, { textContent: '', isConnected: true });
    assert.deepEqual(calls, ['/api/items/2/translate']);
  });

  test('a merge left mid-way stops and does not report success', async () => {
    const m = {};
    const state = { merge: m, inboxSeq: 1 };
    const translatePending = load(state, new Map(), []);
    const pre = { textContent: '', isConnected: false };
    assert.equal(await translatePending(m, () => [{ id: 1, lang: 'ja' }, { id: 2, lang: 'ja' }], { disabled: false }, pre), undefined);
  });

  test('renderMerge runs it before the first preview when the reload kept "In English" on', () => {
    const body = APP.slice(APP.indexOf('  function renderMerge() {'), APP.indexOf('  async function unmergeBundle('));
    assert.match(body, /if \(m\.english && canTranslate\(\)\) translatePending\(m, foreign, englishSw, pre\)\.then\(\(ok\) => \{ if \(ok\) refresh\(\); \}\);\n\s*else refresh\(\);/);
    // and the switch uses the same helper
    assert.match(body, /if \(m\.english && !await translatePending\(m, foreign, englishSw, pre\)\) return;/);
  });
});
