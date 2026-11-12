// Hardening from the launch-checklist security review: lockout DoS, parallel guessing, session revocation,
// phone rate limits, error exposure, browser 404s and the translation endpoint. In-memory DB, fake clients only.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { openDb, now } from '../src/db.js';
import * as A from '../src/auth.js';
import { totp, base32Decode } from '../src/totp.js';

const PW = 'hardening test password 456';
const realNow = Date.now;
let skewMs = 0;
Date.now = () => realNow() + skewMs;
const advance = (sec) => { skewMs += sec * 1000; };

function fakeAnthropic(reply = 'English text') {
  const calls = [];
  return { calls, messages: { async create(p) { calls.push(p); return { stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] }; } } };
}

async function boot({ db, passwordHash, anthropicClient, trustProxy = true } = {}) {
  const app = createApp({
    db: db || openDb(':memory:'), passwordHash: passwordHash || await A.makePasswordHash(PW, 100000), secret: 'h'.repeat(40),
    origins: 'http://vault.test', cookieSecure: false, trustProxy, startWorker: false, anthropicClient,
    fetchFn: async () => new Response('{}', { status: 404 }), paceMs: 0, log: () => {},
  });
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  function browser(ip = '203.0.113.7') {
    const jar = new Map();
    return {
      jar,
      async req(method, path, { body, origin = 'http://vault.test', bearer, accept, cookie } = {}) {
        const headers = { 'X-Forwarded-For': ip };
        if (origin) headers.Origin = origin;
        if (bearer) headers.Authorization = `Bearer ${bearer}`;
        if (accept) headers.Accept = accept;
        const jarStr = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
        if (cookie !== undefined) headers.Cookie = cookie; else if (jarStr) headers.Cookie = jarStr;
        let payload;
        if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
        const res = await fetch(base + path, { method, headers, body: payload, redirect: 'manual' });
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
      },
    };
  }
  return { app, db: app.db, browser, base };
}

async function enableMfa(b, { trust = false } = {}) {
  assert.equal((await b.req('POST', '/api/login', { body: { password: PW } })).status, 200);
  const s = await b.req('POST', '/api/mfa/setup', { body: {} });
  const secret = base32Decode(s.json.secret);
  advance(30);
  const c = await b.req('POST', '/api/mfa/confirm', { body: { code: totp(secret, now()), trust } });
  assert.equal(c.status, 200, c.text);
  return secret;
}
async function codeLogin(b, secret, { trust = false } = {}) {
  const lg = await b.req('POST', '/api/login', { body: { password: PW } });
  if (lg.json && lg.json.ok) return;
  advance(30);
  const r = await b.req('POST', '/api/login/mfa', { body: { code: totp(secret, now()), trust } });
  assert.equal(r.status, 200, r.text);
}

describe('lockouts can not be turned against the owner', () => {
  let env; let secret; let owner;
  before(async () => { env = await boot(); owner = env.browser('198.51.100.1'); secret = await enableMfa(owner); });
  after(async () => { await env.app.close(); });
  beforeEach(() => A._resetLockouts());

  test('failed pairing attempts never lock the sign-in', async () => {
    for (let i = 0; i < 45; i++) await env.browser(`192.0.2.${i}`).req('POST', '/api/pair', { body: { code: '000000' }, origin: null });
    assert.equal((await env.browser('192.0.2.200').req('POST', '/api/pair', { body: { code: '000000' }, origin: null })).status, 429, 'pairing is locked');
    const b = env.browser('198.51.100.9');
    assert.equal((await b.req('POST', '/api/login', { body: { password: PW } })).status, 200, 'sign-in still works');
  });

  test('a vault-wide lock from strangers does not block a trusted browser', async () => {
    const mine = env.browser('198.51.100.2');
    await codeLogin(mine, secret, { trust: true });
    assert.ok(mine.jar.get('tv_trust'));
    mine.jar.delete('tv_sid');
    for (let i = 0; i < 45; i++) await env.browser(`192.0.2.${i}`).req('POST', '/api/login', { body: { password: 'nope' } });
    assert.equal((await env.browser('192.0.2.201').req('POST', '/api/login', { body: { password: PW } })).status, 429, 'untrusted browsers are locked');
    const r = await mine.req('POST', '/api/login', { body: { password: PW } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
  });

  test('parallel wrong passwords are counted before the slow hash; a lockout writes one audit row', async () => {
    const b = env.browser('192.0.2.77');
    const before = env.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'login_locked'").get().n;
    await Promise.all(Array.from({ length: 15 }, () => b.req('POST', '/api/login', { body: { password: 'guess' } })));
    for (let i = 0; i < 5; i++) assert.equal((await b.req('POST', '/api/login', { body: { password: PW } })).status, 429);
    const after2 = env.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'login_locked'").get().n;
    assert.ok(after2 - before <= 1, `one lock notice, got ${after2 - before}`);
  });
});

describe('sessions end when the keys change', () => {
  test('setting up a new authenticator signs out every other session and trusted browser', async () => {
    const env = await boot();
    try {
      const a = env.browser('198.51.100.3');
      const secret = await enableMfa(a);
      const other = env.browser('198.51.100.4');
      await codeLogin(other, secret, { trust: true });
      assert.equal((await other.req('GET', '/api/inbox')).status, 200);
      advance(30);
      const s = await a.req('POST', '/api/mfa/setup', { body: { code: totp(secret, now()) } });
      assert.equal(s.status, 200, s.text);
      const s2 = base32Decode(s.json.secret);
      advance(30);
      assert.equal((await a.req('POST', '/api/mfa/confirm', { body: { code: totp(s2, now()) } })).status, 200);
      assert.equal((await other.req('GET', '/api/inbox')).status, 401, 'the other session ended');
      assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM trusted_browsers').get().n, 0);
      assert.equal((await a.req('GET', '/api/inbox')).status, 200, 'the session that made the change stays');
    } finally { await env.app.close(); }
  });

  test('a changed password signs everyone out when the server starts', async () => {
    const db = openDb(':memory:');
    const env = await boot({ db });
    const b = env.browser('198.51.100.5');
    assert.equal((await b.req('POST', '/api/login', { body: { password: PW } })).status, 200);
    await env.app.close();
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n > 0);
    const env2 = await boot({ db, passwordHash: await A.makePasswordHash('a brand new password', 100000) });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'password_changed'").get().n, 1);
    } finally { await env2.app.close(); }
  });

  test('wrong codes typed while signed in end the session after five', async () => {
    const env = await boot();
    try {
      const a = env.browser('198.51.100.6');
      await enableMfa(a);
      for (let i = 0; i < 4; i++) assert.equal((await a.req('POST', '/api/mfa/recovery', { body: { code: '000000' } })).status, 401);
      const last = await a.req('POST', '/api/mfa/recovery', { body: { code: '000000' } });
      assert.equal(last.json.error, 'signed_out');
      assert.equal((await a.req('GET', '/api/inbox')).status, 401);
    } finally { await env.app.close(); }
  });
});

