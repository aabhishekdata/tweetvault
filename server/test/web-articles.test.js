// Phase 3.2, full article text for normal links: the SSRF-safe page fetcher (webfetch.js), the text
// extractor (htmltext.js), the reader (web.js) and its wiring into capture, the worker, the merged text,
// the item cards, the "Get article text again" route and the read-links command.
// Nothing here touches the network: DNS is a fake resolver, connections are fake https.request stand-ins,
// and the worker gets a fake page fetcher reading saved fixtures.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { openDb, now } from '../src/db.js';
import { capture, byId } from '../src/items.js';
import { createFetcher, BACKOFF } from '../src/fetcher.js';
import { readLink } from '../src/linkreader.js';
import { readWebPage, readableUrl } from '../src/web.js';
import {
  safeFetch, checkUrl, isRefusedAddress, resolvePublic, pinnedLookup, decodeHtml, ipv6Bytes,
  WebFetchError, WEB_UA, MAX_PAGE_BYTES,
} from '../src/webfetch.js';
import {
  extractArticle, parseHtml, toMarkdown, decodeEntities, capMarkdown, readableLength, CUT_NOTE, MAX_MD, toEpoch,
} from '../src/htmltext.js';
import { renderItems, loadItemsInOrder, renderChars, demoteHeadings, articleHeading } from '../src/render.js';
import { itemDto } from '../src/tree.js';
import { main as cli } from '../src/cli.js';
import { createApp } from '../src/server.js';
import * as A from '../src/auth.js';
import { totp, base32Decode } from '../src/totp.js';

const page = (n) => readFileSync(new URL(`./fixtures/web/${n}.html`, import.meta.url), 'utf8');
let cid = 0;
const save = (db, input, extra = {}) => capture(db, { input, client_id: `web-cid-${++cid}-xxxxxx`, ...extra });

// ---------- fake DNS and fake connections ----------
// table: host -> list of addresses | (callNumber) => list; unknown hosts are ENOTFOUND
function fakeDns(table) {
  const calls = [];
  const lookup = async (host, opts) => {
    calls.push({ host, opts });
    let v = table[host];
    if (typeof v === 'function') v = v(calls.filter((c) => c.host === host).length);
    if (v instanceof Error) throw v;
    if (!v) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return v.map((address) => ({ address, family: net.isIP(address) }));
  };
  return { lookup, calls };
}

// A fake https.request. It "connects" the way Node does: through options.lookup for a name (asking for a
// list, as autoSelectFamily does), straight to the IP for an IP literal. handler(ctx) returns a response
// spec { status, headers, body | chunks, stall } or an Error to emit on the request.
function fakeHttps(handler) {
  const seen = [];
  const request = (options, cb) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    req.end = () => {
      setImmediate(() => {
        const connect = (address) => {
          const ctx = { host: options.hostname, path: options.path, address, options, n: seen.length };
          seen.push(ctx);
          const spec = handler(ctx);
          if (spec instanceof Error) { req.emit('error', spec); return; }
          ctx.res = makeRes(spec);
          cb(ctx.res);
        };
        if (net.isIP(options.hostname)) connect(options.hostname);
        else options.lookup(options.hostname, { all: true }, (err, list) => connect(list[0].address));
      });
    };
    return req;
  };
  return { request, seen };
}
const HTML = { 'content-type': 'text/html; charset=utf-8' };
function makeRes({ status = 200, headers = HTML, body = '', chunks = null, stall = false } = {}) {
  const parts = chunks || [Buffer.isBuffer(body) ? body : Buffer.from(String(body))];
  let i = 0;
  const res = new Readable({
    read() {
      if (i < parts.length) this.push(parts[i++]);
      else if (!stall) this.push(null);   // a stalled body just never ends
    },
  });
  res.statusCode = status;
  res.headers = headers;
  return res;
}
const PUBLIC = '93.184.216.34';
const ARTICLE = `<html><head><title>T</title></head><body><article><p>${'Readable words here. '.repeat(40)}</p></article></body></html>`;

async function refusedWith(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof WebFetchError, `expected a WebFetchError, got ${e && e.stack}`);
    if (code) assert.equal(e.code, code, e.message);
    return true;
  });
}

// ======================================================================
describe('which addresses are refused', () => {
  const REFUSED_V4 = [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254',
    '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.0.1',
    '192.168.255.255', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250',
    '240.0.0.1', '255.255.255.255',
  ];
  const REFUSED_V6 = [
    '::', '::1', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'febf:ffff::1', 'fec0::1', 'ff02::1', 'ff0e::fb',
    '64:ff9b::a00:1', '64:ff9b::808:808', '64:ff9b:1::1', '100::1', '2001:db8::1', '2001:0:4136:e378::1',
    // IPv4-mapped / compatible / SIIT / 6to4 spellings of refused IPv4 addresses
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '::ffff:169.254.169.254',
    '0:0:0:0:0:ffff:c0a8:101', '::ffff:0:7f00:1', '::127.0.0.1', '::7f00:1', '2002:7f00:1::1', '2002:a9fe:a9fe::',
    'fe80::1%eth0',
  ];
  const ALLOWED = ['8.8.8.8', '1.1.1.1', PUBLIC, '172.32.0.1', '172.15.255.255', '100.128.0.1', '100.63.255.255',
    '198.20.0.1', '192.169.0.1', '11.0.0.1', '2606:4700::1111', '2a01:4f8:c2c:123f::1', '::ffff:8.8.8.8', '2002:808:808::1'];

  test('every refused IPv4 range', () => { for (const a of REFUSED_V4) assert.equal(isRefusedAddress(a), true, a); });
  test('every refused IPv6 range, and IPv4 hidden inside IPv6', () => { for (const a of REFUSED_V6) assert.equal(isRefusedAddress(a), true, a); });
  test('public addresses pass', () => { for (const a of ALLOWED) assert.equal(isRefusedAddress(a), false, a); });
  test('anything that is not an IP address is refused', () => {
    for (const a of ['', 'example.com', '127.0.0.1.', '1.2.3', null, undefined, '::ffff:999.1.1.1']) assert.equal(isRefusedAddress(a), true, String(a));
  });
  test('the IPv6 parser reads mapped and compressed forms', () => {
    assert.deepEqual([...ipv6Bytes('::ffff:127.0.0.1')].slice(10), [0xff, 0xff, 127, 0, 0, 1]);
    assert.deepEqual([...ipv6Bytes('::1')], [...new Array(15).fill(0), 1]);
    assert.equal(ipv6Bytes('1::2::3'), null);
  });
});

