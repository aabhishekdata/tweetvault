// Adversarial security tests: auth bypasses, CSRF, scope confusion, lockout, SSRF, cookie handling.
// In-memory DB and a fake fetchFn only; nothing touches the network except 127.0.0.1.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApp } from '../src/server.js';
import { openDb, now } from '../src/db.js';
import { createFetcher } from '../src/fetcher.js';
import { capture } from '../src/items.js';
import * as A from '../src/auth.js';
import { totp, base32Decode } from '../src/totp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (n) => readFileSync(join(HERE, 'fixtures', n), 'utf8');
const PW = 'sec-test password 123';

const realNow = Date.now;
let skewMs = 0;
Date.now = () => realNow() + skewMs;
const advance = (sec) => { skewMs += sec * 1000; };

async function boot({ trustProxy = false, cookieSecure = false } = {}) {
  const app = createApp({
    dbPath: ':memory:', passwordHash: await A.makePasswordHash(PW, 100000), secret: 's'.repeat(40),
    origins: 'http://vault.test', cookieSecure, trustProxy, startWorker: false,
    fetchFn: async () => new Response('{}', { status: 404 }), paceMs: 0, log: () => {},
  });
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  function browser() {
    const jar = new Map();
    return {
      jar,
      async req(method, path, { body, origin = 'http://vault.test', headers: extra = {}, cookie, bearer, ct } = {}) {
        const headers = { ...extra };
        if (origin) headers.Origin = origin;
        if (bearer) headers.Authorization = `Bearer ${bearer}`;
        const jarStr = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
        if (cookie !== undefined) headers.Cookie = cookie;
        else if (jarStr) headers.Cookie = jarStr;
        let payload;
        if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = ct || 'application/json'; }
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
        return { status: res.status, text, json, headers: res.headers, setCookie: res.headers.getSetCookie() };
      },
    };
  }
  return { app, db: app.db, browser, base };
}

async function enableMfa(b) {
  assert.equal((await b.req('POST', '/api/login', { body: { password: PW } })).status, 200);
  const s = await b.req('POST', '/api/mfa/setup', { body: {} });
  assert.equal(s.status, 200, s.text);
  const secret = base32Decode(s.json.secret);
  advance(30);
  const c = await b.req('POST', '/api/mfa/confirm', { body: { code: totp(secret, now()) } });
  assert.equal(c.status, 200, c.text);
  return { secret, recovery: c.json.recovery_codes };
}

