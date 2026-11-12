// Fetching one web page from an address someone shared (phase 3.2). Every address here comes from
// whatever got shared, so this module is mostly a defence against server-side request forgery (SSRF):
// the vault must never be talked into requesting the Docker gateway, the cloud provider's metadata service or any
// other address that is not on the public internet.
//
// The rules, per request and again for every redirect hop:
//   - https: only, port 443, no username or password in the address
//   - we resolve the name ourselves (dns.lookup, all answers) and refuse if ANY answer is not public
//   - the connection goes to the address we checked (a pinned `lookup` for https.request), so a second,
//     different DNS answer (DNS rebinding) can't swap in an internal address; the real name is still used
//     for SNI and the certificate check
//   - at most 5 redirects, followed by hand
//   - only text/html or application/xhtml+xml, at most 3 MB, 15 seconds for the whole thing
//
// It is not the X allow-list fetcher in fetcher.js (http()): that one only ever talks to four fixed hosts.
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

export const WEB_UA = 'TweetVault/1.0 (+https://vault.example.com; personal archive)';
export const MAX_PAGE_BYTES = 3 * 1024 * 1024;
export const PAGE_TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 5;
const MAX_URL = 2048;

// A failure with a short message for the owner. retry = true means "temporary, try again later"
// (the worker's backoff); anything else ends the link as link_only with this message as the reason.
export class WebFetchError extends Error {
  constructor(code, message, { retry = false } = {}) {
    super(message);
    this.code = code;
    this.retry = retry;
  }
}
const refused = (msg = 'Not a public web address') => new WebFetchError('refused', msg);

// ---- which addresses are refused ----
const V4_REFUSED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4],    // multicast
  ['240.0.0.0', 4],    // reserved, and 255.255.255.255 (broadcast)
];
const V6_REFUSED = [
  ['::', 96],          // ::, ::1 and the old IPv4-compatible ::a.b.c.d forms
  ['64:ff9b::', 96],   // NAT64: would reach any IPv4 address, internal ones included
  ['64:ff9b:1::', 48],
  ['100::', 64],       // discard-only
  ['2001::', 32],      // Teredo (hides an IPv4 address)
  ['2001:db8::', 32],  // documentation
  ['fc00::', 7],       // unique local
  ['fe80::', 10],      // link-local
  ['fec0::', 10],      // old site-local
  ['ff00::', 8],       // multicast
];
const V4 = new net.BlockList();
for (const [a, p] of V4_REFUSED) V4.addSubnet(a, p, 'ipv4');
const V6 = new net.BlockList();
for (const [a, p] of V6_REFUSED) V6.addSubnet(a, p, 'ipv6');

// The 16 bytes of an IPv6 address (already validated by net.isIPv6), or null.
export function ipv6Bytes(addr) {
  let s = String(addr);
  let tail = [];
  const dot = s.lastIndexOf('.');
  if (dot >= 0) {
    // a dotted IPv4 tail, as in ::ffff:127.0.0.1
    const colon = s.lastIndexOf(':');
    const v4 = s.slice(colon + 1);
    if (!net.isIPv4(v4)) return null;
    const p = v4.split('.').map(Number);
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    s = s.slice(0, colon);
    if (s.endsWith(':')) s += ':';   // "::1.2.3.4" keeps its "::"
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (x) => (x ? x.split(':').filter((g) => g !== '').map((g) => parseInt(g, 16)) : []);
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - rest.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...new Array(fill).fill(0), ...rest, ...tail];
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  const b = new Uint8Array(16);
  groups.forEach((g, i) => { b[i * 2] = g >> 8; b[i * 2 + 1] = g & 0xff; });
  return b;
}

// An IPv4 address hidden inside an IPv6 one (mapped ::ffff:a.b.c.d, SIIT ::ffff:0:a.b.c.d, 6to4 2002:ab:cd::).
function embeddedV4(b) {
  const zero = (from, to) => { for (let i = from; i < to; i++) if (b[i] !== 0) return false; return true; };
  const at = (i) => `${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}`;
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return at(12);
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return at(12);
  if (b[0] === 0x20 && b[1] === 0x02) return at(2);
  return null;
}

