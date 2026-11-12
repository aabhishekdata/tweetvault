// OAuth 2.1 for the MCP endpoint, so claude.ai (web, desktop, mobile) and Claude Code can connect to
// /mcp as a custom connector. Single owner, hand-written, no dependencies.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728 protected resource metadata
//   GET  /.well-known/oauth-authorization-server       RFC 8414 authorization server metadata
//   POST /oauth/register                               RFC 7591 dynamic registration (public clients only)
//   GET  /oauth/authorize                              consent page (behind password + two-step sign-in)
//   POST /oauth/authorize/decision                     Allow / Deny from that page
//   POST /oauth/token                                  authorization_code (S256 PKCE) and refresh_token (rotating)
//   POST /oauth/revoke                                 RFC 7009
//
// Only two kinds of redirect URI can ever be registered: claude.ai's callback and a loopback
// http://localhost|127.0.0.1[:port]/callback (Claude Code, matched on any port). No Client ID Metadata
// Documents, so nothing here ever fetches a URL. Codes and tokens are stored only as SHA-256 hashes.
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { now, tx } from './db.js';
import { sha256, sourceKey, plainIp } from './auth.js';
import { audit } from './audit.js';

export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1)(?::([1-9]\d{0,4}))?\/callback$/;
export const SCOPE_READ = 'vault.read';
const SCOPES = [SCOPE_READ, 'offline_access'];
export const ACCESS_TTL = 3600;              // 1 hour
export const REFRESH_TTL = 30 * 86400;       // 30 days
export const CODE_TTL = 60;                  // 60 seconds, single use
export const CSRF_TTL = 10 * 60;             // the consent page's form
export const MAX_CLIENTS = 200;
export const CLIENT_GRACE = 15 * 60;         // a registration this young is never pruned (sign-in time plus the consent form)
export const SEEN_GRACE = 86400;             // nor one that reached the consent page within a day
export const CLIENT_IDLE = 30 * 86400;       // housekeeping removes a registration with no live connection after this long idle
const MAX_REDIRECTS = 10;
const MAX_REDIRECT_LEN = 200;
const NAME_MAX = 100;
const REG_MAX_BODY = 16 * 1024;
const FORM_MAX_BODY = 16 * 1024;
const STATE_MAX = 1024;
const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const ACCESS_RE = /^Bearer\s+(tva_[A-Za-z0-9_-]{20,})$/i;

const newSecret = (prefix) => `${prefix}${randomBytes(32).toString('base64url')}`;

// Anthropic's published egress range: claude.ai registers and fetches tokens from here, for every claude.ai
// user at once, so it gets its own (much larger) buckets instead of sharing one per-address bucket.
const ANTHROPIC = new BlockList();
ANTHROPIC.addSubnet('160.79.104.0', 21, 'ipv4');
export function isAnthropicIp(ip) {
  const s = plainIp(ip);
  const v = isIP(s);
  if (!v) return false;
  try { return ANTHROPIC.check(s, v === 6 ? 'ipv6' : 'ipv4'); } catch { return false; }
}
// the rate-limit bucket for an address
const bucketOf = (ip) => (isAnthropicIp(ip) ? 'anthropic' : sourceKey(ip));

// A registration that may be removed to make room or by housekeeping: no live connection (no grant, or only
// removed ones), not just made, and not at the consent page lately. SQL over the alias c, with ? = now.
const PRUNABLE = `NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id AND g.revoked_at IS NULL)
    AND c.created_at <= ? - ${CLIENT_GRACE} AND (c.seen_at IS NULL OR c.seen_at <= ? - ${SEEN_GRACE})`;

// Delete a client if nothing live is left under it (call inside a transaction). Its removed grants, codes
// and tokens go with it (ON DELETE CASCADE).
export function deleteClientIfUnused(db, clientId) {
  // ...unless a new consent is under way: the consent page was shown after its latest grant was made, within
  // CLIENT_GRACE. That Allow must still work. (The page is always shown before its own grant, so an app
  // removed right after connecting is still deleted.)
  return Number(db.prepare(`DELETE FROM oauth_clients WHERE client_id = ? AND NOT EXISTS
      (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id AND g.revoked_at IS NULL)
      AND NOT (COALESCE(seen_at, 0) >= ? AND COALESCE(seen_at, 0) >
        COALESCE((SELECT MAX(g.created_at) FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id), 0))`)
    .run(clientId, now() - CLIENT_GRACE).changes);
}