describe('phones, errors, pages and translation', () => {
  let env; let secret; let owner; let fake; let token;
  before(async () => {
    fake = fakeAnthropic('Why do pictures made with ChatGPT always feel cheap?');
    env = await boot({ anthropicClient: fake });
    owner = env.browser('198.51.100.8');
    secret = await enableMfa(owner);
    const pc = await owner.req('POST', '/api/devices', { body: { scopes: 'capture' } });
    token = (await env.browser('198.51.100.8').req('POST', '/api/pair', { body: { code: pc.json.code, name: 'Test phone' }, origin: null })).json.token;
    assert.ok(token);
  });
  after(async () => { await env.app.close(); });

  test('a phone is rate limited and size capped', async () => {
    const phone = env.browser('198.51.100.20');
    assert.equal((await phone.req('POST', '/api/captures', { body: { input: 'x'.repeat(50_001), client_id: 'big-1-aaaaaaaa' }, bearer: token, origin: null })).status, 413);
    let last;
    for (let i = 0; i < 61; i++) last = await phone.req('POST', '/api/captures', { body: { input: `note number ${i}`, client_id: `rate-${i}-aaaaaaaa` }, bearer: token, origin: null });
    assert.equal(last.status, 429);
  });

  test('a browser opening an unknown page is sent to the app; the API still answers JSON', async () => {
    const r = await owner.req('GET', '/some/old/bookmark', { accept: 'text/html' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/');
    const api = await owner.req('GET', '/api/nope');
    assert.equal(api.status, 404);
    assert.equal(api.json.message, 'Not found');
  });

  test('translation: owner only, Haiku, cached, and shown with the item afterwards', async () => {
    const me = await owner.req('GET', '/api/me');
    assert.equal(me.json.translate, true);
    const c = await owner.req('POST', '/api/captures', { body: { input: '你用 ChatGPT 做出来的图片，为什么总有一股廉价的 AI 味?', client_id: 'zh-1-aaaaaaaa' } });
    const id = c.json.item_id;
    assert.ok(id, c.text);
    // a phone's capture-only token can't use it, and neither can a stranger
    assert.equal((await env.browser('198.51.100.21').req('POST', `/api/items/${id}/translate`, { body: {}, bearer: token, origin: null })).status, 403);
    assert.equal((await env.browser('198.51.100.22').req('POST', `/api/items/${id}/translate`, { body: {} })).status, 401);
    // nor from another site (CSRF)
    assert.equal((await owner.req('POST', `/api/items/${id}/translate`, { body: {}, origin: 'https://evil.example' })).status, 403);
    const t1 = await owner.req('POST', `/api/items/${id}/translate`, { body: {} });
    assert.equal(t1.status, 200, t1.text);
    assert.equal(t1.json.lang, 'Chinese');
    assert.equal(t1.json.cached, false);
    const t2 = await owner.req('POST', `/api/items/${id}/translate`, { body: {} });
    assert.equal(t2.json.cached, true);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].model, 'claude-haiku-5-5');
    const inbox = await owner.req('GET', '/api/inbox');
    const item = inbox.json.groups.flatMap((g) => [g.root, ...g.thread, ...g.replies]).find((x) => x && x.id === id);
    assert.equal(item.lang, 'Chinese');
    assert.equal(item.translation.text, 'Why do pictures made with ChatGPT always feel cheap?');
    // copy in English
    const r = await owner.req('POST', '/api/render', { body: { item_ids: [id], english: true } });
    assert.match(r.json.text, /Why do pictures made with ChatGPT/);
    assert.match(r.json.text_sources, /English translation from Chinese/);
  });

  test('the API key never reaches the page', async () => {
    for (const p of ['/', '/app.js', '/api/me', '/api/inbox']) {
      const r = await owner.req('GET', p);
      assert.doesNotMatch(r.text, /sk-ant|ANTHROPIC_API_KEY/);
    }
  });
});
