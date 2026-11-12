// API tests for server.js: sign-in, two-step codes, CSRF, scopes, captures, bundles, audit.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApp } from '../src/server.js';
import * as A from '../src/auth.js';
import { totp, base32Decode } from '../src/totp.js';
import { now } from '../src/db.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (n) => readFileSync(join(HERE, 'fixtures', n), 'utf8');
const ARTICLE = FIX('article.json');
const ARTICLE_ID = '2117512471930167377';
const PW = 'correct horse battery staple';

// ---- controllable clock (TOTP steps, replay windows) ----
const realNow = Date.now;
let skewMs = 0;
Date.now = () => realNow() + skewMs;
const advance = (sec) => { skewMs += sec * 1000; };

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

// fake fetch: FxTwitter returns the article fixture for its id, the "missing" HTML page otherwise
const fetchCalls = [];
async function fakeFetch(url) {
  fetchCalls.push(String(url));
  if (String(url).includes(`/status/${ARTICLE_ID}`)) return new Response(ARTICLE, { status: 200 });
  if (String(url).startsWith('https://publish.twitter.com/')) return new Response('', { status: 404 });
  return new Response(FIX('missing.json'), { status: 200, headers: { 'content-type': 'text/html' } });
}

async function boot() {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const app = createApp({
    dbPath: ':memory:', passwordHash: await A.makePasswordHash(PW, 100000), secret: 'x'.repeat(40),
    origins: origin, cookieSecure: false, trustProxy: false, startWorker: false, fetchFn: fakeFetch, paceMs: 0,
    log: () => {},
  });
  await app.listen(port, '127.0.0.1');
  const base = origin;

  // a browser with its own cookie jar
  function browser() {
    const jar = new Map();
    const b = {
      jar,
      async req(method, path, { body, origin: o = origin, ct, bearer, raw, noCookies } = {}) {
        const headers = {};
        if (o) headers.Origin = o;
        if (bearer) headers.Authorization = `Bearer ${bearer}`;
        if (!noCookies && jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
        let payload;
        if (raw !== undefined) { payload = raw; headers['Content-Type'] = ct || 'application/json'; }
        else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = ct || 'application/json'; }
        const res = await fetch(base + path, { method, headers, body: payload });
        for (const sc of res.headers.getSetCookie()) {
          const [kv, ...attrs] = sc.split(';');
          const i = kv.indexOf('=');
          const k = kv.slice(0, i).trim();
          const v = decodeURIComponent(kv.slice(i + 1).trim());
          const maxAge = attrs.map((a) => a.trim()).find((a) => a.startsWith('Max-Age='));
          if (!v || maxAge === 'Max-Age=0') jar.delete(k); else jar.set(k, v);
        }
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* text */ }
        return { status: res.status, headers: res.headers, text, json, setCookie: res.headers.getSetCookie() };
      },
    };
    return b;
  }
  return { app, port, origin, base, browser, db: app.db };
}

// two-step setup helper: returns the raw TOTP secret and recovery codes
async function setupMfa(b) {
  const lg = await b.req('POST', '/api/login', { body: { password: PW } });
  assert.equal(lg.status, 200);
  assert.equal(lg.json.mfa_setup_required, true);
  const s = await b.req('POST', '/api/mfa/setup', { body: {} });
  assert.equal(s.status, 200, s.text);
  const secret = base32Decode(s.json.secret);
  advance(30);
  const c = await b.req('POST', '/api/mfa/confirm', { body: { code: totp(secret, now()) } });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.recovery_codes.length, 8);
  return { secret, recovery: c.json.recovery_codes };
}

// fresh login through password + current code
async function fullLogin(env, secret, opts = {}) {
  const b = opts.browser || env.browser();
  const lg = await b.req('POST', '/api/login', { body: { password: PW } });
  assert.equal(lg.status, 200, lg.text);
  if (lg.json.mfa_required) {
    advance(30);
    const m = await b.req('POST', '/api/login/mfa', { body: { code: totp(secret, now()), trust: !!opts.trust } });
    assert.equal(m.status, 200, m.text);
  }
  return b;
}

function insertItem(db, f) {
  const cols = Object.keys(f);
  return Number(db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => f[c])).lastInsertRowid);
}

// a root tweet, the author's own follow-up and two replies (one replying to the other)
function seedConversation(db) {
  const t = now();
  const R = '1900000000000000001';
  const base = { kind: 'tweet', fetch_status: 'ok', saved: 1, state: 'inbox', root_tweet_id: R, first_saved_at: t, last_saved_at: t };
  const root = insertItem(db, { ...base, tweet_id: R, author_handle: 'alice', text: 'Root post', posted_at: 1000, url: `https://x.com/alice/status/${R}` });
  const self = insertItem(db, { ...base, tweet_id: '1900000000000000002', parent_tweet_id: R, author_handle: 'alice', is_self_thread: 1, text: 'Part two', posted_at: 1001 });
  const r1 = insertItem(db, { ...base, tweet_id: '1900000000000000003', parent_tweet_id: R, author_handle: 'bob', text: 'Reply from bob', posted_at: 1002 });
  const r2 = insertItem(db, { ...base, tweet_id: '1900000000000000004', parent_tweet_id: '1900000000000000003', author_handle: 'carol', text: 'Reply to bob', posted_at: 1003 });
  const note = insertItem(db, { kind: 'text', fetch_status: 'n/a', saved: 1, state: 'inbox', text: 'A loose note', first_saved_at: t, last_saved_at: t });
  return { root, self, r1, r2, note };
}

