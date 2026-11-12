// OAuth 2.1 for claude.ai custom connectors (oauth.js): metadata, dynamic registration, the consent
// page and its CSRF token, code exchange with PKCE, rotating refresh tokens, revocation, /mcp with an
// OAuth token, the Connected apps routes and housekeeping. A real createApp over HTTP.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { createApp } from '../src/server.js';
import * as A from '../src/auth.js';
import { housekeeping } from '../src/audit.js';
import { totp, base32Decode } from '../src/totp.js';
import { now, openDb } from '../src/db.js';
import { redirectKind, redirectMatches, CLAUDE_CALLBACK } from '../src/oauth.js';

const PW = 'correct horse battery staple';
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

let app;
let db;
let base;
let origin;
let mfaSecret;
let ipN = 0;
// every test speaks from its own address (trustProxy is on), so the per-IP limits only bite where wanted
const nextIp = () => { ipN++; return `10.9.${Math.floor(ipN / 250)}.${(ipN % 250) + 1}`; };

async function raw(method, path, { headers = {}, body, ip = nextIp() } = {}) {
  const res = await fetch(base + path, { method, headers: { 'X-Forwarded-For': ip, ...headers }, body, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}

const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined)).toString();
const FORM_CT = { 'Content-Type': 'application/x-www-form-urlencoded' };

function register(body, opts = {}) {
  return raw('POST', '/oauth/register', { headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), ...opts });
}
function tokenReq(fields, opts = {}) {
  return raw('POST', '/oauth/token', { headers: { ...FORM_CT, ...(opts.headers || {}) }, body: opts.rawBody ?? form(fields), ip: opts.ip });
}

// a browser with a cookie jar (the owner, or a second sign-in)
function browser() {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  async function req(method, path, { json: body, formBody, headers = {}, origin: o = origin } = {}) {
    const h = { 'X-Forwarded-For': '10.1.1.1', ...headers };
    if (o) h.Origin = o;
    if (jar.size) h.Cookie = cookieHeader();
    let payload;
    if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    if (formBody !== undefined) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = typeof formBody === 'string' ? formBody : form(formBody); }
    const res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i).trim();
      const v = decodeURIComponent(kv.slice(i + 1).trim());
      if (!v || /Max-Age=0/.test(sc)) jar.delete(k); else jar.set(k, v);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, headers: res.headers, text, json };
  }
  return { jar, req };
}

let owner;

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function newClient(redirect_uris = [CLAUDE_CALLBACK], extra = {}) {
  const r = await register({ client_name: 'Claude', redirect_uris, ...extra });
  assert.equal(r.status, 201, r.text);
  return r.json;
}

function authorizePath(o) {
  return `/oauth/authorize?${form({ response_type: 'code', code_challenge_method: 'S256', scope: 'vault.read offline_access', state: 'st-123', ...o })}`;
}

const unescapeHtml = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const hiddenFields = (html) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)">/g)].map((m) => [m[1], unescapeHtml(m[2])]));

// GET the consent page as the owner; returns its fields
async function consent(o, who = owner) {
  const r = await who.req('GET', authorizePath(o), { origin: null });
  assert.equal(r.status, 200, r.text);
  return { page: r, fields: hiddenFields(r.text) };
}
function decide(fields, decision, { who = owner, headers = {}, origin: o = origin } = {}) {
  return who.req('POST', '/oauth/authorize/decision', { formBody: { ...fields, decision }, headers, origin: o });
}
const qs = (loc) => new URL(loc).searchParams;

// the whole browser part: register (unless given), consent, Allow; returns the code and everything needed to redeem it
async function getCode({ client, redirect_uri = CLAUDE_CALLBACK, registered = [redirect_uri], resource } = {}) {
  const c = client || await newClient(registered);
  const p = pkce();
  const { fields } = await consent({ client_id: c.client_id, redirect_uri, code_challenge: p.challenge, ...(resource ? { resource } : {}) });
  const d = await decide(fields, 'allow');
  assert.equal(d.status, 302, d.text);
  const q = qs(d.headers.get('location'));
  assert.ok(q.get('code'));
  return { client: c, code: q.get('code'), verifier: p.verifier, redirect_uri, location: d.headers.get('location') };
}
async function getTokens(o = {}) {
  const g = await getCode(o);
  const r = await tokenReq({ grant_type: 'authorization_code', code: g.code, redirect_uri: g.redirect_uri, client_id: g.client.client_id, code_verifier: g.verifier });
  assert.equal(r.status, 200, r.text);
  return { ...g, tokens: r.json };
}

async function mcp(token, method = 'tools/list') {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: JSON.parse(text) };
}

async function signIn(b) {
  const lg = await b.req('POST', '/api/login', { json: { password: PW } });
  assert.equal(lg.status, 200, lg.text);
  if (lg.json.mfa_required) {
    advance(30);
    const m = await b.req('POST', '/api/login/mfa', { json: { code: totp(mfaSecret, now()) } });
    assert.equal(m.status, 200, m.text);
  }
}

before(async () => {
  const port = await freePort();
  origin = `http://localhost:${port}`;
  app = createApp({
    dbPath: ':memory:', passwordHash: await A.makePasswordHash(PW, 100000), secret: 'y'.repeat(40),
    origins: `${origin},http://127.0.0.1:${port}`, cookieSecure: false, trustProxy: true, startWorker: false, paceMs: 0,
    fetchFn: async () => new Response('', { status: 404 }), log: () => {},
  });
  await app.listen(port, '127.0.0.1');
  db = app.db;
  base = `http://127.0.0.1:${port}`;

  owner = browser();
  const lg = await owner.req('POST', '/api/login', { json: { password: PW } });
  assert.equal(lg.status, 200, lg.text);
  const s = await owner.req('POST', '/api/mfa/setup', { json: {} });
  mfaSecret = base32Decode(s.json.secret);
  advance(30);
  const c = await owner.req('POST', '/api/mfa/confirm', { json: { code: totp(mfaSecret, now()) } });
  assert.equal(c.status, 200, c.text);
});