// true when the vault must not connect to this address. Anything that is not a plain IP is refused.
export function isRefusedAddress(addr) {
  const a = String(addr || '');
  if (a.includes('%')) return true;   // a zone id only exists on link-local addresses
  const fam = net.isIP(a);
  if (fam === 4) return V4.check(a, 'ipv4');
  if (fam !== 6) return true;
  if (V6.check(a, 'ipv6')) return true;
  const b = ipv6Bytes(a);
  if (!b) return true;
  const v4 = embeddedV4(b);
  return !!(v4 && V4.check(v4, 'ipv4'));
}

// Names that only mean something inside a network (Docker service names have no dot at all).
const LOCAL_SUFFIX = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa|in-addr\.arpa|ip6\.arpa)$/i;

// Check an address before anything is resolved. Returns { url, host, ip } (ip set for IP literals).
// IP literals in decimal, octal or hex spellings (https://2130706433/, https://0x7f.1/) are already
// turned into dotted form by the URL parser, so they are checked like any other IP.
export function checkUrl(raw) {
  const s = String(raw ?? '');
  if (s.length > MAX_URL) throw new WebFetchError('bad_url', 'The address is too long');
  let u;
  try { u = new URL(s); } catch { throw new WebFetchError('bad_url', 'Not a valid web address'); }
  if (u.protocol !== 'https:') throw refused('Only https pages are read');
  if (u.username || u.password) throw refused('Addresses with a user name or password are not read');
  if (u.port && u.port !== '443') throw refused('Only the normal https port (443) is allowed');
  let host = u.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) throw new WebFetchError('bad_url', 'Not a valid web address');
  if (net.isIP(host)) {
    if (isRefusedAddress(host)) throw refused();
    return { url: u, host, ip: host };
  }
  const name = host.replace(/\.$/, '').toLowerCase();
  if (!name.includes('.') || LOCAL_SUFFIX.test(name) || name.length > 253) throw refused();
  return { url: u, host: name, ip: null };
}

// Resolve a name and refuse it when ANY answer is not public: a name that points at both a public and a
// private address is someone's trick, and we would not know which one a later connection would use.
// The lookup counts against the page's deadline: a slow resolver can't hold the single worker past it.
export async function resolvePublic(host, lookup = dns.promises.lookup, deadline = Infinity) {
  let answers;
  let timer = null;
  try {
    const asked = lookup(host, { all: true, verbatim: true });
    if (Number.isFinite(deadline)) {
      const slow = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new WebFetchError('slow', 'The site took too long to answer', { retry: true })),
          Math.max(0, deadline - Date.now()));
      });
      Promise.resolve(asked).catch(() => {});   // a lookup that fails after the deadline is not an unhandled rejection
      answers = await Promise.race([asked, slow]);
    } else answers = await asked;
  } catch (e) {
    if (e instanceof WebFetchError) throw e;
    if (e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA')) throw new WebFetchError('dns', "This site's name doesn't exist");
    throw new WebFetchError('dns', "Couldn't look up the site", { retry: true });
  } finally {
    clearTimeout(timer);
  }
  if (!Array.isArray(answers) || !answers.length) throw new WebFetchError('dns', "This site's name doesn't exist");
  for (const a of answers.slice(0, 64)) if (!a || isRefusedAddress(a.address)) throw refused();
  if (answers.length > 64) throw refused();
  const a = answers[0];
  return { address: a.address, family: net.isIP(a.address) };
}

// A lookup for https.request that ignores DNS and always answers with the address we checked.
// Node may ask for one answer or (with autoSelectFamily) for a list, so both shapes are served.
export function pinnedLookup(vetted) {
  return function lookup(hostname, opts, cb) {
    const done = typeof opts === 'function' ? opts : cb;
    const o = typeof opts === 'object' && opts ? opts : {};
    if (o.all) done(null, [{ address: vetted.address, family: vetted.family }]);
    else done(null, vetted.address, vetted.family);
  };
}

