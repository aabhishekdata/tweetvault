// Regression tests for the OAuth review fixes (findings 0, 2, 3, 6, 7, 8, 9, 10 and 11 of the review of
// commit dfba884): which redirect a consent used, registrations seen at the consent page, pruning that frees
// slots without evicting a registration in use, per-range and global rate limits, expired refresh tokens,
// the claude.ai wording and the recovery-code sign-in in the connect flow. A real createApp over HTTP.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createApp } from '../src/server.js';
import * as A from '../src/auth.js';
import { housekeeping } from '../src/audit.js';
import { totp, base32Decode } from '../src/totp.js';
import { now, openDb } from '../src/db.js';
import { CLAUDE_CALLBACK, MAX_CLIENTS, isAnthropicIp, listGrants } from '../src/oauth.js';

const PW = 'correct horse battery staple';
const D = 86400;

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined)).toString();
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const unescapeHtml = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const hiddenFields = (html) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)">/g)].map((m) => [m[1], unescapeHtml(m[2])]));
const authorizePath = (o) => `/oauth/authorize?${form({ response_type: 'code', code_challenge_method: 'S256', scope: 'vault.read offline_access', state: 'st', ...o })}`;

// one app on its own port, with an owner who has password and two-step sign-in
async function startVault(opts = {}) {
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const base = `http://127.0.0.1:${port}`;
  const app = createApp({
    dbPath: ':memory:', passwordHash: await A.makePasswordHash(PW, 100000), secret: 'z'.repeat(40),
    origins: `${origin},http://127.0.0.1:${port}`, cookieSecure: false, trustProxy: true, startWorker: false, paceMs: 0,
    fetchFn: async () => new Response('', { status: 404 }), log: () => {}, ...opts,
  });
  await app.listen(port, '127.0.0.1');
  let ipN = 0;
  const nextIp = () => { ipN++; return `10.7.${Math.floor(ipN / 250)}.${(ipN % 250) + 1}`; };
  async function raw(method, path, { headers = {}, body, ip = nextIp() } = {}) {
    const res = await fetch(base + path, { method, headers: { 'X-Forwarded-For': ip, ...headers }, body, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, text, json };
  }
  const jar = new Map();
  async function req(method, path, { json: body, formBody, o = origin } = {}) {
    const h = { 'X-Forwarded-For': '10.1.1.1' };
    if (o) h.Origin = o;
    if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    let payload;
    if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    if (formBody !== undefined) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = form(formBody); }
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
  const lg = await req('POST', '/api/login', { json: { password: PW } });
  assert.equal(lg.status, 200, lg.text);
  const s = await req('POST', '/api/mfa/setup', { json: {} });
  const secret = base32Decode(s.json.secret);
  const c = await req('POST', '/api/mfa/confirm', { json: { code: totp(secret, now()) } });
  assert.equal(c.status, 200, c.text);

  const register = (body, o = {}) => raw('POST', '/oauth/register', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...o });
  const token = (fields, o = {}) => raw('POST', '/oauth/token', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(fields), ...o });
  async function newClient(redirect_uris = [CLAUDE_CALLBACK], name = 'Claude') {
    const r = await register({ client_name: name, redirect_uris });
    assert.equal(r.status, 201, r.text);
    return r.json;
  }
  async function consent(clientId, redirect_uri, challenge) {
    const r = await req('GET', authorizePath({ client_id: clientId, redirect_uri, code_challenge: challenge }), { o: null });
    assert.equal(r.status, 200, r.text);
    return hiddenFields(r.text);
  }
  const decide = (fields, decision) => req('POST', '/oauth/authorize/decision', { formBody: { ...fields, decision } });
  async function connect(client, redirect_uri = CLAUDE_CALLBACK) {
    const p = pkce();
    const d = await decide(await consent(client.client_id, redirect_uri, p.challenge), 'allow');
    assert.equal(d.status, 302, d.text);
    const code = new URL(d.headers.get('location')).searchParams.get('code');
    const t = await token({ grant_type: 'authorization_code', code, redirect_uri, client_id: client.client_id, code_verifier: p.verifier });
    assert.equal(t.status, 200, t.text);
    const grantId = app.db.prepare('SELECT grant_id FROM oauth_tokens WHERE token_hash = ?').get(A.sha256(t.json.access_token)).grant_id;
    return { tokens: t.json, grantId };
  }
  return { app, db: app.db, raw, req, register, token, newClient, consent, decide, connect };
}