// The registrations housekeeping removes (call inside a transaction): never used, never at the consent page
// and over a day old; or nothing live left and idle for 30 days.
export function pruneClients(db, t = now()) {
  return Number(db.prepare(`DELETE FROM oauth_clients WHERE client_id IN (SELECT c.client_id FROM oauth_clients c WHERE
      NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id AND g.revoked_at IS NULL)
      AND ((c.last_used_at IS NULL AND c.seen_at IS NULL AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id)
            AND c.created_at < ?)
        OR MAX(c.created_at, COALESCE(c.last_used_at, 0), COALESCE(c.seen_at, 0)) < ?))`).run(t - 86400, t - CLIENT_IDLE).changes);
}

// Revoke connections that can no longer be used: no refresh token left that is unexpired, unspent and not
// revoked (call inside a transaction). Grants younger than a day are left alone (a code may still be redeemed).
export function revokeDeadGrants(db, t = now(), onRevoke = () => {}) {
  const dead = db.prepare(`SELECT id FROM oauth_grants g WHERE g.revoked_at IS NULL AND g.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM oauth_tokens k WHERE k.grant_id = g.id AND k.kind = 'refresh'
        AND k.expires_at > ? AND k.used_at IS NULL AND k.revoked_at IS NULL)`).all(t - 86400, t);
  let n = 0;
  for (const g of dead) {
    const k = revokeGrant(db, g.id, t);
    if (k) onRevoke(g.id);
    n += k;
  }
  return n;
}

// a registered redirect URI, or null: { kind: 'claude' } or { kind: 'loopback', host, port }
export function redirectKind(u) {
  if (typeof u !== 'string') return null;
  if (u === CLAUDE_CALLBACK) return { kind: 'claude' };
  const m = LOOPBACK.exec(u);
  if (!m) return null;
  const port = m[2] === undefined ? null : Number(m[2]);
  if (port !== null && port > 65535) return null;
  return { kind: 'loopback', host: m[1], port };
}

// exact match, or (RFC 8252 7.3) a loopback URI on the same host with any port
export function redirectMatches(registered, given) {
  const g = redirectKind(given);
  if (!g) return false;
  if (registered.includes(given)) return true;
  if (g.kind !== 'loopback') return false;
  return registered.some((r) => { const k = redirectKind(r); return !!k && k.kind === 'loopback' && k.host === g.host; });
}

const cleanName = (s) => Array.from(String(s).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim()).slice(0, NAME_MAX).join('').trim();

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const t = Date.now();
    if (hits.size > 5000) for (const [k, l] of hits) if (!l.length || t - l[l.length - 1] >= windowMs) hits.delete(k);
    const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length >= max) { hits.set(key, list); return Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000)); }
    list.push(t);
    hits.set(key, list);
    return 0;
  };
}