describe('address rules before anything is resolved', () => {
  test('https on 443 only, no user name or password', () => {
    assert.equal(checkUrl('https://example.com/a?b=1').host, 'example.com');
    assert.equal(checkUrl('https://example.com:443/a').host, 'example.com');
    for (const u of ['http://example.com/', 'ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com/',
      'https://example.com:8443/', 'https://example.com:80/', 'https://user@example.com/', 'https://user:pw@example.com/',
      'https://:pw@example.com/', 'not a url', `https://example.com/${'a'.repeat(3000)}`]) {
      assert.throws(() => checkUrl(u), WebFetchError, u);
    }
  });
  test('internal names are refused (localhost, Docker service names, .internal)', () => {
    for (const u of ['https://localhost/', 'https://LOCALHOST./', 'https://foo.localhost/', 'https://tweet-vault/',
      'https://metadata.google.internal/', 'https://printer.local/', 'https://router.lan/', 'https://nas.home.arpa/']) {
      assert.throws(() => checkUrl(u), (e) => e.code === 'refused', u);
    }
  });
  test('IP literals in decimal, octal, hex and short spellings are normalised and refused', () => {
    for (const u of ['https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/', 'https://0x7f.1/', 'https://127.1/',
      'https://017700000001/', 'https://0xa9.0xfe.0xa9.0xfe/', 'https://2852039166/', 'https://169.254.169.254/',
      'https://0/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:a9fe:a9fe]/', 'https://[fd00::1]/',
      'https://[0:0:0:0:0:ffff:7f00:1]:443/', 'https://10.1/', 'https://192.168.1.1/']) {
      assert.throws(() => checkUrl(u), (e) => e.code === 'refused', u);
    }
    assert.equal(checkUrl('https://8.8.8.8/').ip, '8.8.8.8');
    assert.equal(checkUrl('https://134744072/').ip, '8.8.8.8');   // 8.8.8.8 in decimal is still public
  });
  test('a shared http link is read over https; other schemes and ports are not read', () => {
    assert.equal(readableUrl('http://example.com/a?b=1'), 'https://example.com/a?b=1');
    assert.equal(readableUrl('http://example.com:80/a'), 'https://example.com/a');
    assert.equal(readableUrl('http://example.com:8080/a'), null);
    assert.equal(readableUrl('https://example.com/a'), 'https://example.com/a');
    assert.equal(readableUrl('javascript:alert(1)'), null);
    assert.equal(readableUrl('ftp://example.com/'), null);
  });
});

describe('our own DNS lookup', () => {
  test('refused when ANY answer is not public (one public plus one private)', async () => {
    const dns = fakeDns({ 'mixed.example': ['8.8.8.8', '10.0.0.5'] });
    await refusedWith(resolvePublic('mixed.example', dns.lookup), 'refused');
    const d2 = fakeDns({ 'mixed6.example': [PUBLIC, '::ffff:127.0.0.1'] });
    await refusedWith(resolvePublic('mixed6.example', d2.lookup), 'refused');
    const d3 = fakeDns({ 'v6.example': ['2606:4700::1111', 'fe80::1'] });
    await refusedWith(resolvePublic('v6.example', d3.lookup), 'refused');
  });
  test('asks for every answer, and passes a public name', async () => {
    const dns = fakeDns({ 'ok.example': [PUBLIC, '2606:4700::1111'] });
    assert.deepEqual(await resolvePublic('ok.example', dns.lookup), { address: PUBLIC, family: 4 });
    assert.equal(dns.calls[0].opts.all, true);
  });
  test('unknown names end the link, a temporary DNS failure is retried', async () => {
    await refusedWith(resolvePublic('nope.example', fakeDns({}).lookup), 'dns');
    try { await resolvePublic('nope.example', fakeDns({}).lookup); } catch (e) { assert.equal(e.retry, false); }
    const tmp = fakeDns({ 'flaky.example': Object.assign(new Error('EAI_AGAIN'), { code: 'EAI_AGAIN' }) });
    await assert.rejects(resolvePublic('flaky.example', tmp.lookup), (e) => e.retry === true);
    await refusedWith(resolvePublic('empty.example', fakeDns({ 'empty.example': [] }).lookup), 'dns');
  });
  test('the pinned lookup answers with the checked address in both shapes Node asks for', () => {
    const lk = pinnedLookup({ address: PUBLIC, family: 4 });
    lk('evil.example', {}, (err, a, f) => { assert.equal(a, PUBLIC); assert.equal(f, 4); });
    lk('evil.example', { all: true }, (err, list) => assert.deepEqual(list, [{ address: PUBLIC, family: 4 }]));
    lk('evil.example', (err, a) => assert.equal(a, PUBLIC));
  });
});

