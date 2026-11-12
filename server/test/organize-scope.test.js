// Phase A0 (PLAN-APP-2.md): the 'organize' scope for a paired phone. The owner switches it on per phone on
// the Security page; the phone keeps its token and id. Covers the switch, what the scope opens and what it
// never opens, the per-phone rate limit and the activity log.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, ORGANIZE_MAX, ORGANIZE_WINDOW } from '../src/server.js';
import { now } from '../src/db.js';
import { capture } from '../src/items.js';
import * as A from '../src/auth.js';
import { totp, base32Decode } from '../src/totp.js';

const PW = 'organize-test password 1';
const realNow = Date.now;
let skewMs = 0;
Date.now = () => realNow() + skewMs;
const advance = (sec) => { skewMs += sec * 1000; };

async function boot() {
  const app = createApp({
    dbPath: ':memory:', passwordHash: await A.makePasswordHash(PW, 100000), secret: 's'.repeat(40),
    origins: 'http://vault.test', cookieSecure: false, startWorker: false,
    fetchFn: async () => new Response('{}', { status: 404 }), paceMs: 0, log: () => {},
  });
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const jar = new Map();
  async function req(method, path, { body, bearer, cookies = true } = {}) {
    const headers = { Origin: 'http://vault.test' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (cookies && jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const res = await fetch(base + path, { method, headers, body: payload });
    if (cookies) {
      for (const sc of res.headers.getSetCookie()) {
        const kv = sc.split(';')[0];
        const i = kv.indexOf('=');
        jar.set(kv.slice(0, i).trim(), decodeURIComponent(kv.slice(i + 1).trim()));
      }
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, text, json };
  }
  // sign in as the owner with two-step set up
  assert.equal((await req('POST', '/api/login', { body: { password: PW } })).status, 200);
  const s = await req('POST', '/api/mfa/setup', { body: {} });
  advance(30);
  const c = await req('POST', '/api/mfa/confirm', { body: { code: totp(base32Decode(s.json.secret), now()) } });
  assert.equal(c.status, 200, c.text);
  return { app, db: app.db, req };
}

describe('organize scope for a paired phone', () => {
  let env; let phone; let phoneId; let items;
  const asPhone = (method, path, body) => env.req(method, path, { body, bearer: phone, cookies: false });
  const scopesOf = (id) => env.db.prepare('SELECT scopes FROM devices WHERE id = ?').get(id).scopes;

  before(async () => {
    env = await boot();
    const d = A.createDeviceToken(env.db, 'Galaxy', 'capture');
    phone = d.token; phoneId = d.device_id;
    items = [1, 2, 3].map((n) => capture(env.db, { input: `A thought worth keeping, number ${n}`, client_id: `organize-item-${n}` }).item_id);
  });
  after(async () => { await env.app.close(); });

  test('a save-only phone cannot make a merged item', async () => {
    const r = await asPhone('POST', '/api/bundles', { title: 'From the phone', item_ids: items });
    assert.equal(r.status, 403, r.text);
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM bundles').get().n, 0);
  });

  test('the phone reads its own scopes', async () => {
    const r = await asPhone('GET', '/api/device');
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { id: phoneId, name: 'Galaxy', scopes: ['capture'] });
    assert.equal((await env.req('GET', '/api/device')).status, 401);   // a browser session is not a device
  });

  test('a phone cannot switch organizing on for itself', async () => {
    const r = await asPhone('PATCH', `/api/devices/${phoneId}`, { organize: true });
    assert.equal(r.status, 403);
    assert.equal(scopesOf(phoneId), 'capture');
  });

  test('the owner switches it on: same device row, token still works, logged', async () => {
    assert.equal((await env.req('PATCH', `/api/devices/${phoneId}`, { body: { organize: 'yes' } })).status, 400);
    const r = await env.req('PATCH', `/api/devices/${phoneId}`, { body: { organize: true } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.scopes, 'capture,organize');
    assert.equal(scopesOf(phoneId), 'capture,organize');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 1);
    assert.deepEqual((await asPhone('GET', '/api/device')).json.scopes, ['capture', 'organize']);
    const log = env.db.prepare("SELECT detail FROM audit_log WHERE event = 'device_organize_changed'").all();
    assert.deepEqual(log.map((x) => x.detail), ['Galaxy: organizing allowed']);
    // switching on twice changes nothing
    assert.equal((await env.req('PATCH', `/api/devices/${phoneId}`, { body: { organize: true } })).json.scopes, 'capture,organize');
  });

  test('with organizing on, the phone makes a merged item and can still save', async () => {
    const r = await asPhone('POST', '/api/bundles', { title: 'From the phone', item_ids: items });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.slug, 'from-the-phone');
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM bundle_items').get().n, 3);
    const s = await asPhone('POST', '/api/captures', { input: 'still saving', client_id: 'organize-save-1' });
    assert.equal(s.status, 202, s.text);
  });

  test('organizing never opens the website-only routes', async () => {
    const cat = (await env.req('POST', '/api/categories', { body: { name: 'Keep' } })).json.id;
    const recipe = env.db.prepare('SELECT id FROM recipes LIMIT 1').get().id;
    const closed = [
      ['GET', '/api/inbox'], ['GET', '/api/devices'], ['GET', '/api/audit'], ['GET', '/api/organize'],
      ['GET', '/api/bundles'],                                              // the phone reads through /api/sync
      ['POST', '/api/devices', { scopes: 'capture,read' }], ['POST', '/api/devices/key', { name: 'k' }],
      ['DELETE', `/api/devices/${phoneId}`], ['PATCH', `/api/devices/${phoneId}`, { organize: true }],
      ['POST', '/api/categories', { name: 'x' }], ['PATCH', `/api/categories/${cat}`, { name: 'y' }], ['DELETE', `/api/categories/${cat}`],
      ['DELETE', '/api/tags/x'],
      ['POST', '/api/recipes', { name: 'x', prompt: 'y' }], ['PATCH', `/api/recipes/${recipe}`, { name: 'z' }], ['DELETE', `/api/recipes/${recipe}`],
      ['GET', '/api/oauth/grants'], ['POST', `/api/items/${items[0]}/translate`, {}],
      ['POST', '/api/mfa/recovery', { code: '000000' }], ['POST', '/api/mfa/setup', {}],
    ];
    for (const [m, p, body] of closed) {
      const r = await asPhone(m, p, body);
      assert.ok(r.status === 403 || r.status === 401, `${m} ${p} -> ${r.status}`);
    }
    assert.equal(env.db.prepare("SELECT name FROM categories WHERE id = ?").get(cat).name, 'Keep');
    assert.ok(env.db.prepare('SELECT 1 FROM recipes WHERE id = ?').get(recipe));
    assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM bundles').get().n, 1);
    assert.equal(scopesOf(phoneId), 'capture,organize');
  });

  test('the activity log gets one line per kind of change per hour', async () => {
    await asPhone('POST', '/api/bundles', { title: 'Second', item_ids: [items[0]] });
    const n = () => env.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'phone_organized'").get().n;
    assert.equal(n(), 1);
    assert.equal(env.db.prepare("SELECT detail FROM audit_log WHERE event = 'phone_organized'").get().detail, 'Galaxy: made a merged item');
    advance(3601);
    await asPhone('POST', '/api/bundles', { title: 'Third', item_ids: [items[1]] });
    assert.equal(n(), 2);
  });

  test('a phone is held to the change limit, then let through again later; the website is not limited', async () => {
    advance(ORGANIZE_WINDOW + 1);
    for (let i = 0; i < ORGANIZE_MAX; i++) {
      const r = await asPhone('POST', '/api/bundles', { title: `Bulk ${i}`, item_ids: [items[2]] });
      assert.equal(r.status, 201, `${i}: ${r.text}`);
    }
    const blocked = await asPhone('POST', '/api/bundles', { title: 'One too many', item_ids: [items[2]] });
    assert.equal(blocked.status, 429, blocked.text);
    assert.equal(blocked.json.error, 'rate_limited');
    assert.equal((await env.req('POST', '/api/bundles', { body: { title: 'From the website', item_ids: [items[2]] } })).status, 201);
    advance(ORGANIZE_WINDOW + 1);
    assert.equal((await asPhone('POST', '/api/bundles', { title: 'After the wait', item_ids: [items[2]] })).status, 201);
  });

  test('switching it off takes effect at once and keeps saving working', async () => {
    const r = await env.req('PATCH', `/api/devices/${phoneId}`, { body: { organize: false } });
    assert.equal(r.json.scopes, 'capture');
    assert.equal((await asPhone('POST', '/api/bundles', { title: 'Too late', item_ids: items })).status, 403);
    assert.equal((await asPhone('POST', '/api/captures', { input: 'saving after', client_id: 'organize-save-2' })).status, 202);
  });

  test('a Claude key stays read-only, and a removed or unknown device cannot be switched', async () => {
    const key = A.createDeviceToken(env.db, 'Claude Code', 'read');
    const r = await env.req('PATCH', `/api/devices/${key.device_id}`, { body: { organize: true } });
    assert.equal(r.status, 400, r.text);
    assert.equal(scopesOf(key.device_id), 'read');
    const gone = A.createDeviceToken(env.db, 'Old phone', 'capture');
    assert.equal((await env.req('DELETE', `/api/devices/${gone.device_id}`)).status, 200);
    assert.equal((await env.req('PATCH', `/api/devices/${gone.device_id}`, { body: { organize: true } })).status, 404);
    assert.equal((await env.req('PATCH', '/api/devices/99999', { body: { organize: true } })).status, 404);
    // a phone that can also read keeps its order of scopes
    const both = A.createDeviceToken(env.db, 'Tablet', 'capture,read');
    assert.equal((await env.req('PATCH', `/api/devices/${both.device_id}`, { body: { organize: true } })).json.scopes, 'capture,read,organize');
  });
});
