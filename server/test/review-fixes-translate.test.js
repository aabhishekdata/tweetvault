// Review fixes: translation billing and the daily cap, article source text, in-flight reuse across a text
// change, and the trash purge racing a second process. Fake clients or a local stand-in server, never the real API.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, now } from '../src/db.js';
import { byId, capture } from '../src/items.js';
import { createTranslator, sourceText } from '../src/translate.js';
import { housekeeping } from '../src/audit.js';

function ins(db, f) {
  const row = { kind: 'tweet', saved: 1, state: 'inbox', fetch_status: 'ok', ...f };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid);
}
const reply = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

describe('translation billing (finding 12)', () => {
  test('every real HTTP attempt to the API is counted against the daily cap', async () => {
    // a stand-in for the API that is overloaded every time
    let posts = 0;
    const srv = http.createServer((req, res) => {
      if (req.url.includes('/v1/messages')) posts++;
      req.resume();
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const prev = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
    try {
      const db = openDb(':memory:');
      const id = ins(db, { tweet_id: '1', text: '你好世界' });
      const t = createTranslator(db, { apiKey: 'sk-test-dummy', dailyLimit: 200 });
      await assert.rejects(t.translate(byId(db, id)), (e) => e.code === 'translate_busy');
      assert.ok(posts >= 1);
      assert.equal(t.usage().used, posts, 'the counter matches the requests actually sent');
      assert.ok(posts <= 2, 'at most one retry');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prev;
      srv.close();
    }
  });

  test('a timeout is not retried, and a short post does not ask for 16k tokens', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { tweet_id: '2', text: '短文' });
    const calls = [];
    const timeout = Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
    const client = { messages: { async create(p, o) { calls.push([p, o]); throw timeout; } } };
    const t = createTranslator(db, { client });
    await assert.rejects(t.translate(byId(db, id)), (e) => e.code === 'translate_failed');
    assert.equal(calls.length, 1, 'a timed-out generation may still be billed, so it is not sent again');
    const [params, opts] = calls[0];
    assert.ok(params.max_tokens < 16000 && params.max_tokens >= 4096, `max_tokens ${params.max_tokens}`);
    assert.ok(opts.timeout > 60_000 + params.max_tokens * 20, 'timeout leaves room for the whole generation');
  });

  test('a long article still gets the full output budget and a long timeout', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { tweet_id: '3', text: '这是一篇很长的中文文章。'.repeat(2000) });
    const calls = [];
    const client = { messages: { async create(p, o) { calls.push([p, o]); return reply('A long article.'); } } };
    await createTranslator(db, { client }).translate(byId(db, id));
    assert.equal(calls[0][0].max_tokens, 16000);
    assert.ok(calls[0][1].timeout >= 400_000);
  });

  test('a retry that would pass the cap is refused instead of sent', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { tweet_id: '4', text: '你好' });
    let n = 0;
    const busy = Object.assign(new Error('Overloaded'), { status: 529 });
    const client = { messages: { async create() { n++; throw busy; } } };
    const t = createTranslator(db, { client, dailyLimit: 1 });
    await assert.rejects(t.translate(byId(db, id)), (e) => e.code === 'translate_cap');
    assert.equal(n, 1);
    assert.deepEqual(t.usage(), { used: 1, limit: 1 });
  });
});

describe('article source text (finding 14)', () => {
  test('the post text of an article is translated, in render order, and changing it makes the translation stale', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { kind: 'article', tweet_id: '5', text: '作者的评论：必读', article_title: '标题', article_md: '正文内容' });
    assert.equal(sourceText(byId(db, id)), '标题\n\n作者的评论：必读\n\n正文内容');
    const calls = [];
    const client = { messages: { async create(p) { calls.push(p); return reply('TITLE EN\n\nCOMMENT EN\n\nBODY EN'); } } };
    const t = createTranslator(db, { client });
    await t.translate(byId(db, id));
    assert.match(calls[0].messages[0].content, /作者的评论：必读/);
    assert.ok(t.lookup(byId(db, id)));
    db.prepare('UPDATE items SET text = ? WHERE id = ?').run('完全不同的评论', id);
    assert.equal(t.lookup(byId(db, id)), null, 'an edited comment is not covered by the old translation');
    // an article with no post text is unchanged from before
    assert.equal(sourceText({ kind: 'article', text: '', article_title: 'T', article_md: 'B' }), 'T\n\nB');
  });
});