describe('safeFetch: one page through the SSRF defences', () => {
  test('a normal page: GET, our user agent, no cookies or auth, connects to the checked address with SNI', async () => {
    const dns = fakeDns({ 'news.example': [PUBLIC] });
    const web = fakeHttps(() => ({ body: ARTICLE }));
    const r = await safeFetch('https://news.example/story?id=7', { lookup: dns.lookup, request: web.request });
    assert.equal(r.status, 200);
    assert.equal(r.finalUrl, 'https://news.example/story?id=7');
    assert.equal(r.html, ARTICLE);
    assert.equal(r.charset, 'utf-8');
    const o = web.seen[0].options;
    assert.equal(o.method, 'GET');
    assert.equal(o.hostname, 'news.example');
    assert.equal(o.servername, 'news.example');
    assert.equal(o.port, 443);
    assert.equal(o.path, '/story?id=7');
    assert.equal(o.agent, false);
    assert.equal(o.rejectUnauthorized, true);
    assert.equal(o.headers['User-Agent'], WEB_UA);
    assert.equal(WEB_UA, 'TweetVault/1.0 (+https://vault.example.com; personal archive)');
    assert.match(o.headers.Accept, /text\/html/);
    const names = Object.keys(o.headers).map((k) => k.toLowerCase());
    assert.ok(!names.includes('cookie') && !names.includes('authorization'));
    assert.equal(web.seen[0].address, PUBLIC);
  });

  test('DNS rebinding: a second, private answer can never be the address we connect to', async () => {
    // first lookup public, any later lookup private
    const dns = fakeDns({ 'rebind.example': (n) => (n === 1 ? [PUBLIC] : ['127.0.0.1']) });
    const web = fakeHttps(() => ({ body: ARTICLE }));
    await safeFetch('https://rebind.example/', { lookup: dns.lookup, request: web.request });
    assert.equal(dns.calls.length, 1, 'the connection must not resolve the name again');
    assert.equal(web.seen[0].address, PUBLIC);
    // and even if Node asked our lookup again, it would answer the vetted address
    const second = await new Promise((res) => web.seen[0].options.lookup('rebind.example', {}, (e, a) => res(a)));
    assert.equal(second, PUBLIC);
  });

  test('a name that resolves to one public and one private address is refused before connecting', async () => {
    const dns = fakeDns({ 'both.example': [PUBLIC, '192.168.1.10'] });
    const web = fakeHttps(() => ({ body: ARTICLE }));
    await refusedWith(safeFetch('https://both.example/', { lookup: dns.lookup, request: web.request }), 'refused');
    assert.equal(web.seen.length, 0);
  });

  test('IP-literal pages: private refused without any request, public connects to that IP without SNI', async () => {
    const web = fakeHttps(() => ({ body: ARTICLE }));
    const dns = fakeDns({});
    for (const u of ['https://2130706433/', 'https://0x7f.1/', 'https://0177.0.0.1/', 'https://[::ffff:127.0.0.1]/', 'https://169.254.169.254/latest/meta-data/']) {
      await refusedWith(safeFetch(u, { lookup: dns.lookup, request: web.request }), 'refused');
    }
    assert.equal(web.seen.length, 0);
    assert.equal(dns.calls.length, 0);
    await safeFetch('https://8.8.8.8/', { lookup: dns.lookup, request: web.request });
    assert.equal(web.seen[0].address, '8.8.8.8');
    assert.equal(web.seen[0].options.servername, undefined);
  });

  test('user names, other ports and http are refused before any lookup', async () => {
    const dns = fakeDns({ 'example.com': [PUBLIC] });
    const web = fakeHttps(() => ({ body: ARTICLE }));
    for (const u of ['https://admin:pw@example.com/', 'https://example.com:8443/', 'http://example.com/']) {
      await refusedWith(safeFetch(u, { lookup: dns.lookup, request: web.request }), 'refused');
    }
    assert.equal(dns.calls.length, 0);
    assert.equal(web.seen.length, 0);
  });

  test('redirects are followed by hand and every hop is checked again', async () => {
    const dns = fakeDns({ 'a.example': [PUBLIC], 'b.example': ['8.8.4.4'] });
    const web = fakeHttps(({ host, path }) => {
      if (host === 'a.example' && path === '/start') return { status: 301, headers: { location: '/moved' } };
      if (host === 'a.example' && path === '/moved') return { status: 302, headers: { location: 'https://b.example/final' } };
      return { body: ARTICLE };
    });
    const r = await safeFetch('https://a.example/start', { lookup: dns.lookup, request: web.request });
    assert.equal(r.finalUrl, 'https://b.example/final');
    assert.deepEqual(web.seen.map((s) => `${s.host}${s.path}@${s.address}`),
      [`a.example/start@${PUBLIC}`, `a.example/moved@${PUBLIC}`, 'b.example/final@8.8.4.4']);
    assert.deepEqual(dns.calls.map((c) => c.host), ['a.example', 'a.example', 'b.example']);
  });

  test('a redirect into a private range, to a private name, to http: or to another port is refused', async () => {
    const targets = ['https://10.0.0.1/admin', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/',
      'https://inside.example/', 'http://b.example/', 'https://b.example:8443/', 'https://localhost/', 'https://u:p@b.example/',
      'https://2130706433/'];
    for (const loc of targets) {
      const dns = fakeDns({ 'a.example': [PUBLIC], 'b.example': ['8.8.4.4'], 'inside.example': ['172.17.0.1'] });
      const web = fakeHttps(({ host }) => (host === 'a.example' ? { status: 302, headers: { location: loc } } : { body: ARTICLE }));
      await refusedWith(safeFetch('https://a.example/', { lookup: dns.lookup, request: web.request }), 'refused');
      assert.equal(web.seen.length, 1, loc);
    }
  });

  test('at most 5 redirects', async () => {
    const dns = fakeDns({ 'loop.example': [PUBLIC] });
    const web = fakeHttps(({ n }) => ({ status: 302, headers: { location: `/hop${n + 1}` } }));
    await refusedWith(safeFetch('https://loop.example/', { lookup: dns.lookup, request: web.request }), 'redirects');
    assert.equal(web.seen.length, 6);   // the page plus 5 redirects
    // exactly 5 is fine
    const web5 = fakeHttps(({ n }) => (n < 5 ? { status: 302, headers: { location: `/hop${n + 1}` } } : { body: ARTICLE }));
    const r = await safeFetch('https://loop.example/', { lookup: dns.lookup, request: web5.request });
    assert.equal(r.finalUrl, 'https://loop.example/hop5');
  });

  test('only HTML: PDFs, images, JSON and unlabeled answers are not read', async () => {
    const dns = fakeDns({ 'x.example': [PUBLIC] });
    for (const ct of ['application/pdf', 'image/png', 'application/json', 'text/plain', 'application/octet-stream', '']) {
      const web = fakeHttps(() => ({ headers: ct ? { 'content-type': ct } : {}, body: '%PDF-1.7' }));
      await assert.rejects(safeFetch('https://x.example/f', { lookup: dns.lookup, request: web.request }),
        (e) => e.code === 'not_html' && e.retry === false && /Not a web page/.test(e.message));
      assert.ok(web.seen[0].res.destroyed, 'the body is not downloaded');
    }
    const xh = fakeHttps(() => ({ headers: { 'content-type': 'application/xhtml+xml' }, body: ARTICLE }));
    assert.equal((await safeFetch('https://x.example/', { lookup: dns.lookup, request: xh.request })).contentType, 'application/xhtml+xml');
  });

  test('a body over 3 MB is cut off, with or without a Content-Length', async () => {
    const dns = fakeDns({ 'big.example': [PUBLIC] });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const web = fakeHttps(() => ({ chunks: new Array(60).fill(chunk) }));   // 3.75 MB, no length given
    await refusedWith(safeFetch('https://big.example/', { lookup: dns.lookup, request: web.request }), 'too_large');
    assert.ok(web.seen[0].res.destroyed, 'the download is cancelled');
    const told = fakeHttps(() => ({ headers: { ...HTML, 'content-length': String(MAX_PAGE_BYTES + 1) }, body: 'x' }));
    await refusedWith(safeFetch('https://big.example/', { lookup: dns.lookup, request: told.request }), 'too_large');
    // just under the cap is fine
    const ok = fakeHttps(() => ({ chunks: [Buffer.alloc(MAX_PAGE_BYTES - 10, 0x61)] }));
    assert.equal((await safeFetch('https://big.example/', { lookup: dns.lookup, request: ok.request })).bytes, MAX_PAGE_BYTES - 10);
  });

  test('a compressed body counts its unpacked size (no zip bombs)', async () => {
    const dns = fakeDns({ 'zip.example': [PUBLIC] });
    const bomb = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x20));
    assert.ok(bomb.length < 100_000);
    const web = fakeHttps(() => ({ headers: { ...HTML, 'content-encoding': 'gzip' }, body: bomb }));
    await refusedWith(safeFetch('https://zip.example/', { lookup: dns.lookup, request: web.request }), 'too_large');
    const good = fakeHttps(() => ({ headers: { ...HTML, 'content-encoding': 'gzip' }, body: zlib.gzipSync(Buffer.from(ARTICLE)) }));
    assert.equal((await safeFetch('https://zip.example/', { lookup: dns.lookup, request: good.request })).html, ARTICLE);
    const odd = fakeHttps(() => ({ headers: { ...HTML, 'content-encoding': 'zstd-weird' }, body: 'x' }));
    await refusedWith(safeFetch('https://zip.example/', { lookup: dns.lookup, request: odd.request }), 'encoding');
  });

  test('a body that arrives too slowly is stopped (and retried later)', async () => {
    const dns = fakeDns({ 'slow.example': [PUBLIC] });
    const web = fakeHttps(() => ({ chunks: [Buffer.from('<html><body><p>start')], stall: true }));
    const t0 = Date.now();
    await assert.rejects(safeFetch('https://slow.example/', { lookup: dns.lookup, request: web.request, timeoutMs: 150 }),
      (e) => e.code === 'slow' && e.retry === true);
    assert.ok(Date.now() - t0 < 2000);
    assert.ok(web.seen[0].res.destroyed);
  });

  test('status answers: 5xx and 429 retry later, 404 and 403 end the link', async () => {
    const dns = fakeDns({ 's.example': [PUBLIC] });
    const run = (status) => safeFetch('https://s.example/', { lookup: dns.lookup, request: fakeHttps(() => ({ status })).request });
    for (const s of [500, 502, 503, 429, 408]) await assert.rejects(run(s), (e) => e.retry === true, String(s));
    await assert.rejects(run(404), (e) => e.code === 'gone' && !e.retry);
    await assert.rejects(run(410), (e) => e.code === 'gone' && !e.retry);
    await assert.rejects(run(403), (e) => e.code === 'blocked' && !e.retry);
    await assert.rejects(run(302), (e) => e.code === 'status');   // a redirect without a Location
  });

  test('connection errors retry, certificate errors do not', async () => {
    const dns = fakeDns({ 'e.example': [PUBLIC] });
    const err = (code) => Object.assign(new Error(code), { code });
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH']) {
      await assert.rejects(safeFetch('https://e.example/', { lookup: dns.lookup, request: fakeHttps(() => err(code)).request }), (e) => e.retry === true, code);
    }
    for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
      await assert.rejects(safeFetch('https://e.example/', { lookup: dns.lookup, request: fakeHttps(() => err(code)).request }), (e) => e.code === 'tls' && !e.retry, code);
    }
  });
});