let V;
before(async () => { V = await startVault(); });
after(async () => { await V.app.close(); });

const clientRow = (id) => V.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(id);

describe('finding 0: Connected apps names the redirect the consent actually used', () => {
  test('a client registered for both claude.ai and localhost that consented via localhost shows as this computer', async () => {
    const c = await V.newClient([CLAUDE_CALLBACK, 'http://localhost:5555/callback'], 'Mixed');
    const viaLocal = await V.connect(c, 'http://localhost:5555/callback');
    const viaClaude = await V.connect(c, CLAUDE_CALLBACK);
    assert.equal(V.db.prepare('SELECT redirect_kind FROM oauth_grants WHERE id = ?').get(viaLocal.grantId).redirect_kind, 'loopback');
    assert.equal(V.db.prepare('SELECT redirect_kind FROM oauth_grants WHERE id = ?').get(viaClaude.grantId).redirect_kind, 'claude');
    const list = (await V.req('GET', '/api/oauth/grants')).json.grants;
    assert.equal(list.find((g) => g.id === viaLocal.grantId).returns_to, 'localhost');
    assert.equal(list.find((g) => g.id === viaClaude.grantId).returns_to, 'claude.ai');
  });

  test('a grant from before v7 (no redirect recorded) with a mixed registration is shown as this computer', () => {
    const db = openDb(':memory:');
    const t = now();
    db.prepare("INSERT INTO oauth_clients (client_id, name, redirect_uris, grant_types, created_at) VALUES ('mixed', 'Claude', ?, '[]', ?)")
      .run(JSON.stringify([CLAUDE_CALLBACK, 'http://localhost:1/callback']), t);
    db.prepare("INSERT INTO oauth_clients (client_id, name, redirect_uris, grant_types, created_at) VALUES ('web', 'Claude', ?, '[]', ?)")
      .run(JSON.stringify([CLAUDE_CALLBACK]), t);
    db.prepare("INSERT INTO oauth_grants (client_id, scope, created_at) VALUES ('mixed', 'vault.read', ?), ('web', 'vault.read', ?)").run(t, t + 1);
    const byClient = Object.fromEntries(listGrants(db).map((g) => [g.created_at === t ? 'mixed' : 'web', g.returns_to]));
    assert.deepEqual(byClient, { mixed: 'localhost', web: 'claude.ai' });
  });

  test('migration v7 adds the columns to a v6 database and keeps its rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tv-v7-'));
    try {
      const path = join(dir, 'v6.db');
      const old = openDb(path, { upTo: 6 });
      assert.equal(old.prepare('PRAGMA user_version').get().user_version, 6);
      old.prepare("INSERT INTO oauth_clients (client_id, name, redirect_uris, grant_types, created_at) VALUES ('keep', 'K', '[]', '[]', 1)").run();
      old.prepare("INSERT INTO oauth_grants (client_id, scope, created_at) VALUES ('keep', 'vault.read', 1)").run();
      old.close();
      const db = openDb(path);
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12, 'upgraded through v7 to the latest');
      assert.deepEqual({ ...db.prepare("SELECT name, seen_at FROM oauth_clients WHERE client_id = 'keep'").get() }, { name: 'K', seen_at: null });
      assert.equal(db.prepare("SELECT redirect_kind FROM oauth_grants WHERE client_id = 'keep'").get().redirect_kind, null);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('findings 2 and 6: a registration the owner is using is never pruned', () => {
  test('showing the consent page and choosing Deny mark the registration as seen', async () => {
    const c = await V.newClient(['http://localhost:4000/callback'], 'Claude Code');
    assert.equal(clientRow(c.client_id).seen_at, null);
    // a request that only reaches the sign-in redirect does not count
    const out = await V.raw('GET', authorizePath({ client_id: c.client_id, redirect_uri: 'http://localhost:4000/callback', code_challenge: pkce().challenge }));
    assert.equal(out.status, 302);
    assert.equal(clientRow(c.client_id).seen_at, null);
    const fields = await V.consent(c.client_id, 'http://localhost:4000/callback', pkce().challenge);
    assert.ok(clientRow(c.client_id).seen_at >= now() - 5);
    V.db.prepare('UPDATE oauth_clients SET seen_at = NULL WHERE client_id = ?').run(c.client_id);
    const d = await V.decide(fields, 'deny');
    assert.equal(d.status, 302);
    assert.equal(new URL(d.headers.get('location')).searchParams.get('error'), 'access_denied');
    assert.ok(clientRow(c.client_id).seen_at >= now() - 5, 'Deny marks it seen');
    assert.equal(clientRow(c.client_id).last_used_at, null);
    // housekeeping a few days later keeps it (Claude Code reuses its saved client_id)
    V.db.prepare('UPDATE oauth_clients SET created_at = ?, seen_at = ? WHERE client_id = ?').run(now() - 5 * D, now() - 3 * D, c.client_id);
    housekeeping(V.db);
    assert.ok(clientRow(c.client_id), 'a registration that reached the consent page is kept');
  });

  test('the unknown-client page says what to do in Claude Code and in claude.ai', async () => {
    const r = await V.req('GET', authorizePath({ client_id: 'tvc_gone', redirect_uri: CLAUDE_CALLBACK, code_challenge: pkce().challenge }), { o: null });
    assert.equal(r.status, 400);
    assert.equal(r.headers.get('location'), null);
    assert.match(r.text, /run \/mcp/);
    assert.match(r.text, /clear its saved sign-in/);
    assert.match(r.text, /remove the connector under Customize, Connectors, then add it again/);
  });

  test('at the cap: a fresh or recently seen registration is never evicted; all fresh means 503', async () => {
    const db = V.db;
    const t = now();
    db.prepare('DELETE FROM oauth_clients WHERE client_id NOT IN (SELECT client_id FROM oauth_grants WHERE revoked_at IS NULL)').run();
    const ins = db.prepare("INSERT INTO oauth_clients (client_id, name, redirect_uris, grant_types, created_at, last_used_at, seen_at) VALUES (?, 'f', '[]', '[]', ?, ?, ?)");
    try {
      const have = db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get().n;
      ins.run('z-in-flight', t - 60, null, null);                // the owner is signing in right now
      ins.run('z-seen', t - 10 * D, null, t - 3600);             // at the consent page an hour ago
      for (let i = 0; i < MAX_CLIENTS - have - 2; i++) ins.run(`z-fresh-${i}`, t - 30, null, null);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get().n, MAX_CLIENTS);
      const r = await V.register({ redirect_uris: [CLAUDE_CALLBACK] });
      assert.equal(r.status, 503, r.text);
      assert.ok(Number(r.headers.get('retry-after')) > 0);
      assert.ok(clientRow('z-in-flight') && clientRow('z-seen'));
      // once the flood ages past 15 minutes, those go first; the in-flight and seen ones still stay
      db.prepare("UPDATE oauth_clients SET created_at = ? WHERE client_id LIKE 'z-fresh-%'").run(t - 3600);
      db.prepare("UPDATE oauth_clients SET created_at = ? WHERE client_id = 'z-in-flight'").run(t - 60);
      for (let i = 0; i < 3; i++) assert.equal((await V.register({ redirect_uris: [CLAUDE_CALLBACK] })).status, 201);
      assert.ok(clientRow('z-in-flight') && clientRow('z-seen'));
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get().n, MAX_CLIENTS);
    } finally {
      db.prepare("DELETE FROM oauth_clients WHERE client_id LIKE 'z-%' OR client_id NOT IN (SELECT client_id FROM oauth_grants)").run();
    }
  });
});