// ======================================================================
describe('auth: sessions, two-step, CSRF, scopes', () => {
  let env; let secret; let recovery; let owner;
  before(async () => {
    env = await boot();
    owner = env.browser();
    ({ secret, recovery } = await enableMfa(owner));
  });
  after(async () => { await env.app.close(); });
  beforeEach(() => A._resetLockouts());

  test('pending (password-only) session cannot reach any S route, mfa setup/confirm, or recovery renewal', async () => {
    const b = env.browser();
    assert.deepEqual((await b.req('POST', '/api/login', { body: { password: PW } })).json, { mfa_required: true });
    for (const [m, p, body] of [
      ['POST', '/api/mfa/setup', {}], ['POST', '/api/mfa/confirm', { code: '000000' }], ['POST', '/api/mfa/recovery', { code: '000000' }],
      ['POST', '/api/devices', {}], ['GET', '/api/devices'], ['GET', '/api/audit'], ['POST', '/api/render', { item_ids: [] }],
      ['GET', '/api/bundles'], ['DELETE', '/api/sessions/0123456789abcdef'], ['DELETE', '/api/trusted/0123456789abcdef'],
    ]) {
      const r = await b.req(m, p, body === undefined ? {} : { body });
      assert.equal(r.status, 401, `${m} ${p}`);
    }
  });

  test('TOTP code consumed by /api/mfa/recovery cannot be replayed at /api/login/mfa', async () => {
    advance(30);
    const code = totp(secret, now());
    assert.equal((await owner.req('POST', '/api/mfa/recovery', { body: { code } })).status, 200);
    const b = env.browser();
    await b.req('POST', '/api/login', { body: { password: PW } });
    assert.equal((await b.req('POST', '/api/login/mfa', { body: { code } })).status, 401);
  });

  test('a recovery code burns on use and a renewed set invalidates the old set', async () => {
    // recovery codes were renewed in the previous test, so the original set must be dead
    const b = env.browser();
    await b.req('POST', '/api/login', { body: { password: PW } });
    assert.equal((await b.req('POST', '/api/login/mfa', { body: { recovery_code: recovery[0] } })).status, 401);
  });

  test('a forged / unknown tv_trust cookie does not skip the code', async () => {
    const b = env.browser();
    b.jar.set('tv_trust', 'not-a-real-token');
    const r = await b.req('POST', '/api/login', { body: { password: PW } });
    assert.deepEqual(r.json, { mfa_required: true });
  });

  test('every cookie-authenticated state change refuses a foreign or missing Origin', async () => {
    const t = now();
    const id = Number(env.db.prepare("INSERT INTO items (kind, text, fetch_status, saved, state, first_saved_at, last_saved_at) VALUES ('text','x','n/a',1,'inbox',?,?)").run(t, t).lastInsertRowid);
    env.db.prepare("INSERT INTO bundles (slug, title, created_at, updated_at) VALUES ('csrf-b','b',?,?)").run(t, t);
    const calls = [
      ['POST', '/api/captures', { input: 'hi', client_id: 'csrf-0001' }], ['PATCH', `/api/items/${id}`, { state: 'trashed' }],
      ['POST', '/api/items/bulk', { ids: [id], state: 'trashed' }], ['POST', `/api/items/${id}/refetch`, undefined],
      ['POST', '/api/bundles', { item_ids: [id] }], ['PUT', '/api/bundles/csrf-b', { title: 'z' }], ['DELETE', '/api/bundles/csrf-b', undefined],
      ['POST', '/api/devices', {}], ['DELETE', '/api/devices/1', undefined], ['DELETE', '/api/sessions/0123456789abcdef', undefined],
      ['DELETE', '/api/trusted/0123456789abcdef', undefined], ['POST', '/api/mfa/setup', {}], ['POST', '/api/mfa/confirm', { code: '1' }],
      ['POST', '/api/mfa/recovery', { code: '1' }], ['POST', '/api/logout', {}],
    ];
    for (const origin of ['https://evil.example', null, 'null']) {
      for (const [m, p, body] of calls) {
        const r = await owner.req(m, p, { origin, ...(body === undefined ? {} : { body }) });
        assert.equal(r.status, 403, `${m} ${p} with Origin ${origin}`);
      }
    }
    assert.equal(env.db.prepare('SELECT state FROM items WHERE id = ?').get(id).state, 'inbox');
    assert.ok(env.db.prepare("SELECT 1 FROM bundles WHERE slug = 'csrf-b'").get());
    assert.equal((await owner.req('GET', '/api/me')).json.signed_in, true);
  });

  test('a text/plain (form-like) POST with the right Origin is still refused', async () => {
    const r = await owner.req('POST', '/api/captures', { body: { input: 'x', client_id: 'csrf-0002' }, ct: 'text/plain' });
    assert.equal(r.status, 415);
  });

  test('scope confusion: capture token cannot read, read token cannot write, bearer never upgrades a cookie', async () => {
    const cap = A.createDeviceToken(env.db, 'c', 'capture').token;
    const rd = A.createDeviceToken(env.db, 'r', 'read').token;
    const anon = env.browser();
    for (const p of ['/api/inbox', '/api/bundles', '/api/devices', '/api/audit', '/api/items/1']) {
      assert.equal((await anon.req('GET', p, { bearer: cap })).status, 403, p);
    }
    assert.equal((await anon.req('POST', '/api/captures', { bearer: rd, body: { input: 'x', client_id: 'scope-001' } })).status, 403);
    assert.equal((await anon.req('POST', '/api/devices', { bearer: rd, body: { scopes: 'capture,read' } })).status, 403);
    assert.equal((await anon.req('POST', '/api/mfa/setup', { bearer: rd, body: {} })).status, 401);
    // a pending cookie plus a capture token does not reach S-only routes
    const p = env.browser();
    await p.req('POST', '/api/login', { body: { password: PW } });
    assert.equal((await p.req('GET', '/api/inbox', { bearer: cap })).status, 401);
    // an unknown bearer next to a full session is rejected rather than silently ignored
    assert.equal((await owner.req('GET', '/api/inbox', { bearer: 'tv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).status, 401);
  });

  test('static serving only knows its four files (no traversal)', async () => {
    const b = env.browser();
    for (const p of ['/../src/server.js', '/%2e%2e/src/server.js', '/static/app.js', '/..%2fsrc%2fdb.js', '/__proto__', '/constructor']) {
      const r = await b.req('GET', p, { origin: null });
      assert.ok(r.status === 404 || r.status === 405, `${p} -> ${r.status}`);
      assert.doesNotMatch(r.text, /createApp|DatabaseSync/);
    }
  });

  test('pairing codes work once and only within 10 minutes', async () => {
    const pc = await owner.req('POST', '/api/devices', { body: { scopes: 'capture' } });
    const anon = env.browser();
    advance(601);
    assert.equal((await anon.req('POST', '/api/pair', { body: { code: pc.json.code } })).status, 401);
  });

  test('anonymous /api/me does not reveal how many recovery codes are left', async () => {
    const r = await env.browser().req('GET', '/api/me', { origin: null });
    assert.equal(r.status, 200);
    assert.equal(r.json.recovery_left, undefined);
  });

  test('a malformed cookie (e.g. tossed from a sibling *.example.com host) does not break sign-in', async () => {
    const r = await env.browser().req('POST', '/api/login', { body: { password: 'wrong' }, cookie: 'junk=%E0' });
    assert.equal(r.status, 401);
  });

  test('session cookies use the __Host- prefix so sibling subdomains cannot overwrite them', async () => {
    const env2 = await boot({ cookieSecure: true });
    const r = await env2.browser().req('POST', '/api/login', { body: { password: PW } });
    await env2.app.close();
    assert.ok(r.setCookie.some((c) => c.startsWith('__Host-') && c.includes('Secure')), r.setCookie.join(' | '));
  });

  test('"keep this computer signed in" lasts 30 days and the 30 days roll forward on use', async () => {
    const env2 = await boot({ cookieSecure: true });
    try {
      const H = { 'Content-Type': 'application/json', Origin: 'http://vault.test' };
      const login = await fetch(`${env2.base}/api/login`, { method: 'POST', headers: H, body: JSON.stringify({ password: PW }) });
      const sid = login.headers.getSetCookie().find((c) => c.startsWith('__Host-tv_sid=')).split(';')[0];
      // a trusted browser skips the code, so it can't be made before two-step sign-in is on
      const early = await fetch(`${env2.base}/api/me/remember`, { method: 'POST', headers: { ...H, Cookie: sid }, body: '{}' });
      assert.equal(early.status, 403);
      env2.db.prepare("INSERT OR REPLACE INTO mfa (id, enabled, recovery_json, updated_at) VALUES (1, 1, '[]', 0)").run();
      const rem = await fetch(`${env2.base}/api/me/remember`, { method: 'POST', headers: { ...H, Cookie: sid }, body: '{}' });
      assert.equal(rem.status, 200);
      const set = rem.headers.getSetCookie();
      assert.ok(set.some((c) => c.startsWith('__Host-tv_sid=') && c.includes(`Max-Age=${A.TRUSTED_TTL}`)), set.join(' | '));
      assert.ok(set.some((c) => c.startsWith('__Host-tv_trust=')), 'a trusted-browser cookie is set too');
      const me1 = await (await fetch(`${env2.base}/api/me`, { headers: { Cookie: sid } })).json();
      assert.equal(me1.remembered, true);
      // five days later the next visit pushes the expiry back out to 30 days
      const hash = A.sha256(sid.split('=')[1]);
      env2.db.prepare('UPDATE sessions SET expires_at = ? WHERE id_hash = ?').run(now() + A.TRUSTED_TTL - 5 * 86400, hash);
      const again = await fetch(`${env2.base}/api/me`, { headers: { Cookie: sid } });
      assert.ok(again.headers.getSetCookie().some((c) => c.startsWith('__Host-tv_sid=') && c.includes(`Max-Age=${A.TRUSTED_TTL}`)));
      const left = env2.db.prepare('SELECT expires_at FROM sessions WHERE id_hash = ?').get(hash).expires_at - now();
      assert.ok(left > A.TRUSTED_TTL - 60, `expiry rolled forward (${left}s left)`);
      // without the Origin header the remember call is refused (CSRF)
      const bad = await fetch(`${env2.base}/api/me/remember`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sid }, body: '{}' });
      assert.equal(bad.status, 403);
    } finally { await env2.app.close(); }
  });

  test('with production cookies, the session cookie from sign-in is recognised afterwards', async () => {
    const env2 = await boot({ cookieSecure: true });
    try {
      const login = await fetch(`${env2.base}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://vault.test' }, body: JSON.stringify({ password: PW }),
      });
      assert.equal(login.status, 200);
      const sid = login.headers.getSetCookie().find((c) => c.startsWith('__Host-tv_sid=')).split(';')[0];
      const me = await (await fetch(`${env2.base}/api/me`, { headers: { Cookie: sid } })).json();
      assert.equal(me.signed_in, true, 'the __Host- session cookie must sign you in');
    } finally { await env2.app.close(); }
  });
});

// ======================================================================
describe('lockout behind the proxy (trustProxy on)', () => {
  let env; let secret;
  before(async () => {
    env = await boot({ trustProxy: true });
    ({ secret } = await enableMfa(env.browser()));
  });
  after(async () => { await env.app.close(); });
  beforeEach(() => A._resetLockouts());

  test('spoofed left-hand X-Forwarded-For entries are ignored (Nginx appends the real address)', async () => {
    const b = env.browser();
    for (let i = 0; i < 10; i++) {
      await b.req('POST', '/api/login', { body: { password: 'nope' }, headers: { 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.9` } });
    }
    const r = await b.req('POST', '/api/login', { body: { password: PW }, headers: { 'X-Forwarded-For': '198.51.100.1, 203.0.113.9' } });
    assert.equal(r.status, 429);
  });

  test('one pending session cannot be used to spray two-step codes from many addresses', async () => {
    const b = env.browser();
    await b.req('POST', '/api/login', { body: { password: PW }, headers: { 'X-Forwarded-For': '2001:db8::1' } });
    for (let i = 0; i < 30; i++) {
      await b.req('POST', '/api/login/mfa', { body: { code: '000000' }, headers: { 'X-Forwarded-For': `2001:db8::${(i + 2).toString(16)}` } });
    }
    advance(30);
    const r = await b.req('POST', '/api/login/mfa', { body: { code: totp(secret, now()) }, headers: { 'X-Forwarded-For': '2001:db8::ff' } });
    assert.notEqual(r.status, 200, 'after 30 wrong codes the pending session should be dead (401/400) or the source locked (429)');
  });

  test('password guessing is capped globally, not only per address', async () => {
    const b = env.browser();
    for (let i = 0; i < 50; i++) {
      await b.req('POST', '/api/login', { body: { password: `guess${i}` }, headers: { 'X-Forwarded-For': `2001:db8:0:1::${(i + 1).toString(16)}` } });
    }
    const r = await b.req('POST', '/api/login', { body: { password: PW }, headers: { 'X-Forwarded-For': '2001:db8:0:1::ffff' } });
    assert.equal(r.status, 429);
  });
});