describe('charset decoding', () => {
  test('from Content-Type: windows-1252 and iso-8859-1', () => {
    const b = Buffer.from([0x93, 0x68, 0x69, 0x94, 0x20, 0x63, 0x61, 0x66, 0xe9, 0x20, 0x96]);
    assert.equal(decodeHtml(b, 'text/html; charset=windows-1252').text, '“hi” café –');
    const r = decodeHtml(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'text/html; charset="ISO-8859-1"');
    assert.equal(r.text, 'café');
    assert.equal(r.charset, 'windows-1252');   // browsers read latin-1 as windows-1252 too
  });
  test('from <meta charset> when the header has none', () => {
    const b = Buffer.concat([Buffer.from('<html><head><meta charset="iso-8859-1"></head><body>'), Buffer.from([0xfc, 0x62, 0x65, 0x72])]);
    assert.match(decodeHtml(b, 'text/html').text, /über/);
    const c = Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">'), Buffer.from([0x85])]);
    assert.match(decodeHtml(c, '').text, /…/);
  });
  test('UTF-8 by default, a BOM wins, unknown labels fall back to UTF-8', () => {
    assert.equal(decodeHtml(Buffer.from('naïve ✓'), 'text/html').text, 'naïve ✓');
    assert.equal(decodeHtml(Buffer.from('﻿hi'), 'text/html; charset=windows-1252').text, 'hi');
    assert.equal(decodeHtml(Buffer.from('ok ✓'), 'text/html; charset=klingon-9').text, 'ok ✓');
    assert.equal(decodeHtml(Buffer.from('ok ✓'), 'text/html; charset=utf-16').charset, 'utf-8');
  });
  test('through safeFetch end to end', async () => {
    const dns = fakeDns({ 'c.example': [PUBLIC] });
    const web = fakeHttps(() => ({ headers: { 'content-type': 'text/html; charset=windows-1252' }, body: Buffer.from([0x93, 0x41, 0x94]) }));
    const r = await safeFetch('https://c.example/', { lookup: dns.lookup, request: web.request });
    assert.equal(r.html, '“A”');
    assert.equal(r.charset, 'windows-1252');
  });
});