describe('findings 3 and 10: used registrations stop holding slots', () => {
  test('removing a connected app deletes its registration, unless another connection still uses it', async () => {
    const solo = await V.newClient();
    const a = await V.connect(solo);
    assert.equal((await V.req('DELETE', `/api/oauth/grants/${a.grantId}`)).status, 200);
    assert.equal(clientRow(solo.client_id), undefined, 'nothing else used it, so it is gone');

    const shared = await V.newClient();
    const b1 = await V.connect(shared);
    const b2 = await V.connect(shared);
    assert.equal((await V.req('DELETE', `/api/oauth/grants/${b1.grantId}`)).status, 200);
    assert.ok(clientRow(shared.client_id), 'kept: the other connection is live');
    assert.equal((await V.req('DELETE', `/api/oauth/grants/${b2.grantId}`)).status, 200);
    assert.equal(clientRow(shared.client_id), undefined);
  });

  test('housekeeping removes registrations with nothing live left after 30 idle days', () => {
    const db = openDb(':memory:');
    const t = now();
    const c = db.prepare('INSERT INTO oauth_clients (client_id, name, redirect_uris, grant_types, created_at, last_used_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    c.run('used-removed-old', 'a', '[]', '[]', t - 90 * D, t - 40 * D, null);   // its only grant was removed: goes
    c.run('used-removed-recent', 'b', '[]', '[]', t - 90 * D, t - 5 * D, null); // idle only 5 days: stays
    c.run('used-live', 'c', '[]', '[]', t - 90 * D, t - 40 * D, null);          // a live connection: stays
    c.run('seen-old', 'd', '[]', '[]', t - 90 * D, null, t - 31 * D);           // denied long ago: goes
    c.run('seen-recent', 'e', '[]', '[]', t - 90 * D, null, t - 2 * D);         // denied 2 days ago: stays
    c.run('never-old', 'f', '[]', '[]', t - 2 * D, null, null);                 // never used or seen: goes after a day
    const g = db.prepare('INSERT INTO oauth_grants (client_id, scope, created_at, revoked_at) VALUES (?, ?, ?, ?)');
    g.run('used-removed-old', 'vault.read', t - 60 * D, t - 10 * D);
    g.run('used-removed-recent', 'vault.read', t - 60 * D, t - 5 * D);
    const live = Number(g.run('used-live', 'vault.read', t - 60 * D, null).lastInsertRowid);
    db.prepare("INSERT INTO oauth_tokens (token_hash, grant_id, kind, created_at, expires_at) VALUES ('r', ?, 'refresh', ?, ?)").run(live, t, t + 20 * D);
    const r = housekeeping(db);
    const left = db.prepare('SELECT client_id FROM oauth_clients ORDER BY client_id').all().map((x) => x.client_id);
    assert.deepEqual(left, ['seen-recent', 'used-live', 'used-removed-recent']);
    assert.equal(r.oauth.clients, 3);
  });

  test('at the cap, a used registration whose connections were all removed makes room', async () => {
    const db = V.db;
    const t = now();
    db.prepare('DELETE FROM oauth_clients WHERE client_id NOT IN (SELECT client_id FROM oauth_grants WHERE revoked_at IS NULL)').run();
    const have = db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get().n;
    try {
      const ins = db.prepare("INSERT INTO oauth_clients (client_id, name, redirect_uris, grant_types, created_at, last_used_at) VALUES (?, 'u', '[]', '[]', ?, ?)");
      ins.run('y-used-removed', t - 50 * D, t - 20 * D);
      db.prepare("INSERT INTO oauth_grants (client_id, scope, created_at, revoked_at) VALUES ('y-used-removed', 'vault.read', ?, ?)").run(t - 50 * D, t - 20 * D);
      ins.run('y-used-live', t - 60 * D, t - 30 * D);
      db.prepare("INSERT INTO oauth_grants (client_id, scope, created_at) VALUES ('y-used-live', 'vault.read', ?)").run(t - 60 * D);
      for (let i = 0; i < MAX_CLIENTS - have - 2; i++) ins.run(`y-fresh-${i}`, t - 10, t - 5);
      const r = await V.register({ redirect_uris: [CLAUDE_CALLBACK] });
      assert.equal(r.status, 201, r.text);
      assert.equal(clientRow('y-used-removed'), undefined);
      assert.ok(clientRow('y-used-live'), 'a live connection is never pruned');
    } finally {
      db.prepare("DELETE FROM oauth_clients WHERE client_id LIKE 'y-%'").run();
    }
  });
});

describe('finding 7: expired connections leave the list', () => {
  test('an expired refresh token answers invalid_grant and ends its connection', async () => {
    const c = await V.newClient();
    const k = await V.connect(c);
    V.db.prepare("UPDATE oauth_tokens SET expires_at = ? WHERE grant_id = ? AND kind = 'refresh'").run(now() - 1, k.grantId);
    const r = await V.token({ grant_type: 'refresh_token', refresh_token: k.tokens.refresh_token, client_id: c.client_id });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'invalid_grant');
    assert.ok(V.db.prepare('SELECT revoked_at FROM oauth_grants WHERE id = ?').get(k.grantId).revoked_at);
    assert.ok(!(await V.req('GET', '/api/oauth/grants')).json.grants.some((g) => g.id === k.grantId));
    assert.ok(V.db.prepare("SELECT 1 FROM audit_log WHERE event = 'oauth_grant_expired'").get());
  });

  test('housekeeping ends connections with no usable refresh token, but not one just granted', () => {
    const db = openDb(':memory:');
    const t = now();
    db.prepare("INSERT INTO oauth_clients (client_id, name, redirect_uris, grant_types, created_at, last_used_at) VALUES ('c', 'C', '[]', '[]', ?, ?)").run(t - 60 * D, t);
    const g = db.prepare("INSERT INTO oauth_grants (client_id, scope, created_at) VALUES ('c', 'vault.read', ?)");
    const expired = Number(g.run(t - 40 * D).lastInsertRowid);
    const spent = Number(g.run(t - 40 * D).lastInsertRowid);
    const live = Number(g.run(t - 40 * D).lastInsertRowid);
    const neverRedeemed = Number(g.run(t - 2 * D).lastInsertRowid);
    const justNow = Number(g.run(t - 30).lastInsertRowid);
    const tok = db.prepare('INSERT INTO oauth_tokens (token_hash, grant_id, kind, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?)');
    tok.run('r-exp', expired, 'refresh', t - 40 * D, t - 10 * D, null);
    tok.run('r-spent', spent, 'refresh', t - 20 * D, t + 10 * D, t - 19 * D);
    tok.run('r-live', live, 'refresh', t - D, t + 29 * D, null);
    const r = housekeeping(db);
    assert.equal(r.oauth.dead, 3);
    assert.deepEqual(listGrants(db).map((x) => x.id).sort((a, b) => a - b), [live, justNow]);
    assert.ok(db.prepare('SELECT revoked_at FROM oauth_grants WHERE id = ?').get(neverRedeemed).revoked_at);
  });
});

