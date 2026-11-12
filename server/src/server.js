// Tweet Vault HTTP server: API + the web page. node:http only.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import QRCode from 'qrcode';
import { openDb, tx, now } from './db.js';
import { capture, byId, linkStartStatus } from './items.js';
import { createFetcher } from './fetcher.js';
import { buildInbox, itemDto } from './tree.js';
import { renderItems, loadItemsInOrder, normaliseOrder, renderChars, MAX_RENDER_CHARS } from './render.js';
import * as A from './auth.js';
import { audit, listAudit, housekeeping } from './audit.js';
import * as O from './organize.js';
import { createHash } from 'node:crypto';
import { createTranslator, detectLanguage, sourceText, TranslateError, translateMissing, untranslatedNote, markUntranslated } from './translate.js';
import { threadRefusal, queueThread, threadState } from './thread.js';
import * as R from './recipes.js';
import { createMcp, RawReply } from './mcp.js';
import { installOAuth, listGrants, revokeGrant, deleteClientIfUnused } from './oauth.js';
import { createMediaWorker, mediaDirFor, mediaFile, attachImages } from './media.js';
import { configureYouTube } from './youtube.js';
import { appDirFor, createAppReleases, releaseDto, apkHeaders } from './appupdate.js';
import { createVoice, voiceDirFor, CHUNK_BYTES as VOICE_CHUNK } from './voice.js';
import * as Y from './sync.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC = join(HERE, '..', 'static');
const MAX_BODY = 256 * 1024;
export const ORGANIZE_MAX = 120;                                  // changes a phone may make ...
export const ORGANIZE_WINDOW = 600;                               // ... in this many seconds
const DEVICE_MAX_BULK = 200;                                      // items a phone may change in one request
const DEVICE_MAX_INPUT = 50_000;                                 // characters per save from a phone
const MAX_DB_BYTES = Number(process.env.VAULT_MAX_DB_MB || 2048) * 1024 * 1024;

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
  + "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

// A phone's change that was already answered (sync.js seenOp): the stored answer is sent again.
class Replay {
  constructor(status, body) { this.status = status; this.body = body; }
}

class HttpError extends Error {
  constructor(status, msg, extra, headers) { super(msg); this.status = status; this.extra = extra; this.headers = headers; }
}

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (k in out) continue; // first one wins
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip malformed cookie */ }
  }
  return out;
}

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'bundle';
}

