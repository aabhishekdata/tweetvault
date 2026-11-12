// Phase 3 core fixes: the picker's light query (ADD0), /combine checking inside its transaction (ADD1),
// the merge editor on a 404 save (ADD2), the picker's Archived hint (ADD3), HEAD for /media (IMG5), and
// English on demand for export ?english=1 and MCP get_bundle english: true.
// Real createApp over HTTP, in-memory DB, a fake translation client only: nothing reaches the network.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createApp } from '../src/server.js';
import { openDb, now } from '../src/db.js';
import * as A from '../src/auth.js';
import { totp, base32Decode } from '../src/totp.js';
import { createTranslator, translateMissing, markUntranslated, untranslatedNote, ON_DEMAND_MAX } from '../src/translate.js';

delete process.env.ANTHROPIC_API_KEY;   // "not set up" must mean not set up, whatever the machine has
const PW = 'p3 core fixes password 789';
const realNow = Date.now;
let skewMs = 0;
Date.now = () => realNow() + skewMs;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

// a fake Anthropic client: "EN:" + the source, or what reply(text) says; it can be slow or fail
function fakeClient({ reply, delayMs = 0 } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(p) {
        const src = p.messages[0].content.replace(/^<source>\n|\n<\/source>$/g, '');
        calls.push(src);
        if (delayMs) await tick(delayMs);
        const out = reply ? reply(src) : `EN: ${src}`;
        if (out instanceof Error) throw out;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: out }] };
      },
    },
  };
}