class BodyError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readBody(req, max, type) {
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== type) throw new BodyError(400, `Send the request as ${type}.`);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) throw new BodyError(413, 'The request is too large.');
  const chunks = [];
  let size = 0;
  for await (const ch of req) {
    size += ch.length;
    if (size > max) throw new BodyError(413, 'The request is too large.');
    chunks.push(ch);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// form or query parameters: first value of each, and the names that came more than once
function params(sp) {
  const v = Object.create(null);
  const dup = new Set();
  for (const [k, val] of sp) { if (k in v) dup.add(k); else v[k] = val; }
  return { v, dup };
}

// The grant that an access token belongs to, or null (unknown, expired, revoked, or its app removed).
export function accessFromBearer(db, header) {
  const m = ACCESS_RE.exec(String(header || ''));
  if (!m) return null;
  const r = db.prepare(`SELECT t.expires_at, t.revoked_at, g.id AS grant_id, g.scope, g.revoked_at AS grant_revoked,
      g.last_used_at, c.client_id, c.name FROM oauth_tokens t
      JOIN oauth_grants g ON g.id = t.grant_id JOIN oauth_clients c ON c.client_id = g.client_id
      WHERE t.token_hash = ? AND t.kind = 'access'`).get(sha256(m[1]));
  const t = now();
  if (!r || r.revoked_at || r.grant_revoked || r.expires_at <= t) return null;
  if (t - (r.last_used_at || 0) > 60) {
    db.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').run(t, r.grant_id);
    db.prepare('UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?').run(t, r.client_id);
  }
  return { grantId: r.grant_id, name: r.name || 'Connected app', scopeSet: new Set(String(r.scope).split(' ')) };
}
export const isOAuthBearer = (header) => /^Bearer\s+tva_/i.test(String(header || ''));

// Revoke a grant and everything issued under it (call inside a transaction).
export function revokeGrant(db, grantId, t = now()) {
  const n = Number(db.prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(t, grantId).changes);
  db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(t, grantId);
  db.prepare('UPDATE oauth_codes SET used_at = ? WHERE grant_id = ? AND used_at IS NULL').run(t, grantId);
  return n;
}

export function listGrants(db) {
  return db.prepare(`SELECT g.id, g.scope, g.created_at, g.last_used_at, g.redirect_kind, c.name, c.redirect_uris FROM oauth_grants g
      JOIN oauth_clients c ON c.client_id = g.client_id WHERE g.revoked_at IS NULL ORDER BY g.created_at DESC, g.id DESC`).all()
    .map((g) => {
      // where this consent's code actually went; a grant from before v7 falls back to the registration
      // (and to localhost when it lists a loopback address at all, the cautious answer)
      let kind = g.redirect_kind;
      if (kind !== 'claude' && kind !== 'loopback') {
        let uris = [];
        try { uris = JSON.parse(g.redirect_uris); } catch { /* keep empty */ }
        kind = uris.length && uris.every((u) => u === CLAUDE_CALLBACK) ? 'claude' : 'loopback';
      }
      return {
        id: g.id, name: g.name || 'Unnamed app', scope: g.scope, created_at: g.created_at, last_used_at: g.last_used_at,
        returns_to: kind === 'claude' ? 'claude.ai' : 'localhost',
      };
    });
}

// Adds the OAuth routes. issuer is the public origin (the first VAULT_ORIGINS entry).
export function installOAuth({ route, db, issuer, origins, secret, csp, fullSession, registerPerHour = 20, tokenPerMinute = 60,
  anthropicRegisterPerHour = 300, anthropicTokenPerMinute = 1500, registerGlobalPerHour = 500, reportError = () => {} }) {
  const RESOURCE = `${issuer}/mcp`;
  // per address (an IPv6 /64), except Anthropic's range, which shares one much larger bucket; plus a
  // ceiling on registrations from everywhere together, as a backstop against churn from many addresses
  const regLimit = limiter(registerPerHour, 3600_000);
  const regLimitAnthropic = limiter(anthropicRegisterPerHour, 3600_000);
  const regLimitAll = limiter(registerGlobalPerHour, 3600_000);
  const tokenLimit = limiter(tokenPerMinute, 60_000);
  const tokenLimitAnthropic = limiter(anthropicTokenPerMinute, 60_000);
  const regWait = (ip) => { const k = bucketOf(ip); return (k === 'anthropic' ? regLimitAnthropic : regLimit)(k); };
  // the global backstop counts only well-formed registrations (junk can't fill it) and never applies to
  // Anthropic's range, so strangers can't block claude.ai from connecting
  const regGlobalWait = (ip) => (bucketOf(ip) === 'anthropic' ? 0 : regLimitAll('all'));
  const tokenWait = (ip) => { const k = bucketOf(ip); return (k === 'anthropic' ? tokenLimitAnthropic : tokenLimit)(k); };

  // ---- responses ----
  const BASE = { 'X-Content-Type-Options': 'nosniff' };
  function json(res, status, body, headers = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      ...BASE, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(payload)),
      'Cache-Control': 'no-store', Pragma: 'no-cache', ...headers,
    });
    res.end(payload);
  }
  const oauthError = (res, status, error, description, headers) => json(res, status, { error, error_description: description }, headers);

  function html(res, status, body, { formAction = null } = {}) {
    const policy = formAction ? csp.replace("form-action 'self'", `form-action 'self' ${formAction}`) : csp;
    res.writeHead(status, {
      ...BASE, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)),
      'Cache-Control': 'no-store', Pragma: 'no-cache', 'Content-Security-Policy': policy,
      'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    });
    res.end(body);
  }
  function redirect(res, location) {
    res.writeHead(302, { ...BASE, Location: location, 'Content-Length': '0', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  }
  // back to the client with the answer (RFC 6749 4.1.2, plus iss from RFC 9207)
  function backTo(res, redirectUri, values, state) {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(values)) u.searchParams.set(k, v);
    if (state) u.searchParams.set('state', state);
    u.searchParams.set('iss', issuer);
    redirect(res, u.toString());
  }

  const page = (title, inner) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} · Tweet Vault</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main class="center"><div class="card narrow oauth">