const TLS_CODES = /^(CERT_|ERR_TLS_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_SSL)/;
function netError(e) {
  if (e instanceof WebFetchError) return e;
  const code = String((e && e.code) || '');
  if (TLS_CODES.test(code)) return new WebFetchError('tls', "The site's security certificate isn't valid");
  return new WebFetchError('network', "Couldn't connect to the site", { retry: true });
}

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
export const mimeOf = (ct) => String(ct || '').split(';')[0].trim().toLowerCase();

// One GET to an already checked address. Resolves { redirect } for a 3xx with a Location,
// { status } for other non-2xx answers, or { status, contentType, body: Buffer } for a page.
function requestOnce(target, vetted, { request, deadline, maxBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    let res = null;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        // stop the download and the connection; errors from the teardown are expected and ignored
        try { if (res) res.destroy(); } catch { /* ignore */ }
        try { if (req) req.destroy(); } catch { /* ignore */ }
        reject(err);
      } else resolve(val);
    };
    const left = Math.max(0, deadline - Date.now());
    const timer = setTimeout(() => finish(new WebFetchError('slow', 'The site took too long to answer', { retry: true })), left);
    const ipHost = net.isIP(target.host) !== 0;
    try {
      req = request({
        protocol: 'https:',
        hostname: target.host,
        port: 443,
        path: `${target.url.pathname}${target.url.search}` || '/',
        method: 'GET',
        headers: {
          'User-Agent': WEB_UA,
          Accept: 'text/html,application/xhtml+xml;q=0.9',
          'Accept-Language': 'en;q=0.9, *;q=0.5',
          // no deflate: some servers send it without the zlib header, which zlib can't read
          'Accept-Encoding': 'gzip, br',
        },
        lookup: pinnedLookup(vetted),     // connect to the checked address only
        servername: ipHost ? undefined : target.host,   // SNI and the certificate check use the real name
        agent: false,                     // no shared sockets: each request is pinned on its own
        rejectUnauthorized: true,
      }, (r) => {
        res = r;
        onResponse(r);
      });
    } catch (e) { finish(netError(e)); return; }
    req.on('error', (e) => finish(netError(e)));
    req.end();

    function onResponse(r) {
      const status = Number(r.statusCode) || 0;
      const h = r.headers || {};
      if (status >= 300 && status < 400 && h.location) {
        finish(null, { redirect: String(h.location) });
        try { r.destroy(); } catch { /* not needed any more */ }
        return;
      }
      if (status < 200 || status >= 300) {
        finish(null, { status });
        try { r.destroy(); } catch { /* not needed any more */ }
        return;
      }
      const contentType = String(h['content-type'] || '');
      if (!HTML_TYPES.has(mimeOf(contentType))) {
        const shown = mimeOf(contentType).replace(/[^\w.+/-]/g, '').slice(0, 60) || 'unknown';
        finish(new WebFetchError('not_html', `Not a web page (${shown})`));
        return;
      }
      if (Number(h['content-length']) > maxBytes) { finish(tooLarge()); return; }
      let stream = r;
      const enc = String(h['content-encoding'] || '').trim().toLowerCase();
      if (enc && enc !== 'identity') {
        // the 3 MB cap counts the unpacked bytes too, so a small "zip bomb" can't fill the memory
        const unpack = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip()
          : enc === 'deflate' ? zlib.createInflate() : enc === 'br' ? zlib.createBrotliDecompress() : null;
        if (!unpack) { finish(new WebFetchError('encoding', 'The page uses an unknown compression')); return; }
        unpack.on('error', () => finish(new WebFetchError('encoding', "The page's compression is broken")));
        let packed = 0;
        r.on('data', (c) => { packed += c.length; if (packed > maxBytes) finish(tooLarge()); });
        r.pipe(unpack);
        stream = unpack;
      }
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => {
        if (settled) return;
        size += c.length;
        if (size > maxBytes) { finish(tooLarge()); try { stream.destroy(); } catch { /* ignore */ } return; }
        chunks.push(c);
      });
      stream.on('end', () => finish(null, { status, contentType, body: Buffer.concat(chunks) }));
      stream.on('error', (e) => finish(netError(e)));
      r.on('aborted', () => finish(new WebFetchError('network', 'The download was cut off', { retry: true })));
    }
  });
}
const tooLarge = () => new WebFetchError('too_large', 'The page is too large (over 3 MB)');