after(async () => { await app.close(); Date.now = realNow; });

describe('metadata', () => {
  test('protected resource metadata at both addresses', async () => {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const r = await raw('GET', p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /application\/json/);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=3600');
      assert.deepEqual(r.json, {
        resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['vault.read'],
        bearer_methods_supported: ['header'], resource_name: 'Tweet Vault',
      });
    }
  });

  test('authorization server metadata (RFC 8414)', async () => {
    const r = await raw('GET', '/.well-known/oauth-authorization-server');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=3600');
    const m = r.json;
    assert.equal(m.issuer, origin);
    assert.equal(m.authorization_endpoint, `${origin}/oauth/authorize`);
    assert.equal(m.token_endpoint, `${origin}/oauth/token`);
    assert.equal(m.registration_endpoint, `${origin}/oauth/register`);
    assert.equal(m.revocation_endpoint, `${origin}/oauth/revoke`);
    assert.deepEqual(m.response_types_supported, ['code']);
    assert.deepEqual(m.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.deepEqual(m.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(m.token_endpoint_auth_methods_supported, ['none']);
    assert.deepEqual(m.scopes_supported, ['vault.read', 'offline_access']);
    assert.equal(m.authorization_response_iss_parameter_supported, true);
  });

  test('/mcp without a token: 401 pointing at the resource metadata', async () => {
    const r = await mcp(null);
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), new RegExp(`^Bearer .*resource_metadata="${origin}/\\.well-known/oauth-protected-resource"`));
    assert.doesNotMatch(r.headers.get('www-authenticate'), /invalid_token/);
  });

  test('redirect URI helpers', () => {
    assert.deepEqual(redirectKind('http://localhost:33418/callback'), { kind: 'loopback', host: 'localhost', port: 33418 });
    assert.deepEqual(redirectKind('http://127.0.0.1/callback'), { kind: 'loopback', host: '127.0.0.1', port: null });
    assert.ok(redirectMatches(['http://localhost:1/callback'], 'http://localhost:9999/callback'));
    assert.ok(!redirectMatches(['http://localhost:1/callback'], 'http://127.0.0.1:9999/callback'));
    assert.ok(!redirectMatches([CLAUDE_CALLBACK], 'http://localhost:9999/callback'));
    assert.ok(!redirectMatches(['http://localhost:1/callback'], CLAUDE_CALLBACK));
  });
});