describe('in-flight reuse (finding 15)', () => {
  test('a call made after the text changed translates the new text, not the pending old one', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { tweet_id: '6', text: '旧的文字' });
    let release;
    const gate = new Promise((r) => (release = r));
    const client = { messages: { async create(p) {
      const src = p.messages[0].content.replace(/<\/?source>/g, '').trim();
      await gate;
      return reply(`EN of ${src}`);
    } } };
    const t = createTranslator(db, { client });
    const p1 = t.translate(byId(db, id));
    await new Promise((r) => setTimeout(r, 10));
    db.prepare('UPDATE items SET text = ? WHERE id = ?').run('新的文字', id);
    const p2 = t.translate(byId(db, id));
    const p3 = t.translate(byId(db, id));   // same new text: still shares one call
    release();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(r1.text, 'EN of 旧的文字');
    assert.equal(r2.text, 'EN of 新的文字');
    assert.equal(r3, r2);
  });
});

describe('trash purge (finding 16)', () => {
  function setup() {
    const f = join(mkdtempSync(join(tmpdir(), 'tv-purge-')), 'v.db');
    const cli = openDb(f);
    const srv = openDb(f);
    const t = now();
    const id = ins(cli, { tweet_id: '1790000000000000111', url: 'https://x.com/a/status/1790000000000000111',
      state: 'trashed', trashed_at: t - 31 * 86400, first_saved_at: t - 40 * 86400, last_saved_at: t - 40 * 86400 });
    return { cli, srv, id };
  }
  // run onFirst once, just as the purge reaches its per-item statements
  function hooked(db, marker, onFirst) {
    let fired = false;
    return new Proxy(db, { get(o, k) {
      if (k === 'prepare') return (sql) => {
        if (!fired && sql.startsWith(marker)) { fired = true; onFirst(); }
        return o.prepare(sql);
      };
      const v = o[k];
      return typeof v === 'function' ? v.bind(o) : v;
    } });
  }

  test('a second process cannot write between the candidate list and the delete', () => {
    const { cli, srv, id } = setup();
    srv.exec('PRAGMA busy_timeout = 50');
    let blocked = null;
    housekeeping(hooked(cli, 'UPDATE captures SET item_id = NULL', () => {
      try {
        capture(srv, { input: 'https://x.com/a/status/1790000000000000111', client_id: 'phone-share-0001' });
        blocked = false;
      } catch (e) { blocked = /locked|busy/i.test(e.message); }
    }));
    assert.equal(blocked, true, 'the re-share waits for the purge instead of landing in the middle of it');
    assert.equal(srv.prepare('SELECT id FROM items WHERE id = ?').get(id), undefined, 'the old trashed item was purged');
    // once the purge is done, the re-share goes through and the save is kept
    const cap = capture(srv, { input: 'https://x.com/a/status/1790000000000000111', client_id: 'phone-share-0002' });
    const it = srv.prepare('SELECT state, saved FROM items WHERE id = ?').get(cap.item_id);
    assert.deepEqual({ ...it }, { state: 'inbox', saved: 1 });
  });

  test('each statement re-checks the item, so a re-saved or merged item is left alone', () => {
    const { cli, id } = setup();
    const t = now();
    const id2 = ins(cli, { tweet_id: '222', url: 'u', state: 'trashed', trashed_at: t - 31 * 86400 });
    cli.prepare("INSERT INTO captures (client_id, item_id, raw_input, received_at) VALUES ('c-000000001', ?, 'x', ?)").run(id, t);
    cli.prepare("INSERT INTO captures (client_id, item_id, raw_input, received_at) VALUES ('c-000000002', ?, 'x', ?)").run(id2, t);
    // after the candidate list: the first item is shared again, the second is added to a merge
    const r = housekeeping(hooked(cli, 'SELECT tweet_id FROM items WHERE id = ?', () => {
      cli.prepare("UPDATE items SET state = 'inbox', trashed_at = NULL WHERE id = ?").run(id);
      const b = Number(cli.prepare("INSERT INTO bundles (slug, title, created_at, updated_at) VALUES ('m','M',?,?)").run(t, t).lastInsertRowid);
      cli.prepare('INSERT INTO bundle_items (bundle_id, item_id, position) VALUES (?, ?, 0)').run(b, id2);
    }));
    assert.equal(r.purged, 0);
    assert.equal(cli.prepare('SELECT state FROM items WHERE id = ?').get(id).state, 'inbox');
    assert.ok(cli.prepare('SELECT id FROM items WHERE id = ?').get(id2), 'the merged item is kept and nothing threw');
    assert.equal(cli.prepare("SELECT item_id FROM captures WHERE client_id = 'c-000000001'").get().item_id, id, 'its capture still points at it');
    assert.equal(cli.prepare("SELECT item_id FROM captures WHERE client_id = 'c-000000002'").get().item_id, id2);
  });
});