${inner}
</div></main>
</body>
</html>
`;
  // a request that can't safely be sent back anywhere: say so here, never redirect
  const errorPage = (res, status, title, text) => html(res, status, page(title,
    `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(text)}</p>\n<p><a href="/">Open Tweet Vault</a></p>`));

  // ---- metadata ----
  const metaJson = (res, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(200, { ...BASE, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(payload)), 'Cache-Control': 'public, max-age=3600' });
    res.end(payload);
  };
  const resourceMeta = {
    resource: RESOURCE, authorization_servers: [issuer], scopes_supported: [SCOPE_READ],
    bearer_methods_supported: ['header'], resource_name: 'Tweet Vault',
  };
  const serverMeta = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SCOPES,
    authorization_response_iss_parameter_supported: true,
  };
  route('GET', '/\\.well-known/oauth-protected-resource', (req, ctx, res) => metaJson(res, resourceMeta));
  route('GET', '/\\.well-known/oauth-protected-resource/mcp', (req, ctx, res) => metaJson(res, resourceMeta));
  route('GET', '/\\.well-known/oauth-authorization-server', (req, ctx, res) => metaJson(res, serverMeta));

  // ---- dynamic client registration (RFC 7591) ----
  function checkRegistration(body) {
    const bad = (error, d) => ({ error, d });
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') {
      return bad('invalid_client_metadata', 'Only public clients are supported: token_endpoint_auth_method must be "none".');
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length) return bad('invalid_redirect_uri', 'Give at least one redirect URI.');
    if (uris.length > MAX_REDIRECTS) return bad('invalid_redirect_uri', `At most ${MAX_REDIRECTS} redirect URIs.`);
    for (const u of uris) {
      if (typeof u !== 'string' || u.length > MAX_REDIRECT_LEN || !redirectKind(u)) {
        return bad('invalid_redirect_uri', `Only ${CLAUDE_CALLBACK} and http://localhost[:port]/callback or http://127.0.0.1[:port]/callback are accepted.`);
      }
    }
    let grants = ['authorization_code', 'refresh_token'];
    if (body.grant_types !== undefined) {
      const g = body.grant_types;
      if (!Array.isArray(g) || !g.length || g.some((x) => !['authorization_code', 'refresh_token'].includes(x)) || !g.includes('authorization_code')) {
        return bad('invalid_client_metadata', 'grant_types can only be authorization_code and refresh_token.');
      }
      grants = [...new Set(g)];
    }
    if (body.response_types !== undefined) {
      const r = body.response_types;
      if (!Array.isArray(r) || !r.length || r.some((x) => x !== 'code')) return bad('invalid_client_metadata', 'response_types can only be "code".');
    }
    if (body.client_name !== undefined && body.client_name !== null && typeof body.client_name !== 'string') {
      return bad('invalid_client_metadata', 'client_name must be text.');
    }
    return { uris: [...new Set(uris)], grants, name: typeof body.client_name === 'string' ? cleanName(body.client_name) : '' };
  }

  route('POST', '/oauth/register', async (req, ctx, res) => {
    const wait = regWait(ctx.ip);
    if (wait) return oauthError(res, 429, 'temporarily_unavailable', 'Too many registrations from this address. Try again later.', { 'Retry-After': String(wait) });
    let body;
    try {
      const raw = await readBody(req, REG_MAX_BODY, 'application/json');
      body = JSON.parse(raw);
    } catch (e) {
      if (e instanceof BodyError) return oauthError(res, e.status, 'invalid_client_metadata', e.message, e.status === 413 ? { Connection: 'close' } : {});
      return oauthError(res, 400, 'invalid_client_metadata', 'The body is not valid JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return oauthError(res, 400, 'invalid_client_metadata', 'Send a JSON object.');
    const c = checkRegistration(body);
    if (c.error) return oauthError(res, 400, c.error, c.d);
    const gwait = regGlobalWait(ctx.ip);
    if (gwait) return oauthError(res, 429, 'temporarily_unavailable', 'Too many new app registrations right now. Try again later.', { 'Retry-After': String(gwait) });
    const t = now();
    const clientId = newSecret('tvc_');
    const ok = tx(db, () => {
      const n = db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get().n;
      if (n >= MAX_CLIENTS) {
        // make room: registrations with no live connection that are not in use right now (see PRUNABLE),
        // never-used ones first, then the longest idle. When every one is fresh, refuse instead (503).
        db.prepare(`DELETE FROM oauth_clients WHERE client_id IN (SELECT client_id FROM oauth_clients c WHERE ${PRUNABLE}
            ORDER BY (c.last_used_at IS NOT NULL), MAX(c.created_at, COALESCE(c.last_used_at, 0), COALESCE(c.seen_at, 0)), c.rowid
            LIMIT ?)`).run(t, t, n - MAX_CLIENTS + 1);
        if (db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get().n >= MAX_CLIENTS) return false;
      }
      db.prepare('INSERT INTO oauth_clients (client_id, name, redirect_uris, grant_types, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(clientId, c.name || null, JSON.stringify(c.uris), JSON.stringify(c.grants), t);
      return true;
    });
    if (!ok) return oauthError(res, 503, 'temporarily_unavailable', 'Too many apps are registered or connecting right now. Try again in 15 minutes, or remove apps under Security.', { 'Retry-After': String(CLIENT_GRACE) });
    return json(res, 201, {
      client_id: clientId, client_id_issued_at: t, ...(c.name ? { client_name: c.name } : {}),
      redirect_uris: c.uris, grant_types: c.grants, response_types: ['code'], token_endpoint_auth_method: 'none',
    });
  });

  // ---- authorization ----
  const clientById = (id) => (typeof id === 'string' && id.length <= 100 ? db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(id) : null);
  const UNKNOWN_CLIENT = 'This app is not registered with the vault (or its registration expired). '
    + 'In Claude Code: run /mcp, choose the vault server, clear its saved sign-in (authentication), then connect again. '
    + 'In claude.ai: remove the connector under Customize, Connectors, then add it again.';
  // the owner has this registration in front of them (the consent page, or Deny): keep it
  const markSeen = (clientId) => db.prepare('UPDATE oauth_clients SET seen_at = ? WHERE client_id = ?').run(now(), clientId);
  const urisOf = (client) => { try { return JSON.parse(client.redirect_uris); } catch { return []; } };

  // client_id and redirect_uri first: if either is wrong, nothing may be sent anywhere
  function checkClient(v, dup) {
    if (dup.has('client_id') || dup.has('redirect_uri')) return { error: 'The sign-in link repeats client_id or redirect_uri.' };
    const client = clientById(v.client_id);
    if (!client) return { error: UNKNOWN_CLIENT };
    if (!v.redirect_uri || !redirectMatches(urisOf(client), v.redirect_uri)) return { error: 'The address to send you back to does not match the app\'s registration.' };
    return { client, redirectUri: v.redirect_uri };
  }

  // the rest of the request; errors from here on go back to the client
  function checkRequest(v, dup) {
    const state = typeof v.state === 'string' && v.state.length <= STATE_MAX ? v.state : '';
    const err = (error, d) => ({ error, d, state });
    if (dup.size) return err('invalid_request', `Repeated parameter: ${[...dup][0]}.`);
    if (typeof v.state === 'string' && v.state.length > STATE_MAX) return err('invalid_request', 'state is too long.');
    if (!v.response_type) return err('invalid_request', 'response_type is missing.');
    if (v.response_type !== 'code') return err('unsupported_response_type', 'Only response_type=code is supported.');
    if (!v.code_challenge) return err('invalid_request', 'PKCE is required: send code_challenge.');
    if (!CHALLENGE.test(v.code_challenge)) return err('invalid_request', 'code_challenge must be 43-128 base64url characters.');
    if (v.code_challenge_method !== 'S256') return err('invalid_request', 'code_challenge_method must be S256.');
    const asked = String(v.scope ?? '').split(' ').filter(Boolean);
    if (asked.some((s) => !SCOPES.includes(s))) return err('invalid_scope', `Scopes can only be ${SCOPES.join(' and ')}.`);
    const scope = [SCOPE_READ, ...(asked.includes('offline_access') ? ['offline_access'] : [])].join(' ');
    if (v.resource !== undefined && v.resource !== RESOURCE) return err('invalid_target', `resource must be ${RESOURCE}.`);
    return { state, scope, challenge: v.code_challenge, resource: v.resource === undefined ? '' : v.resource };
  }

  // The consent form's token: an HMAC over the session and every request parameter, valid 10 minutes.
  const csrfMac = (sessionHash, exp, f) => createHmac('sha256', secret)
    .update(JSON.stringify(['tv-oauth-consent', sessionHash, exp, f.client_id, f.redirect_uri, f.scope, f.code_challenge, f.state, f.resource]))
    .digest('base64url');
  const csrfToken = (sessionHash, f) => { const exp = now() + CSRF_TTL; return `${exp}.${csrfMac(sessionHash, exp, f)}`; };
  function csrfOk(sessionHash, token, f) {
    const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
    if (!m) return false;
    const exp = Number(m[1]);
    if (exp < now()) return false;
    const want = Buffer.from(csrfMac(sessionHash, exp, f));
    const got = Buffer.from(m[2]);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  function consentPage(client, redirectUri, r, sessionHash) {
    const k = redirectKind(redirectUri);
    const fields = { client_id: client.client_id, redirect_uri: redirectUri, scope: r.scope, code_challenge: r.challenge, state: r.state, resource: r.resource };
    const hidden = Object.entries({ ...fields, csrf: csrfToken(sessionHash, fields) })
      .map(([n, val]) => `<input type="hidden" name="${n}" value="${escapeHtml(val)}">`).join('\n');
    const name = client.name
      ? `An app that calls itself <strong class="oauth-name">${escapeHtml(client.name)}</strong> wants to connect to your vault.`
      : 'An app that gave no name wants to connect to your vault.';
    const where = k.kind === 'claude'
      ? '<p>claude.ai</p>'
      : `<p>A program on this computer (localhost${k.port ? `, port ${k.port}` : ''})</p>
<p class="oauth-warn" role="note">Any program running on this computer can claim to be Claude Code. Only allow this if you started connecting Claude Code yourself just now.</p>`;
    const inner = `<h1>Connect to your vault?</h1>
<p>${name}</p>
<p class="muted small">Anyone can give an app any name. Only allow this if you just started connecting it yourself.</p>
<h2 class="oauth-h">It can</h2>
<p>Read your collections and saved items. It cannot save, change or delete anything.</p>
<h2 class="oauth-h">You go back to</h2>
${where}
<p class="muted small">It stays connected until you remove it under Security, Connect Claude, Connected apps.</p>
<form method="post" action="/oauth/authorize/decision">
${hidden}
<div class="oauth-btns">
<button type="submit" class="btn primary" name="decision" value="allow">Allow</button>
<button type="submit" class="btn" name="decision" value="deny">Deny</button>
</div>
</form>`;
    return { body: page('Connect to your vault?', inner), formAction: new URL(redirectUri).origin };
  }

  route('GET', '/oauth/authorize', (req, ctx, res, p, url) => {
    const { v, dup } = params(url.searchParams);
    const c = checkClient(v, dup);
    if (c.error) return errorPage(res, 400, 'This connection link does not work', c.error);
    const r = checkRequest(v, dup);
    if (r.error) return backTo(res, c.redirectUri, { error: r.error, error_description: r.d }, r.state);
    // not signed in (or the cookie stayed behind on the cross-site hop from Claude): the page signs in,
    // then comes back here (app.js reads ?next=)
    if (!fullSession(ctx)) return redirect(res, `/?next=${encodeURIComponent(url.pathname + url.search)}`);
    markSeen(c.client.client_id);
    const pg = consentPage(c.client, c.redirectUri, r, ctx.session.id_hash);
    return html(res, 200, pg.body, { formAction: pg.formAction });
  });

  // A same-origin POST. Browsers send "Origin: null" for a form POST when the page's Referrer-Policy is
  // no-referrer (Nginx sets that site-wide), so then Sec-Fetch-Site (which pages can't forge) must say same-origin.
  function sameOriginPost(req) {
    const o = req.headers.origin;
    if (o !== undefined && o !== 'null') return origins.includes(o);
    return req.headers['sec-fetch-site'] === 'same-origin';
  }

  route('POST', '/oauth/authorize/decision', async (req, ctx, res) => {
    if (!sameOriginPost(req)) return errorPage(res, 403, 'Not allowed', 'This answer did not come from the vault\'s own page.');
    if (!fullSession(ctx)) return errorPage(res, 401, 'Signed out', 'You are signed out of the vault. Start connecting again from Claude.');
    let f;
    try { f = params(new URLSearchParams(await readBody(req, FORM_MAX_BODY, 'application/x-www-form-urlencoded'))); } catch (e) {
      return errorPage(res, e instanceof BodyError ? e.status : 400, 'Something is wrong with this answer', 'Start connecting again from Claude.');
    }
    const { v, dup } = f;
    if (dup.size) return errorPage(res, 400, 'Something is wrong with this answer', 'Start connecting again from Claude.');
    const fields = { client_id: v.client_id, redirect_uri: v.redirect_uri, scope: v.scope, code_challenge: v.code_challenge, state: v.state ?? '', resource: v.resource ?? '' };
    if (!csrfOk(ctx.session.id_hash, v.csrf, fields)) {
      audit(db, 'oauth_consent_refused', { ok: false, ip: ctx.ip, ua: ctx.ua, detail: 'consent form expired, changed or from another sign-in' });
      return errorPage(res, 403, 'This page expired', 'The connection page expired or was changed. Start connecting again from Claude.');
    }
    const c = checkClient(v, new Set());
    if (c.error) return errorPage(res, 400, 'This connection does not work', c.error);
    // the signed values come back as they were checked on the consent page; check them again anyway
    const r = checkRequest({ response_type: 'code', code_challenge_method: 'S256', code_challenge: v.code_challenge, scope: v.scope,
      state: v.state, ...(v.resource ? { resource: v.resource } : {}) }, new Set());
    if (r.error) return backTo(res, c.redirectUri, { error: r.error, error_description: r.d }, r.state);
    const name = c.client.name || 'Unnamed app';
    if (v.decision === 'deny') {
      markSeen(c.client.client_id);
      audit(db, 'oauth_consent_denied', { ip: ctx.ip, ua: ctx.ua, detail: name });
      return backTo(res, c.redirectUri, { error: 'access_denied', error_description: 'The owner said no.' }, r.state);
    }
    if (v.decision !== 'allow') return errorPage(res, 400, 'Something is wrong with this answer', 'Choose Allow or Deny.');
    const code = randomBytes(32).toString('base64url');
    const t = now();
    tx(db, () => {
      const g = db.prepare('INSERT INTO oauth_grants (client_id, scope, created_at, redirect_kind) VALUES (?, ?, ?, ?)')
        .run(c.client.client_id, r.scope, t, redirectKind(c.redirectUri).kind);
      db.prepare(`INSERT INTO oauth_codes (code_hash, grant_id, client_id, redirect_uri, code_challenge, scope, resource, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sha256(code), Number(g.lastInsertRowid), c.client.client_id, c.redirectUri, r.challenge, r.scope, r.resource || null, t + CODE_TTL);
      db.prepare('UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?').run(t, c.client.client_id);
    });
    audit(db, 'oauth_consent_granted', { ip: ctx.ip, ua: ctx.ua, detail: `${name} (${redirectKind(c.redirectUri).kind === 'claude' ? 'claude.ai' : 'localhost'})` });
    return backTo(res, c.redirectUri, { code }, r.state);
  });

  // ---- tokens ----
  function issueTokens(grantId, scope, clientId) {
    const t = now();
    const access = newSecret('tva_');
    const refresh = newSecret('tvr_');
    const ins = db.prepare('INSERT INTO oauth_tokens (token_hash, grant_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)');
    ins.run(sha256(access), grantId, 'access', t, t + ACCESS_TTL);
    ins.run(sha256(refresh), grantId, 'refresh', t, t + REFRESH_TTL);
    db.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').run(t, grantId);
    db.prepare('UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?').run(t, clientId);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope };
  }

  const pkceOk = (verifier, challenge) => {
    const want = Buffer.from(challenge);
    const got = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
    return want.length === got.length && timingSafeEqual(want, got);
  };

  function exchangeCode(v, client, ctx) {
    for (const k of ['code', 'redirect_uri', 'code_verifier']) if (!v[k]) return { status: 400, error: 'invalid_request', d: `${k} is missing.` };
    if (v.resource !== undefined && v.resource !== RESOURCE) return { status: 400, error: 'invalid_target', d: `resource must be ${RESOURCE}.` };
    if (!VERIFIER.test(v.code_verifier)) return { status: 400, error: 'invalid_grant', d: 'code_verifier is malformed.' };
    const bad = (d) => ({ status: 400, error: 'invalid_grant', d });
    let reused = null;
    const out = tx(db, () => {
      const t = now();
      const c = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(sha256(v.code));
      if (!c) return bad('Unknown or expired code.');
      if (c.used_at) {
        // a code used twice: someone else may have it, so everything from this consent stops working
        if (revokeGrant(db, c.grant_id, t)) reused = c.grant_id;
        return bad('This code was already used.');
      }
      if (c.expires_at <= t) return bad('The code expired.');
      if (c.client_id !== client.client_id) return bad('The code was issued to another client.');
      if (c.redirect_uri !== v.redirect_uri) return bad('redirect_uri does not match the one used to get the code.');
      if (!pkceOk(v.code_verifier, c.code_challenge)) return bad('code_verifier does not match the code_challenge.');
      const g = db.prepare('SELECT * FROM oauth_grants WHERE id = ?').get(c.grant_id);
      if (!g || g.revoked_at) return bad('This connection was removed.');
      db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?').run(t, c.code_hash);
      return { tokens: issueTokens(g.id, g.scope, client.client_id) };
    });
    if (reused) audit(db, 'oauth_code_reuse', { ok: false, ip: ctx.ip, ua: ctx.ua, detail: `${client.name || 'Unnamed app'}: connection removed` });
    return out;
  }

  function refreshTokens(v, client, ctx) {
    if (!v.refresh_token) return { status: 400, error: 'invalid_request', d: 'refresh_token is missing.' };
    const asked = v.scope === undefined ? null : String(v.scope).split(' ').filter(Boolean);
    const bad = (d) => ({ status: 400, error: 'invalid_grant', d });
    let reused = false;
    let expired = false;
    const out = tx(db, () => {
      const t = now();
      const r = db.prepare(`SELECT t.*, g.client_id, g.scope, g.revoked_at AS grant_revoked FROM oauth_tokens t
          JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ? AND t.kind = 'refresh'`).get(sha256(v.refresh_token));
      if (!r) return bad('Unknown refresh token.');
      if (r.client_id !== client.client_id) return bad('The refresh token was issued to another client.');
      if (r.grant_revoked || r.revoked_at) return bad('This connection was removed.');
      if (r.used_at) {
        // a spent refresh token came back: it was copied, so the whole connection is revoked
        revokeGrant(db, r.grant_id, t);
        reused = true;
        return bad('This refresh token was already used.');
      }
      if (r.expires_at <= t) {
        // the last way to renew this connection has run out: end it, so Connected apps lists only live ones
        expired = revokeGrant(db, r.grant_id, t) > 0;
        return bad('The refresh token expired.');
      }
      const have = r.scope.split(' ');
      if (asked && asked.some((s) => !have.includes(s))) return { status: 400, error: 'invalid_scope', d: 'That is more than was allowed.' };
      db.prepare('UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ?').run(t, r.token_hash);
      return { tokens: issueTokens(r.grant_id, r.scope, client.client_id) };
    });
    if (expired) audit(db, 'oauth_grant_expired', { ip: ctx.ip, ua: ctx.ua, detail: `${client.name || 'Unnamed app'}: refresh token expired, connection removed` });
    if (reused) audit(db, 'oauth_refresh_reuse', { ok: false, ip: ctx.ip, ua: ctx.ua, detail: `${client.name || 'Unnamed app'}: connection removed` });
    return out;
  }

  // shared front half of /oauth/token and /oauth/revoke: rate limit, form body, no repeated parameters
  async function tokenForm(req, ctx, res) {
    const wait = tokenWait(ctx.ip);
    if (wait) { oauthError(res, 429, 'invalid_request', 'Too many requests. Try again shortly.', { 'Retry-After': String(wait) }); return null; }
    let f;
    try { f = params(new URLSearchParams(await readBody(req, FORM_MAX_BODY, 'application/x-www-form-urlencoded'))); } catch (e) {
      if (!(e instanceof BodyError)) throw e;
      oauthError(res, e.status, 'invalid_request', e.message, e.status === 413 ? { Connection: 'close' } : {});
      return null;
    }
    if (f.dup.size) { oauthError(res, 400, 'invalid_request', `Repeated parameter: ${[...f.dup][0]}.`); return null; }
    return f.v;
  }

  route('POST', '/oauth/token', async (req, ctx, res) => {
    try {
      const v = await tokenForm(req, ctx, res);
      if (!v) return;
      if (!v.grant_type) return oauthError(res, 400, 'invalid_request', 'grant_type is missing.');
      if (v.grant_type !== 'authorization_code' && v.grant_type !== 'refresh_token') return oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
      // public clients send client_id in the body; accept it from an HTTP Basic header with an empty secret too
      if (!v.client_id) {
        const b = /^Basic\s+([A-Za-z0-9+/=]{1,400})$/i.exec(String(req.headers.authorization || ''));
        const user = b ? Buffer.from(b[1], 'base64').toString('utf8').split(':')[0] : '';
        if (user) { try { v.client_id = decodeURIComponent(user); } catch { /* leave it missing */ } }
      }
      if (!v.client_id) return oauthError(res, 400, 'invalid_request', 'client_id is missing.');
      const client = clientById(v.client_id);
      if (!client) return oauthError(res, 401, 'invalid_client', 'Unknown client. Register again.');
      let grantTypes = [];
      try { grantTypes = JSON.parse(client.grant_types); } catch { /* none */ }
      if (!grantTypes.includes(v.grant_type)) return oauthError(res, 400, 'unauthorized_client', `This client did not register for ${v.grant_type}.`);
      const r = v.grant_type === 'authorization_code' ? exchangeCode(v, client, ctx) : refreshTokens(v, client, ctx);
      if (!r.tokens) return oauthError(res, r.status, r.error, r.d);
      return json(res, 200, r.tokens);
    } catch (e) {
      reportError('POST /oauth/token', e);
      if (!res.headersSent) return oauthError(res, 500, 'server_error', 'Something went wrong.');
      return res.end();
    }
  });

  // RFC 7009: always 200 for a well-formed request, whether or not the token was known
  route('POST', '/oauth/revoke', async (req, ctx, res) => {
    try {
      const v = await tokenForm(req, ctx, res);
      if (!v) return;
      if (!v.token) return oauthError(res, 400, 'invalid_request', 'token is missing.');
      const r = db.prepare(`SELECT t.token_hash, t.kind, g.id AS grant_id, g.client_id FROM oauth_tokens t
          JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ?`).get(sha256(v.token));
      if (r && (!v.client_id || v.client_id === r.client_id)) {
        tx(db, () => {
          if (r.kind === 'refresh') revokeGrant(db, r.grant_id);
          else db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(now(), r.token_hash);
        });
      }
      res.writeHead(200, { ...BASE, 'Content-Length': '0', 'Cache-Control': 'no-store', Pragma: 'no-cache' });
      return res.end();
    } catch (e) {
      reportError('POST /oauth/revoke', e);
      if (!res.headersSent) return oauthError(res, 500, 'server_error', 'Something went wrong.');
      return res.end();
    }
  });

  return { resource: RESOURCE, resourceMetadataUrl: `${issuer}/.well-known/oauth-protected-resource` };
}