// ======================================================================
describe('extractor: saved real-world-like pages', () => {
  const at = (iso) => Math.floor(Date.parse(iso) / 1000);

  test('news article: metadata, body with headings, list, quote and links; no chrome, ads or scripts', () => {
    const a = extractArticle(page('news'), 'https://www.dailyledger.example/city/cycle-lanes');
    assert.equal(a.readable, true);
    assert.equal(a.title, 'City council approves new cycle lanes after year-long debate');
    assert.equal(a.site, 'The Daily Ledger');
    assert.equal(a.author, 'Priya Raman');
    assert.equal(a.published_at, at('2026-03-14T08:30:00Z'));
    assert.match(a.md, /^# City council approves/);
    assert.match(a.md, /\n## What changes first\n/);
    assert.match(a.md, /- Market Street: 3\.2 km, opening in July\n- River path link/);
    assert.match(a.md, /> “This is the biggest change/);
    assert.match(a.md, /voted 9–4 on Thursday/);
    assert.match(a.md, /\[council website\]\(https:\/\/www\.dailyledger\.example\/docs\/cycle-plan\.pdf\)/);
    assert.match(a.md, /a summary is on this page\./);   // the javascript: link stays plain text
    for (const junk of ['dataLayer', 'Advertisement', 'SuperPhone', 'cookies', 'Bus fares', 'All rights reserved', 'Sign up', 'Share on X', 'Sport', 'javascript', 'min-height', 'lanes.jpg']) {
      assert.ok(!a.md.includes(junk), `should not include ${junk}`);
    }
    assert.ok(a.words > 150);
  });

  test('blog with JSON-LD: articleBody, author.name and datePublished', () => {
    const a = extractArticle(page('blog-jsonld'), 'https://fieldnotes.example/sqlite');
    assert.equal(a.readable, true);
    assert.equal(a.title, 'Notes on small databases');   // og:title, then <title>
    assert.equal(a.site, 'Field Notes');
    assert.equal(a.author, 'Jonas Berg');
    assert.equal(a.published_at, at('2025-11-02T10:00:00+01:00'));
    assert.match(a.md, /^For most of my side projects .* choosing SQLite\.\n\nIt is one file\./);
    assert.match(a.md, /take a lock before upgrading the schema\.$/);
    assert.equal(a.md.split('\n\n').length, 4);
  });

  test('Substack-like: the post body, bold and italics, an ordered list and code; no subscribe box or comments', () => {
    const a = extractArticle(page('substack'), 'https://margins.example/p/quiet-economics');
    assert.equal(a.title, 'The quiet economics of newsletters');
    assert.equal(a.site, 'Margins');
    assert.equal(a.author, 'Dana Whitfield');
    assert.equal(a.published_at, at('2026-01-20T13:05:44.120Z'));
    assert.match(a.md, /\*\*11,000 free readers\*\* and about \*600 paying ones\*/);
    assert.match(a.md, /1\. Annual plans make up 70 percent of revenue\.\n2\. Monthly plans/);
    assert.match(a.md, /```\nrevenue = paid \* price \* \(1 - fees\)\nfees {4}= 0\.10 \+ card costs\n```/);
    assert.match(a.md, /\[here\]\(https:\/\/docs\.example\.com\/sheet\?id=42&view=1\)/);
    for (const junk of ['Thousands of readers', '23 comments', '_preloads']) assert.ok(!a.md.includes(junk), junk);
  });

  test('Medium-like: minified markup, an author URL is not taken as the author, figures keep only the caption', () => {
    const a = extractArticle(page('medium'), 'https://medium.com/@kenji/ten-things-1a2b');
    assert.equal(a.title, 'Ten things I learned shipping a mobile app alone');
    assert.equal(a.site, 'Medium');
    assert.equal(a.author, 'Kenji Mori');
    assert.equal(a.published_at, at('2025-08-09T17:21:03.551Z'));
    assert.match(a.md, /## 1\. Ship the boring version first/);
    assert.match(a.md, /Daily active users over the first year\./);
    assert.match(a.md, /\[notes on tagging\]\(https:\/\/medium\.com\/@kenji\/support-tags-9f\)/);
    for (const junk of ['miro.medium', 'APOLLO', 'More from Kenji', 'Sign in']) assert.ok(!a.md.includes(junk), junk);
  });

  test('a paywall stub: the title and site are kept, but there is no readable text', () => {
    const a = extractArticle(page('paywall'), 'https://financialweekly.example/chips');
    assert.equal(a.readable, false);
    assert.equal(a.md, null);
    assert.equal(a.words, 0);
    assert.equal(a.title, "Inside the chip shortage's second act");
    assert.equal(a.site, 'Financial Weekly');
  });

  test('an app shell: no text (the <noscript> warning is not an article); the site falls back to the host name', () => {
    const a = extractArticle(page('appshell'), 'https://www.dashly.example/app');
    assert.equal(a.readable, false);
    assert.equal(a.title, 'Dashly - your projects in one place');
    assert.equal(a.site, 'dashly.example');
  });
});

describe('extractor: hostile HTML', () => {
  const pad = (s) => `<html><body><article>${s}<p>${'Plain filler text for length. '.repeat(15)}</p></article></body></html>`;
  const md = (html, url = 'https://h.example/a/b') => extractArticle(html, url).md || '';

  test('script tags in text never run into the output; escaped ones stay visible text', () => {
    const out = md(pad('<p>Hello <script>alert("pwned")</script>world. <script>document.write("</p><p>fake")</script>Code: &lt;script&gt;bad()&lt;/script&gt;</p>'
      + '<style>p{color:red}</style><SCRIPT type="text/javascript">steal()</SCRIPT><noscript><p>Enable JS</p></noscript><template><p>tpl secret</p></template>'));
    for (const bad of ['pwned', 'fake', 'steal', 'color:red', 'Enable JS', 'tpl secret']) assert.ok(!out.includes(bad), bad);
    assert.match(out, /Hello world\. Code: <script>bad\(\)<\/script>/);
  });

  test('javascript:, data: and other non-web links become plain text; web links are made absolute', () => {
    const out = md(pad(`<p><a href="javascript:alert(1)">one</a> <a href=" JaVaScRiPt:alert(2)">two</a> <a href="java&#x09;script:alert(3)">three</a>
      <a href="data:text/html;base64,PHNjcmlwdD4=">four</a> <a href="vbscript:x">five</a> <a href="mailto:a@b.c">six</a>
      <a href="/rel/path?q=(1)">seven</a> <a href="../up">eight</a> <a href="https://u:p@evil.example/">nine</a> <a href="#top">ten</a>
      <a href="http://plain.example/x y">eleven</a> <a href="https://ok.example/"><img src="x.png"></a></p>`));
    for (const w of ['one', 'two', 'three', 'four', 'five', 'six', 'nine', 'ten']) {
      assert.ok(out.includes(w) && !new RegExp(`\\[${w}\\]`).test(out), w);
    }
    assert.ok(!/javascript|data:|vbscript|mailto/i.test(out));
    assert.match(out, /\[seven\]\(https:\/\/h\.example\/rel\/path\?q=%281%29\)/);
    assert.match(out, /\[eight\]\(https:\/\/h\.example\/up\)/);
    assert.match(out, /\[eleven\]\(http:\/\/plain\.example\/x%20y\)/);
    assert.ok(!out.includes('ok.example'), 'an image-only link is dropped with its image');
  });

  test('comments, including "nested" ones, hide their content; doctype and CDATA are skipped', () => {
    const out = md(pad('<!DOCTYPE html><p>Before <!-- hidden one <!-- hidden two --> after --> end.</p><!--[if IE]><p>ie only</p><![endif]--><![CDATA[ cdata ]]>'));
    assert.ok(!out.includes('hidden one') && !out.includes('hidden two') && !out.includes('ie only') && !out.includes('cdata'));
    assert.match(out, /Before after --> end\./);
    // a comment that never ends hides the rest of the page, as in browsers
    const doc = parseHtml('<p>Shown</p><!-- never closed <p>secret</p>');
    assert.equal(toMarkdown(doc.root, 'https://h.example/'), 'Shown');
  });

  test('huge attribute values are capped and parse in linear time', () => {
    const big = 'A'.repeat(2_000_000);
    const t0 = Date.now();
    const doc = parseHtml(`<p title="${big}" data-x='${big}' y=${big}>kept text</p><a href="/x" title="${big}">link</a>`);
    assert.ok(Date.now() - t0 < 3000);
    const p = doc.root.kids[0];
    assert.equal(p.attrs.title.length, 4096);
    assert.equal(p.kids[0], 'kept text');
    // an unterminated quote and stray characters don't swallow the page
    const out = md(pad('<p class="a" "stray" =junk \'>Visible after junk.</p><p title="no end>Still here?</p>'));
    assert.match(out, /Visible after junk\./);
  });

  test('10,000 nested divs (and blockquotes, lists) do not overflow the stack', () => {
    const deep = (tag) => `${`<${tag}>`.repeat(10_000)}<p>${'Deep text that should survive. '.repeat(15)}</p>${`</${tag}>`.repeat(10_000)}`;
    for (const tag of ['div', 'blockquote', 'ul', 'span', 'b']) {
      const a = extractArticle(`<html><body>${deep(tag)}</body></html>`, 'https://h.example/');
      assert.equal(a.readable, true, tag);
      assert.match(a.md, /Deep text that should survive\./, tag);
    }
    // unclosed tags everywhere, too
    const a = extractArticle(`<html><body>${'<div><p>x '.repeat(20_000)}</body></html>`, 'https://h.example/');
    assert.equal(typeof a.readable, 'boolean');
  });

  test('hidden parts, forms, nav, header, footer, aside, iframes and svg are not text', () => {
    const out = md(pad('<p hidden>h1</p><p style="display: none">h2</p><div aria-hidden="true">h3</div><div style="visibility:hidden">h4</div>'
      + '<form><p>f1</p></form><nav>n1</nav><header>hd1</header><footer>ft1</footer><aside>as1</aside><iframe src="x">if1</iframe><svg><text>sv1</text></svg>'
      + '<div class="share-buttons">sh1</div><div id="comments">cm1</div><button>bt1</button>'));
    for (const w of ['h1', 'h2', 'h3', 'h4', 'f1', 'n1', 'hd1', 'ft1', 'as1', 'if1', 'sv1', 'sh1', 'cm1', 'bt1']) assert.ok(!out.includes(w), w);
  });

  test('a page wrapped in one big <form> (old ASP.NET sites) still gives its text', () => {
    const a = extractArticle(`<html><body><form id="aspnetForm"><div class="story"><p>${'First paragraph of a story. '.repeat(5)}</p><p>${'Second paragraph. '.repeat(5)}</p><p>${'Third paragraph. '.repeat(5)}</p></div></form></body></html>`, 'https://old.example/');
    assert.equal(a.readable, true);
    assert.match(a.md, /First paragraph/);
  });

  test('entities are decoded, broken ones safely', () => {
    assert.equal(decodeEntities('&amp;amp; &lt;b&gt; &#65;&#x42; &#0; &#x110000; &#xD800; &#150; &nbsp;&copy &notanentity; &mdash;'),
      '&amp; <b> AB � � � –  © &notanentity; —');
  });

  test('metadata is cleaned: control and bidi characters dropped, long titles capped', () => {
    const a = extractArticle(`<html><head><meta property="og:title" content="Safe‮ title\u0007 ${'x'.repeat(400)}"><meta name="author" content="  Jane⁦ Doe  "></head><body></body></html>`, 'https://m.example/');
    assert.ok(a.title.startsWith('Safe title'));
    assert.ok(a.title.length <= 300);
    assert.ok(!/[‮\u0007]/.test(a.title));
    assert.equal(a.author, 'Jane Doe');
  });

  test('dates outside a sane range are ignored', () => {
    assert.equal(toEpoch('1970-01-01T00:00:00Z'), null);
    assert.equal(toEpoch('2999-01-01'), null);
    assert.equal(toEpoch('not a date'), null);
    assert.equal(toEpoch('2026-01-02T00:00:00Z'), 1767312000);
  });

  test('broken or hostile JSON-LD is ignored, a short teaser articleBody loses to the page text', () => {
    const body = `<p>${'The full text of the article on the page itself. '.repeat(20)}</p>`;
    const a = extractArticle(`<html><head><script type="application/ld+json">{not json</script>
      <script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', articleBody: 'Teaser. '.repeat(45), author: [{ name: 'A One' }, { name: 'B Two' }] })}</script>
      </head><body><article>${body}</article></body></html>`, 'https://j.example/');
    assert.match(a.md, /The full text of the article/);
    assert.equal(a.author, 'A One, B Two');
    // deeply nested JSON is walked without recursion
    let deep = '{"a":'.repeat(5000) + '1' + '}'.repeat(5000);
    assert.doesNotThrow(() => extractArticle(`<script type="application/ld+json">${deep}</script>`, 'https://j.example/'));
    deep = null;
  });

  test('long text is cut at 60,000 characters on a paragraph boundary, with a note', () => {
    const paras = Array.from({ length: 3000 }, (_, i) => `<p>Paragraph ${i} ${'word '.repeat(20)}</p>`).join('');
    const a = extractArticle(`<html><body><article>${paras}</article></body></html>`, 'https://long.example/');
    assert.ok(a.md.length <= MAX_MD);
    assert.ok(a.md.endsWith(`\n\n${CUT_NOTE}`));
    const before = a.md.slice(0, -CUT_NOTE.length - 2);
    assert.match(before, /word$/);   // ends with a whole paragraph
    assert.equal(capMarkdown('short'), 'short');
  });

  test('a 3 MB page extracts in reasonable time', () => {
    const html = `<html><body><article>${'<div class="x"><p>Some text in a paragraph with <a href="/l">a link</a> and <b>bold</b>.</p></div>'.repeat(30_000)}</article></body></html>`;
    assert.ok(html.length > 2_500_000);
    const t0 = Date.now();
    const a = extractArticle(html, 'https://big.example/');
    assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
    assert.equal(a.readable, true);
  });

  test('tables become simple rows; readable length ignores link targets', () => {
    const out = toMarkdown(parseHtml('<table><tr><th>Name</th><th>Age</th></tr><tr><td>Ann</td><td>31</td></tr></table>').root, 'https://t.example/');
    assert.equal(out, 'Name | Age\nAnn | 31');
    assert.equal(readableLength('[ab](https://very.long.example/path)'), 2);
  });
});

// ======================================================================
// the worker with a fake page fetcher (pages: url -> html | Error | (url) => result)
function setupWorker(pages = {}, extra = {}) {
  const db = openDb(':memory:');
  const clock = { t: 1794000000 };
  const asked = [];
  const webFetch = async (url) => {
    asked.push(url);
    const p = typeof pages === 'function' ? pages(url) : pages[url];
    if (p instanceof Error) throw p;
    if (p === undefined) throw new WebFetchError('gone', "The page wasn't found");
    return { status: 200, finalUrl: url, contentType: 'text/html', charset: 'utf-8', html: p, bytes: p.length };
  };
  const tcoTargets = extra.tco || {};
  const fetchFn = async (url) => {
    const u = new URL(url);
    if (u.hostname === 't.co') {
      const loc = tcoTargets[u.pathname.slice(1)];
      return loc ? new Response(null, { status: 301, headers: { location: loc } }) : new Response('', { status: 404 });
    }
    return new Response('{"code":404,"message":"NOT_FOUND"}', { status: 404 });
  };
  const f = createFetcher(db, { fetchFn, paceMs: 0, nowFn: () => clock.t, webFetch: extra.noWebFetch ? undefined : webFetch });
  return { db, clock, f, asked };
}

describe('wiring: capture -> pending -> readLink -> ok / link_only', () => {
  test('a shared plain link starts pending, keeps the share title; X pages, t.co and article pages do not', () => {
    const db = openDb(':memory:');
    const a = byId(db, save(db, 'Cycle lanes approved https://news.example/story').item_id);
    assert.equal(a.fetch_status, 'pending');
    assert.equal(a.text, 'Cycle lanes approved');
    assert.equal(byId(db, save(db, 'https://x.com/someone').item_id).fetch_status, 'link_only');
    assert.equal(byId(db, save(db, 'https://x.com/i/article/2116367635365695488').item_id).fetch_status, 'link_only');
    const t = byId(db, save(db, 'https://t.co/abc123').item_id);
    assert.equal(t.note, 'tco');
    assert.equal(t.fetch_status, 'pending');
  });

  test('a readable page is saved as an article: all link fields, the shared URL kept, a small raw record', async () => {
    const { db, f, clock, asked } = setupWorker({ 'https://news.example/story': page('news') });
    const id = save(db, 'Shared title https://news.example/story').item_id;
    await f.drain();
    const it = byId(db, id);
    assert.deepEqual(asked, ['https://news.example/story']);
    assert.equal(it.fetch_status, 'ok');
    assert.equal(it.fetch_error, null);
    assert.equal(it.url, 'https://news.example/story');
    assert.equal(it.text, 'Shared title');
    assert.equal(it.link_type, 'web');
    assert.equal(it.link_title, 'City council approves new cycle lanes after year-long debate');
    assert.equal(it.link_site, 'The Daily Ledger');
    assert.equal(it.link_author, 'Priya Raman');
    assert.equal(it.link_published_at, Math.floor(Date.parse('2026-03-14T08:30:00Z') / 1000));
    assert.match(it.link_md, /## What changes first/);
    const meta = JSON.parse(it.link_meta);
    assert.equal(meta.final_url, 'https://news.example/story');
    assert.ok(meta.words > 150);
    assert.equal(it.link_fetched_at, clock.t);
    const raw = db.prepare("SELECT * FROM raw_fetches WHERE item_id = ? AND source = 'web'").get(id);
    const body = JSON.parse(raw.body);
    assert.equal(body.final_url, 'https://news.example/story');
    assert.ok(!raw.body.includes('<html'), 'the page itself is not stored');
  });

  test('a paywall or app shell ends link_only with "No readable article text", keeping title and site', async () => {
    const { db, f } = setupWorker({ 'https://fw.example/chips': page('paywall'), 'https://dashly.example/': page('appshell') });
    const a = save(db, 'https://fw.example/chips').item_id;
    const b = save(db, 'https://dashly.example/').item_id;
    await f.drain();
    for (const id of [a, b]) {
      const it = byId(db, id);
      assert.equal(it.fetch_status, 'link_only');
      assert.equal(it.fetch_error, 'No readable article text');
      assert.equal(it.link_type, 'web');
      assert.equal(it.link_md, null);
      assert.ok(it.link_title);
    }
    assert.equal(byId(db, a).link_site, 'Financial Weekly');
  });

  test('a refused or broken page ends link_only with a plain reason and no retry', async () => {
    const { db, f } = setupWorker({ 'https://pdf.example/f': new WebFetchError('not_html', 'Not a web page (application/pdf)') });
    const id = save(db, 'https://pdf.example/f').item_id;
    await f.drain();
    const it = byId(db, id);
    assert.equal(it.fetch_status, 'link_only');
    assert.equal(it.fetch_error, 'Not a web page (application/pdf)');
    assert.equal(it.fetch_attempts, 0);
  });

  test('a temporary failure uses the normal backoff, then succeeds', async () => {
    let n = 0;
    const { db, f, clock } = setupWorker((url) => (++n === 1 ? new WebFetchError('status', 'The site answered 503', { retry: true }) : page('news')));
    const id = save(db, 'https://flaky.example/a').item_id;
    await f.drain();
    let it = byId(db, id);
    assert.equal(it.fetch_status, 'pending');
    assert.equal(it.fetch_attempts, 1);
    assert.equal(it.next_fetch_at, clock.t + BACKOFF[0]);
    assert.equal(it.fetch_error, 'The site answered 503');
    clock.t += BACKOFF[0];
    await f.drain();
    it = byId(db, id);
    assert.equal(it.fetch_status, 'ok');
    assert.equal(it.fetch_attempts, 0);
  });

  test('a page that keeps failing ends as failed after the last backoff step', async () => {
    const { db, f, clock } = setupWorker(() => new WebFetchError('network', "Couldn't connect to the site", { retry: true }));
    const id = save(db, 'https://down.example/').item_id;
    for (let i = 0; i <= BACKOFF.length; i++) { await f.drain(); clock.t += 86400; }
    assert.equal(byId(db, id).fetch_status, 'failed');
  });

  test('a shared http link is read over https, but the item keeps the http address', async () => {
    const { db, f, asked } = setupWorker({ 'https://plain.example/a': page('news') });
    const id = save(db, 'http://plain.example/a').item_id;
    await f.drain();
    assert.deepEqual(asked, ['https://plain.example/a']);
    assert.equal(byId(db, id).url, 'http://plain.example/a');
    assert.equal(byId(db, id).fetch_status, 'ok');
  });

  test('t.co to an ordinary page goes pending and is then read; t.co to an X profile stays a plain link', async () => {
    const { db, f } = setupWorker({ 'https://blog.example/post': page('substack') },
      { tco: { abc123: 'https://blog.example/post', prof99: 'https://x.com/someone' } });
    const a = save(db, 'https://t.co/abc123').item_id;
    const b = save(db, 'https://t.co/prof99').item_id;
    await f.drain();
    const it = byId(db, a);
    assert.equal(it.url, 'https://blog.example/post');
    assert.equal(it.note, null);
    assert.equal(it.fetch_status, 'ok');
    assert.equal(it.link_title, 'The quiet economics of newsletters');
    assert.equal(byId(db, b).fetch_status, 'link_only');
    assert.equal(byId(db, b).url, 'https://x.com/someone');
  });

  test('a fake network without a fake page fetcher reads nothing (tests can never reach out)', async () => {
    const { db, f } = setupWorker({}, { noWebFetch: true });
    const id = save(db, 'https://example.com/a').item_id;
    await f.drain();
    assert.equal(byId(db, id).fetch_status, 'link_only');
    assert.equal(byId(db, id).fetch_error, 'Reading web pages is off here');
  });

  test('readLink sends YouTube to its own reader and everything else to the web reader', async () => {
    const db = openDb(':memory:');
    const yt = save(db, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ').item_id;
    const asked = [];
    const deps = { now: () => 1, log: () => {}, webFetch: async (u) => { asked.push(u); throw new WebFetchError('gone', 'x'); } };
    await readLink(db, byId(db, yt), deps);
    assert.equal(asked.length, 0);
    assert.equal(byId(db, yt).link_type, 'youtube');
  });

  test('readWebPage on a non-web address ends link_only without fetching', async () => {
    const db = openDb(':memory:');
    const t = now();
    const id = Number(db.prepare("INSERT INTO items (kind, url, fetch_status, saved, state, first_saved_at, last_saved_at) VALUES ('link','ftp://files.example/x','pending',1,'inbox',?,?)").run(t, t).lastInsertRowid);
    let called = false;
    await readWebPage(db, byId(db, id), { webFetch: async () => { called = true; } });
    assert.equal(called, false);
    assert.equal(byId(db, id).fetch_status, 'link_only');
  });

  test('extraction errors never leave the item stuck', async () => {
    const db = openDb(':memory:');
    const id = save(db, 'https://odd.example/').item_id;
    await readWebPage(db, byId(db, id), { webFetch: async () => ({ status: 200, finalUrl: 'https://odd.example/', html: { toString() { throw new Error('boom'); } } }) });
    assert.equal(byId(db, id).fetch_status, 'link_only');
    assert.equal(byId(db, id).fetch_error, "Couldn't read this page");
  });
});

// ======================================================================
function webItem(db, f = {}) {
  const t = 1773477000;
  const row = {
    kind: 'link', url: 'https://www.dailyledger.example/story', text: 'Share title', fetch_status: 'ok', saved: 1, state: 'inbox',
    first_saved_at: t, last_saved_at: t, link_type: 'web', link_title: 'Cycle lanes approved', link_site: 'The Daily Ledger',
    link_author: 'Priya Raman', link_published_at: t, link_md: '# Big heading\n\nFirst paragraph.\n\n## Sub\n\n```\n# not a heading\n```',
    link_meta: JSON.stringify({ final_url: 'https://www.dailyledger.example/story', words: 1234 }), link_fetched_at: t, ...f,
  };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c])).lastInsertRowid);
}

describe('merged text', () => {
  test('a read page becomes "## Article: title (site)" with its text, the note after it, and a full Sources line', () => {
    const db = openDb(':memory:');
    const id = webItem(db, { my_note: 'why I saved it' });
    const r = renderItems(db, loadItemsInOrder(db, [id]));
    assert.equal(r.text, '## Article: Cycle lanes approved (The Daily Ledger)\n### Big heading\n\nFirst paragraph.\n\n#### Sub\n\n```\n# not a heading\n```\n\n> My note: why I saved it');
    assert.match(r.text_sources, /\n\[Link 1\] The Daily Ledger · Priya Raman · 2026-03-14 · https:\/\/www\.dailyledger\.example\/story$/);
    assert.deepEqual(r.sections, [{ item_id: id, label: 'Link 1' }]);
    assert.ok(!r.text.includes('Share title'));
  });

  test('untitled falls back to the host name; site equal to the title is not repeated', () => {
    const db = openDb(':memory:');
    const a = webItem(db, { link_title: null, link_site: null, link_author: null, link_published_at: null });
    const r = renderItems(db, loadItemsInOrder(db, [a]));
    assert.match(r.text, /^## Article: dailyledger\.example\n/);
    assert.match(r.text_sources, /\[Link 1\] dailyledger\.example · https:\/\/www\.dailyledger\.example\/story/);
    assert.equal(articleHeading({ link_title: 'Medium', link_site: 'Medium', url: 'https://medium.com/' }), 'Article: Medium');
  });

  test('links without content render exactly as before', () => {
    const db = openDb(':memory:');
    const a = webItem(db, { fetch_status: 'link_only', link_md: null, fetch_error: 'No readable article text' });
    const b = webItem(db, { link_type: null, link_md: null, link_title: null, fetch_status: 'link_only', url: 'https://example.com/a', text: 'Example page' });
    const r = renderItems(db, loadItemsInOrder(db, [a, b]));
    assert.equal(r.text, '## Link 1\nShare title\n\nhttps://www.dailyledger.example/story\n\n## Link 2\nExample page\n\nhttps://example.com/a');
    assert.match(r.text_sources, /\[Link 1\] https:\/\/www\.dailyledger\.example\/story\n\[Link 2\] https:\/\/example\.com\/a$/);
  });

  test('a link still being read says so', () => {
    const db = openDb(':memory:');
    const id = save(db, 'https://wait.example/').item_id;
    assert.match(renderItems(db, loadItemsInOrder(db, [id])).text, /Still loading this page/);
  });

  test('the size check counts the article text', () => {
    assert.equal(renderChars([{ text: 'ab', link_md: 'x'.repeat(100) }]), 102);
  });

  test('heading demotion leaves code alone', () => {
    assert.equal(demoteHeadings('# A\n```\n# b\n```\n#### C\n##### D'), '### A\n```\n# b\n```\n###### C\n##### D');
  });
});

describe('item cards', () => {
  test('itemDto adds the link fields and a preview of the article text', () => {
    const db = openDb(':memory:');
    const d = itemDto(byId(db, webItem(db, { link_md: `Start ${'w '.repeat(700)}` })));
    assert.equal(d.link_type, 'web');
    assert.equal(d.link_title, 'Cycle lanes approved');
    assert.equal(d.link_site, 'The Daily Ledger');
    assert.equal(d.link_author, 'Priya Raman');
    assert.equal(d.link_published_at, 1773477000);
    assert.equal(d.link_has_text, true);
    assert.equal(d.words, 1234);
    assert.ok(d.preview.startsWith('Start ') && d.preview.endsWith('…') && d.preview.length <= 601);
    assert.ok(!('link_md' in d), 'the full text is loaded on demand');
  });

  test('a link without text keeps the old preview; other kinds get no link fields', () => {
    const db = openDb(':memory:');
    const d = itemDto(byId(db, webItem(db, { fetch_status: 'link_only', link_md: null })));
    assert.equal(d.link_has_text, false);
    assert.equal(d.preview, 'Share title');
    assert.ok(!('link_type' in itemDto({ id: 1, kind: 'tweet', text: 'x', fetch_status: 'ok', state: 'inbox' })));
  });

  test('the page shows web articles like articles and offers "Get article text again"', () => {
    const APP = readFileSync(new URL('../static/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const cut = (head, end) => { const i = APP.indexOf(head); assert.ok(i >= 0, head); return APP.slice(i, APP.indexOf(end, i) + end.length); };
    const fns = new Function('safeHref', `${cut('const isWebArticle = ', ';\n')}${cut('const opensInReader = ', ';\n')}${cut('const hostOf = ', ';\n')}${cut('const linkTitle = ', ';\n')}${cut('const canReadLink = ', ';\n')}
      return { isWebArticle, opensInReader, linkTitle, canReadLink };`)((u) => (/^https?:\/\//i.test(String(u || '')) ? u : null));
    const art = { id: 1, kind: 'link', link_has_text: true, url: 'https://www.blog.example/p', fetch_status: 'ok' };
    assert.equal(fns.isWebArticle(art), true);
    assert.equal(fns.opensInReader(art), true);
    assert.equal(fns.linkTitle(art), 'blog.example');
    assert.equal(fns.canReadLink(art), true);
    assert.equal(fns.canReadLink({ ...art, url: 'https://x.com/someone' }), false);
    assert.equal(fns.canReadLink({ ...art, fetch_status: 'pending' }), false);
    assert.equal(fns.canReadLink({ ...art, note: 'This is the article page link.' }), false);
    assert.equal(fns.canReadLink({ ...art, kind: 'tweet' }), false);
    assert.ok(APP.includes("label: 'Get article text again'"));
    assert.ok(APP.includes("'Read full text'"));
    assert.ok(!/\.innerHTML|outerHTML|insertAdjacentHTML/.test(APP));
  });
});

// ======================================================================
describe('read-links command', () => {
  test('re-queues old plain links only; --all also retries links read before without text', () => {
    const db = openDb(':memory:');
    const t = now();
    const ins = (f) => Number(db.prepare(`INSERT INTO items (kind, url, fetch_status, saved, state, note, link_type, first_saved_at, last_saved_at)
        VALUES ('link', ?, ?, 1, ?, ?, ?, ?, ?)`).run(f.url, f.status || 'link_only', f.state || 'inbox', f.note ?? null, f.type ?? null, t, t).lastInsertRowid);
    const old = ins({ url: 'https://old.example/a' });
    const oldHttp = ins({ url: 'http://old.example/b' });
    const archived = ins({ url: 'https://old.example/c', state: 'archived' });
    const trashed = ins({ url: 'https://old.example/d', state: 'trashed' });
    const xPage = ins({ url: 'https://x.com/someone' });
    const artPage = ins({ url: 'https://x.com/i/article/1', note: 'This is the article page link.' });
    const triedWeb = ins({ url: 'https://paywall.example/', type: 'web' });
    const youtube = ins({ url: 'https://youtu.be/abc', type: 'youtube' });
    const okOne = ins({ url: 'https://done.example/', status: 'ok', type: 'web' });
    const lines = [];
    assert.equal(cli(['read-links'], { db, out: (s) => lines.push(s) }), 0);
    assert.match(lines[0], /^Queued 3 links for reading/);
    const st = (id) => byId(db, id).fetch_status;
    for (const id of [old, oldHttp, archived]) assert.equal(st(id), 'pending');
    for (const id of [trashed, xPage, artPage, triedWeb, youtube]) assert.equal(st(id), 'link_only');
    assert.equal(st(okOne), 'ok');
    lines.length = 0;
    assert.equal(cli(['read-links', '--all'], { db, out: (s) => lines.push(s) }), 0);
    assert.match(lines[0], /^Queued 1 link for reading/);
    assert.equal(st(triedWeb), 'pending');
    assert.equal(st(youtube), 'link_only');
    lines.length = 0;
    cli(['read-links'], { db, out: (s) => lines.push(s) });
    assert.equal(lines[0], 'No links to read.');
  });
});

// ======================================================================
describe('API: POST /api/items/:id/read-link', () => {
  const PW = 'correct horse battery staple';
  const realNow = Date.now;
  let skewMs = 0;
  let env;
  let owner;
  let stranger;

  function freePort() {
    return new Promise((res, rej) => {
      const s = net.createServer();
      s.once('error', rej);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
  }
  function browser(base, origin) {
    const jar = new Map();
    return {
      async req(method, path, { body, origin: o = origin } = {}) {
        const headers = {};
        if (o) headers.Origin = o;
        if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
        let payload;
        if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
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
        return { status: res.status, text, json };
      },
    };
  }

  before(async () => {
    Date.now = () => realNow() + skewMs;
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const app = createApp({
      dbPath: ':memory:', passwordHash: await A.makePasswordHash(PW, 100000), secret: 'x'.repeat(40),
      origins: origin, cookieSecure: false, trustProxy: false, startWorker: false, paceMs: 0, log: () => {},
      fetchFn: async () => new Response('', { status: 404 }), webFetch: async () => { throw new WebFetchError('gone', 'x'); },
    });
    await app.listen(port, '127.0.0.1');
    env = { app, db: app.db, base: origin, origin };
    owner = browser(env.base, env.origin);
    stranger = browser(env.base, env.origin);
    const lg = await owner.req('POST', '/api/login', { body: { password: PW } });
    assert.equal(lg.status, 200, lg.text);
    const s = await owner.req('POST', '/api/mfa/setup', { body: {} });
    skewMs += 30_000;
    const c = await owner.req('POST', '/api/mfa/confirm', { body: { code: totp(base32Decode(s.json.secret), now()) } });
    assert.equal(c.status, 200, c.text);
  });
  after(async () => { await env.app.close(); Date.now = realNow; });
  beforeEach(() => A._resetLockouts());

  test('needs a signed-in session from our own origin', async () => {
    const id = webItem(env.db, { fetch_status: 'link_only', link_md: null });
    assert.equal((await stranger.req('POST', `/api/items/${id}/read-link`, { body: {} })).status, 401);
    assert.equal((await owner.req('POST', `/api/items/${id}/read-link`, { body: {}, origin: 'https://evil.example' })).status, 403);
    assert.equal(byId(env.db, id).fetch_status, 'link_only');
  });

  test('re-queues a web link and clears its old error', async () => {
    const id = webItem(env.db, { fetch_status: 'link_only', link_md: null, fetch_error: 'No readable article text', fetch_attempts: 3 });
    const r = await owner.req('POST', `/api/items/${id}/read-link`, { body: {} });
    assert.equal(r.status, 202, r.text);
    const it = byId(env.db, id);
    assert.equal(it.fetch_status, 'pending');
    assert.equal(it.fetch_error, null);
    assert.equal(it.fetch_attempts, 0);
  });

  test('refuses what is not a readable link', async () => {
    assert.equal((await owner.req('POST', '/api/items/99999999/read-link', { body: {} })).status, 404);
    assert.equal((await owner.req('POST', '/api/items/abc/read-link', { body: {} })).status, 404);
    const t = now();
    const tweet = Number(env.db.prepare("INSERT INTO items (kind, tweet_id, url, fetch_status, saved, state, first_saved_at, last_saved_at) VALUES ('tweet','9900001','https://x.com/a/status/9900001','ok',1,'inbox',?,?)").run(t, t).lastInsertRowid);
    assert.equal((await owner.req('POST', `/api/items/${tweet}/read-link`, { body: {} })).status, 404);
    const xLink = webItem(env.db, { url: 'https://x.com/someone', fetch_status: 'link_only', link_type: null, link_md: null });
    const r = await owner.req('POST', `/api/items/${xLink}/read-link`, { body: {} });
    assert.equal(r.status, 400);
    assert.match(r.json.message, /no article/);
  });

  test('GET /api/items/:id returns the article text for the reader', async () => {
    const id = webItem(env.db);
    const r = await owner.req('GET', `/api/items/${id}`);
    assert.equal(r.status, 200);
    assert.match(r.json.item.link_md, /First paragraph/);
    assert.equal(r.json.item.link_title, 'Cycle lanes approved');
  });
});