// ======================================================================
describe('public routes and request hygiene (no MFA yet)', () => {
  let env;
  before(async () => { env = await boot(); });
  after(async () => { await env.app.close(); });
  beforeEach(() => A._resetLockouts());

  test('GET /healthz', async () => {
    const r = await env.browser().req('GET', '/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
  });

  test('static / has CSP and no inline script', async () => {
    const r = await env.browser().req('GET', '/');
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy');
    assert.ok(csp && csp.includes("script-src 'self'"), csp);
    assert.ok(!csp.includes('unsafe-inline'));
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    // every <script> tag must have a src and no body
    const scripts = [...r.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    assert.ok(scripts.length >= 1);
    for (const [, attrs, inner] of scripts) {
      assert.match(attrs, /\bsrc=/);
      assert.equal(inner.trim(), '');
    }
    assert.ok(!/\son[a-z]+\s*=/i.test(r.text), 'no inline event handlers');
    const js = await env.browser().req('GET', '/app.js');
    assert.equal(js.status, 200);
    assert.ok(js.headers.get('content-security-policy'));
  });

  test('self-hosted fonts are served same-origin as woff2 and cached', async () => {
    for (const name of ['regular', 'medium']) {
      const r = await env.browser().req('GET', `/fonts/source-sans-3-${name}.woff2`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'font/woff2');
      assert.match(r.headers.get('cache-control'), /immutable/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    }
    // nothing else under /fonts/ is reachable (the license file is for the repo, not served)
    assert.equal((await env.browser().req('GET', '/fonts/OFL-LICENSE.md', { origin: null })).status, 404);
  });

  test('wrong password -> 401 and an audit row', async () => {
    const b = env.browser();
    const r = await b.req('POST', '/api/login', { body: { password: 'nope' } });
    assert.equal(r.status, 401);
    const row = env.db.prepare("SELECT * FROM audit_log WHERE event = 'login_failed' ORDER BY id DESC").get();
    assert.ok(row);
    assert.equal(row.ok, 0);
    assert.ok(row.ip && row.ip.includes('127.0.0.1'));
    assert.equal(b.jar.size, 0, 'no cookie on failure');
  });

  test('lockout: 429 after 10 failures from one IP, even with the right password', async () => {
    const b = env.browser();
    for (let i = 0; i < 10; i++) {
      const r = await b.req('POST', '/api/login', { body: { password: `bad${i}` } });
      assert.equal(r.status, 401, `attempt ${i + 1}`);
    }
    const r = await b.req('POST', '/api/login', { body: { password: PW } });
    assert.equal(r.status, 429);
    assert.ok(env.db.prepare("SELECT 1 FROM audit_log WHERE event = 'login_locked'").get());
    A._resetLockouts();
    const ok = await b.req('POST', '/api/login', { body: { password: PW } });
    assert.equal(ok.status, 200);
  });

  test('login: missing or foreign Origin -> 403', async () => {
    const b = env.browser();
    assert.equal((await b.req('POST', '/api/login', { body: { password: PW }, origin: null })).status, 403);
    assert.equal((await b.req('POST', '/api/login', { body: { password: PW }, origin: 'https://evil.example' })).status, 403);
    assert.equal(b.jar.size, 0);
  });

  test('non-JSON content type -> 415', async () => {
    const b = env.browser();
    const r = await b.req('POST', '/api/login', { raw: `password=${PW}`, ct: 'application/x-www-form-urlencoded' });
    assert.equal(r.status, 415);
    const r2 = await b.req('POST', '/api/login', { raw: JSON.stringify({ password: PW }), ct: 'text/plain' });
    assert.equal(r2.status, 415);
  });

  test('body over 256KB -> 413', async () => {
    const big = JSON.stringify({ password: 'x'.repeat(300 * 1024) });
    // raw http so an early response does not race the upload
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${env.base}/api/login`, {
        method: 'POST', headers: { Origin: env.origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(big) },
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end(big);
    });
    assert.equal(status, 413);
  });

  test('bad JSON -> 400', async () => {
    const r = await env.browser().req('POST', '/api/login', { raw: '{nope' });
    assert.equal(r.status, 400);
    const r2 = await env.browser().req('POST', '/api/login', { raw: '[1,2]' });
    assert.equal(r2.status, 400);
  });

  test('before two-step setup, data endpoints return 403 mfa_setup_required', async () => {
    const b = env.browser();
    const lg = await b.req('POST', '/api/login', { body: { password: PW } });
    assert.equal(lg.status, 200);
    assert.equal(lg.json.mfa_setup_required, true);
    assert.ok(b.jar.get('tv_sid'));
    const me = await b.req('GET', '/api/me');
    assert.equal(me.json.signed_in, true);
    assert.equal(me.json.mfa_enabled, false);
    for (const [m, p, body] of [['GET', '/api/inbox'], ['GET', '/api/bundles'], ['GET', '/api/audit'], ['GET', '/api/devices'],
      ['POST', '/api/captures', { input: 'hello', client_id: 'abcdefgh1' }], ['POST', '/api/render', { item_ids: [] }]]) {
      const r = await b.req(m, p, { body });
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.json.error, 'mfa_setup_required', `${m} ${p}`);
    }
  });

  test('signed-out requests -> 401, unknown routes 404, wrong method 405', async () => {
    const b = env.browser();
    const r = await b.req('GET', '/api/inbox');
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'signed_out');
    assert.equal((await b.req('GET', '/api/nothing')).status, 404);
    assert.equal((await b.req('DELETE', '/healthz')).status, 405);
  });
});

// ======================================================================
describe('two-step sign-in, sessions, devices and data', () => {
  let env;
  let secret;
  let recovery;
  let owner; // the browser that did the setup (full session)

  before(async () => {
    env = await boot();
    owner = env.browser();
    ({ secret, recovery } = await setupMfa(owner));
  });
  after(async () => { await env.app.close(); });
  beforeEach(() => A._resetLockouts());

  test('setup session stays signed in and can now read data', async () => {
    const me = await owner.req('GET', '/api/me');
    assert.equal(me.json.signed_in, true);
    assert.equal(me.json.mfa_enabled, true);
    assert.equal(me.json.recovery_left, 8);
    assert.equal((await owner.req('GET', '/api/inbox')).status, 200);
    assert.ok(env.db.prepare("SELECT 1 FROM audit_log WHERE event = 'mfa_enabled'").get());
  });

  test('setting up a new authenticator again needs a current code', async () => {
    const r = await owner.req('POST', '/api/mfa/setup', { body: {} });
    assert.equal(r.status, 401);
  });

  test('fresh login now requires /api/login/mfa; pending session cannot read /api/inbox', async () => {
    const b = env.browser();
    const lg = await b.req('POST', '/api/login', { body: { password: PW } });
    assert.equal(lg.status, 200);
    assert.deepEqual(lg.json, { mfa_required: true });
    const me = await b.req('GET', '/api/me');
    assert.equal(me.json.signed_in, false);
    assert.equal(me.json.needs_code, true);
    for (const p of ['/api/inbox', '/api/bundles', '/api/audit', '/api/devices']) {
      const r = await b.req('GET', p);
      assert.equal(r.status, 401, p);
    }
    const cap = await b.req('POST', '/api/captures', { body: { input: 'x', client_id: 'pending-1' } });
    assert.equal(cap.status, 401);
    const ds = await b.req('POST', '/api/devices', { body: {} });
    assert.equal(ds.status, 401);
    const setup = await b.req('POST', '/api/mfa/setup', { body: {} });
    assert.equal(setup.status, 401, 'a password-only session must not re-key the authenticator');
  });

  test('wrong code 401 + audit; right code works; same code replay refused', async () => {
    const b = env.browser();
    await b.req('POST', '/api/login', { body: { password: PW } });
    const bad = await b.req('POST', '/api/login/mfa', { body: { code: '000000' === totp(secret, now()) ? '111111' : '000000' } });
    assert.equal(bad.status, 401);
    assert.ok(env.db.prepare("SELECT 1 FROM audit_log WHERE event = 'code_failed'").get());
    advance(30);
    const code = totp(secret, now());
    const ok = await b.req('POST', '/api/login/mfa', { body: { code } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await b.req('GET', '/api/inbox')).status, 200);
    assert.ok(!b.jar.has('tv_trust'));

    // another browser tries to reuse the same code within its window
    const c = env.browser();
    await c.req('POST', '/api/login', { body: { password: PW } });
    const replay = await c.req('POST', '/api/login/mfa', { body: { code } });
    assert.equal(replay.status, 401);
    // an older code (previous step) is also refused
    const older = await c.req('POST', '/api/login/mfa', { body: { code: totp(secret, now() - 30) } });
    assert.equal(older.status, 401);
  });

  test('/api/login/mfa without a pending session -> 400', async () => {
    const b = env.browser();
    advance(30);
    const r = await b.req('POST', '/api/login/mfa', { body: { code: totp(secret, now()) } });
    assert.equal(r.status, 400);
    const r2 = await owner.req('POST', '/api/login/mfa', { body: { code: totp(secret, now()) } });
    assert.equal(r2.status, 400, 'a full session is not a pending one');
  });

  test('recovery code works exactly once', async () => {
    const b = env.browser();
    await b.req('POST', '/api/login', { body: { password: PW } });
    const r = await b.req('POST', '/api/login/mfa', { body: { recovery_code: recovery[0].toUpperCase().replace('-', '') } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.recovery_left, 7);
    assert.ok(env.db.prepare("SELECT 1 FROM audit_log WHERE event = 'recovery_code_used'").get());

    const c = env.browser();
    await c.req('POST', '/api/login', { body: { password: PW } });
    const again = await c.req('POST', '/api/login/mfa', { body: { recovery_code: recovery[0] } });
    assert.equal(again.status, 401);
    const other = await c.req('POST', '/api/login/mfa', { body: { recovery_code: recovery[1] } });
    assert.equal(other.status, 200);
    assert.equal(other.json.recovery_left, 6);
  });

  test('trust=true sets tv_trust; after the session ends the password alone signs in; signing out forgets the browser', async () => {
    const b = await fullLogin(env, secret, { trust: true });
    assert.ok(b.jar.get('tv_trust'), 'tv_trust cookie set');
    // the session runs out (not a sign-out): the trusted browser skips the code
    env.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(A.sha256(b.jar.get('tv_sid')));
    assert.equal((await b.req('GET', '/api/me')).json.signed_in, false);
    const lg = await b.req('POST', '/api/login', { body: { password: PW } });
    assert.equal(lg.status, 200);
    assert.equal(lg.json.ok, true);
    assert.ok(!lg.json.mfa_required);
    assert.equal((await b.req('GET', '/api/inbox')).status, 200);
    // the trust cookie alone is not a session, and a wrong password still fails
    const c = env.browser();
    c.jar.set('tv_trust', b.jar.get('tv_trust'));
    assert.equal((await c.req('GET', '/api/inbox')).status, 401);
    assert.equal((await c.req('POST', '/api/login', { body: { password: 'wrong' } })).status, 401);
    // signing out clears both cookies and forgets the browser: the next password sign-in needs the code again
    const trustTok = b.jar.get('tv_trust');
    const out = (await b.req('POST', '/api/logout', { body: {} })).setCookie.join('\n');
    assert.match(out, /tv_sid=;/);
    assert.match(out, /tv_trust=;/);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM trusted_browsers WHERE id_hash = ?').get(A.sha256(trustTok)).n, 0);
    const d = env.browser();
    d.jar.set('tv_trust', trustTok);
    assert.equal((await d.req('POST', '/api/login', { body: { password: PW } })).json.mfa_required, true);
    // cookie flags
    const raw = (await env.browser().req('POST', '/api/login', { body: { password: PW } })).setCookie.join('\n');
    assert.match(raw, /HttpOnly/);
    assert.match(raw, /SameSite=Strict/);
  });

  test('cookie-authenticated POSTs need the right Origin', async () => {
    for (const o of [null, 'https://evil.example', `http://127.0.0.1:${env.port + 1}`]) {
      const r = await owner.req('POST', '/api/captures', { body: { input: 'hello', client_id: 'origin-test-1' }, origin: o });
      assert.equal(r.status, 403, String(o));
      const d = await owner.req('POST', '/api/devices', { body: {}, origin: o });
      assert.equal(d.status, 403, String(o));
      const lo = await owner.req('POST', '/api/logout', { body: {}, origin: o });
      assert.equal(lo.status, 403, String(o));
      const del = await owner.req('DELETE', '/api/bundles/whatever', { origin: o });
      assert.equal(del.status, 403, String(o));
    }
    assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM captures WHERE client_id = 'origin-test-1'").get().n, 0);
    assert.equal((await owner.req('GET', '/api/me')).json.signed_in, true, 'foreign logout did nothing');
    const ct = await owner.req('POST', '/api/captures', { raw: JSON.stringify({ input: 'x', client_id: 'ct-test-01' }), ct: 'text/plain' });
    assert.equal(ct.status, 415);
  });

  // ---- devices ----
  let captureToken;
  let captureDeviceId;
  let readToken;

  test('pairing code -> /api/pair token (works once)', async () => {
    const p = await owner.req('POST', '/api/devices', { body: {} });
    assert.equal(p.status, 200);
    assert.match(p.json.code, /^\d{6}$/);
    assert.equal(p.json.scopes, 'capture');
    const phone = env.browser();
    const r = await phone.req('POST', '/api/pair', { body: { code: p.json.code, name: 'S25' }, origin: null });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.token, /^tv_[A-Za-z0-9_-]{40,}$/);
    assert.equal(r.json.scopes, 'capture');
    captureToken = r.json.token;
    const again = await phone.req('POST', '/api/pair', { body: { code: p.json.code, name: 'S25' }, origin: null });
    assert.equal(again.status, 401);
    // the token is stored only as a hash and never logged
    const dev = env.db.prepare("SELECT * FROM devices WHERE name = 'S25'").get();
    captureDeviceId = dev.id;
    assert.notEqual(dev.token_hash, captureToken);
    const logs = JSON.stringify(env.db.prepare('SELECT * FROM audit_log').all());
    assert.ok(!logs.includes(captureToken));
    assert.ok(env.db.prepare("SELECT 1 FROM audit_log WHERE event = 'device_paired'").get());
  });

  test('capture with Bearer token: 202, then same client_id 200', async () => {
    const phone = env.browser();
    const body = { input: `Look https://x.com/addyosmani/status/${ARTICLE_ID}?s=20&t=abc`, source_app: 'com.twitter.android', client_id: 'phone-uuid-0001' };
    const r1 = await phone.req('POST', '/api/captures', { body, bearer: captureToken, origin: null });
    assert.equal(r1.status, 202, r1.text);
    assert.equal(r1.json.fetch_status, 'pending');
    assert.ok(!('duplicate' in r1.json));
    const r2 = await phone.req('POST', '/api/captures', { body, bearer: captureToken, origin: null });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.item_id, r1.json.item_id);
    assert.equal(r2.json.capture_id, r1.json.capture_id);
    // a different client_id for the same tweet gives the same item
    const r3 = await phone.req('POST', '/api/captures', { body: { ...body, client_id: 'phone-uuid-0002' }, bearer: captureToken, origin: null });
    assert.equal(r3.status, 202);
    assert.equal(r3.json.item_id, r1.json.item_id);
    const st = await phone.req('GET', '/api/captures', { bearer: captureToken, origin: null });
    assert.equal(st.status, 200);
    assert.equal(st.json.captures.length, 2);
    // the fetch worker fills it in from the fake FxTwitter
    await env.app.fetcher.drain();
    assert.ok(fetchCalls.some((u) => u.startsWith('https://api.fxtwitter.com/') && u.includes(ARTICLE_ID)));
    const item = env.db.prepare('SELECT * FROM items WHERE id = ?').get(r1.json.item_id);
    assert.equal(item.fetch_status, 'ok');
    assert.equal(item.kind, 'article');
  });

  test('capture-scope token gets 403 on /api/inbox and /api/bundles', async () => {
    const phone = env.browser();
    for (const p of ['/api/inbox', '/api/bundles', '/api/audit', '/api/devices']) {
      const r = await phone.req('GET', p, { bearer: captureToken, origin: null });
      assert.equal(r.status, 403, p);
    }
    assert.equal((await phone.req('POST', '/api/render', { body: { item_ids: [1] }, bearer: captureToken, origin: null })).status, 403);
  });

  test('read-scope token (cli createDeviceToken) can export but not capture', async () => {
    readToken = A.createDeviceToken(env.db, 'claude', 'read').token;
    const items = env.db.prepare('SELECT id FROM items WHERE saved = 1').all().map((x) => x.id);
    const mk = await owner.req('POST', '/api/bundles', { body: { title: 'Agents', item_ids: items } });
    assert.equal(mk.status, 201, mk.text);
    const cli = env.browser();
    const ex = await cli.req('GET', `/api/bundles/${mk.json.slug}/export?sources=1`, { bearer: readToken, origin: null });
    assert.equal(ex.status, 200);
    assert.match(ex.headers.get('content-type'), /^text\/plain/);
    assert.match(ex.text, /^# Agents/);
    assert.equal((await cli.req('GET', '/api/bundles', { bearer: readToken, origin: null })).status, 200);
    const cap = await cli.req('POST', '/api/captures', { body: { input: 'x', client_id: 'read-tok-01' }, bearer: readToken, origin: null });
    assert.equal(cap.status, 403);
    assert.equal((await cli.req('GET', '/api/inbox', { bearer: readToken, origin: null })).status, 403);
    assert.equal((await cli.req('GET', '/api/captures', { bearer: readToken, origin: null })).status, 403);
    assert.equal((await cli.req('DELETE', `/api/bundles/${mk.json.slug}`, { bearer: readToken, origin: null })).status, 403);
  });

  test('revoked device -> 401', async () => {
    const del = await owner.req('DELETE', `/api/devices/${captureDeviceId}`);
    assert.equal(del.status, 200);
    const phone = env.browser();
    const r = await phone.req('POST', '/api/captures', { body: { input: 'x', client_id: 'after-revoke-1' }, bearer: captureToken, origin: null });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'bad_token');
    assert.equal((await phone.req('GET', '/api/captures', { bearer: captureToken, origin: null })).status, 401);
    assert.equal((await phone.req('GET', '/api/inbox', { bearer: 'tv_garbagegarbagegarbagegarbage', origin: null })).status, 401);
    assert.ok(env.db.prepare("SELECT 1 FROM audit_log WHERE event = 'device_removed'").get());
    const list = await owner.req('GET', '/api/devices');
    assert.ok(list.json.devices.find((d) => d.id === captureDeviceId).revoked_at);
  });

  // ---- inbox, render, bundles ----
  let seed;

  test('tweet ids in JSON are strings', async () => {
    seed = seedConversation(env.db);
    const r = await owner.req('GET', '/api/inbox');
    assert.equal(r.status, 200);
    // (the article itself was merged in an earlier test, so it has left the Inbox list)
    assert.ok(r.text.includes('"tweet_id":"1900000000000000001"'), 'root id quoted');
    const merged = await owner.req('GET', '/api/bundles/agents');
    assert.ok(merged.text.includes(`"tweet_id":"${ARTICLE_ID}"`), 'article id quoted');
    assert.ok(r.text.includes('"tweet_id":"1900000000000000004"'));
    assert.ok(!/"tweet_id":\d/.test(r.text));
    assert.ok(!/"parent_tweet_id":\d/.test(r.text));
    const g = r.json.groups.find((x) => x.key === '1900000000000000001');
    assert.ok(g);
    assert.equal(g.root.id, seed.root);
    assert.deepEqual(g.thread.map((t) => t.id), [seed.self]);
    assert.deepEqual(g.replies.map((t) => [t.id, t.depth]), [[seed.r1, 1], [seed.r2, 2]]);
    for (const grp of r.json.groups) for (const it of [grp.root, ...grp.thread, ...grp.replies].filter(Boolean)) {
      if (it.tweet_id !== null) assert.equal(typeof it.tweet_id, 'string');
    }
    const one = await owner.req('GET', `/api/items/${seed.r2}`);
    assert.equal(one.json.item.parent_tweet_id, '1900000000000000003');
  });

  test('/api/render returns normalised order', async () => {
    const r = await owner.req('POST', '/api/render', { body: { title: 'Merge', item_ids: [seed.note, seed.r2, seed.r1, seed.self, seed.root, seed.r2, 99999] } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.order, [seed.note, seed.root, seed.self, seed.r2, seed.r1]);
    assert.match(r.json.text, /^# Merge\n\n## Note 1\nA loose note\n\n## Post by @alice\nRoot post\n\n### Thread, part 2\nPart two\n\n### Reply 1 \(replying to Reply 2\)\nReply to bob\n\n### Reply 2\nReply from bob/);
    assert.ok(!r.json.text.includes('## Sources'));
    assert.ok(r.json.text_sources.startsWith(r.json.text));
    assert.match(r.json.text_sources, /\n---\n## Sources\n/);
    // reply-to-reply label when the parent comes first
    const r2 = await owner.req('POST', '/api/render', { body: { item_ids: [seed.root, seed.r1, seed.r2] } });
    assert.match(r2.json.text, /### Reply 2 \(replying to Reply 1\)\nReply to bob/);
  });

  test('bundles: POST/GET/PUT/DELETE, slug collision -2, export sources=0 vs 1', async () => {
    const a = await owner.req('POST', '/api/bundles', { body: { title: 'Agent notes', item_ids: [seed.r1, seed.root] } });
    assert.equal(a.status, 201);
    assert.equal(a.json.slug, 'agent-notes');
    const b = await owner.req('POST', '/api/bundles', { body: { title: 'Agent notes', item_ids: [seed.root] } });
    assert.equal(b.json.slug, 'agent-notes-2');
    const c = await owner.req('POST', '/api/bundles', { body: { title: 'Agent notes', item_ids: [seed.root] } });
    assert.equal(c.json.slug, 'agent-notes-3');
    const empty = await owner.req('POST', '/api/bundles', { body: { title: 'Nothing', item_ids: [424242] } });
    assert.equal(empty.status, 400);

    const g = await owner.req('GET', '/api/bundles/agent-notes');
    assert.equal(g.status, 200);
    assert.deepEqual(g.json.items.map((x) => x.id), [seed.root, seed.r1]);
    assert.equal(g.json.bundle.version, 1);
    assert.equal(typeof g.json.items[0].tweet_id, 'string');

    const list = await owner.req('GET', '/api/bundles');
    assert.ok(list.json.bundles.find((x) => x.slug === 'agent-notes' && x.items === 2));

    const p = await owner.req('PUT', '/api/bundles/agent-notes', { body: { title: 'Agent notes v2', item_ids: [seed.r2, seed.r1, seed.root] } });
    assert.equal(p.status, 200);
    const g2 = await owner.req('GET', '/api/bundles/agent-notes');
    assert.equal(g2.json.bundle.title, 'Agent notes v2');
    assert.equal(g2.json.bundle.version, 2);
    assert.deepEqual(g2.json.items.map((x) => x.id), [seed.root, seed.r2, seed.r1]);
    const pBad = await owner.req('PUT', '/api/bundles/agent-notes', { body: { item_ids: [] } });
    assert.equal(pBad.status, 400);
    assert.equal((await owner.req('GET', '/api/bundles/agent-notes')).json.items.length, 3, 'failed PUT changed nothing');

    const e0 = await owner.req('GET', '/api/bundles/agent-notes/export?sources=0');
    const e1 = await owner.req('GET', '/api/bundles/agent-notes/export?sources=1');
    assert.equal(e0.status, 200);
    assert.ok(e0.text.startsWith('# Agent notes v2\n\n## Post by @alice'));
    assert.ok(!e0.text.includes('## Sources'));
    assert.ok(e1.text.startsWith(e0.text));
    assert.match(e1.text, /\n---\n## Sources\n\[Post\] @alice/);
    const eDefault = await owner.req('GET', '/api/bundles/agent-notes/export');
    assert.equal(eDefault.text, e1.text);

    const d = await owner.req('DELETE', '/api/bundles/agent-notes-3');
    assert.equal(d.status, 200);
    assert.equal((await owner.req('GET', '/api/bundles/agent-notes-3')).status, 404);
    assert.equal((await owner.req('GET', '/api/bundles/agent-notes-3/export')).status, 404);
    assert.ok(env.db.prepare("SELECT 1 FROM audit_log WHERE event = 'bundle_deleted'").get());
    // the slug can be taken again
    const again = await owner.req('POST', '/api/bundles', { body: { title: 'Agent notes', item_ids: [seed.root] } });
    assert.equal(again.json.slug, 'agent-notes-3');
  });

  test('PATCH item state and bulk; trashed-but-bundled item still exported', async () => {
    const r = await owner.req('PATCH', `/api/items/${seed.r1}`, { body: { state: 'trashed' } });
    assert.equal(r.status, 200);
    assert.equal(env.db.prepare('SELECT state FROM items WHERE id = ?').get(seed.r1).state, 'trashed');
    const inbox = await owner.req('GET', '/api/inbox');
    const g = inbox.json.groups.find((x) => x.key === '1900000000000000001');
    assert.ok(!g.replies.some((x) => x.id === seed.r1) || !g.replies.find((x) => x.id === seed.r1).saved
      || g.replies.find((x) => x.id === seed.r1).state !== 'inbox');
    // r1 is inside a merge, so it shows only there; an unmerged item shows in the trashed list
    await owner.req('PATCH', `/api/items/${seed.note}`, { body: { state: 'trashed' } });
    const trash = await owner.req('GET', '/api/inbox?state=trashed');
    assert.ok(trash.json.groups.some((x) => x.root && x.root.id === seed.note && x.root.state === 'trashed'));
    assert.ok(!trash.json.groups.some((x) => [x.root, ...x.replies].some((y) => y && y.id === seed.r1 && !y.context)));
    await owner.req('PATCH', `/api/items/${seed.note}`, { body: { state: 'inbox' } });

    const ex = await owner.req('GET', '/api/bundles/agent-notes/export?sources=0');
    assert.ok(ex.text.includes('Reply from bob'), 'trashed item still in the bundle export');

    assert.equal((await owner.req('PATCH', `/api/items/${seed.r1}`, { body: { state: 'bogus' } })).status, 400);
    assert.equal((await owner.req('PATCH', '/api/items/987654', { body: { state: 'archived' } })).status, 404);

    const bulk = await owner.req('POST', '/api/items/bulk', { body: { ids: [seed.r1, seed.r2, seed.note, 987654], state: 'archived' } });
    assert.equal(bulk.status, 200);
    assert.equal(bulk.json.changed, 3);
    for (const id of [seed.r1, seed.r2, seed.note]) {
      const row = env.db.prepare('SELECT state, trashed_at FROM items WHERE id = ?').get(id);
      assert.equal(row.state, 'archived');
      assert.equal(row.trashed_at, null);
    }
    const arch = await owner.req('GET', '/api/inbox?state=archived');
    // r1 and r2 are inside a merge, so only the note is listed
    assert.ok(arch.json.groups.some((g) => g.root && g.root.id === seed.note));
    assert.equal((await owner.req('POST', '/api/items/bulk', { body: { ids: 'nope', state: 'inbox' } })).status, 400);
    const back = await owner.req('POST', '/api/items/bulk', { body: { ids: [seed.r1, seed.r2, seed.note], state: 'inbox' } });
    assert.equal(back.json.changed, 3);
  });

  test('context rows (saved = 0) cannot have their state changed', async () => {
    const id = insertItem(env.db, { kind: 'tweet', tweet_id: '1900000000000000099', fetch_status: 'ok', saved: 0, state: 'inbox' });
    assert.equal((await owner.req('PATCH', `/api/items/${id}`, { body: { state: 'trashed' } })).status, 404);
  });

  test('web capture through the session (202, then 200)', async () => {
    const r = await owner.req('POST', '/api/captures', { body: { input: 'Plain highlighted text from the web', client_id: 'web-0000001' } });
    assert.equal(r.status, 202);
    const r2 = await owner.req('POST', '/api/captures', { body: { input: 'Plain highlighted text from the web', client_id: 'web-0000001' } });
    assert.equal(r2.status, 200);
    assert.equal(env.db.prepare('SELECT source_app FROM captures WHERE client_id = ?').get('web-0000001').source_app, 'web');
    const bad = await owner.req('POST', '/api/captures', { body: { input: 'x', client_id: 'short' } });
    assert.equal(bad.status, 400);
    const none = await owner.req('POST', '/api/captures', { body: { input: '   ', client_id: 'web-0000002' } });
    assert.equal(none.status, 400);
  });

  test('/api/audit lists events', async () => {
    const r = await owner.req('GET', '/api/audit?days=30');
    assert.equal(r.status, 200);
    const evs = new Set(r.json.events.map((e) => e.event));
    for (const e of ['login_ok', 'password_ok', 'code_failed', 'mfa_enabled', 'device_paired', 'device_removed', 'bundle_deleted', 'recovery_code_used']) {
      assert.ok(evs.has(e), e);
    }
    // newest first
    const ats = r.json.events.map((e) => e.at);
    assert.deepEqual(ats, [...ats].sort((x, y) => y - x));
    assert.ok(r.json.events.every((e) => !String(e.detail || '').includes('tv_')));
  });

  test('DELETE /api/sessions/<id> signs another browser out', async () => {
    const other = await fullLogin(env, secret);
    assert.equal((await other.req('GET', '/api/inbox')).status, 200);
    const list = await owner.req('GET', '/api/devices');
    const mine = list.json.sessions.filter((s) => s.current);
    assert.equal(mine.length, 1);
    const otherHash = A.sha256(other.jar.get('tv_sid')).slice(0, 16);
    const target = list.json.sessions.find((s) => s.id === otherHash);
    assert.ok(target, 'the other browser is listed');
    assert.equal(target.current, false);
    const d = await owner.req('DELETE', `/api/sessions/${target.id}`);
    assert.equal(d.status, 200);
    assert.equal(d.json.removed, 1);
    assert.equal((await other.req('GET', '/api/inbox')).status, 401);
    assert.equal((await other.req('GET', '/api/me')).json.signed_in, false);
    assert.equal((await owner.req('GET', '/api/inbox')).status, 200, 'owner still signed in');
    assert.equal((await owner.req('DELETE', '/api/sessions/zzzz')).status, 400);
    assert.ok(env.db.prepare("SELECT 1 FROM audit_log WHERE event = 'session_ended'").get());
  });

  test('lost phone: after a recovery-code sign-in you can set up the authenticator again', async () => {
    const b = env.browser();
    await b.req('POST', '/api/login', { body: { password: PW } });
    const r = await b.req('POST', '/api/login/mfa', { body: { recovery_code: recovery[2] } });
    assert.equal(r.status, 200);
    // the phone is gone: no authenticator code available, only the session made with a recovery code
    const s = await b.req('POST', '/api/mfa/setup', { body: {} });
    assert.equal(s.status, 200, s.text);
  });

  test('malformed item_ids are a 400, not a 500', async () => {
    const r = await owner.req('POST', '/api/render', { body: { item_ids: 5 } });
    assert.equal(r.status, 400);
    const b = await owner.req('POST', '/api/bundles', { body: { title: 'x', item_ids: 7 } });
    assert.equal(b.status, 400);
    const s = await owner.req('POST', '/api/bundles', { body: { title: 'chars', item_ids: String(seed.root) } });
    assert.equal(s.status, 400);
  });

  test('a bad percent-escape in a path is a 400/404, not a 500', async () => {
    const r = await owner.req('GET', '/api/bundles/%E0');
    assert.ok(r.status === 400 || r.status === 404, String(r.status));
  });

  test('wrong codes count toward the lockout; 5 wrong codes end the password-only session', async () => {
    const b = env.browser();
    await b.req('POST', '/api/login', { body: { password: PW } });
    const wrong = totp(secret, now()) === '123456' ? '654321' : '123456';
    for (let i = 0; i < 10; i++) {
      const r = await b.req('POST', '/api/login/mfa', { body: { code: wrong } });
      assert.equal(r.status, 401, `attempt ${i + 1}`);
      if ((i + 1) % 5 === 0) {
        assert.equal(JSON.parse(r.text).error, 'signed_out', 'the 5th wrong code ends the pending session');
        const again = await b.req('POST', '/api/login/mfa', { body: { code: wrong } });
        assert.ok(again.status === 400 || again.status === 429, `after 5 wrong codes the session is gone (${again.status})`);
        if (i < 9) await b.req('POST', '/api/login', { body: { password: PW } });
      }
    }
    advance(30);
    const r = await b.req('POST', '/api/login', { body: { password: PW } });
    assert.equal(r.status, 429);
  });
});