async function boot(extra = {}) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const app = createApp({
    dbPath: ':memory:', passwordHash: await A.makePasswordHash(PW, 100000), secret: 'c'.repeat(40),
    origins: origin, cookieSecure: false, trustProxy: false, startWorker: false,
    fetchFn: async () => new Response('', { status: 404 }), paceMs: 0, log: () => {}, ...extra,
  });
  await app.listen(port, '127.0.0.1');
  const jar = new Map();
  async function req(method, path, body, { bearer, origin: o = origin } = {}) {
    const headers = {};
    if (o) headers.Origin = o;
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
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, text, json, headers: res.headers };
  }
  assert.equal((await req('POST', '/api/login', { password: PW })).status, 200);
  const s = await req('POST', '/api/mfa/setup', {});
  skewMs += 30_000;
  assert.equal((await req('POST', '/api/mfa/confirm', { code: totp(base32Decode(s.json.secret), now()) })).status, 200);
  const readKey = A.createDeviceToken(app.db, 'Test Claude', 'read').token;
  let seq = 0;
  async function mcp(name, args) {
    const r = await fetch(`${origin}/mcp`, {
      method: 'POST', headers: { Authorization: `Bearer ${readKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }),
    });
    const j = await r.json();
    assert.ok(j.result, JSON.stringify(j));
    return j.result.content[0].text;
  }
  return { app, db: app.db, req, mcp, origin };
}

let t0 = 1_800_000_000;
function ins(db, f) {
  t0 += 10;
  const row = { kind: 'tweet', fetch_status: 'ok', saved: 1, state: 'inbox', first_saved_at: t0, last_saved_at: t0, ...f };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid);
}
let tid = 5000;
const zh = (db, text, f = {}) => { tid += 1; return ins(db, { tweet_id: String(tid), root_tweet_id: String(tid), author_handle: `zh${tid}`, text, ...f }); };
async function merge(env, title, ids) {
  const r = await env.req('POST', '/api/bundles', { title, item_ids: ids });
  assert.equal(r.status, 201, r.text);
  return r.json.slug;
}
const srcLines = (text) => text.slice(text.lastIndexOf('## Sources')).split('\n').slice(1);

// ======================================================================
describe('English on demand: translateMissing (unit)', () => {
  test('only sources in another language with no current English are translated; links and English never', async () => {
    const db = openDb(':memory:');
    const client = fakeClient();
    const tr = createTranslator(db, { client });
    const a = zh(db, '你好世界，这是一个测试');
    const en = zh(db, 'Already in English');
    const link = ins(db, { kind: 'link', url: 'https://example.com/a', text: '链接标题中文' });
    const note = ins(db, { kind: 'text', fetch_status: 'n/a', text: 'An English note' });
    const rows = [a, en, link, note].map((id) => db.prepare('SELECT * FROM items WHERE id = ?').get(id));
    const failed = await translateMissing(db, tr, rows);
    assert.equal(failed.size, 0);
    assert.deepEqual(client.calls, ['你好世界，这是一个测试']);
    // stored now, so a second request translates nothing
    await translateMissing(db, tr, rows);
    assert.equal(client.calls.length, 1);
  });

  test(`at most ${ON_DEMAND_MAX} per request, never more than two at once; the rest are marked`, async () => {
    const db = openDb(':memory:');
    let running = 0; let peak = 0;
    const client = fakeClient();
    const create = client.messages.create;
    client.messages.create = async (p) => { running++; peak = Math.max(peak, running); try { await tick(5); return await create(p); } finally { running--; } };
    const tr = createTranslator(db, { client });
    const ids = Array.from({ length: 13 }, (_, i) => zh(db, `第${i}条中文帖子内容`));
    const rows = ids.map((id) => db.prepare('SELECT * FROM items WHERE id = ?').get(id));
    const failed = await translateMissing(db, tr, rows);
    assert.equal(client.calls.length, ON_DEMAND_MAX);
    assert.ok(peak <= 2, `peak ${peak}`);
    assert.equal(failed.size, 3);
    assert.match([...failed.values()][0], /more than 10/);
  });

  test('the daily cap stops the rest; a too-long text and a provider error are reasons of their own', async () => {
    const db = openDb(':memory:');
    const client = fakeClient({ reply: (s) => (s.includes('坏') ? Object.assign(new Error('boom'), { status: 400 }) : `EN ${s}`) });
    const tr = createTranslator(db, { client, dailyLimit: 2 });
    const ok = zh(db, '好的中文帖子');
    const bad = zh(db, '坏的中文帖子');
    const long = zh(db, '长'.repeat(30001));
    const capped = zh(db, '第三条中文帖子');
    const rows = [ok, bad, long, capped].map((id) => db.prepare('SELECT * FROM items WHERE id = ?').get(id));
    const failed = await translateMissing(db, tr, rows, { parallel: 1 });
    assert.equal(failed.has(ok), false);
    assert.equal(failed.get(bad), 'the translation service failed');
    assert.equal(failed.get(long), 'too long to translate');
    assert.equal(failed.get(capped), "today's translation limit is used up");
    assert.equal(untranslatedNote(failed), "3 sources could not be translated: the translation service failed; too long to translate; today's translation limit is used up.");
  });

  test('the time budget: what is still running when it ends stays in its own language (and is kept later)', async () => {
    const db = openDb(':memory:');
    const tr = createTranslator(db, { client: fakeClient({ delayMs: 80 }) });
    const ids = [zh(db, '慢的中文帖子一'), zh(db, '慢的中文帖子二'), zh(db, '慢的中文帖子三')];
    const rows = ids.map((id) => db.prepare('SELECT * FROM items WHERE id = ?').get(id));
    const t = realNow();
    const failed = await translateMissing(db, tr, rows, { budgetMs: 30 });
    assert.ok(realNow() - t < 75, 'returned when the budget ran out');
    assert.equal(failed.size, 3);
    assert.ok([...failed.values()].every((v) => v === 'ran out of time'));
    await tick(120);
    // the two that were running finished and were stored for next time
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM translations').get().n, 2);
  });

  test('the per-vault rate limit and "not set up" are said, not hidden', async () => {
    const db = openDb(':memory:');
    const a = zh(db, '中文帖子甲');
    const rows = [db.prepare('SELECT * FROM items WHERE id = ?').get(a)];
    const limited = await translateMissing(db, createTranslator(db, { client: fakeClient() }), rows, { allow: () => false });
    assert.match(limited.get(a), /too many translations/);
    const off = await translateMissing(db, createTranslator(db, { apiKey: '' }), rows);
    assert.equal(off.get(a), 'translation is not set up on this server');
  });

  test('markUntranslated marks only the Sources lines of those items', () => {
    const text = '## Post\nx\n\n---\n## Sources\n[Part 1 · Post] @a · url\n[Part 1 · Reply 1] @b · url\n[Part 2 · Post] @c\nStats as of 2026-01-01.';
    const out = markUntranslated(text, [{ item_id: 1, label: 'Part 1 · Post' }, { item_id: 2, label: 'Part 1 · Reply 1' }], new Map([[2, 'too long to translate']]));
    assert.deepEqual(srcLines(out), ['[Part 1 · Post] @a · url', '[Part 1 · Reply 1] @b · url · not translated: too long to translate', '[Part 2 · Post] @c', 'Stats as of 2026-01-01.']);
  });
});

// ======================================================================
describe('English on demand: export ?english=1 and MCP get_bundle english: true', () => {
  let env; let client; let slug; let ids;
  before(async () => {
    const db = openDb(':memory:');
    client = fakeClient({ reply: (s) => (s.includes('拒绝') ? Object.assign(new Error('x'), { status: 400 }) : `EN: ${s}`) });
    env = await boot({ db, translator: createTranslator(db, { client, log: () => {} }) });
    ids = {
      a: zh(env.db, '第一条中文帖子'),
      b: zh(env.db, '拒绝翻译的帖子'),
      en: zh(env.db, 'An English post'),
      link: ins(env.db, { kind: 'link', url: 'https://example.com/zh', text: '中文链接', fetch_status: 'link_only' }),
    };
    slug = await merge(env, 'Mixed', [ids.a, ids.b, ids.en, ids.link]);
  });
  after(async () => { await env.app.close(); });

  test('export translates what it can, marks the rest, and starts with a one-line note', async () => {
    const r = await env.req('GET', `/api/bundles/${slug}/export?english=1`);
    assert.equal(r.status, 200, r.text);
    const first = r.text.split('\n')[0];
    assert.equal(first, '1 source could not be translated: the translation service failed.');
    assert.match(r.text, /EN: 第一条中文帖子/);
    assert.match(r.text, /拒绝翻译的帖子/);           // left as it was
    const lines = srcLines(r.text);
    assert.ok(lines.some((l) => l.includes('@zh') && l.includes('English translation from Chinese')), lines.join('\n'));
    assert.ok(lines.some((l) => l.endsWith('· not translated: the translation service failed')), lines.join('\n'));
    // the English post and the link were never sent; the failing one was tried
    assert.ok(!client.calls.some((c) => c.includes('English') || c.includes('中文链接')));
  });

  test('without english=1 nothing is translated and there is no note', async () => {
    const n = client.calls.length;
    const r = await env.req('GET', `/api/bundles/${slug}/export`);
    assert.equal(client.calls.length, n);
    assert.match(r.text, /^# Mixed/);
  });

  test('MCP get_bundle english: true does the same, the note before the wrapper', async () => {
    const text = await env.mcp('get_bundle', { name: slug, english: true });
    assert.match(text, /^1 source could not be translated: the translation service failed\.\n\n<vault_bundle/);
    assert.match(text, /EN: 第一条中文帖子/);
    assert.match(text, /not translated: the translation service failed/);
    const plain = await env.mcp('get_bundle', { name: slug });
    assert.match(plain, /^<vault_bundle/);
    assert.match(plain, /第一条中文帖子/);
  });

  test('when translation is not set up, the note says so', async () => {
    const off = await boot();
    try {
      const a = zh(off.db, '没有设置翻译的帖子');
      const s = await merge(off, 'Off', [a]);
      const r = await off.req('GET', `/api/bundles/${s}/export?english=1`);
      assert.match(r.text, /^1 source could not be translated: translation is not set up on this server\./);
      assert.match(srcLines(r.text)[0], /not translated: translation is not set up on this server$/);
      const m = await off.mcp('get_bundle', { name: s, english: true });
      assert.match(m, /^1 source could not be translated: translation is not set up/);
    } finally { await off.app.close(); }
  });
});

// ======================================================================
describe('ADD0: the picker never loads whole bodies', () => {
  let env;
  before(async () => { env = await boot(); });
  after(async () => { await env.app.close(); });

  test('the query cuts the long columns; the preview and search still work', async () => {
    const body = `${'word '.repeat(400)}needle-at-the-end`;
    const id = ins(env.db, { kind: 'article', tweet_id: '9001', root_tweet_id: '9001', article_title: 'Long one', article_md: body });
    const seen = [];
    const prep = env.db.prepare;
    env.db.prepare = function (sql) { seen.push(sql); return prep.call(this, sql); };
    let r;
    try { r = await env.req('GET', '/api/items/pick?q=needle-at-the-end'); } finally { delete env.db.prepare; }
    assert.equal(r.status, 200, r.text);
    const x = r.json.items.find((i) => i.id === id);
    assert.ok(x, 'found by a word past the cut');
    assert.equal(x.preview, `${body.slice(0, 600)}…`);
    assert.equal('words' in x, false);
    const q = seen.find((s) => /FROM items WHERE saved = 1/.test(s));
    assert.ok(q && !/SELECT \*/.test(q) && /substr\(article_md, 1, 601\)/.test(q), q);
  });
});

// ======================================================================
describe('ADD1: /combine reads and checks both merges inside its transaction', () => {
  let env;
  before(async () => { env = await boot(); });
  after(async () => { await env.app.close(); });

  test('the bundle lookups come after BEGIN, and a stale version still rolls back', async () => {
    const a = await merge(env, 'One', [ins(env.db, { kind: 'text', fetch_status: 'n/a', text: 'one' })]);
    const b = await merge(env, 'Two', [ins(env.db, { kind: 'text', fetch_status: 'n/a', text: 'two' })]);
    const log = [];
    const { prepare, exec } = env.db;
    env.db.prepare = function (sql) { if (/FROM bundles WHERE slug/.test(sql)) log.push('lookup'); return prepare.call(this, sql); };
    env.db.exec = function (sql) { if (/^BEGIN/.test(sql)) log.push('begin'); return exec.call(this, sql); };
    try {
      const stale = await env.req('POST', `/api/bundles/${a}/combine`, { from: b, from_version: 99 });
      assert.equal(stale.status, 409);
      const i = log.indexOf('begin');
      assert.ok(i >= 0 && log.indexOf('lookup') > i, log.join(','));
    } finally { delete env.db.prepare; delete env.db.exec; }
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM bundles').get().n, 2);
    const ok = await env.req('POST', `/api/bundles/${a}/combine`, { from: b });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.added, 1);
    assert.equal((await env.req('POST', `/api/bundles/${a}/combine`, { from: b })).status, 404);
  });
});

// ======================================================================
describe('IMG5: HEAD /media/:file', () => {
  let env; let dir; let name;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tv-p3core-'));
    env = await boot({ mediaDir: dir });
    const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(1000)]);
    const sha = createHash('sha256').update(buf).digest('hex');
    name = `${sha}.jpg`;
    writeFileSync(join(dir, name), buf);
    const item = ins(env.db, { tweet_id: '7001', text: 'pic' });
    env.db.prepare(`INSERT INTO media (item_id, source_url, kind, status, sha256, mime, bytes, created_at, fetched_at)
      VALUES (?, 'https://pbs.twimg.com/media/x.jpg', 'image', 'ok', ?, 'image/jpeg', ?, ?, ?)`).run(item, sha, buf.length, now(), now());
  });
  after(async () => { await env.app.close(); rmSync(dir, { recursive: true, force: true }); });

  test('HEAD answers like GET without the body; an unknown file is 404', async () => {
    const h = await env.req('HEAD', `/media/${name}`);
    assert.equal(h.status, 200);
    assert.equal(h.headers.get('content-type'), 'image/jpeg');
    assert.equal(h.headers.get('content-length'), '1004');
    assert.equal(h.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(h.text, '');
    assert.equal((await env.req('HEAD', `/media/${'0'.repeat(64)}.jpg`)).status, 404);
    const g = await env.req('GET', `/media/${name}`);
    assert.equal(g.status, 200);
  });
});

// ======================================================================
const APP = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const cut = (header) => {
  const i = APP.indexOf(header);
  assert.ok(i >= 0, `app.js should contain ${header}`);
  const end = APP.indexOf('\n  }\n', i);
  return APP.slice(i, end + 5);
};

describe('ADD2: a merge combined or unmerged elsewhere', () => {
  test('a 404 on save says so and goes to the Merged list, instead of blaming the connection', async () => {
    const toasts = []; const went = [];
    const state = {};
    const api = async () => { throw Object.assign(new Error('No such bundle'), { status: 404 }); };
    const saveMerge = new Function('state', 'api', 'toast', 'go', 'openBundle',
      `${cut('async function saveMerge(')}; return saveMerge;`)(state, api, (msg, bad) => toasts.push([msg, bad]), async (c) => { went.push(c); state.merge = null; }, async () => {});
    const m = { slug: 'gone', version: 3 };
    state.merge = m;
    const err = await saveMerge(m, { title: 't', item_ids: [1] }).catch((e) => e);
    assert.equal(err.status, 404);
    assert.equal(err.mergeGone, true);
    assert.deepEqual(went, [{ tab: 'bundles' }]);
    assert.match(toasts[0][0], /combined or unmerged somewhere else/);
    // a merge you already left is not chased
    const other = { slug: 'old', version: 1 };
    const e2 = await saveMerge(other, {}).catch((e) => e);
    assert.equal(e2.mergeGone, undefined);
    assert.equal(went.length, 1);
  });

  test('the autosave does not then show "Not saved, check your connection"', () => {
    const body = cut('function refreshPreview(');
    assert.match(body, /if \(x\.status === 409 \|\| x\.mergeGone\) return;/);
  });
});

describe('ADD3: the picker hint', () => {
  test('says archived items you add move out of Archived', () => {
    assert.match(cut('function pickItemsDialog('), /Archived items you add move out of Archived\./);
  });
});

describe('WEB6 (server side): only the real start reads web pages', () => {
  test('createApp passes realWeb only when asked; the server start asks', () => {
    const SRC = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    assert.match(SRC, /realWeb: opts\.realWeb === true && !opts\.webFetch/);
    assert.match(SRC, /const app = createApp\(\{ realWeb: true \}\);/);
  });
});
