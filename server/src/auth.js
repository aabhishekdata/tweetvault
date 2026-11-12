// Password, two-step codes, sessions, trusted browsers, phone tokens and pairing codes.
import { pbkdf2, randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { now, tx } from './db.js';
import { newSecret, base32Encode, verifyTotp, seal, unseal, otpauthUrl } from './totp.js';

const pbkdf2Async = promisify(pbkdf2);
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const token = (n = 32) => randomBytes(n).toString('base64url');

export const SESSION_TTL = 12 * 3600;          // normal sign-in
export const TRUSTED_TTL = 30 * 86400;         // "trust this browser for 30 days"
export const PENDING_TTL = 5 * 60;             // between password and code
export const PAIR_TTL = 10 * 60;

// Hash format written by set-vault-password.sh (same as TTL Studio): pbkdf2_sha256:<iter>:<salt hex>:<hash hex>
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iter = Number(parts[1]);
  if (!Number.isInteger(iter) || iter < 100000 || iter > 5_000_000) return false;
  const expected = Buffer.from(parts[3], 'hex');
  const got = await pbkdf2Async(String(password || ''), Buffer.from(parts[2], 'hex'), iter, expected.length, 'sha256');
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export async function makePasswordHash(password, iter = 600000) {
  const salt = randomBytes(16);
  const h = await pbkdf2Async(String(password), salt, iter, 32, 'sha256');
  return `pbkdf2_sha256:${iter}:${salt.toString('hex')}:${h.toString('hex')}`;
}

// ---- failed-attempt lockout (in memory) ----
// Per source (IPv4 address, or IPv6 /64 so address rotation doesn't help) and one overall cap,
// because a guesser can always come from more places.
const WINDOW = 15 * 60_000;
const PER_SOURCE = 10;
const GLOBAL = 40;
const failures = new Map();
let global = { stamps: [], until: 0 };

// An IPv4-mapped IPv6 address (::ffff:1.2.3.4, or ::ffff:102:304 in hex) as plain IPv4; anything else as given.
export function plainIp(ip) {
  const s = String(ip || '').trim();
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (dotted) return dotted[1];
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(s);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return s;
}

export function sourceKey(ip) {
  const s = plainIp(ip);
  if (!s.includes(':')) return s;
  // expand enough of the IPv6 address to take the first four groups (/64)
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// Lockouts are kept per kind ('login' covers the password and two-step code, 'pair' covers phone pairing),
// so failed pairing attempts can never lock the owner out of signing in.
const globals = new Map();   // kind -> { stamps, until }
const globalOf = (kind) => { if (!globals.has(kind)) globals.set(kind, { stamps: [], until: 0 }); return globals.get(kind); };
const fkey = (ip, kind) => `${kind}|${sourceKey(ip)}`;

function prune(nowMs) {
  for (const [k, f] of failures) if (nowMs - f.first > WINDOW && (!f.until || f.until < nowMs)) failures.delete(k);
  for (const g of globals.values()) g.stamps = g.stamps.filter((t) => nowMs - t < WINDOW);
}

// trusted: the request carries a valid trusted-browser cookie (which an attacker cannot forge). Such a request
// skips the vault-wide lock, so strangers hammering the sign-in can't lock the owner out; its own source lock still applies.
export function isLocked(ip, { kind = 'login', trusted = false } = {}) {
  const n = Date.now();
  if (!trusted && globalOf(kind).until > n) return true;
  const f = failures.get(fkey(ip, kind));
  return !!(f && f.until && f.until > n);
}

// Counts a failed (or, for slow checks, an about-to-be-checked) attempt. Returns a ticket for forgiveFailure.
export function noteFailure(ip, kind = 'login') {
  const n = Date.now();
  prune(n);
  const key = fkey(ip, kind);
  const f = failures.get(key) || { count: 0, until: 0, first: n, logged: 0 };
  if (n - f.first > WINDOW) { f.count = 0; f.first = n; }
  f.count++;
  if (f.count >= PER_SOURCE) { f.until = n + WINDOW; f.count = 0; f.first = n; }
  failures.set(key, f);
  const g = globalOf(kind);
  g.stamps.push(n);
  if (g.stamps.length >= GLOBAL) { g.until = n + WINDOW; g.stamps = []; }
  return { key, stamp: n, kind };
}
// The attempt turned out fine: take it back out of the counts.
export function forgiveFailure(ticket) {
  if (!ticket) return;
  const f = failures.get(ticket.key);
  if (f && f.count > 0) f.count--;
  const g = globalOf(ticket.kind);
  const i = g.stamps.indexOf(ticket.stamp);
  if (i >= 0) g.stamps.splice(i, 1);
}
// true only the first time a locked source is turned away, so a lockout writes one audit row, not thousands
export function firstLockNotice(ip, kind = 'login') {
  const n = Date.now();
  const f = failures.get(fkey(ip, kind));
  const until = f && f.until > n ? f.until : globalOf(kind).until;
  const k = `lock|${kind}|${sourceKey(ip)}`;
  const seen = failures.get(k);
  if (seen && seen.until >= until) return false;
  failures.set(k, { count: 0, until, first: n });
  return true;
}
export const clearFailures = (ip, kind = 'login') => failures.delete(fkey(ip, kind));
export const _resetLockouts = () => { failures.clear(); globals.clear(); };

// PBKDF2 runs on a small thread pool; more than a few at once only queues up guesses
let hashing = 0;
export async function verifyPasswordLimited(password, stored, maxParallel = 3) {
  if (hashing >= maxParallel) return null;   // caller answers 429
  hashing++;
  try { return await verifyPassword(password, stored); } finally { hashing--; }
}

// ---- sessions ----
export function createSession(db, { mfaOk, trusted = false, viaRecovery = false, ip, ua }) {
  const t = now();
  const tok = token();
  const ttl = !mfaOk ? PENDING_TTL : (trusted ? TRUSTED_TTL : SESSION_TTL);
  db.prepare(`INSERT INTO sessions (id_hash, created_at, expires_at, last_seen_at, ip, user_agent, mfa_ok, trusted, via_recovery)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sha256(tok), t, t + ttl, t, ip || null, (ua || '').slice(0, 200), mfaOk ? 1 : 0, trusted ? 1 : 0, viaRecovery ? 1 : 0);
  return { token: tok, maxAge: ttl };
}

export function getSession(db, tok) {
  if (!tok) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(sha256(tok));
  if (!s) return null;
  if (s.expires_at < now()) { db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(s.id_hash); return null; }
  if (now() - (s.last_seen_at || 0) > 300) db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now(), s.id_hash);
  return s;
}

export const deleteSession = (db, tok) => tok && db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(tok));

// ---- trusted browsers ----
export function createTrust(db, { ip, ua }) {
  const t = now();
  const tok = token();
  db.prepare('INSERT INTO trusted_browsers (id_hash, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(tok), t, t + TRUSTED_TTL, ip || null, (ua || '').slice(0, 200));
  return { token: tok, maxAge: TRUSTED_TTL };
}
export function isTrusted(db, tok) {
  if (!tok) return false;
  const r = db.prepare('SELECT expires_at FROM trusted_browsers WHERE id_hash = ?').get(sha256(tok));
  return !!(r && r.expires_at > now());
}

// ---- two-step codes ----
export function mfaRow(db) {
  let r = db.prepare('SELECT * FROM mfa WHERE id = 1').get();
  if (!r) {
    db.prepare("INSERT INTO mfa (id, enabled, recovery_json, updated_at) VALUES (1, 0, '[]', ?)").run(now());
    r = db.prepare('SELECT * FROM mfa WHERE id = 1').get();
  }
  return r;
}
export const mfaEnabled = (db) => !!mfaRow(db).enabled;

export function startMfaSetup(db, masterSecret) {
  const secret = newSecret();
  mfaRow(db);
  db.prepare('UPDATE mfa SET pending_secret_enc = ?, updated_at = ? WHERE id = 1').run(seal(secret, masterSecret), now());
  const b32 = base32Encode(secret);
  return { secret_b32: b32, otpauth: otpauthUrl(b32) };
}

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function recoveryCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
export function newRecoveryCodes(db) {
  const codes = Array.from({ length: 8 }, recoveryCode);
  db.prepare('UPDATE mfa SET recovery_json = ?, updated_at = ? WHERE id = 1')
    .run(JSON.stringify(codes.map((c) => ({ h: sha256(c), used: 0 }))), now());
  return codes;
}

export function confirmMfaSetup(db, code, masterSecret) {
  const r = mfaRow(db);
  if (!r.pending_secret_enc) return null;
  const secret = unseal(r.pending_secret_enc, masterSecret);
  const st = verifyTotp(secret, code, now(), { lastStep: 0 });
  if (st === null) return null;
  return tx(db, () => {
    db.prepare('UPDATE mfa SET secret_enc = pending_secret_enc, pending_secret_enc = NULL, enabled = 1, last_step = ?, updated_at = ? WHERE id = 1')
      .run(st, now());
    return newRecoveryCodes(db);
  });
}

export function checkMfaCode(db, code, masterSecret) {
  const r = mfaRow(db);
  if (!r.enabled || !r.secret_enc) return false;
  const secret = unseal(r.secret_enc, masterSecret);
  const st = verifyTotp(secret, code, now(), { lastStep: r.last_step || 0 });
  if (st === null) return false;
  db.prepare('UPDATE mfa SET last_step = ? WHERE id = 1').run(st);
  return true;
}

export function useRecoveryCode(db, code) {
  const c = String(code || '').trim().toLowerCase().replace(/\s/g, '');
  const norm = c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
  const r = mfaRow(db);
  if (!r.enabled) return false;
  const list = JSON.parse(r.recovery_json || '[]');
  const h = sha256(norm);
  const hit = list.find((x) => !x.used && x.h === h);
  if (!hit) return false;
  hit.used = 1;
  db.prepare('UPDATE mfa SET recovery_json = ? WHERE id = 1').run(JSON.stringify(list));
  return true;
}
export const recoveryLeft = (db) => JSON.parse(mfaRow(db).recovery_json || '[]').filter((x) => !x.used).length;

export function resetMfa(db) {
  mfaRow(db);
  db.prepare("UPDATE mfa SET secret_enc = NULL, pending_secret_enc = NULL, enabled = 0, last_step = 0, recovery_json = '[]', updated_at = ? WHERE id = 1").run(now());
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM trusted_browsers').run();
}

// ---- phones and other devices ----
export function createPairCode(db, scopes = 'capture') {
  const ok = ['capture', 'read', 'capture,read'];
  const sc = ok.includes(scopes) ? scopes : 'capture';
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const t = now();
  db.prepare('DELETE FROM pair_codes WHERE expires_at < ? OR used = 1').run(t);
  db.prepare('INSERT OR REPLACE INTO pair_codes (code_hash, scopes, created_at, expires_at, used) VALUES (?, ?, ?, ?, 0)')
    .run(sha256(`pair:${code}`), sc, t, t + PAIR_TTL);
  return { code, scopes: sc, expires_at: t + PAIR_TTL };
}

export function redeemPairCode(db, code, name) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  return tx(db, () => {
    const r = db.prepare('SELECT * FROM pair_codes WHERE code_hash = ?').get(sha256(`pair:${c}`));
    if (!r || r.used || r.expires_at < now()) return null;
    db.prepare('UPDATE pair_codes SET used = 1 WHERE code_hash = ?').run(r.code_hash);
    const tok = `tv_${token(32)}`;
    const res = db.prepare('INSERT INTO devices (name, token_hash, scopes, created_at) VALUES (?, ?, ?, ?)')
      .run(String(name || 'Phone').slice(0, 60), sha256(tok), r.scopes, now());
    return { token: tok, device_id: Number(res.lastInsertRowid), scopes: r.scopes };
  });
}

export function deviceFromBearer(db, header) {
  const m = /^Bearer\s+(tv_[A-Za-z0-9_-]{20,})$/i.exec(String(header || ''));   // the scheme is case-insensitive (RFC 9110)
  if (!m) return null;
  const d = db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(m[1]));
  if (!d) return null;
  if (now() - (d.last_used_at || 0) > 60) db.prepare('UPDATE devices SET last_used_at = ? WHERE id = ?').run(now(), d.id);
  return { ...d, scopeSet: new Set(String(d.scopes).split(',')) };
}

// "Allow organizing" for a paired phone: adds or removes the 'organize' scope on the same device row, so
// the phone keeps its token and id. Only a live device that can save ('capture') qualifies: a read-only
// Claude key can never be given write access this way. Returns the new scopes, or null.
export function setDeviceOrganize(db, id, on) {
  const d = db.prepare('SELECT id, scopes FROM devices WHERE id = ? AND revoked_at IS NULL').get(Number(id));
  if (!d) return null;
  const set = new Set(String(d.scopes).split(',').filter(Boolean));
  if (!set.has('capture')) return null;
  if (on) set.add('organize'); else set.delete('organize');
  const scopes = ['capture', 'read', 'organize'].filter((s) => set.has(s)).join(',');
  db.prepare('UPDATE devices SET scopes = ? WHERE id = ?').run(scopes, d.id);
  return scopes;
}

// A device made from the CLI (for scripts or tests); prints its token once.
export function createDeviceToken(db, name, scopes) {
  const tok = `tv_${token(32)}`;
  const r = db.prepare('INSERT INTO devices (name, token_hash, scopes, created_at) VALUES (?, ?, ?, ?)')
    .run(String(name).slice(0, 60), sha256(tok), scopes, now());
  return { token: tok, device_id: Number(r.lastInsertRowid) };
}
