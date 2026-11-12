// Authenticator-app codes (TOTP, RFC 6238) with node:crypto only.
import { createHmac, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(secret, counter, digits = 6, algo = 'sha1') {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algo, secret).update(b).digest();
  const o = h[h.length - 1] & 0xf;
  const code = (h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

export function totp(secret, nowSec, { step = 30, digits = 6, algo = 'sha1' } = {}) {
  return hotp(secret, Math.floor(nowSec / step), digits, algo);
}

// Returns the matching time step, or null. Codes at or before lastStep are refused (no replays).
export function verifyTotp(secret, code, nowSec, { step = 30, window = 1, lastStep = 0 } = {}) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const cur = Math.floor(nowSec / step);
  for (let d = -window; d <= window; d++) {
    const s = cur + d;
    if (s <= lastStep) continue;
    if (hotp(secret, s) === c) return s;
  }
  return null;
}

export const newSecret = () => randomBytes(20);

export function otpauthUrl(secretB32, { account = 'Tweet Vault', issuer = 'Tweet Vault' } = {}) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// Encrypt the TOTP secret at rest with a key derived from VAULT_SECRET.
const keyFrom = (masterSecret) => createHash('sha256').update(`tweet-vault-mfa:${masterSecret}`).digest();

export function seal(buf, masterSecret) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFrom(masterSecret), iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function unseal(str, masterSecret) {
  const [v, iv, tag, enc] = String(str).split(':');
  if (v !== 'v1') throw new Error('unknown seal version');
  const tagBuf = Buffer.from(tag || '', 'base64');
  if (tagBuf.length !== 16) throw new Error('bad auth tag');
  const d = createDecipheriv('aes-256-gcm', keyFrom(masterSecret), Buffer.from(iv, 'base64'), { authTagLength: 16 });
  d.setAuthTag(tagBuf);
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]);
}