// ======================================================================
describe('fetcher: outbound requests stay on the allow-list', () => {
  const ID = '2117512471930167377';

  function setup(handler) {
    const db = openDb(':memory:');
    const calls = [];
    const fetchFn = async (url, opts = {}) => { calls.push({ url: String(url), opts }); return handler(String(url), opts); };
    const f = createFetcher(db, { fetchFn, paceMs: 0 });
    return { db, f, calls };
  }

  test('non-allow-listed hosts are refused before any request', async () => {
    const { db, f, calls } = setup(() => new Response('', { status: 500 }));
    const t = now();
    db.prepare("INSERT INTO items (kind, url, note, fetch_status, saved, state, first_saved_at, last_saved_at) VALUES ('link','https://evil.example/x','tco','pending',1,'inbox',?,?)").run(t, t);
    await f.drain(1);
    assert.equal(calls.length, 0);
  });

  test('a t.co hop to an internal address is stored as a link, never fetched', async () => {
    const { db, f, calls } = setup(() => new Response('', { status: 301, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }));
    capture(db, { input: 'https://t.co/abc123', client_id: 'tco-ssrf-1' });
    await f.drain(5);
    assert.equal(calls.length, 1);
    assert.equal(db.prepare("SELECT fetch_status FROM items WHERE kind = 'link'").get().fetch_status, 'link_only');
  });

  test('FxTwitter and oEmbed requests do not follow redirects off the allow-list', async () => {
    const { db, f, calls } = setup((url) => (url.includes('api.fxtwitter.com') ? new Response(FIX('missing.json'), { status: 200 }) : new Response('', { status: 404 })));
    capture(db, { input: `https://x.com/a/status/${ID}`, client_id: 'redir-0001' });
    await f.drain(1);
    assert.ok(calls.length >= 1);
    for (const c of calls) assert.ok(c.opts.redirect === 'manual' || c.opts.redirect === 'error', `${c.url} redirect=${c.opts.redirect}`);
  });

  test('a t.co hop never stores a javascript: or data: URL (it becomes the "Open" href)', async () => {
    const { db, f } = setup(() => new Response('', { status: 301, headers: { location: 'javascript:alert(document.domain)' } }));
    capture(db, { input: 'https://t.co/js1', client_id: 'tco-js-001' });
    await f.drain(5);
    const url = db.prepare("SELECT url FROM items WHERE kind = 'link'").get().url;
    assert.match(url, /^https?:\/\//);
  });

  test('t.co is only fetched over https', async () => {
    const { db, f, calls } = setup(() => new Response('', { status: 301, headers: { location: 'https://example.com/' } }));
    capture(db, { input: 'http://t.co/plain1', client_id: 'tco-http-1' });
    await f.drain(5);
    for (const c of calls) assert.ok(c.url.startsWith('https://'), c.url);
  });
});