describe('finding 9: Anthropic\'s range has its own buckets, plus a global registration ceiling', () => {
  test('the address check covers IPv4 and IPv4-mapped IPv6, and nothing else', () => {
    for (const a of ['160.79.104.0', '160.79.104.1', '160.79.111.255', '::ffff:160.79.105.3', '::FFFF:160.79.104.9', '::ffff:a04f:6801', '0:0:0:0:0:ffff:160.79.110.1']) {
      assert.equal(isAnthropicIp(a), true, a);
    }
    for (const a of ['160.79.103.255', '160.79.112.0', '10.0.0.1', '::ffff:10.0.0.1', '2001:db8::1', '::1', '', null, 'garbage', '160.79.104']) {
      assert.equal(isAnthropicIp(a), false, String(a));
    }
    assert.equal(A.sourceKey('::ffff:a04f:6801'), '160.79.104.1');
    assert.equal(A.sourceKey('::ffff:10.0.0.9'), '10.0.0.9');
  });

  test('per-address limits stay, Anthropic shares a larger bucket, and every address together has a ceiling', async () => {
    const L = await startVault({
      oauthRegisterPerHour: 2, oauthAnthropicRegisterPerHour: 5, oauthRegisterGlobalPerHour: 4,
      oauthTokenPerMinute: 2, oauthAnthropicTokenPerMinute: 6,
    });
    try {
      const reg = (ip) => L.register({ redirect_uris: [CLAUDE_CALLBACK] }, { ip });
      // an ordinary address: 2 an hour (and its IPv4-mapped spelling is the same address)
      assert.equal((await reg('10.20.0.1')).status, 201);
      assert.equal((await reg('::ffff:10.20.0.1')).status, 201);
      assert.equal((await reg('10.20.0.1')).status, 429);
      // Anthropic: one bucket of 5 for the whole /21, whatever the spelling
      for (const ip of ['160.79.104.10', '160.79.111.200', '::ffff:160.79.106.1', '::ffff:a04f:6801', '160.79.104.10']) {
        assert.equal((await reg(ip)).status, 201, ip);
      }
      const anth = await reg('160.79.107.7');
      assert.equal(anth.status, 429);
      assert.ok(Number(anth.headers.get('retry-after')) > 0);
      // just outside the range is an ordinary address
      assert.equal((await reg('160.79.112.1')).status, 201);
      // junk from many addresses never counts toward the global ceiling
      for (let i = 0; i < 10; i++) {
        assert.equal((await L.register({ redirect_uris: ['https://evil.example/cb'] }, { ip: `10.50.0.${i + 1}` })).status, 400);
      }
      // 3 valid registrations so far from ordinary addresses (Anthropic's don't count): one more fits
      assert.equal((await reg('10.30.0.1')).status, 201);
      // now the global ceiling (4) refuses a new ordinary address...
      const g = await reg('10.30.0.2');
      assert.equal(g.status, 429);
      assert.equal(g.json.error, 'temporarily_unavailable');
      assert.match(g.json.error_description, /registrations right now/);
      // ...but never claude.ai's own range (its bucket of 5 is used up, so wait for a fresh vault below)
      const L2 = await startVault({ oauthRegisterPerHour: 50, oauthAnthropicRegisterPerHour: 5, oauthRegisterGlobalPerHour: 1 });
      try {
        assert.equal((await L2.register({ redirect_uris: [CLAUDE_CALLBACK] }, { ip: '10.60.0.1' })).status, 201);
        assert.equal((await L2.register({ redirect_uris: [CLAUDE_CALLBACK] }, { ip: '10.60.0.2' })).status, 429, 'ceiling full');
        assert.equal((await L2.register({ redirect_uris: [CLAUDE_CALLBACK] }, { ip: '160.79.104.20' })).status, 201, 'Anthropic is exempt');
      } finally { await L2.app.close(); }

      // token endpoint: 2 a minute per address, 6 for the Anthropic range
      const tok = (ip) => L.token({ grant_type: 'refresh_token', refresh_token: 'x', client_id: 'nope' }, { ip });
      assert.notEqual((await tok('10.40.0.1')).status, 429);
      assert.notEqual((await tok('::ffff:10.40.0.1')).status, 429);
      assert.equal((await tok('10.40.0.1')).status, 429);
      for (let i = 0; i < 6; i++) assert.notEqual((await tok(`160.79.10${4 + (i % 4)}.${i + 1}`)).status, 429, `#${i}`);
      assert.equal((await tok('160.79.104.99')).status, 429);
      assert.notEqual((await tok('10.40.0.2')).status, 429, 'other addresses are unaffected');
    } finally {
      await L.app.close();
    }
  });
});