export function createApp(opts = {}) {
  const cfg = {
    dbPath: opts.dbPath ?? process.env.VAULT_DB ?? '/data/vault.db',
    passwordHash: opts.passwordHash ?? process.env.VAULT_PASSWORD_HASH ?? '',
    secret: opts.secret ?? process.env.VAULT_SECRET ?? '',
    origins: (opts.origins ?? process.env.VAULT_ORIGINS ?? 'https://vault.example.com').split(',').map((s) => s.trim()).filter(Boolean),
    cookieSecure: opts.cookieSecure ?? (process.env.VAULT_COOKIE_SECURE ?? '1') !== '0',
    trustProxy: opts.trustProxy ?? (process.env.VAULT_TRUST_PROXY ?? '1') === '1',
    fetchFn: opts.fetchFn,
    paceMs: opts.paceMs,
    startWorker: opts.startWorker ?? true,
    maxRenderChars: opts.maxRenderChars ?? MAX_RENDER_CHARS,      // one copy / preview / export / MCP read
    mcpRatePerMinute: opts.mcpRatePerMinute ?? 60,                // per MCP key
    oauthRegisterPerHour: opts.oauthRegisterPerHour ?? 20,        // per IP
    oauthTokenPerMinute: opts.oauthTokenPerMinute ?? 60,          // per IP, token + revoke
    // Anthropic's egress range (160.79.104.0/21, every claude.ai user) shares these larger buckets instead
    oauthAnthropicRegisterPerHour: opts.oauthAnthropicRegisterPerHour ?? 300,
    oauthAnthropicTokenPerMinute: opts.oauthAnthropicTokenPerMinute ?? 1500,
    oauthRegisterGlobalPerHour: opts.oauthRegisterGlobalPerHour ?? 500,   // all addresses together
    appDownloadsPerHour: opts.appDownloadsPerHour ?? 10,          // per phone (or signed-in browser): APK downloads
    log: opts.log ?? ((m) => console.log(`${new Date().toISOString()} ${m}`)),
  };
  // Kept images (media.js): next to a file database, unless given. A passed-in or in-memory database has
  // no folder of its own, so images are off there (rows stay pending) unless the caller names one.
  cfg.mediaDir = opts.mediaDir !== undefined ? opts.mediaDir : (opts.db ? null : mediaDirFor(cfg.dbPath));
  // The Android app's release (appupdate.js): <db folder>/app, the same rule as images. Off for an
  // in-memory or passed-in database unless the caller names a folder.
  cfg.appDir = opts.appDir !== undefined ? opts.appDir : (opts.db ? null : appDirFor(cfg.dbPath));
  // Voice notes' audio (voice.js): <db folder>/voice, the same rule as images.
  cfg.voiceDir = opts.voiceDir !== undefined ? opts.voiceDir : (opts.db ? null : voiceDirFor(cfg.dbPath));
  if (!cfg.secret || cfg.secret.length < 32) throw new Error('VAULT_SECRET must be set (32+ characters)');
  const db = opts.db ?? openDb(cfg.dbPath);
  // sync.js: notices a database that went back in time (a restore) and gives it a new sync epoch
  const syncGuard = Y.createSyncGuard(db, {
    file: opts.syncFile !== undefined ? opts.syncFile : (opts.db || cfg.dbPath === ':memory:' ? null : `${cfg.dbPath}.sync.json`),
    log: (m) => cfg.log(m),
  });
  syncGuard.check();
  // A changed password (set-vault-password.sh) signs everyone out and forgets trusted browsers.
  if (cfg.passwordHash) {
    const fp = createHash('sha256').update(`pw:${cfg.passwordHash}`).digest('hex');
    const prev = db.prepare("SELECT value FROM kv WHERE key = 'password_fp'").get();
    if (prev && prev.value !== fp) {
      db.prepare('DELETE FROM sessions').run();
      db.prepare('DELETE FROM trusted_browsers').run();
      audit(db, 'password_changed', { detail: 'all sign-ins and trusted browsers removed' });
    }
    db.prepare("INSERT INTO kv (key, value) VALUES ('password_fp', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(fp);
  }
  // the YouTube Data API key (optional; never logged): read by youtube.js when the worker reads a video
  configureYouTube({ apiKey: opts.youtubeApiKey ?? process.env.YOUTUBE_API_KEY ?? null });
  const media = createMediaWorker(db, { mediaDir: cfg.mediaDir, fetchFn: opts.mediaFetchFn ?? cfg.fetchFn, paceMs: cfg.paceMs, log: cfg.log });
  // Shared web pages are read for real (webfetch.js safeFetch) only when asked for: the server's own start
  // below passes realWeb: true. Anything else (tests, a createApp with no options) reads no pages, unless
  // it hands in its own webFetch.
  const fetcher = createFetcher(db, { fetchFn: cfg.fetchFn, paceMs: cfg.paceMs, log: cfg.log, webFetch: opts.webFetch,
    realWeb: opts.realWeb === true && !opts.webFetch, onMedia: () => media.wake() });
  const translator = opts.translator ?? createTranslator(db, { client: opts.anthropicClient, log: cfg.log });
  const voice = createVoice(db, { voiceDir: cfg.voiceDir, fetchFn: opts.groqFetchFn ?? globalThis.fetch, client: opts.voiceClient ?? opts.anthropicClient,
    groqKey: opts.groqKey !== undefined ? opts.groqKey : process.env.GROQ_API_KEY, log: cfg.log, dailyMinutes: opts.voiceDailyMinutes, dailyCalls: opts.voiceDailyCalls });

  // __Host- cookies can't be set or shadowed by sibling subdomains (needs Secure, so plain names in local dev)
  const SID = cfg.cookieSecure ? '__Host-tv_sid' : 'tv_sid';
  const TRUST = cfg.cookieSecure ? '__Host-tv_trust' : 'tv_trust';
  const cookie = (name, value, maxAge) => [
    `${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    cfg.cookieSecure ? 'Secure' : null, `Max-Age=${maxAge}`,
  ].filter(Boolean).join('; ');

  function clientIp(req) {
    if (cfg.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return req.socket.remoteAddress || null;
  }

  async function readJson(req) {
    const ct = String(req.headers['content-type'] || '');
    if (!ct.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send JSON');
    const chunks = [];
    let size = 0;
    for await (const ch of req) {
      size += ch.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Too large');
      chunks.push(ch);
    }
    if (!size) return {};
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
      return v;
    } catch { throw new HttpError(400, 'Bad JSON'); }
  }

  // a RawReply (MCP): its own status and headers, a JSON body or none at all (202)
  function sendRaw(res, r) {
    const base = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (r.body === null || r.body === undefined) {
      res.writeHead(r.status, { ...base, 'Content-Length': '0', ...r.headers });
      res.end();
      return;
    }
    const payload = JSON.stringify(r.body);
    res.writeHead(r.status, { ...base, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(payload)), ...r.headers });
    res.end(payload);
  }

  function send(res, status, body, headers = {}) {
    const isText = typeof body === 'string';
    const payload = isText ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(payload);
  }

  // ---- auth context ----
  function authContext(req) {
    const cookies = parseCookies(req.headers.cookie);
    const session = A.getSession(db, cookies[SID]);
    const device = req.headers.authorization ? A.deviceFromBearer(db, req.headers.authorization) : null;
    return { cookies, session, device, ip: clientIp(req), ua: String(req.headers['user-agent'] || '') };
  }

  function requireOrigin(req) {
    const o = req.headers.origin;
    if (!o || !cfg.origins.includes(o)) throw new HttpError(403, 'Bad origin');
  }

  // who may call: 'S' full session (two-step done and set up), 'Dc'/'Dr'/'Do' device scopes
  // (capture, read, organize)
  function guard(req, ctx, allow) {
    if (ctx.device && !ctx.cookies[SID]) {
      if (allow.includes('Dc') && ctx.device.scopeSet.has('capture')) return 'device';
      if (allow.includes('Dr') && ctx.device.scopeSet.has('read')) return 'device';
      if (allow.includes('Do') && ctx.device.scopeSet.has('organize')) return 'device';
      throw new HttpError(403, 'This device token cannot do that');
    }
    if (req.headers.authorization && !ctx.device) throw new HttpError(401, 'Unknown or revoked token', { error: 'bad_token' });
    if (allow.includes('S') && ctx.session && ctx.session.mfa_ok) {
      if (req.method !== 'GET' && req.method !== 'HEAD') requireOrigin(req);
      if (!A.mfaEnabled(db)) throw new HttpError(403, 'Set up two-step sign-in first', { error: 'mfa_setup_required' });
      return 'session';
    }
    throw new HttpError(401, 'Sign in first', { error: 'signed_out' });
  }

  // Changes a phone may make once the owner switched "Allow organizing" on for it (the website session
  // passes as before). Only routes that call this accept the 'organize' scope, so everything else
  // (emptying the Trash, deleting for good, categories, recipes, Security, devices, keys) stays
  // website-only. A phone, or a stolen token, is held to ORGANIZE_MAX changes per ORGANIZE_WINDOW
  // seconds, and the activity log gets one line per phone, kind of change and hour.
  const organizeHits = new Map();   // device id -> times of its recent changes
  const organizeLogged = new Map(); // `${device id}:${kind}` -> hour already logged
  function guardOrganize(req, ctx, kind) {
    const who = guard(req, ctx, ['S', 'Do']);
    if (who !== 'device') return who;
    // the app names each change (X-Op-Id) so a resend after a lost answer is answered again, not run twice
    const opId = req.headers['x-op-id'];
    if (opId !== undefined) {
      if (!Y.OP_ID.test(String(opId))) throw new HttpError(400, 'Bad X-Op-Id');
      // claimed here, in the same step as the look-up, so two copies of one change can't both run
      const claim = Y.claimOp(db, ctx.device.id, String(opId));
      if (claim !== 'new') {
        if (claim.busy) throw new HttpError(409, 'This change is still being saved. Try again in a moment.', { error: 'in_progress' }, { 'Retry-After': '2' });
        throw new Replay(claim.status, claim.body);
      }
      ctx.opId = String(opId);
    }
    const t = now();
    const hits = (organizeHits.get(ctx.device.id) || []).filter((x) => x > t - ORGANIZE_WINDOW);
    if (hits.length >= ORGANIZE_MAX) {
      organizeHits.set(ctx.device.id, hits);
      // (the claim on this change's id is released by handle(), like after any refused change)
      throw new HttpError(429, 'Too many changes from this phone. Try again in a few minutes.', { error: 'rate_limited' });
    }
    hits.push(t);
    organizeHits.set(ctx.device.id, hits);
    const hour = Math.floor(t / 3600);
    const key = `${ctx.device.id}:${kind}`;
    if (organizeLogged.get(key) !== hour) {
      if (organizeLogged.size > 500) organizeLogged.clear();
      organizeLogged.set(key, hour);
      audit(db, 'phone_organized', { ip: ctx.ip, ua: ctx.ua, detail: `${ctx.device.name}: ${kind}` });
    }
    return who;
  }

  function requireFullSession(req, ctx) {
    if (!(ctx.session && ctx.session.mfa_ok)) throw new HttpError(401, 'Sign in first', { error: 'signed_out' });
    if (req.method !== 'GET') requireOrigin(req);
  }

  // ---- routes ----
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/healthz', () => {
    db.prepare('SELECT 1').get();
    return { ok: true };
  });

  // "Keep me signed in on this computer": the session and a trusted-browser cookie both last 30 days,
  // and the 30 days restart whenever the vault is opened (at most once a day).
  function keepSignedIn(ctx, res, { newTrust = true } = {}) {
    const s = ctx.session;
    const t = now();
    db.prepare('UPDATE sessions SET trusted = 1, expires_at = ? WHERE id_hash = ?').run(t + A.TRUSTED_TTL, s.id_hash);
    const cookies = [cookie(SID, ctx.cookies[SID], A.TRUSTED_TTL)];
    if (newTrust && !A.isTrusted(db, ctx.cookies[TRUST])) {
      const tr = A.createTrust(db, { ip: ctx.ip, ua: ctx.ua });
      cookies.push(cookie(TRUST, tr.token, tr.maxAge));
    } else if (ctx.cookies[TRUST] && A.isTrusted(db, ctx.cookies[TRUST])) {
      db.prepare('UPDATE trusted_browsers SET expires_at = ? WHERE id_hash = ?').run(t + A.TRUSTED_TTL, A.sha256(ctx.cookies[TRUST]));
      cookies.push(cookie(TRUST, ctx.cookies[TRUST], A.TRUSTED_TTL));
    }
    res.setHeader('Set-Cookie', cookies);
  }

  route('GET', '/api/me', (req, ctx, res) => {
    const s = ctx.session;
    if (!(s && s.mfa_ok)) return { signed_in: false, needs_code: !!s };
    // rolling 30 days for a remembered computer
    if (s.trusted && s.expires_at - now() < A.TRUSTED_TTL - 86400) keepSignedIn(ctx, res, { newTrust: false });
    return {
      signed_in: true,
      needs_code: false,
      remembered: !!s.trusted,
      mfa_enabled: A.mfaEnabled(db),
      recovery_left: A.mfaEnabled(db) ? A.recoveryLeft(db) : 0,
      via_recovery: !!s.via_recovery,
      translate: translator.enabled(),
    };
  });

  route('POST', '/api/me/remember', async (req, ctx, res) => {
    requireFullSession(req, ctx);
    // a trusted browser skips the two-step code, so it can only be made once two-step is on
    if (!A.mfaEnabled(db)) throw new HttpError(403, 'Set up two-step sign-in first', { error: 'mfa_setup_required' });
    await readJson(req);
    keepSignedIn(ctx, res);
    audit(db, 'browser_remembered', { ip: ctx.ip, ua: ctx.ua, detail: 'signed in for 30 days' });
    return { ok: true };
  });

  route('POST', '/api/login', async (req, ctx, res) => {
    requireOrigin(req);
    const body = await readJson(req);
    if (typeof body.password !== 'string' || !body.password || body.password.length > 1024) throw new HttpError(400, 'Enter your password');
    const trustedCookie = A.isTrusted(db, ctx.cookies[TRUST]);
    if (A.isLocked(ctx.ip, { kind: 'login', trusted: trustedCookie })) {
      if (A.firstLockNotice(ctx.ip, 'login')) audit(db, 'login_locked', { ok: false, ip: ctx.ip, ua: ctx.ua });
      throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    }
    if (!cfg.passwordHash) throw new HttpError(503, 'No password set yet. Run set-vault-password.sh on the server.');
    // count the attempt before the slow hash, so parallel guesses can't all slip past the limit
    const ticket = A.noteFailure(ctx.ip, 'login');
    const ok = await A.verifyPasswordLimited(body.password, cfg.passwordHash);
    if (ok === null) throw new HttpError(429, 'Busy checking other sign-ins. Try again in a moment.');
    if (!ok) {
      audit(db, 'login_failed', { ok: false, ip: ctx.ip, ua: ctx.ua, detail: 'wrong password' });
      throw new HttpError(401, 'Wrong password');
    }
    A.forgiveFailure(ticket);
    A.deleteSession(db, ctx.cookies[SID]);
    const enabled = A.mfaEnabled(db);
    const trusted = enabled && trustedCookie;
    if (enabled && !trusted) {
      const s = A.createSession(db, { mfaOk: false, ip: ctx.ip, ua: ctx.ua });
      res.setHeader('Set-Cookie', cookie(SID,s.token, s.maxAge));
      audit(db, 'password_ok', { ip: ctx.ip, ua: ctx.ua, detail: 'waiting for code' });
      return { mfa_required: true };
    }
    A.clearFailures(ctx.ip, 'login');
    const s = A.createSession(db, { mfaOk: true, trusted, ip: ctx.ip, ua: ctx.ua });
    res.setHeader('Set-Cookie', cookie(SID,s.token, s.maxAge));
    audit(db, 'login_ok', { ip: ctx.ip, ua: ctx.ua, detail: trusted ? 'trusted browser' : 'two-step not set up yet' });
    return { ok: true, mfa_setup_required: !enabled };
  });

  route('POST', '/api/login/mfa', async (req, ctx, res) => {
    requireOrigin(req);
    const body = await readJson(req);
    const s = ctx.session;
    if (!s || s.mfa_ok) throw new HttpError(400, 'Enter your password first');
    if (A.isLocked(ctx.ip, { kind: 'login' })) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    if (body.code && body.recovery_code) throw new HttpError(400, 'Send one code at a time');
    if ((body.code != null && (typeof body.code !== 'string' || body.code.length > 12))
      || (body.recovery_code != null && (typeof body.recovery_code !== 'string' || body.recovery_code.length > 20))) throw new HttpError(400, 'That code is not valid');
    let how = null;
    if (body.code && A.checkMfaCode(db, body.code, cfg.secret)) how = 'authenticator';
    else if (body.recovery_code && A.useRecoveryCode(db, body.recovery_code)) how = 'recovery code';
    if (!how) {
      A.noteFailure(ctx.ip, 'login');
      const n = (s.failures || 0) + 1;
      // a password-only session gets 5 tries, then the password has to be entered again
      if (n >= 5) A.deleteSession(db, ctx.cookies[SID]);
      else db.prepare('UPDATE sessions SET failures = ? WHERE id_hash = ?').run(n, s.id_hash);
      audit(db, 'code_failed', { ok: false, ip: ctx.ip, ua: ctx.ua, detail: n >= 5 ? 'too many wrong codes; password needed again' : null });
      throw new HttpError(401, n >= 5 ? 'Too many wrong codes. Enter your password again.' : 'That code did not work',
        n >= 5 ? { error: 'signed_out' } : undefined);
    }
    A.clearFailures(ctx.ip, 'login');
    A.deleteSession(db, ctx.cookies[SID]);
    const trust = !!body.trust;
    const ns = A.createSession(db, { mfaOk: true, trusted: trust, viaRecovery: how === 'recovery code', ip: ctx.ip, ua: ctx.ua });
    const cookies = [cookie(SID,ns.token, ns.maxAge)];
    if (trust) {
      const t = A.createTrust(db, { ip: ctx.ip, ua: ctx.ua });
      cookies.push(cookie(TRUST, t.token, t.maxAge));
    }
    res.setHeader('Set-Cookie', cookies);
    audit(db, 'login_ok', { ip: ctx.ip, ua: ctx.ua, detail: `${how}${trust ? ', browser trusted for 30 days' : ''}` });
    if (how === 'recovery code') audit(db, 'recovery_code_used', { ip: ctx.ip, ua: ctx.ua, detail: `${A.recoveryLeft(db)} left` });
    return { ok: true, recovery_left: A.recoveryLeft(db) };
  });

  // Signing out also forgets this browser, so the password alone can't skip the two-step code afterwards.
  route('POST', '/api/logout', (req, ctx, res) => {
    requireOrigin(req);
    A.deleteSession(db, ctx.cookies[SID]);
    if (ctx.cookies[TRUST]) db.prepare('DELETE FROM trusted_browsers WHERE id_hash = ?').run(A.sha256(ctx.cookies[TRUST]));
    res.setHeader('Set-Cookie', [cookie(SID, '', 0), cookie(TRUST, '', 0)]);
    return { ok: true };
  });

  // A wrong code typed while already signed in (re-setup, new recovery codes) counts against the session:
  // five strikes and the session ends.
  function sessionCodeFailure(ctx) {
    const n = (ctx.session.failures || 0) + 1;
    if (n >= 5) {
      db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(ctx.session.id_hash);
      audit(db, 'code_failed', { ok: false, ip: ctx.ip, ua: ctx.ua, detail: 'too many wrong codes while signed in; signed out' });
      throw new HttpError(401, 'Too many wrong codes. Sign in again.', { error: 'signed_out' });
    }
    db.prepare('UPDATE sessions SET failures = ? WHERE id_hash = ?').run(n, ctx.session.id_hash);
  }

  // After the authenticator changes (or is first turned on), every other session and every trusted
  // browser is signed out, so a lost or stolen device stops working.
  function revokeOthers(ctx, why) {
    const s = db.prepare('DELETE FROM sessions WHERE id_hash != ?').run(ctx.session.id_hash).changes;
    const t = db.prepare('DELETE FROM trusted_browsers').run().changes;
    if (s || t) audit(db, 'sessions_revoked', { ip: ctx.ip, ua: ctx.ua, detail: `${why}: ${s} other sign-ins and ${t} trusted browsers removed` });
  }

  route('POST', '/api/mfa/setup', async (req, ctx) => {
    requireFullSession(req, ctx);
    const body = await readJson(req);
    // Already on: re-setup needs a current code, unless this sign-in used a recovery code (lost phone).
    if (A.mfaEnabled(db) && !ctx.session.via_recovery && !A.checkMfaCode(db, String(body.code || '').slice(0, 12), cfg.secret)) {
      sessionCodeFailure(ctx);
      throw new HttpError(401, 'Enter a current code from your authenticator to set up a new one');
    }
    const s = A.startMfaSetup(db, cfg.secret);
    const qr = await QRCode.toDataURL(s.otpauth, { margin: 1, width: 240 });
    return { secret: s.secret_b32.replace(/(.{4})/g, '$1 ').trim(), otpauth: s.otpauth, qr };
  });

  route('POST', '/api/mfa/confirm', async (req, ctx, res) => {
    requireFullSession(req, ctx);
    const body = await readJson(req);
    const codes = A.confirmMfaSetup(db, String(body.code || '').slice(0, 12), cfg.secret);
    if (!codes) {
      audit(db, 'mfa_setup_failed', { ok: false, ip: ctx.ip, ua: ctx.ua });
      sessionCodeFailure(ctx);
      throw new HttpError(401, 'That code did not match. Check the time on your phone and try again.');
    }
    audit(db, 'mfa_enabled', { ip: ctx.ip, ua: ctx.ua });
    revokeOthers(ctx, 'two-step sign-in set up');
    if (body.trust) keepSignedIn(ctx, res);
    return { ok: true, recovery_codes: codes };
  });

  route('POST', '/api/mfa/recovery', async (req, ctx) => {
    guard(req, ctx, ['S']);
    const body = await readJson(req);
    if (!A.checkMfaCode(db, String(body.code || '').slice(0, 12), cfg.secret)) {
      sessionCodeFailure(ctx);
      throw new HttpError(401, 'Enter a current code from your authenticator');
    }
    const codes = A.newRecoveryCodes(db);
    audit(db, 'recovery_codes_renewed', { ip: ctx.ip, ua: ctx.ua });
    return { recovery_codes: codes };
  });

  // ---- pairing and devices ----
  route('POST', '/api/pair', async (req, ctx) => {
    const body = await readJson(req);
    if (A.isLocked(ctx.ip, { kind: 'pair' })) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    if (typeof body.code !== 'string' || body.code.length > 20 || (body.name != null && typeof body.name !== 'string')) throw new HttpError(400, 'Enter the pairing code');
    const r = A.redeemPairCode(db, body.code, body.name);
    if (!r) {
      A.noteFailure(ctx.ip, 'pair');
      audit(db, 'pair_failed', { ok: false, ip: ctx.ip, ua: ctx.ua });
      throw new HttpError(401, 'That pairing code is wrong or expired');
    }
    audit(db, 'device_paired', { ip: ctx.ip, ua: ctx.ua, detail: `${String(body.name || 'Phone').slice(0, 60)} (${r.scopes})` });
    return { token: r.token, scopes: r.scopes };
  });

  route('GET', '/api/devices', (req, ctx) => {
    guard(req, ctx, ['S']);
    const myHash = ctx.session.id_hash;
    return {
      devices: db.prepare('SELECT id, name, scopes, created_at, last_used_at, revoked_at FROM devices ORDER BY created_at DESC').all(),
      sessions: db.prepare('SELECT id_hash, created_at, expires_at, last_seen_at, ip, user_agent, trusted FROM sessions WHERE mfa_ok = 1 AND expires_at > ? ORDER BY last_seen_at DESC').all(now())
        .map((s) => ({ id: s.id_hash.slice(0, 16), current: s.id_hash === myHash, created_at: s.created_at, expires_at: s.expires_at, last_seen_at: s.last_seen_at, ip: s.ip, user_agent: s.user_agent, trusted: !!s.trusted })),
      trusted: db.prepare('SELECT id_hash, created_at, expires_at, ip, user_agent FROM trusted_browsers WHERE expires_at > ? ORDER BY created_at DESC').all(now())
        .map((t) => ({ id: t.id_hash.slice(0, 16), created_at: t.created_at, expires_at: t.expires_at, ip: t.ip, user_agent: t.user_agent })),
    };
  });

  route('POST', '/api/devices', async (req, ctx) => {
    guard(req, ctx, ['S']);
    const body = await readJson(req);
    const p = A.createPairCode(db, body.scopes || 'capture');
    audit(db, 'pair_code_created', { ip: ctx.ip, ua: ctx.ua, detail: p.scopes });
    return p;
  });

  // "Connect Claude": a read-only key for the MCP endpoint, made straight from the signed-in page (no
  // pairing code). The key is shown once; only its hash is kept, and it is removed like any device.
  route('POST', '/api/devices/key', async (req, ctx) => {
    guard(req, ctx, ['S']);
    const body = await readJson(req);
    if (body.name != null && typeof body.name !== 'string') throw new HttpError(400, 'Give the key a name');
    const name = String(body.name ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Claude Code';
    const d = A.createDeviceToken(db, name, 'read');
    audit(db, 'device_key_created', { ip: ctx.ip, ua: ctx.ua, detail: `${name} (read)` });
    const mcpUrl = `${req.headers.origin}/mcp`;   // guard() checked the origin is one of ours
    return [201, {
      token: d.token, device_id: d.device_id, name, scopes: 'read', mcp_url: mcpUrl,
      command: `claude mcp add --transport http vault ${mcpUrl} --header "Authorization: Bearer ${d.token}"`,
    }];
  });

  // "Allow organizing" switch for a paired phone. Website only: a phone can never widen its own access.
  route('PATCH', '/api/devices/:id', async (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    const body = await readJson(req);
    if (typeof body.organize !== 'boolean') throw new HttpError(400, 'Say whether this phone may organize');
    const d = db.prepare('SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL').get(Number(p.id));
    if (!d) throw new HttpError(404, 'No such device');
    const scopes = A.setDeviceOrganize(db, d.id, body.organize);
    if (!scopes) throw new HttpError(400, 'Only a paired phone can be allowed to organize. A Claude key stays read-only.');
    if (!body.organize) organizeHits.delete(d.id);
    audit(db, 'device_organize_changed', { ip: ctx.ip, ua: ctx.ua, detail: `${d.name}: organizing ${body.organize ? 'allowed' : 'stopped'}` });
    return { ok: true, scopes };
  });

  // What this phone's token may do, so the app can show or hide its organize screens.
  route('GET', '/api/device', (req, ctx) => {
    guard(req, ctx, ['Dc', 'Dr', 'Do']);
    return { id: ctx.device.id, name: ctx.device.name, scopes: [...ctx.device.scopeSet].filter(Boolean) };
  });

  route('DELETE', '/api/devices/:id', (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(Number(p.id));
    if (!d) throw new HttpError(404, 'No such device');
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), d.id);
    audit(db, 'device_removed', { ip: ctx.ip, ua: ctx.ua, detail: d.name });
    return { ok: true };
  });

  route('DELETE', '/api/sessions/:id', (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    const id = String(p.id);
    if (!/^[0-9a-f]{16}$/.test(id)) throw new HttpError(400, 'Bad id');
    const n = Number(db.prepare("DELETE FROM sessions WHERE substr(id_hash, 1, 16) = ?").run(id).changes);
    audit(db, 'session_ended', { ip: ctx.ip, ua: ctx.ua });
    return { ok: true, removed: n };
  });

  route('DELETE', '/api/trusted/:id', (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    const id = String(p.id);
    if (!/^[0-9a-f]{16}$/.test(id)) throw new HttpError(400, 'Bad id');
    db.prepare("DELETE FROM trusted_browsers WHERE substr(id_hash, 1, 16) = ?").run(id);
    audit(db, 'trusted_browser_removed', { ip: ctx.ip, ua: ctx.ua });
    return { ok: true };
  });

  route('GET', '/api/audit', (req, ctx, res, p, url) => {
    guard(req, ctx, ['S']);
    return { events: listAudit(db, url.searchParams.get('days')) };
  });

  // A hard ceiling on the database file, so nothing that adds text (a save, a note) can fill the server's disk.
  function requireRoom(where) {
    const { page_count: pc } = db.prepare('PRAGMA page_count').get();
    const { page_size: ps } = db.prepare('PRAGMA page_size').get();
    if (pc * ps > MAX_DB_BYTES) {
      reportError(where, new Error('database size limit reached'));
      throw new HttpError(507, 'The vault is full. Empty the Trash or ask the owner to raise the limit.');
    }
  }

  // ---- capture ----
  route('POST', '/api/captures', async (req, ctx) => {
    const who = guard(req, ctx, ['S', 'Dc']);
    const body = await readJson(req);
    if (typeof body.input !== 'string') throw new HttpError(400, 'Nothing to save');
    // A paired phone (or a stolen token) can't flood the vault: per-device rate limits and a smaller size cap.
    if (who === 'device') {
      if (body.input.length > DEVICE_MAX_INPUT) throw new HttpError(413, 'That is too long to save from a phone. Paste it on the computer instead.');
      const t = now();
      const recent = db.prepare('SELECT COUNT(*) AS n FROM captures WHERE device_id = ? AND received_at >= ?');
      if (recent.get(ctx.device.id, t - 600).n >= 60 || recent.get(ctx.device.id, t - 86400).n >= 1000) {
        throw new HttpError(429, 'Too many saves from this phone. Try again later.');
      }
    }
    requireRoom('POST /api/captures');
    let r;
    try {
      r = capture(db, {
        input: body.input, source_app: who === 'session' ? (body.source_app || 'web') : body.source_app,
        client_id: body.client_id, captured_at: body.captured_at, device_id: who === 'device' ? ctx.device.id : null,
      });
    } catch (e) {
      if (e.status) throw new HttpError(e.status, e.message);
      throw e;
    }
    fetcher.wake();
    const { duplicate, ...rest } = r;
    return [duplicate ? 200 : 202, rest];
  });

  route('GET', '/api/captures', (req, ctx, res, p, url) => {
    guard(req, ctx, ['Dc']);
    const since = Number(url.searchParams.get('since')) || now() - 7 * 86400;
    const rows = db.prepare(`SELECT c.client_id, c.item_id, c.received_at, i.fetch_status, i.kind, i.article_title, i.text, i.author_handle
        FROM captures c LEFT JOIN items i ON i.id = c.item_id WHERE c.device_id = ? AND c.received_at >= ? ORDER BY c.received_at DESC LIMIT 200`)
      .all(ctx.device.id, since);
    return {
      captures: rows.map((r) => ({
        client_id: r.client_id, item_id: r.item_id, received_at: r.received_at, fetch_status: r.fetch_status || 'gone',
        title: r.article_title || (r.text ? String(r.text).replace(/\s+/g, ' ').slice(0, 80) : (r.author_handle ? `Post by @${r.author_handle}` : null)),
      })),
    };
  });

  // ---- inbox and items ----
  // Adds lang (a non-Latin script detected in the text) and translation (stored English, if still current) to item DTOs.
  function withLanguage(dtos) {
    const list = dtos.filter(Boolean);
    if (!list.length) return dtos;
    const ids = list.map((d) => d.id);
    const have = new Set(db.prepare(`SELECT item_id FROM translations WHERE item_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.item_id));
    for (const d of list) {
      d.lang = detectLanguage(`${d.title || ''}\n${d.preview || ''}`);
      if (have.has(d.id)) {
        const row = byId(db, d.id);
        const tr = row ? translator.lookup(row) : null;
        if (tr) d.translation = tr;
      }
    }
    return dtos;
  }

  route('GET', '/api/inbox', (req, ctx, res, p, url) => {
    guard(req, ctx, ['S']);
    const sp = url.searchParams;
    const groups = buildInbox(db, {
      state: sp.get('state') || 'inbox', q: String(sp.get('q') || '').slice(0, 200), filter: O.parseFilter(sp, db),
      sort: O.SORTS.includes(sp.get('sort')) ? sp.get('sort') : 'saved_desc',
    });
    for (const g of groups) withLanguage([g.root, ...g.thread, ...g.replies]);
    return { groups };
  });

  // ---- translation into English (Claude Haiku; the key stays on the server) ----
  // Limits: the daily cap inside the translator, plus at most 30 requests a minute for the whole vault.
  // The same limit covers English made on demand for an export or an MCP read (englishFor below).
  let trWindow = { start: 0, n: 0 };
  const trAllow = () => {
    const t = Date.now();
    if (t - trWindow.start > 60_000) trWindow = { start: t, n: 0 };
    return ++trWindow.n <= 30;
  };
  route('POST', '/api/items/:id/translate', async (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    await readJson(req);
    if (!trAllow()) throw new HttpError(429, 'Too many translations at once. Try again in a minute.', { error: 'rate_limited' });
    const it = byId(db, p.id);
    if (!it || !it.saved) throw new HttpError(404, 'No such item');
    const r = await translator.translate(it);
    return { text: r.text, lang: r.lang || detectLanguage(sourceText(it)), cached: r.cached, usage: translator.usage() };
  });

  // English asked for outside the page (export ?english=1, MCP get_bundle english: true): the sources in
  // another language with no stored English are translated now (translate.js translateMissing: at most
  // 10, two at a time, about 25 s in all). Returns Map(item id -> why it is still in its own language).
  const englishFor = (rows) => translateMissing(db, translator, rows, { allow: trAllow });
  // The rendered text with those sources marked in the Sources list, and the note that goes first.
  const withEnglishNote = (r, failed) => ({
    text: r.text, text_sources: markUntranslated(r.text_sources, r.sections, failed), note: untranslatedNote(failed),
  });

  // ---- organizing: sidebar numbers, categories, tags ----
  route('GET', '/api/organize', (req, ctx) => {
    guard(req, ctx, ['S']);
    return O.organizeSummary(db);
  });

  route('POST', '/api/categories', async (req, ctx) => {
    guard(req, ctx, ['S']);
    const body = await readJson(req);
    return [201, { id: tx(db, () => O.createCategory(db, body.name, body.parent_id ?? null)) }];
  });

  route('PATCH', '/api/categories/:id', async (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    const body = await readJson(req);
    // name and/or parent_id (null: top level); one transaction, so a refused request changes nothing
    if (body.name === undefined && body.parent_id === undefined) throw new HttpError(400, 'Nothing to change');
    const n = tx(db, () => {
      let done = 1;
      if (body.parent_id !== undefined) done = O.moveCategory(db, p.id, body.parent_id);
      if (done && body.name !== undefined) done = O.renameCategory(db, p.id, body.name);
      return done;
    });
    if (!n) throw new HttpError(404, 'No such category');
    return { ok: true };
  });

  route('DELETE', '/api/categories/:id', (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    if (!tx(db, () => O.deleteCategory(db, p.id))) throw new HttpError(404, 'No such category');
    return { ok: true };
  });

  route('DELETE', '/api/tags/:name', (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    const id = O.findTagId(db, p.name);
    if (!id) throw new HttpError(404, 'No such tag');
    db.prepare('DELETE FROM tags WHERE id = ?').run(id);
    return { ok: true };
  });

  // (no transaction of its own: callers wrap it)
  const setStateRows = (ids, state) => {
    const t = now();
    let n = 0;
    for (const id of ids) {
      n += Number(db.prepare(`UPDATE items SET state = ?, trashed_at = ? WHERE id = ? AND saved = 1`)
        .run(state, state === 'trashed' ? t : null, Number(id)).changes);
      // a trashed post's queued "Get full thread" job is dropped, so the thread can't bring it back
      // (an archived post keeps its job: thread.js saves the parts into the Archive)
      if (state === 'trashed') {
        db.prepare("UPDATE items SET thread_status = NULL, thread_error = NULL, thread_at = NULL WHERE id = ? AND saved = 1 AND thread_status = 'queued'")
          .run(Number(id));
      }
    }
    return n;
  };

  // state (inbox/archived/trashed) and/or organizing fields for one or many items:
  // everything is checked first and written in one transaction, so a rejected request changes nothing
  const META = ['category_id', 'priority', 'add_tags', 'remove_tags'];
  const changeItems = (ids, body) => {
    const hasMeta = META.some((k) => body[k] !== undefined);
    if (body.state === undefined && !hasMeta) throw new HttpError(400, 'Nothing to change');
    if (body.state !== undefined && !['inbox', 'archived', 'trashed'].includes(body.state)) throw new HttpError(400, 'Bad state');
    O.checkCategory(db, body.category_id);
    O.checkPriority(body.priority);
    O.cleanTagList(body.add_tags);
    O.cleanTagList(body.remove_tags);
    return tx(db, () => {
      let n = 0;
      if (body.state !== undefined) n = setStateRows(ids, body.state);
      if (hasMeta) n = Math.max(n, O.applyItemMeta(db, ids, body));
      return n;
    });
  };

  // The owner's "why I saved this" note (items.my_note, never the internal items.note).
  // Trimmed; an empty note clears it. Returns the value to store.
  const MY_NOTE_MAX = 2000;
  const cleanMyNote = (v) => {
    if (v === null) return null;
    if (typeof v !== 'string') throw new HttpError(400, 'A note must be text');
    const t = v.trim();
    if (t.length > MY_NOTE_MAX) throw new HttpError(400, `A note can be up to ${MY_NOTE_MAX} characters`);
    return t || null;
  };

  route('PATCH', '/api/items/:id', async (req, ctx, res, p) => {
    guardOrganize(req, ctx, 'changed an item');
    const body = await readJson(req);
    if (body.my_note === undefined) {
      const n = changeItems([p.id], body);
      if (!n) throw new HttpError(404, 'No such item');
      return { ok: true };
    }
    // a note, maybe with other changes. The note is checked first, then the other changes run (they
    // check everything before writing), and the note is written last, so a rejected request changes nothing.
    const note = cleanMyNote(body.my_note);
    const it = byId(db, p.id);
    if (!it) throw new HttpError(404, 'No such item');
    if (!it.saved) throw new HttpError(400, 'Save this post first, then add your note');
    const { my_note: _note, ...rest } = body;
    if ((rest.state !== undefined || META.some((k) => rest[k] !== undefined)) && !changeItems([it.id], rest)) {
      throw new HttpError(404, 'No such item');
    }
    db.prepare('UPDATE items SET my_note = ? WHERE id = ?').run(note, it.id);
    return { ok: true, my_note: note };
  });

  route('POST', '/api/items/bulk', async (req, ctx) => {
    const who = guardOrganize(req, ctx, 'changed several items');
    const body = await readJson(req);
    if (!Array.isArray(body.ids) || body.ids.length > (who === 'device' ? DEVICE_MAX_BULK : 2000)) {
      throw new HttpError(400, Array.isArray(body.ids) ? `At most ${who === 'device' ? DEVICE_MAX_BULK : 2000} items at once` : 'ids must be a list');
    }
    // notes are written about one item, so they are never set for many at once
    if (body.my_note !== undefined) throw new HttpError(400, 'Notes are saved one item at a time');
    return { ok: true, changed: changeItems(body.ids, body) };
  });

  route('POST', '/api/items/:id/refetch', (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    const it = byId(db, p.id);
    if (!it || !it.tweet_id) throw new HttpError(404, 'Nothing to refetch');
    db.prepare("UPDATE items SET fetch_status = 'pending', fetch_attempts = 0, next_fetch_at = NULL, fetch_error = NULL WHERE id = ?").run(it.id);
    fetcher.wake();
    return { ok: true };
  });

  // "Get article text again": the worker reads the shared page once more (web.js / linkreader.js)
  route('POST', '/api/items/:id/read-link', async (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    await readJson(req);
    const it = /^\d{1,15}$/.test(p.id) ? byId(db, p.id) : null;
    if (!it || it.kind !== 'link') throw new HttpError(404, 'No such link');
    if (it.note === 'tco' && it.fetch_status === 'pending') return [202, { queued: true }];   // still being expanded
    if (linkStartStatus(it.url) !== 'pending') throw new HttpError(400, 'This link has no article to read');
    db.prepare(`UPDATE items SET fetch_status = 'pending', fetch_attempts = 0, next_fetch_at = NULL, fetch_error = NULL
        WHERE id = ?`).run(it.id);
    fetcher.wake();
    return [202, { queued: true }];
  });

  // "Get full thread": the background worker fetches the author's thread and saves every part (thread.js)
  route('POST', '/api/items/:id/thread', async (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    await readJson(req);
    const it = /^\d{1,15}$/.test(p.id) ? byId(db, p.id) : null;
    if (!it) throw new HttpError(404, 'No such item');
    const why = threadRefusal(it);
    if (why) throw new HttpError(400, why);
    if (queueThread(db, it.id)) fetcher.wake();
    return [202, { queued: true }];
  });

  route('GET', '/api/items/:id/thread', (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    const it = /^\d{1,15}$/.test(p.id) ? byId(db, p.id) : null;
    if (!it) throw new HttpError(404, 'No such item');
    return threadState(db, it);
  });

  // ---- "Add items" picker: any saved item that isn't in Trash, including ones already in other merges ----
  // (registered before GET /api/items/:id, which would otherwise take "pick" as an id)
  const PICK_FIELDS = ['text', 'article_title', 'article_md', 'author_handle', 'author_name', 'url', 'my_note', 'link_title', 'link_author'];
  // The picker shows a preview, never a whole body: the long text columns come back cut to one character
  // more than the preview (tree.js, 600), so it still knows to add "…", and a page of 100 long articles
  // never loads their full text. The word count would be wrong from a cut body, so it is left out.
  const PICK_CUT = 601;
  let pickCols = null;
  const pickSelect = () => {
    if (!pickCols) {
      pickCols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name)
        .map((n) => (['text', 'article_md', 'link_md'].includes(n) ? `substr(${n}, 1, ${PICK_CUT}) AS ${n}` : n)).join(', ');
    }
    return pickCols;
  };
  route('GET', '/api/items/pick', (req, ctx, res, p, url) => {
    guard(req, ctx, ['S']);
    const sp = url.searchParams;
    const words = String(sp.get('q') || '').slice(0, 200).trim().split(/\s+/).filter(Boolean).slice(0, 20);
    const lim = Number(sp.get('limit'));
    const limit = Number.isInteger(lim) && lim >= 1 ? Math.min(lim, 100) : 50;
    const where = ["saved = 1", "state <> 'trashed'"];
    const args = [];
    for (const w of words) {
      const like = `%${w.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      where.push(`(${PICK_FIELDS.map((f) => `${f} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      args.push(...PICK_FIELDS.map(() => like));
    }
    const ex = sp.get('exclude') ? bundleBySlug(sp.get('exclude')) : null;
    if (ex) { where.push('id NOT IN (SELECT item_id FROM bundle_items WHERE bundle_id = ?)'); args.push(ex.id); }
    const rows = db.prepare(`SELECT ${pickSelect()} FROM items WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(last_saved_at, first_saved_at, 0) DESC, id DESC LIMIT ${limit}`).all(...args);
    const mergedIn = new Map();
    if (rows.length) {
      const ph = rows.map(() => '?').join(',');
      for (const r of db.prepare(`SELECT bi.item_id, b.slug, b.title FROM bundle_items bi JOIN bundles b ON b.id = bi.bundle_id
          WHERE bi.item_id IN (${ph}) ORDER BY b.updated_at DESC`).all(...rows.map((r) => r.id))) {
        if (!mergedIn.has(r.item_id)) mergedIn.set(r.item_id, []);
        mergedIn.get(r.item_id).push({ slug: r.slug, title: r.title });
      }
    }
    // a reply names the post it answers, so the picker can show it under that post
    const parent = db.prepare('SELECT id, author_handle, author_name, substr(text, 1, 400) AS text, article_title FROM items WHERE tweet_id = ?');
    const items = rows.map((it) => {
      const par = it.parent_tweet_id && !it.is_self_thread ? parent.get(it.parent_tweet_id) : null;
      const d = itemDto(it, {
        merged_in: mergedIn.get(it.id) || [],
        reply_to: par ? { id: par.id, author_handle: par.author_handle || null, author_name: par.author_name || null,
          preview: String(par.article_title || par.text || '').replace(/\s+/g, ' ').slice(0, 120) } : null,
      });
      delete d.words;
      return d;
    });
    return { items, limit };
  });

  route('GET', '/api/items/:id', (req, ctx, res, p) => {
    guard(req, ctx, ['S', 'Do']);   // not read-only Claude keys: their reads go through /mcp and its activity log
    const it = byId(db, p.id);
    if (!it) throw new HttpError(404, 'No such item');
    return { item: withLanguage(attachImages(db, [{ ...itemDto(it), text: it.text, article_md: it.article_md, link_md: it.link_md || null }]))[0] };
  });

  // ---- sync for the phone app (sync.js): what changed after the number the phone last got ----
  // Not open to read-only Claude keys: they read through /mcp, where every read is written to the activity log.
  route('GET', '/api/sync', (req, ctx, res, p, url) => {
    guard(req, ctx, ['S', 'Do']);
    const sp = url.searchParams;
    syncGuard.check();   // a restored database gets a new epoch before anything is answered
    const page = Y.syncPage(db, { since: sp.get('since') || 0, limit: sp.get('limit') || undefined, epoch: sp.get('epoch') });
    syncGuard.sent(page.rev);
    attachImages(db, page.items);
    // list rows say which language an item is in and whether English is stored; the English itself is
    // long and comes with the item when it is opened
    if (page.items.length) {
      const ids = page.items.map((d) => d.id);
      const have = new Set(db.prepare(`SELECT item_id FROM translations WHERE item_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.item_id));
      for (const d of page.items) {
        d.lang = detectLanguage(`${d.title || ''}\n${d.preview || ''}`);
        d.has_translation = have.has(d.id);
      }
    }
    return page;
  });

  // ---- the owner's own typed notes (sync.js): saved as written, and the only items whose text can be edited ----
  const noteReply = (id) => {
    const it = byId(db, id);
    return { item: { ...itemDto(it), text: it.text, tags: O.tagsByItem(db).get(it.id) || [] } };
  };
  // the same limits as a save: the database ceiling, and a smaller size from a phone (or a stolen token)
  const noteLimits = (who) => (who === 'device' ? { maxText: DEVICE_MAX_INPUT } : {});
  route('POST', '/api/notes', async (req, ctx) => {
    const who = guardOrganize(req, ctx, 'wrote a note');
    const body = await readJson(req);
    requireRoom('POST /api/notes');
    return [201, noteReply(Y.createNote(db, body, noteLimits(who)))];
  });
  route('PATCH', '/api/notes/:id', async (req, ctx, res, p) => {
    const who = guardOrganize(req, ctx, 'edited a note');
    const body = await readJson(req);
    requireRoom('PATCH /api/notes');
    try {
      return noteReply(Y.editNote(db, p.id, body, noteLimits(who)));
    } catch (e) {
      // changed somewhere else since the editor opened: send the current note, so nothing is lost unseen
      if (e.status === 409 && e.extra?.current) return [409, { error: 'stale', message: e.message, current: e.extra.current }];
      throw e;
    }
  });

  // ---- merge and bundles ----
  route('POST', '/api/render', async (req, ctx) => {
    guard(req, ctx, ['S', 'Do']);
    const body = await readJson(req);
    const recipe = recipeFor(body.recipe_id);
    const rows = loadItemsInOrder(db, body.item_ids);
    const order = normaliseOrder(rows, db);
    const rows2 = renderable(loadItemsInOrder(db, order));
    const title = String(body.title || '').slice(0, 200);
    const r = renderItems(db, rows2, { title, english: body.english === true, notes: body.notes !== false });
    return { order, text: r.text, text_sources: r.text_sources, sections: r.sections,
      ...(recipe ? { prompt_text: R.buildRecipePrompt(recipe, title, r.text_sources) } : {}) };
  });

  // "Copy with <recipe>": null when none was asked for, 404 when the asked-for one doesn't exist
  function recipeFor(v, { byName = false } = {}) {
    if (v === undefined || v === null || v === '') return null;
    if (!byName && !(Number.isInteger(v) || (typeof v === 'string' && /^\d{1,15}$/.test(v)))) throw new HttpError(400, 'recipe_id must be a recipe number');
    const r = byName ? R.getRecipe(db, String(v).slice(0, 200)) : R.getRecipeById(db, Number(v));
    if (!r) throw new HttpError(404, 'No such recipe');
    return r;
  }

  // refuse a copy/preview/export bigger than MAX_RENDER_CHARS before building it (the container has 128 MB)
  function renderable(rows) {
    if (renderChars(rows) > cfg.maxRenderChars) throw new HttpError(413, 'That is too much text to put together at once. Split it into smaller collections.');
    return rows;
  }

  const bundleBySlug = (slug) => db.prepare('SELECT * FROM bundles WHERE slug = ?').get(String(slug));
  // Replace a merge's item list (call inside a transaction). Anything that goes into a merge, or comes
  // back out of one, becomes a live Inbox item again (not archived, not in Trash), so it can't vanish.
  const saveItems = (bundleId, ids) => {
    const before = new Set(db.prepare('SELECT item_id FROM bundle_items WHERE bundle_id = ?').all(bundleId).map((r) => r.item_id));
    db.prepare('DELETE FROM bundle_items WHERE bundle_id = ?').run(bundleId);
    const ins = db.prepare('INSERT INTO bundle_items (bundle_id, item_id, position) VALUES (?, ?, ?)');
    ids.forEach((id, i) => ins.run(bundleId, id, i));
    const after = new Set(ids);
    const changed = [...after].filter((x) => !before.has(x)).concat([...before].filter((x) => !after.has(x)));
    const live = db.prepare("UPDATE items SET state = 'inbox', trashed_at = NULL WHERE id = ? AND saved = 1");
    for (const id of changed) live.run(id);
  };
  // Unmerge frees the slug, and the page names a merge after its first item, so merging the same items
  // again gives the same slug. A tab still open on the old merge would then send a version the new one
  // also has and pass the 409 check. So remember the last version each deleted slug reached, and start
  // a merge that reuses the slug above it. (Call both inside a transaction.)
  // (the helpers live in organize.js so the CLI's make-bundle uses the same floor)
  const rememberSlugVersion = (slug, version) => O.rememberSlugVersion(db, slug, version);
  const firstVersionFor = (slug) => O.firstBundleVersion(db, slug);
  const bundleMeta = (id) => {
    const b = db.prepare('SELECT version, category_id, priority FROM bundles WHERE id = ?').get(id);
    return { version: b.version, category_id: b.category_id ?? null, priority: b.priority || 0, tags: O.tagsByBundle(db).get(id) || [] };
  };

  route('GET', '/api/bundles', (req, ctx, res, p, url) => {
    guard(req, ctx, ['S', 'Dr']);
    const sp = url.searchParams;
    const f = O.parseFilter(sp, db);
    const q = String(sp.get('q') || '').toLowerCase().trim();
    const tagMap = O.tagsByBundle(db);
    const members = new Map();
    for (const r of db.prepare(`SELECT bi.bundle_id, i.id, i.posted_at, i.likes
        FROM bundle_items bi JOIN items i ON i.id = bi.item_id`).all()) {
      if (!members.has(r.bundle_id)) members.set(r.bundle_id, []);
      members.get(r.bundle_id).push(r);
    }
    let rows = db.prepare(`SELECT b.id, b.slug, b.title, b.created_at, b.updated_at, b.version, b.category_id, b.priority, b.by_ai,
          COUNT(bi.item_id) AS items FROM bundles b LEFT JOIN bundle_items bi ON bi.bundle_id = b.id GROUP BY b.id`).all()
      .map((b) => {
        const ms = members.get(b.id) || [];
        return { ...b, tags: tagMap.get(b.id) || [], posted: Math.max(0, ...ms.map((m) => m.posted_at || 0)), likes: Math.max(0, ...ms.map((m) => m.likes || 0)), ms };
      })
      // a merged item matches on its own category, priority and tags only. It inherits them from its
      // items when it is made, and the items keep their old values afterwards, so matching on the items
      // too would keep it under a tag, category or priority the owner has since taken off it (and the
      // sidebar counts, which look at the merged item only, would disagree with the list)
      .filter((b) => O.matches(b, b.tags, f))
      .filter((b) => !q || b.title.toLowerCase().includes(q) || b.slug.includes(q) || b.tags.some((t) => t.toLowerCase().includes(q)));
    const by = {
      saved_desc: (a, b) => b.created_at - a.created_at,
      saved_asc: (a, b) => a.created_at - b.created_at,
      posted_desc: (a, b) => b.posted - a.posted || b.created_at - a.created_at,
      priority: (a, b) => b.priority - a.priority || b.created_at - a.created_at,
      likes: (a, b) => b.likes - a.likes || b.created_at - a.created_at,
    }[sp.get('sort')] || ((a, b) => b.updated_at - a.updated_at);
    rows = rows.sort(by).map(({ id, ms, posted, likes, ...rest }) => rest);
    return { bundles: rows };
  });

  route('POST', '/api/bundles', async (req, ctx) => {
    guardOrganize(req, ctx, 'made a merged item');
    const body = await readJson(req);
    const title = String(body.title || '').trim().slice(0, 200) || 'Untitled bundle';
    const rows = loadItemsInOrder(db, body.item_ids);
    if (!rows.length) throw new HttpError(400, 'Pick at least one item');
    const order = normaliseOrder(rows, db);
    const t = now();
    const slug = tx(db, () => {
      const base = slugify(body.slug || title);
      let s = base;
      for (let i = 2; bundleBySlug(s); i++) s = `${base}-${i}`;
      const r = db.prepare('INSERT INTO bundles (slug, title, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?)')
        .run(s, title, t, t, firstVersionFor(s));
      saveItems(Number(r.lastInsertRowid), order);
      O.inheritBundleMeta(db, Number(r.lastInsertRowid), order);
      return s;
    });
    return [201, { slug }];
  });

  route('GET', '/api/bundles/:slug', (req, ctx, res, p) => {
    guard(req, ctx, ['S', 'Dr', 'Do']);
    const b = bundleBySlug(p.slug);
    if (!b) throw new HttpError(404, 'No such bundle');
    const ids = db.prepare('SELECT item_id FROM bundle_items WHERE bundle_id = ? ORDER BY position').all(b.id).map((r) => r.item_id);
    const rows = loadItemsInOrder(db, ids);
    // the list of items is always sent, so an oversized merge can still be opened and trimmed;
    // its full text is only built when it fits under the same cap as copy and export
    let r = { text: null, text_sources: null };
    let tooBig = null;
    try { r = renderItems(db, renderable(rows), { title: b.title }); } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 413) throw e;
      tooBig = e.message;
    }
    return {
      bundle: { ...b, tags: O.tagsByBundle(db).get(b.id) || [] }, items: attachImages(db, withLanguage(rows.map((x) => itemDto(x)))),
      text: r.text, text_sources: r.text_sources, ...(tooBig ? { too_big: tooBig } : {}),
    };
  });

  route('PUT', '/api/bundles/:slug', async (req, ctx, res, p) => {
    guardOrganize(req, ctx, 'edited a merged item');
    const body = await readJson(req);
    const b = bundleBySlug(p.slug);
    if (!b) throw new HttpError(404, 'No such bundle');
    // the page sends the version it loaded; if the merge changed since (another tab, "Add to merged"),
    // refuse instead of overwriting, and the page reloads it
    if (body.version !== undefined && Number(body.version) !== b.version) {
      throw new HttpError(409, 'This merged item changed somewhere else. Reloaded the latest version.', { error: 'stale' });
    }
    tx(db, () => {
      if (body.title !== undefined) db.prepare('UPDATE bundles SET title = ? WHERE id = ?').run(String(body.title).trim().slice(0, 200) || b.title, b.id);
      if (body.item_ids !== undefined) {
        const rows = loadItemsInOrder(db, body.item_ids);
        if (!rows.length) throw new HttpError(400, 'A bundle needs at least one item');
        saveItems(b.id, normaliseOrder(rows, db));
      }
      O.setBundleMeta(db, b.id, body);
      db.prepare('UPDATE bundles SET updated_at = ?, version = version + 1 WHERE id = ?').run(now(), b.id);
    });
    return { ok: true, slug: b.slug, ...bundleMeta(b.id) };
  });

  route('DELETE', '/api/bundles/:slug', (req, ctx, res, p) => {
    guardOrganize(req, ctx, 'unmerged a merged item');
    const b = bundleBySlug(p.slug);
    if (!b) throw new HttpError(404, 'No such bundle');
    // "Unmerge": the merge goes away; its items were never deleted and show up in the Inbox again
    const n = db.prepare('SELECT COUNT(*) AS n FROM bundle_items WHERE bundle_id = ?').get(b.id).n;
    tx(db, () => {
      O.passMetaToItems(db, b.id);   // its tags, category and priority stay with the items
      saveItems(b.id, []);           // and every item is a live Inbox item again
      rememberSlugVersion(b.slug, b.version);
      db.prepare('DELETE FROM bundles WHERE id = ?').run(b.id);
      O.pruneTags(db);
    });
    audit(db, 'bundle_deleted', { ip: ctx.ip, ua: ctx.ua, detail: `${b.title} (${n} items back in the Inbox)` });
    return { ok: true, returned: n };
  });

  // Add more items to an existing merge. They slot into their own conversation
  // (a late reply lands under its article), new conversations go at the end.
  route('POST', '/api/bundles/:slug/add', async (req, ctx, res, p) => {
    guardOrganize(req, ctx, 'added to a merged item');
    const body = await readJson(req);
    const b = bundleBySlug(p.slug);
    if (!b) throw new HttpError(404, 'No such bundle');
    const added = loadItemsInOrder(db, body.item_ids);
    if (!added.length) throw new HttpError(400, 'Pick at least one item');
    const r = tx(db, () => {
      const cur = db.prepare('SELECT item_id FROM bundle_items WHERE bundle_id = ? ORDER BY position').all(b.id).map((x) => x.item_id);
      const have = new Set(cur);
      const fresh = added.filter((x) => !have.has(x.id));
      saveItems(b.id, normaliseOrder(loadItemsInOrder(db, [...cur, ...fresh.map((x) => x.id)]), db));
      O.addItemsToBundleMeta(db, b.id, fresh.map((x) => x.id));
      db.prepare('UPDATE bundles SET updated_at = ?, version = version + 1 WHERE id = ?').run(now(), b.id);
      return { added: fresh.length, already: added.length - fresh.length };
    });
    return { ok: true, slug: b.slug, ...r, version: bundleMeta(b.id).version };
  });

  // Combine two merges: every item of `from` moves into this one (same order rules as /add), its tags
  // come along, priority goes up to the higher one, an empty category fills in. Then `from` goes away.
  // Its items are not sent back to the Inbox: they live in this merge now. Its slug's last version is
  // remembered, so a tab still open on it gets 404 (or 409 if the slug is reused) instead of overwriting.
  route('POST', '/api/bundles/:slug/combine', async (req, ctx, res, p) => {
    guardOrganize(req, ctx, 'combined two merged items');
    const body = await readJson(req);
    if (typeof body.from !== 'string' || !body.from.trim()) throw new HttpError(400, 'Say which merged item to combine into this one');
    if (body.from === p.slug) throw new HttpError(400, 'A merged item cannot be combined with itself');
    const idsOf = (id) => db.prepare('SELECT item_id FROM bundle_items WHERE bundle_id = ? ORDER BY position').all(id).map((x) => x.item_id);
    // read and checked inside the transaction, so another writer (the CLI is a separate process) can't
    // change either merge between the check and the write; a throw here rolls everything back
    const r = tx(db, () => {
      const b = bundleBySlug(p.slug);
      const src = bundleBySlug(body.from);
      if (!b || !src) throw new HttpError(404, 'No such bundle');
      // optional: the versions the page last saw, so a stale tab is refused instead of guessing
      const stale = (v, row) => v !== undefined && v !== null && Number(v) !== row.version;
      if (stale(body.version, b) || stale(body.from_version, src)) {
        throw new HttpError(409, 'One of these merged items changed somewhere else. Reload and try again.', { error: 'stale' });
      }
      const cur = idsOf(b.id);
      const have = new Set(cur);
      const fresh = idsOf(src.id).filter((id) => !have.has(id));
      const rows = loadItemsInOrder(db, [...cur, ...fresh]);
      if (renderChars(rows) > cfg.maxRenderChars) {
        throw new HttpError(413, 'Together these would be too much text to copy at once. Keep them as two merged items.');
      }
      saveItems(b.id, normaliseOrder(rows, db));
      db.prepare('INSERT OR IGNORE INTO bundle_tags (bundle_id, tag_id) SELECT ?, tag_id FROM bundle_tags WHERE bundle_id = ?').run(b.id, src.id);
      db.prepare('UPDATE bundles SET priority = MAX(priority, ?), category_id = COALESCE(category_id, ?), updated_at = ?, version = version + 1 WHERE id = ?')
        .run(src.priority || 0, src.category_id ?? null, now(), b.id);
      rememberSlugVersion(src.slug, src.version);
      db.prepare('DELETE FROM bundles WHERE id = ?').run(src.id);   // its bundle_items and bundle_tags go with it
      O.pruneTags(db);
      return { added: fresh.length, b, src };
    });
    const { b, src } = r;
    audit(db, 'bundle_combined', { ip: ctx.ip, ua: ctx.ua, detail: `${src.title} → ${b.title} (${r.added} items moved)` });
    return { ok: true, slug: b.slug, added: r.added, version: bundleMeta(b.id).version };
  });

  route('GET', '/api/bundles/:slug/export', async (req, ctx, res, p, url) => {
    guard(req, ctx, ['S', 'Dr']);
    const b = bundleBySlug(p.slug);
    if (!b) throw new HttpError(404, 'No such bundle');
    const ids = db.prepare('SELECT item_id FROM bundle_items WHERE bundle_id = ? ORDER BY position').all(b.id).map((x) => x.item_id);
    const recipe = recipeFor(url.searchParams.get('recipe'), { byName: true });
    const english = url.searchParams.get('english') === '1';
    const rows = renderable(loadItemsInOrder(db, ids));
    const failed = english ? await englishFor(rows) : null;
    // the translations above changed nothing but the translations table; read the rows again in case
    // the bundle or an item changed while they ran
    const rows2 = english ? renderable(loadItemsInOrder(db, ids)) : rows;
    const r = withEnglishNote(renderItems(db, rows2, { title: b.title, english, notes: url.searchParams.get('notes') !== '0' }), failed);
    const text = url.searchParams.get('sources') === '0' ? r.text : r.text_sources;
    const out = recipe ? R.buildRecipePrompt(recipe, b.title, text) : text;
    return r.note ? `${r.note}

${out}` : out;
  });

  // ---- prompt recipes (read-only tokens can list them, so Claude can pick one; only you can change them) ----
  route('GET', '/api/recipes', (req, ctx) => {
    guard(req, ctx, ['S', 'Dr', 'Do']);
    return { recipes: R.listRecipes(db), limits: { name: R.NAME_MAX, prompt: R.PROMPT_MAX, count: R.MAX_RECIPES } };
  });

  route('POST', '/api/recipes', async (req, ctx) => {
    guard(req, ctx, ['S']);
    const body = await readJson(req);
    return [201, { recipe: tx(db, () => R.createRecipe(db, body)) }];
  });

  route('POST', '/api/recipes/order', async (req, ctx) => {
    guard(req, ctx, ['S']);
    const body = await readJson(req);
    return { recipes: tx(db, () => R.reorderRecipes(db, body.ids)) };
  });

  route('PATCH', '/api/recipes/:id', async (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    const body = await readJson(req);
    const r = tx(db, () => R.updateRecipe(db, p.id, { name: body.name, prompt: body.prompt }));
    if (!r) throw new HttpError(404, 'No such recipe');
    return { recipe: r };
  });

  route('DELETE', '/api/recipes/:id', (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    if (!R.deleteRecipe(db, p.id)) throw new HttpError(404, 'No such recipe');
    return { ok: true };
  });

  // ---- MCP (read-only, bearer key; see mcp.js). GET, DELETE and the rest get 405 with Allow: POST from handle(). ----
  const mcp = createMcp({ db, origins: cfg.origins, ratePerMinute: cfg.mcpRatePerMinute, maxRenderChars: cfg.maxRenderChars, mediaDir: cfg.mediaDir,
    englishFor, withEnglishNote,
    reportError: (where, e) => reportError(where, e) });
  route('POST', '/mcp', (req, ctx) => mcp.handlePost(req, ctx));

  // ---- OAuth 2.1 for claude.ai custom connectors (see oauth.js). The public origin is the first VAULT_ORIGINS entry. ----
  installOAuth({
    route, db, issuer: cfg.origins[0], origins: cfg.origins, secret: cfg.secret, csp: CSP,
    fullSession: (ctx) => !!(ctx.session && ctx.session.mfa_ok && A.mfaEnabled(db)),
    registerPerHour: cfg.oauthRegisterPerHour, tokenPerMinute: cfg.oauthTokenPerMinute,
    anthropicRegisterPerHour: cfg.oauthAnthropicRegisterPerHour, anthropicTokenPerMinute: cfg.oauthAnthropicTokenPerMinute,
    registerGlobalPerHour: cfg.oauthRegisterGlobalPerHour,
    reportError: (where, e) => reportError(where, e),
  });

  // Connected apps on the Security page: one row per consent. Removing one ends its tokens at once.
  route('GET', '/api/oauth/grants', (req, ctx) => {
    guard(req, ctx, ['S']);
    return { grants: listGrants(db) };
  });

  route('DELETE', '/api/oauth/grants/:id', (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    if (!/^\d{1,15}$/.test(p.id)) throw new HttpError(404, 'No such app');
    const g = db.prepare('SELECT g.id, g.client_id, c.name FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id WHERE g.id = ? AND g.revoked_at IS NULL').get(Number(p.id));
    if (!g) throw new HttpError(404, 'No such app');
    // and the registration too, when nothing else is connected through it, so it never holds a slot
    tx(db, () => { revokeGrant(db, g.id); deleteClientIfUnused(db, g.client_id); });
    audit(db, 'oauth_grant_removed', { ip: ctx.ip, ua: ctx.ua, detail: g.name || 'Unnamed app' });
    return { ok: true };
  });

  // ---- kept images (media.js): /media/<sha256>.<ext>, only files a media row says were saved ----
  // The type comes from the name (it was checked from the file's bytes when it was saved), never from
  // sniffing; the image gets its own locked-down CSP, so even a bad file can't run anything here.
  const mediaHeaders = (f) => ({
    'Content-Type': f.mime, 'Content-Length': String(f.size), 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Disposition': 'inline', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer',
  });
  // HEAD (some clients and caches ask first): the same checks and headers, no file opened, no body
  route('HEAD', '/media/:file', (req, ctx, res, p) => {
    guard(req, ctx, ['S', 'Dr']);
    const f = mediaFile(db, cfg.mediaDir, p.file);
    if (!f) throw new HttpError(404, 'Not found');
    res.writeHead(200, mediaHeaders(f));
    res.end();
  });
  route('GET', '/media/:file', (req, ctx, res, p) => {
    guard(req, ctx, ['S', 'Dr']);
    const f = mediaFile(db, cfg.mediaDir, p.file);
    if (!f) throw new HttpError(404, 'Not found');
    const stream = createReadStream(f.path);
    stream.once('open', () => {
      res.writeHead(200, mediaHeaders(f));
      pipeline(stream, res, (e) => { if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') cfg.log(`media ${p.file}: ${e.message}`); });
    });
    // gone between the check and the open (housekeeping): a plain 404
    return new Promise((resolve, reject) => {
      stream.once('open', () => resolve());
      stream.once('error', (e) => { if (res.headersSent) { res.destroy(); resolve(); } else reject(new HttpError(404, 'Not found')); });
    });
  });

  // ---- the Android app's own updates (appupdate.js; TweetVaultApp UpdateClient) ----
  // Who: the phone's capture token, or a signed-in browser (so the web page can show it later). A read-only
  // key (Claude / MCP) gets 403: it has no business installing apps, and nothing else needs it.
  // GET /api/app/latest: 200 with the release, or 204 when none is published (or latest.json doesn't check out).
  // GET|HEAD /api/app/apk: the APK, streamed from disk (never buffered in memory), or 404.
  const releases = createAppReleases({ appDir: cfg.appDir, log: cfg.log });
  const appDownloads = new Map();   // who -> start times (ms) of APK downloads in the last hour
  const APP_WHO = ['S', 'Dc'];
  const downloaderKey = (who, ctx) => (who === 'device' ? `d${ctx.device.id}` : `s${ctx.session.id_hash}`);
  function takeDownloadSlot(key) {
    const t = Date.now();
    for (const [k, list] of appDownloads) {           // forget old entries, so the map can't grow
      const keep = list.filter((x) => t - x < 3600_000);
      if (keep.length) appDownloads.set(k, keep); else appDownloads.delete(k);
    }
    const list = appDownloads.get(key) || [];
    if (list.length >= cfg.appDownloadsPerHour) {
      const retry = Math.max(1, Math.ceil((list[0] + 3600_000 - t) / 1000));
      throw new HttpError(429, 'Too many app downloads from this device. Try again later.', { error: 'rate_limited' }, { 'Retry-After': String(retry) });
    }
    list.push(t);
    appDownloads.set(key, list);
  }

  route('GET', '/api/app/latest', async (req, ctx, res) => {
    guard(req, ctx, APP_WHO);
    const r = await releases.current();
    if (!r) {
      res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end();
      return undefined;
    }
    return releaseDto(r);
  });
  route('HEAD', '/api/app/apk', async (req, ctx, res) => {
    guard(req, ctx, APP_WHO);
    const r = await releases.current();
    if (!r) throw new HttpError(404, 'No app release published');
    res.writeHead(200, apkHeaders(r));
    res.end();
  });
  route('GET', '/api/app/apk', async (req, ctx, res) => {
    const who = guard(req, ctx, APP_WHO);
    const r = await releases.current();
    if (!r) throw new HttpError(404, 'No app release published');
    const key = downloaderKey(who, ctx);
    takeDownloadSlot(key);
    const fh = await releases.openApk(r);
    if (!fh) {
      appDownloads.get(key)?.pop();   // nothing was sent: it doesn't count
      throw new HttpError(404, 'No app release published');
    }
    audit(db, 'app_update_downloaded', { ip: ctx.ip, ua: ctx.ua,
      detail: `${who === 'device' ? ctx.device.name : 'signed-in browser'}: ${r.version_name} (${r.version_code})` });
    res.writeHead(200, apkHeaders(r));
    // never buffered: 64 KB at a time, paced by the phone's connection; the file handle closes with the stream
    const stream = fh.createReadStream({ highWaterMark: 64 * 1024 });
    pipeline(stream, res, (e) => { if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') cfg.log(`app apk: ${e.message}`); });
    return undefined;
  });

  // ---- voice notes (voice.js) ----
  // Who: a signed-in browser does everything. The phone's capture token can create and upload notes and see
  // the status of the ones it sent, nothing else (it still can't read the vault). A read-only key (Claude /
  // MCP) can read notes and play their audio.
  const ownNotes = (who, ctx) => (who === 'device' ? (v) => v.device_id === ctx.device.id : undefined);
  const voiceId = (p) => {
    if (!/^\d{1,15}$/.test(p.id)) throw new HttpError(404, 'No such voice note');
    return Number(p.id);
  };
  route('POST', '/api/voice', (req, ctx) => voiceCreate(req, ctx));
  async function voiceCreate(req, ctx) {
    const who = guard(req, ctx, ['S', 'Dc']);
    const body = await readJson(req);
    const source = who === 'device' ? (body.source === 'share' ? 'share' : 'phone') : (body.source === 'share' ? 'share' : 'web');
    const r = voice.create({ source, mime: body.mime, bytes: body.bytes, duration_s: body.duration_s, title: body.title,
      client_id: body.client_id, device_id: who === 'device' ? ctx.device.id : null });
    if (!r.duplicate) audit(db, 'voice_note_started', { ip: ctx.ip, ua: ctx.ua, detail: `${source}, ${Math.round(Number(body.duration_s) / 60)} min` });
    return [r.duplicate ? 200 : 201, r];
  }
  route('PUT', '/api/voice/:id/chunk', async (req, ctx, res, p, url) => {
    const who = guard(req, ctx, ['S', 'Dc']);
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/octet-stream')) throw new HttpError(415, 'Send the audio as application/octet-stream');
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > VOICE_CHUNK) throw new HttpError(413, `Send at most ${VOICE_CHUNK} bytes at a time`);
    return voice.writeChunk(voiceId(p), url.searchParams.get('offset'), req, { owner: ownNotes(who, ctx) });
  });
  route('POST', '/api/voice/:id/finish', async (req, ctx, res, p) => {
    const who = guard(req, ctx, ['S', 'Dc']);
    await readJson(req);
    const r = await voice.finish(voiceId(p), { owner: ownNotes(who, ctx), source_app: who === 'device' ? null : 'web' });
    return [202, r];
  });
  // '/api/voice/' too: an early nginx rule sent browsers a permanent (cached) redirect there for a while
  route('GET', '/api/voice/', (req, ctx, res, p, url) => voiceList(req, ctx, url));
  route('POST', '/api/voice/', (req, ctx) => voiceCreate(req, ctx));
  route('GET', '/api/voice', (req, ctx, res, p, url) => voiceList(req, ctx, url));
  function voiceList(req, ctx, url) {
    const who = guard(req, ctx, ['S', 'Dc', 'Dr']);
    // a capture-only phone sees just the notes it sent
    const deviceId = who === 'device' && !ctx.device.scopeSet.has('read') ? ctx.device.id : undefined;
    return { notes: voice.list({ limit: url.searchParams.get('limit'), deviceId }), usage: who === 'session' ? voice.usage() : undefined };
  }
  route('GET', '/api/voice/:id', (req, ctx, res, p) => {
    guard(req, ctx, ['S', 'Dr']);
    const v = voice.get(voiceId(p));
    if (!v) throw new HttpError(404, 'No such voice note');
    return v;
  });
  route('PATCH', '/api/voice/:id', async (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    return voice.patch(voiceId(p), await readJson(req));
  });
  route('DELETE', '/api/voice/:id', async (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    const r = await voice.remove(voiceId(p));
    audit(db, 'voice_note_deleted', { ip: ctx.ip, ua: ctx.ua, detail: `#${p.id}` });
    return r;
  });
  route('POST', '/api/voice/:id/retry', async (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    const body = await readJson(req);
    return voice.retry(voiceId(p), body.what);
  });
  route('POST', '/api/voice/:id/passes', async (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    const body = await readJson(req);
    return [202, voice.addPass(voiceId(p), body.prompt)];
  });
  route('DELETE', '/api/voice/:id/passes/:pid', (req, ctx, res, p) => {
    guard(req, ctx, ['S']);
    if (!/^\d{1,15}$/.test(p.pid)) throw new HttpError(404, 'No such pass');
    return voice.removePass(voiceId(p), p.pid);
  });

  // The audio, with Range support so the page's player can seek. Streamed from disk, never buffered.
  const audioHeaders = (f, extra = {}) => ({
    'Content-Type': f.mime, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400', 'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Disposition': `inline; filename="voice-note-${f.id}.${f.ext}"`, 'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer', ...extra,
  });
  // bytes=a-b, bytes=a- or bytes=-n; one range only. null: the whole file. false: can't be satisfied.
  function parseRange(h, size) {
    if (!h) return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(h).trim());
    if (!m || (!m[1] && !m[2])) return null;
    let start;
    let end;
    if (!m[1]) { start = Math.max(0, size - Number(m[2])); end = size - 1; } else {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    }
    if (!Number.isSafeInteger(start) || start >= size || end < start) return false;
    return { start, end };
  }
  function serveAudio(req, ctx, res, p) {
    guard(req, ctx, ['S', 'Dr']);
    const f = voice.audioFile(voiceId(p));
    if (!f) throw new HttpError(404, 'Not found');
    const r = parseRange(req.headers.range, f.size);
    if (r === false) {
      res.writeHead(416, audioHeaders(f, { 'Content-Range': `bytes */${f.size}`, 'Content-Length': '0' }));
      res.end();
      return undefined;
    }
    const status = r ? 206 : 200;
    const headers = audioHeaders(f, r
      ? { 'Content-Range': `bytes ${r.start}-${r.end}/${f.size}`, 'Content-Length': String(r.end - r.start + 1) }
      : { 'Content-Length': String(f.size) });
    if (req.method === 'HEAD') { res.writeHead(status, headers); res.end(); return undefined; }
    const stream = createReadStream(f.path, { highWaterMark: 64 * 1024, ...(r ? { start: r.start, end: r.end } : {}) });
    return new Promise((resolve, reject) => {
      stream.once('open', () => {
        res.writeHead(status, headers);
        pipeline(stream, res, (e) => { if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') cfg.log(`voice audio ${f.id}: ${e.message}`); });
        resolve();
      });
      stream.once('error', () => { if (res.headersSent) { res.destroy(); resolve(); } else reject(new HttpError(404, 'Not found')); });
    });
  }
  route('GET', '/voice/:id/audio', serveAudio);
  route('HEAD', '/voice/:id/audio', serveAudio);

  // ---- static page ----
  const STATIC_FILES = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/app.css': ['app.css', 'text/css; charset=utf-8'],
    '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
    // Source Sans 3 (SIL OFL 1.1, see static/fonts/OFL-LICENSE.md). Same-origin, so the CSP stays 'self'.
    // The files never change under these names, so browsers may keep them.
    '/fonts/source-sans-3-regular.woff2': ['fonts/source-sans-3-regular.woff2', 'font/woff2', 'public, max-age=31536000, immutable'],
    '/fonts/source-sans-3-medium.woff2': ['fonts/source-sans-3-medium.woff2', 'font/woff2', 'public, max-age=31536000, immutable'],
  };
  const cache = new Map();
  async function serveStatic(req, res, path) {
    const f = STATIC_FILES[path];
    if (!f) return false;
    let buf = cache.get(f[0]);
    if (!buf) { buf = await readFile(join(STATIC, f[0])); if (opts.cacheStatic !== false) cache.set(f[0], buf); }
    res.writeHead(200, {
      'Content-Type': f[1], 'Cache-Control': f[2] || (path === '/' ? 'no-store' : 'no-cache'),
      'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
    return true;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    let ctx = null;
    try {
      if ((req.method === 'GET' || req.method === 'HEAD') && await serveStatic(req, res, path)) return;
      const r = routes.find((x) => x.method === req.method && x.re.test(path));
      // a browser opening an unknown page (old bookmark, typo) goes to the app, not to a raw JSON error
      const known = routes.filter((x) => x.re.test(path));
      if (!r && !known.length && req.method === 'GET' && !path.startsWith('/api/') && /text\/html/.test(String(req.headers.accept || ''))) {
        res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end();
        return;
      }
      if (!r) {
        if (!known.length) throw new HttpError(404, 'Not found');
        throw new HttpError(405, 'Method not allowed', undefined, { Allow: [...new Set(known.map((x) => x.method))].join(', ') });
      }
      const m = r.re.exec(path);
      let params;
      try {
        params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      } catch { throw new HttpError(400, 'Bad path'); }
      ctx = authContext(req);
      const out = await r.handler(req, ctx, res, params, url);
      // a phone's change (see guardOrganize): keep the answer for a resend if it worked, free its id if not.
      // Keeping it must never turn a change that worked into an error, or the phone would send it again.
      if (ctx.opId) {
        const status = Array.isArray(out) ? out[0] : 200;
        const worked = !(out instanceof RawReply) && !res.headersSent && status >= 200 && status < 300;
        try {
          if (worked) Y.finishOp(db, ctx.device.id, ctx.opId, status, Array.isArray(out) ? out[1] : out);
          else Y.releaseOp(db, ctx.device.id, ctx.opId);
        } catch (e) { reportError(`${req.method} ${path} (keeping the answer)`, e); }
        ctx.opId = null;
      }
      if (res.headersSent) return;   // the handler answered itself (OAuth pages and redirects)
      if (out instanceof RawReply) sendRaw(res, out);
      else if (Array.isArray(out)) send(res, out[0], out[1]);
      else send(res, 200, out);
    } catch (e) {
      if (e instanceof Replay) { send(res, e.status, e.body); return; }
      // a phone's change that was refused or failed: its id is free again
      if (ctx && ctx.opId) {
        try { Y.releaseOp(db, ctx.device.id, ctx.opId); } catch { /* the claim lapses by itself in a minute */ }
      }
      // Only errors the app raised on purpose show their message; anything else (a library, a bug) is a
      // plain 500 with no details, and is recorded for the owner.
      const deliberate = e instanceof HttpError || e instanceof TranslateError || e.expose === true;
      const status = deliberate && e.status ? e.status : 500;
      if (status >= 500) reportError(`${req.method} ${path}`, e);
      if (!res.headersSent) send(res, status, { error: e.extra?.error || e.code && deliberate && String(e.code) || 'error', message: status >= 500 && !deliberate ? 'Something went wrong' : e.message }, (e instanceof HttpError && e.headers) || {});
      else res.end();
    }
  }

  // ---- error tracking: every server error lands in the Security page's activity log (and, if the owner
  // set ALERT_WEBHOOK_URL, e.g. an ntfy.sh topic, a short push at most every 10 minutes). No stack traces leave the server.
  let lastAlert = 0;
  function reportError(where, e) {
    cfg.log(`error ${where}: ${e && (e.stack || e.message)}`);
    try { audit(db, 'server_error', { ok: false, detail: `${where}: ${String((e && e.message) || e).slice(0, 200)}` }); } catch { /* db trouble: the log line above is all we can do */ }
    const hook = process.env.ALERT_WEBHOOK_URL;
    if (hook && /^https:\/\//.test(hook) && Date.now() - lastAlert > 10 * 60_000) {
      lastAlert = Date.now();
      fetch(hook, { method: 'POST', body: `Tweet Vault server error at ${where}. See Security > Recent activity.`, signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
  }
  cfg.reportError = reportError;

  const server = http.createServer((req, res) => { handle(req, res); });
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  let hk = null;
  return {
    server, db, fetcher, media, voice, mediaDir: cfg.mediaDir, appDir: cfg.appDir, voiceDir: cfg.voiceDir,
    listen(port = 8092, host = '0.0.0.0') {
      housekeeping(db, { mediaDir: cfg.mediaDir });
      try { voice.cleanFiles(); } catch (e) { cfg.log(`voice housekeeping: ${e.message}`); }
      hk = setInterval(() => {
        try { housekeeping(db, { mediaDir: cfg.mediaDir }); } catch (e) { cfg.log(`housekeeping: ${e.message}`); }
        try { voice.cleanFiles(); } catch (e) { cfg.log(`voice housekeeping: ${e.message}`); }
      }, 6 * 3600 * 1000);
      hk.unref();
      if (cfg.startWorker) { fetcher.start(); media.start(); voice.start(); }
      return new Promise((r) => server.listen(port, host, () => r(server.address().port)));
    },
    close() {
      fetcher.stop();
      media.stop();
      voice.stop();
      if (hk) clearInterval(hk);
      return new Promise((r) => server.close(() => r()));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = createApp({ realWeb: true });
  const port = Number(process.env.PORT || 8092);
  app.listen(port).then((p) => console.log(`Tweet Vault listening on ${p}`));
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // log the cause, then exit so Docker restarts a clean process (never keep running in an unknown state)
  process.on('unhandledRejection', (e) => { console.error('unhandled rejection:', e); process.exit(1); });
}
