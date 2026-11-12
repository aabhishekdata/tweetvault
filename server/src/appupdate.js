// In-app updates for the Android app (pass 1, feature 4.2): the release the phone may install.
//
// deploy.ps1 -App puts it under the data volume, next to the database (/data/app in production):
//   latest.json      {version_code, version_name, size, sha256, notes, file, uploaded_at}
//   <sha256>.apk     the APK itself, named by its own hash
// latest.json is read again on every request (it is tiny) and checked strictly. Anything that doesn't check
// out is treated as "no release", so a half-written or tampered file can never point the phone anywhere else:
// the APK's name must be exactly <sha256>.apk inside this folder, never a path, and its real size must match.
import { lstat, readFile, open } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { dirname, join } from 'node:path';

export const MAX_APK_BYTES = 100 * 1024 * 1024;     // the app refuses anything bigger too (UpdatePolicy)
export const MAX_VERSION_CODE = 2_000_000_000;      // Android's own ceiling is 2100000000
export const MAX_NOTES = 2000;
const MAX_LATEST_BYTES = 16 * 1024;
const NAME_RE = /^[0-9A-Za-z.+\-_ ]{1,40}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const KEYS = new Set(['version_code', 'version_name', 'size', 'sha256', 'notes', 'file', 'uploaded_at']);
// O_NOFOLLOW where the platform has it (Linux, the server): a symlink swapped in after the check is refused
const OPEN_FLAGS = FS.O_RDONLY | (FS.O_NOFOLLOW || 0);

// Where releases live: next to a file database (/data/vault.db -> /data/app). An in-memory database has
// no folder, so the feature is off (204 / 404) unless a folder is given.
export function appDirFor(dbPath, explicit) {
  if (explicit) return explicit;
  if (!dbPath || dbPath === ':memory:') return null;
  return join(dirname(dbPath), 'app');
}

// Why a parsed latest.json can't be used, or null when it is fine. Checks the record only, not the file.
export function releaseProblem(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not a JSON object';
  for (const k of Object.keys(r)) if (!KEYS.has(k)) return `unexpected field "${k.slice(0, 40)}"`;
  if (!Number.isInteger(r.version_code) || r.version_code < 1 || r.version_code > MAX_VERSION_CODE) return 'bad version_code';
  if (typeof r.version_name !== 'string' || !NAME_RE.test(r.version_name) || r.version_name.trim() !== r.version_name) return 'bad version_name';
  if (!Number.isInteger(r.size) || r.size < 1 || r.size > MAX_APK_BYTES) return 'bad size (1 byte to 100 MB)';
  if (typeof r.sha256 !== 'string' || !SHA_RE.test(r.sha256)) return 'bad sha256 (64 lower-case hex)';
  if (r.file !== `${r.sha256}.apk`) return 'file must be <sha256>.apk';
  if (r.notes !== undefined && r.notes !== null && (typeof r.notes !== 'string' || r.notes.length > MAX_NOTES)) return 'bad notes';
  if (r.uploaded_at !== undefined && r.uploaded_at !== null
    && !(typeof r.uploaded_at === 'string' && r.uploaded_at.length <= 40)
    && !(Number.isInteger(r.uploaded_at) && r.uploaded_at > 0)) return 'bad uploaded_at';
  return null;
}

// The current release, or null. `log` hears about a broken latest.json once per distinct problem.
export function createAppReleases({ appDir, log = () => {} }) {
  let lastProblem = null;
  const ok = () => { lastProblem = null; };
  const bad = (why) => {
    if (why !== lastProblem) log(`app update: latest.json ignored (${why}); serving no release`);
    lastProblem = why;
    return null;
  };

  async function current() {
    if (!appDir) return null;
    const meta = join(appDir, 'latest.json');
    let st;
    try { st = await lstat(meta); } catch { ok(); return null; }   // no release published: nothing to say
    if (!st.isFile()) return bad('latest.json is not a plain file');
    if (st.size > MAX_LATEST_BYTES) return bad('latest.json is too large');
    let r;
    try { r = JSON.parse((await readFile(meta, 'utf8')).replace(/^﻿/, '')); } catch { return bad('not valid JSON'); }
    const why = releaseProblem(r);
    if (why) return bad(why);
    const path = join(appDir, r.file);
    let fst;
    try { fst = await lstat(path); } catch { return bad(`${r.file} is missing`); }
    if (!fst.isFile()) return bad(`${r.file} is not a plain file`);
    if (fst.size !== r.size) return bad(`size ${r.size} does not match the file (${fst.size} bytes)`);
    ok();
    return {
      version_code: r.version_code, version_name: r.version_name, size: r.size, sha256: r.sha256,
      notes: typeof r.notes === 'string' && r.notes.length ? r.notes : null, path,
    };
  }

  // Opens the release's APK for streaming; null when it is gone or no longer the size latest.json says
  // (checked on the open file, so a swap between the check and the open can't change what is sent).
  async function openApk(rel) {
    let fh;
    try {
      fh = await open(rel.path, OPEN_FLAGS);
      const st = await fh.stat();
      if (!st.isFile() || st.size !== rel.size) { await fh.close(); return null; }
      return fh;
    } catch {
      if (fh) await fh.close().catch(() => {});
      return null;
    }
  }

  return { current, openApk };
}

// The JSON the app parses (AppRelease in TweetVaultApp): exactly these five fields.
export const releaseDto = (r) => ({
  version_code: r.version_code, version_name: r.version_name, size: r.size, sha256: r.sha256, notes: r.notes,
});

export function apkHeaders(r) {
  return {
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Length': String(r.size),
    'Content-Disposition': `attachment; filename="tweet-vault-${r.version_name}.apk"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Referrer-Policy': 'no-referrer',
  };
}