describe('registration', () => {
  test('a claude.ai client registers', async () => {
    const r = await register({ client_name: '  Claude  ', redirect_uris: [CLAUDE_CALLBACK], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'vault.read offline_access' });
    assert.equal(r.status, 201, r.text);
    assert.match(r.json.client_id, /^tvc_[A-Za-z0-9_-]{43}$/);
    assert.equal(typeof r.json.client_id_issued_at, 'number');
    assert.equal(r.json.client_name, 'Claude');
    assert.deepEqual(r.json.redirect_uris, [CLAUDE_CALLBACK]);
    assert.deepEqual(r.json.grant_types, ['authorization_code', 'refresh_token']);
    assert.deepEqual(r.json.response_types, ['code']);
    assert.equal(r.json.token_endpoint_auth_method, 'none');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  test('loopback clients (Claude Code) register, with or without a port', async () => {
    for (const u of ['http://localhost:33418/callback', 'http://127.0.0.1:5000/callback', 'http://localhost/callback']) {
      const r = await register({ redirect_uris: [u] });
      assert.equal(r.status, 201, u);
      assert.ok(!('client_name' in r.json));
    }
  });

  test('every other redirect URI is refused', async () => {
    const bad = [
      `${CLAUDE_CALLBACK}/`, `${CLAUDE_CALLBACK}?x=1`, `${CLAUDE_CALLBACK}#f`, 'http://claude.ai/api/mcp/auth_callback',
      'https://claude.ai.evil.com/api/mcp/auth_callback', 'https://evil.com/callback', 'https://CLAUDE.ai/api/mcp/auth_callback',
      'http://localhost:8080/other', 'http://localhost:8080/callback/', 'http://localhost:8080/callback?x=1', 'http://localhost:8080/callback#x',
      'http://user@localhost/callback', 'http://user:pw@127.0.0.1:80/callback', 'http://localhost:0/callback', 'http://localhost:65536/callback',
      'http://localhost:08080/callback', 'http://[::1]:8080/callback', 'http://localhost.evil.com/callback', 'https://localhost/callback',
      'HTTP://localhost/callback', 'http://127.0.0.2/callback', 'http://LOCALHOST/callback', 'javascript:alert(1)', '',
    ];
    for (const u of bad) {
      const r = await register({ redirect_uris: [u] });
      assert.equal(r.status, 400, u);
      assert.equal(r.json.error, 'invalid_redirect_uri', u);
      assert.ok(r.json.error_description);
    }
    for (const uris of [undefined, [], 'https://claude.ai/api/mcp/auth_callback', [42], [CLAUDE_CALLBACK, 'https://evil.com/cb'], Array(11).fill(CLAUDE_CALLBACK)]) {
      const r = await register({ redirect_uris: uris });
      assert.equal(r.status, 400, JSON.stringify(uris));
      assert.equal(r.json.error, 'invalid_redirect_uri');
    }
  });

  test('only public clients and the two grant types', async () => {
    for (const extra of [
      { token_endpoint_auth_method: 'client_secret_basic' }, { token_endpoint_auth_method: 'client_secret_post' },
      { grant_types: ['client_credentials'] }, { grant_types: ['authorization_code', 'implicit'] }, { grant_types: ['refresh_token'] }, { grant_types: [] },
      { response_types: ['token'] }, { response_types: ['code', 'id_token'] }, { client_name: 42 },
    ]) {
      const r = await register({ redirect_uris: [CLAUDE_CALLBACK], ...extra });
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.equal(r.json.error, 'invalid_client_metadata');
    }
    const g = await register({ redirect_uris: [CLAUDE_CALLBACK], grant_types: ['authorization_code'] });
    assert.equal(g.status, 201);
    assert.deepEqual(g.json.grant_types, ['authorization_code']);
  });

  test('the name is cleaned and cut to 100 characters', async () => {
    const r = await register({ client_name: `  Cl‮aude\u0000 \n\t ${'x'.repeat(200)}`, redirect_uris: [CLAUDE_CALLBACK] });
    assert.equal(r.status, 201);
    assert.ok(r.json.client_name.startsWith('Claude x'));
    assert.equal(r.json.client_name.length, 100);
  });

  test('bad bodies: not JSON, wrong type, too large', async () => {
    assert.equal((await register('{not json')).status, 400);
    assert.equal((await register('[1,2]')).status, 400);
    const ct = await raw('POST', '/oauth/register', { headers: FORM_CT, body: 'redirect_uris=x' });
    assert.equal(ct.status, 400);
    assert.equal(ct.json.error, 'invalid_client_metadata');
    const big = await register({ redirect_uris: [CLAUDE_CALLBACK], client_name: 'x'.repeat(20_000) });
    assert.equal(big.status, 413);
  });

  test('at most 20 registrations an hour from one address', async () => {
    const ip = nextIp();
    for (let i = 0; i < 20; i++) assert.equal((await register({ redirect_uris: [CLAUDE_CALLBACK] }, { ip })).status, 201, `#${i + 1}`);
    const r = await register({ redirect_uris: [CLAUDE_CALLBACK] }, { ip });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    assert.equal((await register({ redirect_uris: [CLAUDE_CALLBACK] })).status, 201, 'another address is fine');
  });

  test('at most 200 clients: the oldest never-used ones make room', async () => {
    const saved = db.prepare('SELECT * FROM oauth_clients').all();
    db.prepare('DELETE FROM oauth_clients WHERE client_id NOT IN (SELECT client_id FROM oauth_grants)').run();
    const have = db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get().n;
    const ins = db.prepare("INSERT INTO oauth_clients (client_id, name, redirect_uris, grant_types, created_at, last_used_at) VALUES (?, 'filler', '[]', '[]', ?, ?)");
    const t = now();
    ins.run('used-oldest', t - 9999, t - 10);   // used, no live connection: pruned only after the never-used ones
    for (let i = 0; i < 200 - have - 1; i++) ins.run(`filler-${String(i).padStart(3, '0')}`, t - 5000 + i, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get().n, 200);
    const r = await register({ redirect_uris: [CLAUDE_CALLBACK] });
    assert.equal(r.status, 201, r.text);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get().n, 200);
    assert.equal(db.prepare("SELECT 1 FROM oauth_clients WHERE client_id = 'filler-000'").get(), undefined, 'the oldest unused one went');
    assert.ok(db.prepare("SELECT 1 FROM oauth_clients WHERE client_id = 'filler-001'").get());
    assert.ok(db.prepare("SELECT 1 FROM oauth_clients WHERE client_id = 'used-oldest'").get());
    // all of them just registered: nothing may be pruned, so the registration is refused
    db.prepare('UPDATE oauth_clients SET created_at = ?').run(t);
    const full = await register({ redirect_uris: [CLAUDE_CALLBACK] });
    assert.equal(full.status, 503);
    assert.equal(full.json.error, 'temporarily_unavailable');
    assert.ok(Number(full.headers.get('retry-after')) > 0);
    // put things back
    db.prepare('DELETE FROM oauth_clients WHERE client_id NOT IN (SELECT client_id FROM oauth_grants)').run();
    const back = db.prepare('INSERT OR IGNORE INTO oauth_clients (client_id, name, redirect_uris, grant_types, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const c of saved) back.run(c.client_id, c.name, c.redirect_uris, c.grant_types, c.created_at, c.last_used_at);
  });
});

describe('authorize', () => {
  test('unknown client or a redirect URI that does not match: an error page, never a redirect', async () => {
    const c = await newClient([CLAUDE_CALLBACK]);
    const loop = await newClient(['http://localhost:1234/callback']);
    const { challenge } = pkce();
    const cases = [
      { client_id: 'tvc_nope', redirect_uri: CLAUDE_CALLBACK },
      { redirect_uri: CLAUDE_CALLBACK },
      { client_id: c.client_id },
      { client_id: c.client_id, redirect_uri: 'https://evil.com/callback' },
      { client_id: c.client_id, redirect_uri: 'http://localhost:1234/callback' },
      { client_id: loop.client_id, redirect_uri: 'http://127.0.0.1:1234/callback' },
      { client_id: loop.client_id, redirect_uri: 'http://localhost:1234/other' },
      { client_id: loop.client_id, redirect_uri: CLAUDE_CALLBACK },
    ];
    for (const o of cases) {
      const r = await owner.req('GET', authorizePath({ code_challenge: challenge, ...o }), { origin: null });
      assert.equal(r.status, 400, JSON.stringify(o));
      assert.equal(r.headers.get('location'), null);
      assert.match(r.headers.get('content-type'), /text\/html/);
      assert.match(r.text, /does not work/);
    }
    // repeated client_id or redirect_uri: also no redirect
    const dup = await owner.req('GET', `${authorizePath({ client_id: c.client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge })}&redirect_uri=${encodeURIComponent(CLAUDE_CALLBACK)}`, { origin: null });
    assert.equal(dup.status, 400);
    assert.equal(dup.headers.get('location'), null);
  });

  test('bad PKCE, scope, resource or response type: back to the client with an error, state and iss', async () => {
    const c = await newClient();
    const { challenge } = pkce();
    const ok = { client_id: c.client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge };
    const cases = [
      [{ code_challenge: undefined }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ code_challenge: `${'a'.repeat(42)}+` }, 'invalid_request'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge_method: undefined }, 'invalid_request'],
      [{ response_type: undefined }, 'invalid_request'],
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ scope: 'vault.read vault.write' }, 'invalid_scope'],
      [{ scope: 'admin' }, 'invalid_scope'],
      [{ resource: `${origin}/mcp/` }, 'invalid_target'],
      [{ resource: 'https://evil.com/mcp' }, 'invalid_target'],
    ];
    for (const [o, err] of cases) {
      const r = await owner.req('GET', authorizePath({ ...ok, ...o }), { origin: null });
      assert.equal(r.status, 302, JSON.stringify(o));
      const loc = r.headers.get('location');
      assert.ok(loc.startsWith(`${CLAUDE_CALLBACK}?`), loc);
      const q = qs(loc);
      assert.equal(q.get('error'), err, JSON.stringify(o));
      assert.equal(q.get('state'), 'st-123');
      assert.equal(q.get('iss'), origin);
      assert.equal(q.get('code'), null);
    }
  });

  test('not signed in: off to the sign-in page, which comes back here', async () => {
    const c = await newClient();
    const { challenge } = pkce();
    const p = authorizePath({ client_id: c.client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge });
    for (const who of [browser(), null]) {
      const r = who ? await who.req('GET', p, { origin: null }) : await raw('GET', p);
      assert.equal(r.status, 302);
      const loc = r.headers.get('location');
      assert.ok(loc.startsWith('/?next='), loc);
      assert.equal(new URL(loc, origin).searchParams.get('next'), p);
    }
    // a password-only session (two-step not done) is not enough either
    const half = browser();
    const lg = await half.req('POST', '/api/login', { json: { password: PW } });
    assert.equal(lg.json.mfa_required, true);
    const r = await half.req('GET', p, { origin: null });
    assert.equal(r.status, 302);
    assert.ok(r.headers.get('location').startsWith('/?next='));
  });

  test('the consent page: what it says, and its headers', async () => {
    const c = await newClient();
    const { challenge } = pkce();
    const { page, fields } = await consent({ client_id: c.client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge, resource: `${origin}/mcp` });
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /form-action 'self' https:\/\/claude\.ai(;|$)/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.doesNotMatch(page.text, /<script|\sstyle=|\son\w+=/i);
    assert.match(page.text, /<link rel="stylesheet" href="\/app.css">/);
    assert.match(page.text, /calls itself <strong class="oauth-name">Claude<\/strong>/);
    assert.match(page.text, /<p>claude\.ai<\/p>/);
    assert.match(page.text, /Read your collections and saved items\. It cannot save, change or delete anything\./);
    assert.match(page.text, /action="\/oauth\/authorize\/decision"/);
    assert.match(page.text, /value="allow"/);
    assert.match(page.text, /value="deny"/);
    assert.doesNotMatch(page.text, /any program running on this computer/i);
    assert.equal(fields.client_id, c.client_id);
    assert.equal(fields.redirect_uri, CLAUDE_CALLBACK);
    assert.equal(fields.scope, 'vault.read offline_access');
    assert.equal(fields.state, 'st-123');
    assert.equal(fields.resource, `${origin}/mcp`);
    assert.match(fields.csrf, /^\d+\.[A-Za-z0-9_-]{43}$/);
  });

  test('a loopback client: the page warns that any local program can claim to be Claude Code', async () => {
    const c = await newClient(['http://127.0.0.1:1234/callback']);
    const { challenge } = pkce();
    const { page } = await consent({ client_id: c.client_id, redirect_uri: 'http://127.0.0.1:5555/callback', code_challenge: challenge });
    assert.match(page.text, /A program on this computer \(localhost, port 5555\)/);
    assert.match(page.text, /Any program running on this computer can claim to be Claude Code/);
    assert.match(page.headers.get('content-security-policy'), /form-action 'self' http:\/\/127\.0\.0\.1:5555(;|$)/);
  });

  test('a hostile app name is escaped', async () => {
    const evil = '<script>alert(1)</script>"><img src=x onerror=alert(1)> & \'q\'';
    const r = await register({ client_name: evil, redirect_uris: [CLAUDE_CALLBACK] });
    assert.equal(r.status, 201);
    const { challenge } = pkce();
    const state = '"><script>alert(2)</script>';
    const page = await owner.req('GET', authorizePath({ client_id: r.json.client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: challenge, state }), { origin: null });
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /<script|<img/i);
    assert.match(page.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt; &amp; &#39;q&#39;/);
    assert.equal(hiddenFields(page.text).state, state);
  });
});

