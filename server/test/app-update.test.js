// In-app updates for the Android app (pass 1, feature 4.2): GET /api/app/latest and GET|HEAD /api/app/apk,
// over a real createApp on HTTP, with a temp app folder and fake APK bytes. The JSON shape is exactly what
// TweetVaultApp's AppRelease / UpdateClient parse (snake_case, 204 for "no release", 401 for a bad token).
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, openSync, writeSync, closeSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { now } from '../src/db.js';
import { createApp } from '../src/server.js';
import * as A from '../src/auth.js';
import { totp, base32Decode } from '../src/totp.js';
import { releaseProblem, appDirFor, MAX_APK_BYTES } from '../src/appupdate.js';

const PW = 'correct horse battery staple';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const dirs = [];
const newDir = () => { const d = mkdtempSync(join(tmpdir(), 'tv-app-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// fake APK bytes (a zip header, then noise)
const APK = Buffer.concat([Buffer.from('PK\x03\x04'), randomBytes(50_000)]);

function clear(dir) { for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true }); }
// writes <sha>.apk and latest.json the way deploy.ps1 -App does; `meta` overrides fields, `raw` replaces the JSON text
function publish(dir, bytes = APK, { meta = {}, raw, writeApk = true } = {}) {
  clear(dir);
  const h = sha(bytes);
  if (writeApk) writeFileSync(join(dir, `${h}.apk`), bytes);
  const rec = { version_code: 3, version_name: '1.2.0', size: bytes.length, sha256: h, notes: 'Update banner and fixes',
    file: `${h}.apk`, uploaded_at: '2026-11-08T10:00:00Z', ...meta };
  writeFileSync(join(dir, 'latest.json'), raw ?? JSON.stringify(rec, null, 2));
  return rec;
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

describe('releaseProblem (latest.json rules)', () => {
  const good = { version_code: 3, version_name: '1.2.0', size: 10, sha256: 'a'.repeat(64), notes: null, file: `${'a'.repeat(64)}.apk`, uploaded_at: 'x' };
  test('a good record passes; notes and uploaded_at are optional', () => {
    assert.equal(releaseProblem(good), null);
    const { notes, uploaded_at, ...bare } = good;
    assert.equal(releaseProblem(bare), null);
    assert.equal(releaseProblem({ ...good, version_name: '1.2.0-beta+3 rc_1' }), null);
  });
  test('every broken field is refused', () => {
    const bad = [
      null, [], 'x', { ...good, extra: 1 },
      { ...good, version_code: 0 }, { ...good, version_code: 2_000_000_001 }, { ...good, version_code: '3' }, { ...good, version_code: 1.5 },
      { ...good, version_name: '' }, { ...good, version_name: 'x'.repeat(41) }, { ...good, version_name: '../1' }, { ...good, version_name: '1.0/2' },
      { ...good, version_name: ' 1.0' }, { ...good, version_name: 3 },
      { ...good, size: 0 }, { ...good, size: MAX_APK_BYTES + 1 }, { ...good, size: '10' }, { ...good, size: 1.5 },
      { ...good, sha256: 'A'.repeat(64) }, { ...good, sha256: 'a'.repeat(63) }, { ...good, sha256: 'g'.repeat(64) },
      { ...good, file: '../x.apk' }, { ...good, file: `../${'a'.repeat(64)}.apk` }, { ...good, file: `sub/${'a'.repeat(64)}.apk` },
      { ...good, file: `/data/${'a'.repeat(64)}.apk` }, { ...good, file: `${'b'.repeat(64)}.apk` },
      { ...good, notes: 5 }, { ...good, notes: 'x'.repeat(2001) }, { ...good, uploaded_at: {} },
    ];
    for (const r of bad) assert.ok(releaseProblem(r), JSON.stringify(r)?.slice(0, 120));
  });
  test('the folder sits next to a file database; in memory it is off', () => {
    assert.equal(appDirFor('/data/vault.db'), join('/data', 'app'));
    assert.equal(appDirFor(':memory:'), null);
    assert.equal(appDirFor(':memory:', '/x'), '/x');
  });
});

describe('over HTTP', () => {
  let app;
  let db;
  let base;
  let port;
  let dir;
  let cookie = '';
  let captureKey;
  let readKey;
  let bothKey;
  const logs = [];
  const realNow = Date.now;
  let skewMs = 0;

  const req = async (path, { auth = 'session', method = 'GET', headers = {} } = {}) => {
    const h = { ...headers };
    if (auth === 'session' && cookie) h.Cookie = cookie;
    else if (auth && auth !== 'session' && auth !== 'none') h.Authorization = `Bearer ${auth}`;
    const res = await fetch(base + path, { method, headers: h });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary or empty */ }
    return { status: res.status, headers: res.headers, buf, json };
  };
  const newCapture = (name = 'Phone') => A.createDeviceToken(db, name, 'capture').token;

  before(async () => {
    Date.now = () => realNow() + skewMs;
    dir = newDir();
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    app = createApp({
      dbPath: ':memory:', appDir: dir, passwordHash: await A.makePasswordHash(PW, 100000), secret: 'x'.repeat(40),
      origins: base, cookieSecure: false, trustProxy: false, startWorker: false, appDownloadsPerHour: 3,
      log: (m) => logs.push(m),
    });
    await app.listen(port, '127.0.0.1');
    db = app.db;
    captureKey = newCapture('Galaxy S24');
    readKey = A.createDeviceToken(db, 'Claude', 'read').token;
    bothKey = A.createDeviceToken(db, 'Both', 'capture,read').token;
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: PW }) });
    assert.equal(login.status, 200);
    cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const s = await fetch(`${base}/api/mfa/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: '{}' }).then((r) => r.json());
    skewMs += 30_000;
    const c = await fetch(`${base}/api/mfa/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
      body: JSON.stringify({ code: totp(base32Decode(s.secret), now()) }) });
    assert.equal(c.status, 200, await c.text());
    const set = c.headers.getSetCookie().map((x) => x.split(';')[0]);
    if (set.length) cookie = set.join('; ');
  });
  after(async () => { await app.close(); Date.now = realNow; });
  beforeEach(() => { logs.length = 0; });

  test('no release: latest is 204 with no body, the APK is 404 (GET and HEAD)', async () => {
    clear(dir);
    const r = await req('/api/app/latest', { auth: captureKey });
    assert.equal(r.status, 204);
    assert.equal(r.buf.length, 0);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal((await req('/api/app/apk', { auth: captureKey })).status, 404);
    assert.equal((await req('/api/app/apk', { auth: captureKey, method: 'HEAD' })).status, 404);
    assert.deepEqual(logs, [], 'no release is not a problem worth logging');
  });

  test('an in-memory vault with no app folder has the feature off', async () => {
    const p2 = await freePort();
    const other = createApp({ dbPath: ':memory:', secret: 'y'.repeat(40), origins: `http://127.0.0.1:${p2}`, startWorker: false, log: () => {} });
    assert.equal(other.appDir, null);
    await other.listen(p2, '127.0.0.1');
    try {
      const k = A.createDeviceToken(other.db, 'Phone', 'capture').token;
      const h = { Authorization: `Bearer ${k}` };
      assert.equal((await fetch(`http://127.0.0.1:${p2}/api/app/latest`, { headers: h })).status, 204);
      assert.equal((await fetch(`http://127.0.0.1:${p2}/api/app/apk`, { headers: h })).status, 404);
    } finally { await other.close(); }
  });

  test('a valid release: exactly the JSON the app parses', async () => {
    const rec = publish(dir);
    const r = await req('/api/app/latest', { auth: captureKey });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^application\/json/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(r.json, { version_code: 3, version_name: '1.2.0', size: APK.length, sha256: rec.sha256, notes: 'Update banner and fixes' });
    assert.deepEqual(Object.keys(r.json), ['version_code', 'version_name', 'size', 'sha256', 'notes']);
    assert.ok(!('file' in r.json) && !('path' in r.json), 'no file names or paths reach the phone');
    // empty or missing notes are null
    publish(dir, APK, { meta: { notes: '' } });
    assert.equal((await req('/api/app/latest', { auth: captureKey })).json.notes, null);
    const { notes, ...noNotes } = rec;
    publish(dir, APK, { raw: JSON.stringify(noNotes) });
    assert.equal((await req('/api/app/latest', { auth: captureKey })).json.notes, null);
    // a UTF-8 byte-order mark (a file written by Windows PowerShell) is fine
    publish(dir, APK, { raw: `﻿${JSON.stringify(rec)}` });
    assert.equal((await req('/api/app/latest', { auth: captureKey })).status, 200);
  });

  test('a broken latest.json means no release (204 / 404), logged once per problem', async () => {
    const h = sha(APK);
    const cases = [
      ['bad sha', { meta: { sha256: h.toUpperCase(), file: `${h.toUpperCase()}.apk` } }],
      ['sha and file disagree', { meta: { file: `${'0'.repeat(64)}.apk` } }],
      ['path traversal in file', { meta: { file: `../${h}.apk` } }],
      ['absolute path in file', { meta: { file: join(dir, `${h}.apk`) } }],
      ['size does not match the real file', { meta: { size: APK.length - 1 } }],
      ['too big', { meta: { size: 100 * 1024 * 1024 + 1 } }],
      ['version_code 0', { meta: { version_code: 0 } }],
      ['version_code a string', { meta: { version_code: '4' } }],
      ['version_code too large', { meta: { version_code: 2_000_000_001 } }],
      ['bad version_name', { meta: { version_name: '1.2"; rm -rf' } }],
      ['unknown field', { meta: { url: 'https://example.com/x.apk' } }],
      ['not JSON', { raw: '{"version_code": 3,' }],
      ['an array', { raw: '[]' }],
      ['APK file missing', { writeApk: false }],
    ];
    for (const [name, o] of cases) {
      publish(dir);   // a good release in between, so each problem is new
      assert.equal((await req('/api/app/latest', { auth: captureKey })).status, 200);
      publish(dir, APK, o);
      logs.length = 0;
      assert.equal((await req('/api/app/latest', { auth: captureKey })).status, 204, name);
      assert.equal((await req('/api/app/latest', { auth: captureKey })).status, 204, name);
      assert.equal((await req('/api/app/apk', { auth: captureKey })).status, 404, name);
      assert.equal((await req('/api/app/apk', { auth: captureKey, method: 'HEAD' })).status, 404, name);
      assert.equal(logs.filter((m) => m.includes('latest.json ignored')).length, 1, `${name}: logged once: ${logs}`);
    }
    // a file outside the folder is never served, even when it exists and its size matches
    clear(dir);
    const outside = join(dir, '..', `${h}.apk`);
    writeFileSync(outside, APK);
    try {
      publish(dir, APK, { writeApk: false, meta: { file: `../${h}.apk` } });
      assert.equal((await req('/api/app/apk', { auth: captureKey })).status, 404);
    } finally { rmSync(outside, { force: true }); }
    // latest.json that is a folder, or huge
    clear(dir);
    mkdirSync(join(dir, 'latest.json'));
    assert.equal((await req('/api/app/latest', { auth: captureKey })).status, 204);
    clear(dir);
    writeFileSync(join(dir, 'latest.json'), `{"notes":"${'x'.repeat(20_000)}"}`);
    assert.equal((await req('/api/app/latest', { auth: captureKey })).status, 204);
    // fixed again: served, and nothing more is logged
    publish(dir);
    logs.length = 0;
    assert.equal((await req('/api/app/latest', { auth: captureKey })).status, 200);
    assert.deepEqual(logs, []);
  });

  test('the APK streams with the right headers, bytes and length; HEAD has the headers and no body', async () => {
    const rec = publish(dir, APK, { meta: { version_name: '1.2.0' } });
    const key = newCapture();
    const r = await req('/api/app/apk', { auth: key });
    assert.equal(r.status, 200);
    assert.ok(r.buf.equals(APK));
    assert.equal(sha(r.buf), rec.sha256);
    assert.equal(r.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.equal(r.headers.get('content-length'), String(APK.length));
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="tweet-vault-1.2.0.apk"');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const hd = await req('/api/app/apk', { auth: key, method: 'HEAD' });
    assert.equal(hd.status, 200);
    assert.equal(hd.buf.length, 0);
    assert.equal(hd.headers.get('content-length'), String(APK.length));
    assert.equal(hd.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.equal(hd.headers.get('content-disposition'), 'attachment; filename="tweet-vault-1.2.0.apk"');
  });

  test('who may ask: capture token and a signed-in browser yes; no token, a revoked token and a read key no', async () => {
    publish(dir);
    // no token at all: 401 (the app shows "pair again")
    assert.equal((await req('/api/app/latest', { auth: 'none' })).status, 401);
    assert.equal((await req('/api/app/apk', { auth: 'none' })).status, 401);
    assert.equal((await req('/api/app/apk', { auth: 'none', method: 'HEAD' })).status, 401);
    // a token the vault never made
    assert.equal((await req('/api/app/latest', { auth: `tv_${'z'.repeat(40)}` })).status, 401);
    // revoked
    const gone = newCapture('Old phone');
    assert.equal((await req('/api/app/latest', { auth: gone })).status, 200);
    db.prepare('UPDATE devices SET revoked_at = ? WHERE token_hash = ?').run(now(), A.sha256(gone));
    assert.equal((await req('/api/app/latest', { auth: gone })).status, 401);
    assert.equal((await req('/api/app/apk', { auth: gone })).status, 401);
    // capture token, a phone with both scopes, a signed-in browser
    for (const auth of [captureKey, bothKey, 'session']) {
      assert.equal((await req('/api/app/latest', { auth })).status, 200, String(auth).slice(0, 8));
      assert.equal((await req('/api/app/apk', { auth, method: 'HEAD' })).status, 200, String(auth).slice(0, 8));
    }
    // a read-only key (Claude / MCP) can't fetch the app
    assert.equal((await req('/api/app/latest', { auth: readKey })).status, 403);
    assert.equal((await req('/api/app/apk', { auth: readKey })).status, 403);
    // signed out browser
    assert.equal((await fetch(`${base}/api/app/latest`)).status, 401);
  });

  test('downloads are rate limited per device; HEAD and latest are not counted', async () => {
    publish(dir);
    const a = newCapture('Loop phone');
    const b = newCapture('Other phone');
    for (let i = 0; i < 5; i++) assert.equal((await req('/api/app/apk', { auth: a, method: 'HEAD' })).status, 200);
    for (let i = 0; i < 3; i++) assert.equal((await req('/api/app/apk', { auth: a })).status, 200, `download ${i + 1}`);
    const r = await req('/api/app/apk', { auth: a });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    assert.equal(r.json.error, 'rate_limited');
    assert.equal((await req('/api/app/latest', { auth: a })).status, 200);
    assert.equal((await req('/api/app/apk', { auth: b })).status, 200, 'another phone has its own allowance');
    // an hour later it works again
    skewMs += 3601_000;
    assert.equal((await req('/api/app/apk', { auth: a })).status, 200);
  });

  test('a download is audited with the device name and version, never the token', async () => {
    publish(dir, APK, { meta: { version_code: 7, version_name: '1.3.0' } });
    const key = newCapture('Audit phone');
    const before = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'app_update_downloaded'").get().n;
    assert.equal((await req('/api/app/apk', { auth: key, method: 'HEAD' })).status, 200);
    assert.equal((await req('/api/app/latest', { auth: key })).status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event = 'app_update_downloaded'").get().n, before, 'HEAD and latest are not downloads');
    assert.equal((await req('/api/app/apk', { auth: key })).status, 200);
    const row = db.prepare("SELECT * FROM audit_log WHERE event = 'app_update_downloaded' ORDER BY id DESC LIMIT 1").get();
    assert.ok(row);
    assert.match(row.detail, /Audit phone/);
    assert.match(row.detail, /1\.3\.0/);
    assert.match(row.detail, /\b7\b/);
    const all = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
    assert.ok(!all.includes(key) && !all.includes(key.slice(3)), 'the token is not in the activity log');
  });

  test('a 20 MB APK is streamed from disk, not read into memory', async () => {
    // the route uses a file stream (never readFile) for the APK
    const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    const i = src.indexOf("route('GET', '/api/app/apk'");
    assert.ok(i > 0);
    const handler = src.slice(i, src.indexOf('\n  });\n', i));
    assert.match(handler, /createReadStream/);
    assert.match(handler, /pipeline\(/);
    assert.doesNotMatch(handler, /readFile|\.read\(|Buffer\.concat/);

    // write the file 1 MB at a time (the test itself never holds 20 MB either)
    clear(dir);
    const chunk = randomBytes(1024 * 1024);
    const hash = createHash('sha256');
    const tmpName = join(dir, 'big.tmp');
    const fd = openSync(tmpName, 'w');
    const MB = 20;
    for (let i2 = 0; i2 < MB; i2++) { chunk[0] = i2; writeSync(fd, chunk); hash.update(chunk); }
    closeSync(fd);
    const h = hash.digest('hex');
    rmSync(tmpName);
    // rewrite under its real name
    const fd2 = openSync(join(dir, `${h}.apk`), 'w');
    for (let i2 = 0; i2 < MB; i2++) { chunk[0] = i2; writeSync(fd2, chunk); }
    closeSync(fd2);
    const size = MB * 1024 * 1024;
    writeFileSync(join(dir, 'latest.json'), JSON.stringify({ version_code: 9, version_name: '2.0.0', size, sha256: h, notes: null, file: `${h}.apk` }));

    const key = newCapture('Big phone');
    const baseline = process.memoryUsage().arrayBuffers;
    const got = createHash('sha256');
    let total = 0;
    let peakGrowth = 0;
    await new Promise((resolve, reject) => {
      const r = http.get(`${base}/api/app/apk`, { headers: { Authorization: `Bearer ${key}` } }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-length'], String(size));
        let paused = false;
        res.on('data', (c) => {
          total += c.length;
          got.update(c);
          if (!paused) {
            // stop reading for a moment: a streaming server stops too, a buffering one would hold all 20 MB
            paused = true;
            res.pause();
            setTimeout(() => {
              peakGrowth = process.memoryUsage().arrayBuffers - baseline;
              res.resume();
            }, 400);
          }
        });
        res.on('end', resolve);
        res.on('error', reject);
      });
      r.on('error', reject);
    });
    assert.equal(total, size);
    assert.equal(got.digest('hex'), h);
    assert.ok(peakGrowth < 10 * 1024 * 1024, `memory grew by ${Math.round(peakGrowth / 1024 / 1024)} MB while the phone paused`);
  });
});