function statusError(status) {
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return new WebFetchError('status', `The site answered ${status}`, { retry: true });
  }
  if (status === 401 || status === 403 || status === 451) return new WebFetchError('blocked', 'The site refused to show the page');
  if (status === 404 || status === 410) return new WebFetchError('gone', "The page wasn't found");
  return new WebFetchError('status', `The site answered ${status}`);
}

// Fetch a page. Returns { status, finalUrl, contentType, charset, html, bytes }; throws WebFetchError.
// lookup and request are only replaced in tests (a fake resolver and fake connections).
export async function safeFetch(rawUrl, {
  lookup = dns.promises.lookup, request = https.request,
  timeoutMs = PAGE_TIMEOUT_MS, maxBytes = MAX_PAGE_BYTES, maxRedirects = MAX_REDIRECTS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let cur = String(rawUrl ?? '');
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const target = checkUrl(cur);          // every hop is checked from scratch
    const vetted = target.ip ? { address: target.ip, family: net.isIP(target.ip) } : await resolvePublic(target.host, lookup, deadline);
    if (Date.now() >= deadline) throw new WebFetchError('slow', 'The site took too long to answer', { retry: true });
    const r = await requestOnce(target, vetted, { request, deadline, maxBytes });
    if (r.redirect !== undefined) {
      let next;
      try { next = new URL(r.redirect, target.url); } catch { throw new WebFetchError('redirect', 'The site sent a broken redirect'); }
      cur = next.href;
      continue;
    }
    if (r.status < 200 || r.status >= 300 || !r.body) throw statusError(r.status);
    const { text, charset } = decodeHtml(r.body, r.contentType);
    return { status: r.status, finalUrl: target.url.href, contentType: mimeOf(r.contentType), charset, html: text, bytes: r.body.length };
  }
  throw new WebFetchError('redirects', 'Too many redirects');
}

// ---- text decoding ----
function decoderFor(label) {
  const l = String(label || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!l || l.length > 40) return null;
  // a page that is ASCII-readable can't really be UTF-16; browsers read such a claim as UTF-8
  if (/^utf-?16/.test(l)) return { dec: new TextDecoder('utf-8'), name: 'utf-8' };
  try {
    const dec = new TextDecoder(l);
    return { dec, name: dec.encoding };
  } catch { return null; }
}

// Bytes to text: a BOM first, then the Content-Type charset, then <meta charset> near the top, then UTF-8.
// iso-8859-1 is read as windows-1252, like browsers do.
export function decodeHtml(buf, contentType = '') {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  let pick = null;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) pick = { dec: new TextDecoder('utf-8'), name: 'utf-8' };
  else if (b[0] === 0xff && b[1] === 0xfe) pick = { dec: new TextDecoder('utf-16le'), name: 'utf-16le' };
  else if (b[0] === 0xfe && b[1] === 0xff) pick = { dec: new TextDecoder('utf-16be'), name: 'utf-16be' };
  if (!pick) {
    const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(String(contentType));
    if (m) pick = decoderFor(m[1]);
  }
  if (!pick) {
    const head = b.subarray(0, 4096).toString('latin1');
    const m = /<meta[^>]{0,200}?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
    if (m) pick = decoderFor(m[1]);
  }
  if (!pick) pick = { dec: new TextDecoder('utf-8'), name: 'utf-8' };
  return { text: pick.dec.decode(b), charset: pick.name };
}