describe('consent decision', () => {
  async function fresh() {
    const c = await newClient();
    const p = pkce();
    const { fields } = await consent({ client_id: c.client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: p.challenge });
    return { c, p, fields };
  }
  const grants = () => db.prepare('SELECT COUNT(*) AS n FROM oauth_grants').get().n;

  test('Allow: a code back at claude.ai with state and iss', async () => {
    const { c, fields } = await fresh();
    const before = grants();
    const d = await decide(fields, 'allow');
    assert.equal(d.status, 302);
    assert.equal(d.headers.get('cache-control'), 'no-store');
    assert.equal(d.headers.get('referrer-policy'), 'no-referrer');
    const loc = d.headers.get('location');
    assert.ok(loc.startsWith(`${CLAUDE_CALLBACK}?`));
    const q = qs(loc);
    assert.match(q.get('code'), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(q.get('state'), 'st-123');
    assert.equal(q.get('iss'), origin);
    assert.equal(grants(), before + 1);
    // only the hash is stored
    assert.equal(db.prepare('SELECT 1 FROM oauth_codes WHERE code_hash = ?').get(q.get('code')), undefined);
    assert.ok(db.prepare('SELECT 1 FROM oauth_codes WHERE code_hash = ?').get(A.sha256(q.get('code'))));
    const row = db.prepare("SELECT detail FROM audit_log WHERE event = 'oauth_consent_granted' ORDER BY id DESC LIMIT 1").get();
    assert.match(row.detail, /^Claude \(claude\.ai\)/);
    assert.ok(db.prepare('SELECT last_used_at FROM oauth_clients WHERE client_id = ?').get(c.client_id).last_used_at);
  });

  test('Deny: access_denied with state and iss, no grant', async () => {
    const { fields } = await fresh();
    const before = grants();
    const d = await decide(fields, 'deny');
    assert.equal(d.status, 302);
    const q = qs(d.headers.get('location'));
    assert.equal(q.get('error'), 'access_denied');
    assert.equal(q.get('state'), 'st-123');
    assert.equal(q.get('iss'), origin);
    assert.equal(q.get('code'), null);
    assert.equal(grants(), before);
    assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE event = 'oauth_consent_denied'").get());
  });

  test('CSRF: missing, forged, from another sign-in, or with a changed parameter is refused', async () => {
    const { fields } = await fresh();
    const before = grants();
    const [exp, mac] = fields.csrf.split('.');
    const other = browser();
    await signIn(other);
    const attempts = [
      [{ ...fields, csrf: undefined }, owner],
      [{ ...fields, csrf: '' }, owner],
      [{ ...fields, csrf: `${exp}.${'A'.repeat(43)}` }, owner],
      [{ ...fields, csrf: `${Number(exp) + 600}.${mac}` }, owner],
      [fields, other],
      [{ ...fields, state: 'other-state' }, owner],
      [{ ...fields, scope: 'vault.read' }, owner],
      [{ ...fields, code_challenge: pkce().challenge }, owner],
      [{ ...fields, resource: `${origin}/mcp` }, owner],
      [{ ...fields, redirect_uri: 'http://localhost:9/callback' }, owner],
      [{ ...fields, client_id: (await newClient()).client_id }, owner],
    ];
    for (const [f, who] of attempts) {
      const d = await decide(f, 'allow', { who });
      assert.equal(d.status, 403, JSON.stringify(f));
      assert.equal(d.headers.get('location'), null);
    }
    assert.equal(grants(), before);
    // the untouched form still works
    assert.equal((await decide(fields, 'allow')).status, 302);
  });

  test('CSRF: the form expires after 10 minutes', async () => {
    const { fields } = await fresh();
    advance(601);
    const d = await decide(fields, 'allow');
    assert.equal(d.status, 403);
    assert.equal(d.headers.get('location'), null);
  });

  test('Origin: a foreign origin is refused; "null" only with Sec-Fetch-Site: same-origin', async () => {
    const { fields } = await fresh();
    for (const [o, headers] of [['https://evil.com', {}], ['null', {}], [null, {}], ['null', { 'Sec-Fetch-Site': 'cross-site' }], ['https://evil.com', { 'Sec-Fetch-Site': 'same-origin' }]]) {
      const d = await decide(fields, 'allow', { origin: o, headers });
      assert.equal(d.status, 403, `${o} ${JSON.stringify(headers)}`);
    }
    const d = await decide(fields, 'allow', { origin: 'null', headers: { 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(d.status, 302);
  });

  test('signed out: refused, nothing is sent back', async () => {
    const { fields } = await fresh();
    const d = await decide(fields, 'allow', { who: browser() });
    assert.equal(d.status, 401);
    assert.equal(d.headers.get('location'), null);
  });

  test('a decision that is neither allow nor deny', async () => {
    const { fields } = await fresh();
    assert.equal((await decide(fields, 'maybe')).status, 400);
  });
});

describe('token', () => {
  test('claude.ai: code for tokens', async () => {
    const g = await getCode();
    const r = await tokenReq({ grant_type: 'authorization_code', code: g.code, redirect_uri: CLAUDE_CALLBACK, client_id: g.client.client_id, code_verifier: g.verifier, resource: `${origin}/mcp` });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('pragma'), 'no-cache');
    assert.match(r.json.access_token, /^tva_[A-Za-z0-9_-]{43}$/);
    assert.match(r.json.refresh_token, /^tvr_[A-Za-z0-9_-]{43}$/);
    assert.equal(r.json.token_type, 'Bearer');
    assert.equal(r.json.expires_in, 3600);
    assert.equal(r.json.scope, 'vault.read offline_access');
    // only hashes are stored
    assert.equal(db.prepare('SELECT 1 FROM oauth_tokens WHERE token_hash = ?').get(r.json.access_token), undefined);
    assert.ok(db.prepare('SELECT 1 FROM oauth_tokens WHERE token_hash = ?').get(A.sha256(r.json.access_token)));
    const m = await mcp(r.json.access_token);
    assert.equal(m.status, 200);
    assert.ok(m.json.result.tools.length);
  });

  test('client_id may come in an HTTP Basic header with an empty secret', async () => {
    const g = await getCode();
    const r = await tokenReq({ grant_type: 'authorization_code', code: g.code, redirect_uri: CLAUDE_CALLBACK, code_verifier: g.verifier },
      { headers: { Authorization: `Basic ${Buffer.from(`${g.client.client_id}:`).toString('base64')}` } });
    assert.equal(r.status, 200, r.text);
  });

  test('loopback: a different port than the registered one works', async () => {
    const t = await getTokens({ redirect_uri: 'http://localhost:51234/callback', registered: ['http://localhost:8000/callback'] });
    assert.match(t.location, /^http:\/\/localhost:51234\/callback\?code=/);
    assert.equal((await mcp(t.tokens.access_token)).status, 200);
    const t2 = await getTokens({ redirect_uri: 'http://127.0.0.1:40000/callback', registered: ['http://127.0.0.1/callback'] });
    assert.equal((await mcp(t2.tokens.access_token)).status, 200);
  });

  test('wrong verifier, redirect, client or resource: refused', async () => {
    const g = await getCode();
    const other = await newClient();
    const ok = { grant_type: 'authorization_code', code: g.code, redirect_uri: CLAUDE_CALLBACK, client_id: g.client.client_id, code_verifier: g.verifier };
    const cases = [
      [{ code_verifier: pkce().verifier }, 400, 'invalid_grant'],
      [{ code_verifier: 'short' }, 400, 'invalid_grant'],
      [{ redirect_uri: 'http://localhost:1/callback' }, 400, 'invalid_grant'],
      [{ client_id: other.client_id }, 400, 'invalid_grant'],
      [{ client_id: 'tvc_unknown' }, 401, 'invalid_client'],
      [{ client_id: undefined }, 400, 'invalid_request'],
      [{ resource: 'https://evil.com/mcp' }, 400, 'invalid_target'],
      [{ code: 'not-a-code' }, 400, 'invalid_grant'],
      [{ code: undefined }, 400, 'invalid_request'],
      [{ code_verifier: undefined }, 400, 'invalid_request'],
      [{ grant_type: 'password' }, 400, 'unsupported_grant_type'],
      [{ grant_type: undefined }, 400, 'invalid_request'],
    ];
    for (const [o, status, error] of cases) {
      const r = await tokenReq({ ...ok, ...o });
      assert.equal(r.status, status, JSON.stringify(o));
      assert.equal(r.json.error, error, JSON.stringify(o));
      assert.ok(r.json.error_description);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
    // none of that used the code up
    assert.equal((await tokenReq(ok)).status, 200);
  });

  test('a repeated parameter or the wrong content type: invalid_request', async () => {
    const g = await getCode();
    const body = form({ grant_type: 'authorization_code', code: g.code, redirect_uri: CLAUDE_CALLBACK, client_id: g.client.client_id, code_verifier: g.verifier });
    const dup = await tokenReq(null, { rawBody: `${body}&code=other` });
    assert.equal(dup.status, 400);
    assert.equal(dup.json.error, 'invalid_request');
    const js = await raw('POST', '/oauth/token', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code' }) });
    assert.equal(js.status, 400);
    assert.equal(js.json.error, 'invalid_request');
    assert.equal(js.headers.get('pragma'), 'no-cache');
  });

  test('an expired code', async () => {
    const g = await getCode();
    advance(61);
    const r = await tokenReq({ grant_type: 'authorization_code', code: g.code, redirect_uri: CLAUDE_CALLBACK, client_id: g.client.client_id, code_verifier: g.verifier });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'invalid_grant');
  });

  test('a code used twice: invalid_grant, and every token from it stops working', async () => {
    const t = await getTokens();
    assert.equal((await mcp(t.tokens.access_token)).status, 200);
    const again = await tokenReq({ grant_type: 'authorization_code', code: t.code, redirect_uri: CLAUDE_CALLBACK, client_id: t.client.client_id, code_verifier: t.verifier });
    assert.equal(again.status, 400);
    assert.equal(again.json.error, 'invalid_grant');
    const m = await mcp(t.tokens.access_token);
    assert.equal(m.status, 401);
    assert.match(m.headers.get('www-authenticate'), /error="invalid_token"/);
    const rf = await tokenReq({ grant_type: 'refresh_token', refresh_token: t.tokens.refresh_token, client_id: t.client.client_id });
    assert.equal(rf.json.error, 'invalid_grant');
    assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE event = 'oauth_code_reuse' AND ok = 0").get());
  });

  test('refresh tokens rotate; an old one revokes the whole connection', async () => {
    const t = await getTokens();
    const r1 = await tokenReq({ grant_type: 'refresh_token', refresh_token: t.tokens.refresh_token, client_id: t.client.client_id });
    assert.equal(r1.status, 200, r1.text);
    assert.notEqual(r1.json.refresh_token, t.tokens.refresh_token);
    assert.notEqual(r1.json.access_token, t.tokens.access_token);
    assert.equal(r1.json.scope, 'vault.read offline_access');
    assert.equal(r1.headers.get('cache-control'), 'no-store');
    assert.equal((await mcp(r1.json.access_token)).status, 200);
    // asking for more scope than was allowed
    const wide = await tokenReq({ grant_type: 'refresh_token', refresh_token: r1.json.refresh_token, client_id: t.client.client_id, scope: 'vault.write' });
    assert.equal(wide.json.error, 'invalid_scope');
    // another client can't use it
    const other = await newClient();
    const stolen = await tokenReq({ grant_type: 'refresh_token', refresh_token: r1.json.refresh_token, client_id: other.client_id });
    assert.equal(stolen.json.error, 'invalid_grant');
    const r2 = await tokenReq({ grant_type: 'refresh_token', refresh_token: r1.json.refresh_token, client_id: t.client.client_id, scope: 'vault.read' });
    assert.equal(r2.status, 200, r2.text);
    // the spent first refresh token comes back: invalid_grant, and everything from this consent is revoked
    const replay = await tokenReq({ grant_type: 'refresh_token', refresh_token: t.tokens.refresh_token, client_id: t.client.client_id });
    assert.equal(replay.status, 400);
    assert.equal(replay.json.error, 'invalid_grant');
    assert.equal((await mcp(r2.json.access_token)).status, 401);
    const r3 = await tokenReq({ grant_type: 'refresh_token', refresh_token: r2.json.refresh_token, client_id: t.client.client_id });
    assert.equal(r3.json.error, 'invalid_grant');
    assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE event = 'oauth_refresh_reuse' AND ok = 0").get());
    assert.equal((await tokenReq({ grant_type: 'refresh_token', refresh_token: 'tvr_unknown', client_id: t.client.client_id })).json.error, 'invalid_grant');
  });

  test('access tokens expire after an hour; the refresh token still works', async () => {
    const t = await getTokens();
    advance(3601);
    const m = await mcp(t.tokens.access_token);
    assert.equal(m.status, 401);
    assert.match(m.headers.get('www-authenticate'), /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource", error="invalid_token"/);
    const r = await tokenReq({ grant_type: 'refresh_token', refresh_token: t.tokens.refresh_token, client_id: t.client.client_id });
    assert.equal(r.status, 200);
    assert.equal((await mcp(r.json.access_token)).status, 200);
  });

  test('at most 60 token requests a minute from one address', async () => {
    const ip = nextIp();
    for (let i = 0; i < 60; i++) assert.equal((await tokenReq({ grant_type: 'refresh_token', refresh_token: 'tvr_x', client_id: 'tvc_x' }, { ip })).status, 401);
    const r = await tokenReq({ grant_type: 'refresh_token', refresh_token: 'tvr_x', client_id: 'tvc_x' }, { ip });
    assert.equal(r.status, 429);
    assert.ok(r.headers.get('retry-after'));
  });
});

describe('revoke', () => {
  const revoke = (fields) => raw('POST', '/oauth/revoke', { headers: FORM_CT, body: form(fields) });

  test('an access token: just that token', async () => {
    const t = await getTokens();
    const r = await revoke({ token: t.tokens.access_token, token_type_hint: 'access_token', client_id: t.client.client_id });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal((await mcp(t.tokens.access_token)).status, 401);
    const rf = await tokenReq({ grant_type: 'refresh_token', refresh_token: t.tokens.refresh_token, client_id: t.client.client_id });
    assert.equal(rf.status, 200);
  });

  test('a refresh token: the whole connection', async () => {
    const t = await getTokens();
    assert.equal((await revoke({ token: t.tokens.refresh_token })).status, 200);
    assert.equal((await mcp(t.tokens.access_token)).status, 401);
    assert.ok(db.prepare('SELECT g.revoked_at FROM oauth_grants g JOIN oauth_tokens t ON t.grant_id = g.id WHERE t.token_hash = ?').get(A.sha256(t.tokens.access_token)).revoked_at);
  });

  test('unknown tokens and other clients\' tokens: 200, nothing changes', async () => {
    const t = await getTokens();
    assert.equal((await revoke({ token: 'tva_whatever' })).status, 200);
    const other = await newClient();
    assert.equal((await revoke({ token: t.tokens.access_token, client_id: other.client_id })).status, 200);
    assert.equal((await mcp(t.tokens.access_token)).status, 200);
    assert.equal((await revoke({})).status, 400);
  });
});

describe('/mcp with OAuth', () => {
  test('a token works and is rate limited per connection; removing the app ends it', async () => {
    const t = await getTokens();
    const m = await mcp(t.tokens.access_token, 'ping');
    assert.equal(m.status, 200);
    const gid = db.prepare('SELECT grant_id FROM oauth_tokens WHERE token_hash = ?').get(A.sha256(t.tokens.access_token)).grant_id;
    assert.ok(db.prepare('SELECT last_used_at FROM oauth_grants WHERE id = ?').get(gid).last_used_at);
    db.prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ?').run(now(), gid);
    const r = await mcp(t.tokens.access_token);
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /resource_metadata="/);
    assert.match(r.headers.get('www-authenticate'), /error="invalid_token"/);
    assert.ok(r.json.error);
  });

  test('device keys still work, and an OAuth token is not a key for the rest of the API', async () => {
    const key = A.createDeviceToken(db, 'Claude Code', 'read').token;
    assert.equal((await mcp(key)).status, 200);
    const t = await getTokens();
    const api = await raw('GET', '/api/bundles', { headers: { Authorization: `Bearer ${t.tokens.access_token}` } });
    assert.equal(api.status, 401);
    const bad = await mcp('tva_notarealtokennotarealtoken');
    assert.equal(bad.status, 401);
  });
});

describe('connected apps', () => {
  test('listed on the Security page and removable (session only, same origin)', async () => {
    const reg = await register({ client_name: 'Claude', redirect_uris: [CLAUDE_CALLBACK] });
    const t = await getTokens({ client: reg.json });
    const list = await owner.req('GET', '/api/oauth/grants');
    assert.equal(list.status, 200);
    const g = list.json.grants.find((x) => x.name === 'Claude' && x.returns_to === 'claude.ai');
    assert.ok(g, list.text);
    assert.ok(g.created_at && g.last_used_at);
    const gid = db.prepare('SELECT grant_id FROM oauth_tokens WHERE token_hash = ?').get(A.sha256(t.tokens.access_token)).grant_id;

    // a device key can't list or remove them; no Origin is refused
    const key = A.createDeviceToken(db, 'Reader', 'read').token;
    assert.equal((await raw('GET', '/api/oauth/grants', { headers: { Authorization: `Bearer ${key}` } })).status, 403);
    assert.equal((await owner.req('DELETE', `/api/oauth/grants/${gid}`, { origin: null })).status, 403);
    assert.equal((await owner.req('DELETE', `/api/oauth/grants/${gid}`, { origin: 'https://evil.com' })).status, 403);
    assert.equal((await mcp(t.tokens.access_token)).status, 200);

    const del = await owner.req('DELETE', `/api/oauth/grants/${gid}`);
    assert.equal(del.status, 200, del.text);
    assert.equal((await mcp(t.tokens.access_token)).status, 401);
    // nothing else was connected through that registration, so it went too: the client must register again
    const rf = await tokenReq({ grant_type: 'refresh_token', refresh_token: t.tokens.refresh_token, client_id: t.client.client_id });
    assert.equal(rf.json.error, 'invalid_client');
    assert.equal(db.prepare('SELECT 1 FROM oauth_clients WHERE client_id = ?').get(t.client.client_id), undefined);
    assert.ok(!(await owner.req('GET', '/api/oauth/grants')).json.grants.some((x) => x.id === gid));
    assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE event = 'oauth_grant_removed' AND detail = 'Claude'").get());
    assert.equal((await owner.req('DELETE', `/api/oauth/grants/${gid}`)).status, 404);
    assert.equal((await owner.req('DELETE', '/api/oauth/grants/abc')).status, 404);
    // signed out
    assert.equal((await browser().req('GET', '/api/oauth/grants')).status, 401);
  });

  test('a loopback app shows as this computer', async () => {
    await getTokens({ redirect_uri: 'http://localhost:7000/callback' });
    const list = await owner.req('GET', '/api/oauth/grants');
    assert.ok(list.json.grants.some((x) => x.returns_to === 'localhost'));
  });
});

describe('housekeeping', () => {
  test('prunes codes, old tokens, old removed connections and unused registrations', () => {
    const hdb = openDb(':memory:');
    const t = now();
    const D = 86400;
    const client = hdb.prepare('INSERT INTO oauth_clients (client_id, name, redirect_uris, grant_types, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)');
    client.run('fresh-unused', 'a', '[]', '[]', t - 3600, null);
    client.run('old-unused', 'b', '[]', '[]', t - 2 * D, null);
    client.run('old-used', 'c', '[]', '[]', t - 40 * D, t - 40 * D);
    const grant = hdb.prepare('INSERT INTO oauth_grants (client_id, scope, created_at, revoked_at) VALUES (?, ?, ?, ?)');
    const live = Number(grant.run('old-used', 'vault.read', t - 40 * D, null).lastInsertRowid);
    const goneLong = Number(grant.run('old-used', 'vault.read', t - 40 * D, t - 31 * D).lastInsertRowid);
    const goneRecent = Number(grant.run('old-used', 'vault.read', t - 40 * D, t - 5 * D).lastInsertRowid);
    const code = hdb.prepare('INSERT INTO oauth_codes (code_hash, grant_id, client_id, redirect_uri, code_challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    code.run('c-expired', live, 'old-used', 'x', 'x', 'vault.read', t - 1);
    code.run('c-valid', live, 'old-used', 'x', 'x', 'vault.read', t + 60);
    code.run('c-of-gone', goneLong, 'old-used', 'x', 'x', 'vault.read', t + 60);
    const tok = hdb.prepare('INSERT INTO oauth_tokens (token_hash, grant_id, kind, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)');
    tok.run('t-live', live, 'access', t, t + 3600, null);
    tok.run('t-live-refresh', live, 'refresh', t, t + 29 * D, null);
    tok.run('t-expired-today', live, 'access', t - 7200, t - 3600, null);
    tok.run('t-expired-long', live, 'refresh', t - 40 * D, t - 2 * D, null);
    tok.run('t-revoked-today', live, 'access', t - 100, t + 3000, t - 60);
    tok.run('t-revoked-long', live, 'access', t - 3 * D, t + 3000, t - 2 * D);
    tok.run('t-of-gone', goneLong, 'refresh', t - 40 * D, t + D, t - 31 * D);

    const r = housekeeping(hdb);
    const keys = (sql) => hdb.prepare(sql).all().map((x) => Object.values(x)[0]).sort();
    assert.deepEqual(keys('SELECT code_hash FROM oauth_codes'), ['c-valid']);
    assert.deepEqual(keys('SELECT token_hash FROM oauth_tokens'), ['t-expired-today', 't-live', 't-live-refresh', 't-revoked-today']);
    assert.deepEqual(keys('SELECT id FROM oauth_grants'), [live, goneRecent].sort());
    assert.deepEqual(keys('SELECT client_id FROM oauth_clients'), ['fresh-unused', 'old-used']);
    assert.equal(r.oauth.clients, 1);
    assert.equal(r.oauth.grants, 1);
  });
});