describe('client fixes (app.js)', () => {
  const APP = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  test('finding 8: the claude.ai step says Customize, then Connectors (here, README and RUNBOOK)', () => {
    assert.ok(APP.includes('In Claude, open Customize, then Connectors, then Add custom connector.'));
    assert.ok(!/Settings, then Connectors/.test(APP));
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const runbook = readFileSync(new URL('../../deploy/RUNBOOK.md', import.meta.url), 'utf8');
    assert.ok(!/Settings → Connectors/.test(readme) && /Customize → Connectors/.test(readme));
    assert.ok(!/Settings, Connectors/.test(runbook) && /Customize, then Connectors, then Add custom connector/.test(runbook));
  });

  test('finding 11: boot() says when it left for the consent page, and the code form stops there', async () => {
    const cut = (header) => {
      const i = APP.indexOf(header);
      assert.ok(i >= 0, header);
      return APP.slice(i, APP.indexOf('\n  }\n', i) + 5);
    };
    let replaced = null;
    let routed = 0;
    let toasts = 0;
    const make = new Function('api', 'location', 'sessionStorage', 'history', 'toast', 'route', 'state', 'NEXT', 'showCode', 'showLogin', 'showMfaSetup',
      `${cut('function followNext()')}\n${cut('async function boot()')}\nreturn boot;`);
    const store = new Map();
    const boot = make(
      async () => ({ signed_in: true, mfa_enabled: true }),
      { replace: (u) => { replaced = u; } },
      { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
      { replaceState: () => {} }, () => { toasts++; }, () => { routed++; return 'routed'; }, {},
      '/oauth/authorize?client_id=x', () => {}, () => {}, () => {});
    assert.equal(await boot(), 'next');
    assert.equal(replaced, '/oauth/authorize?client_id=x');
    assert.equal(routed, 0);
    assert.equal(toasts, 0);
    // the two-step form returns as soon as boot() left, before the recovery-code toast and go()
    const i = APP.indexOf("const r = await api('POST', '/api/login/mfa', body);");
    const block = APP.slice(i, APP.indexOf('} catch (x)', i));
    assert.ok(block.indexOf("if (await boot() === 'next') return;") > 0);
    assert.ok(block.indexOf("if (await boot() === 'next') return;") < block.indexOf('if (useRecovery)'));
  });
});

describe('check follow-ups', () => {
  test('removing an app keeps its registration while a new consent for it is under way', async () => {
    const L = await startVault();
    try {
      const c = await L.newClient();
      const t = now();
      // an earlier connection, since removed; then the consent page shown again just now
      const gid = Number(L.db.prepare("INSERT INTO oauth_grants (client_id, scope, created_at, revoked_at) VALUES (?, 'vault.read', ?, ?)").run(c.client_id, t - 600, t - 60).lastInsertRowid);
      L.db.prepare('UPDATE oauth_clients SET seen_at = ? WHERE client_id = ?').run(t, c.client_id);
      const { deleteClientIfUnused } = await import('../src/oauth.js');
      assert.equal(deleteClientIfUnused(L.db, c.client_id), 0, 'kept: a consent is open');
      L.db.prepare('UPDATE oauth_clients SET seen_at = ? WHERE client_id = ?').run(t - 900, c.client_id);
      assert.equal(deleteClientIfUnused(L.db, c.client_id), 1, 'deleted: the consent was before the grant');
      assert.ok(gid);
    } finally { await L.app.close(); }
  });

  test('housekeeping writes ended connections to Recent activity', async () => {
    const L = await startVault();
    try {
      const c = await L.newClient(undefined, 'Old Claude');
      L.db.prepare("INSERT INTO oauth_grants (client_id, scope, created_at) VALUES (?, 'vault.read', ?)").run(c.client_id, now() - 3 * 86400);
      const { housekeeping } = await import('../src/audit.js');
      housekeeping(L.db);
      const row = L.db.prepare("SELECT detail FROM audit_log WHERE event = 'oauth_grant_expired' ORDER BY id DESC").get();
      assert.ok(row && /Old Claude/.test(row.detail), JSON.stringify(row));
    } finally { await L.app.close(); }
  });
});
