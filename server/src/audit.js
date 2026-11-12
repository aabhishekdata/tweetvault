// Activity log (kept 30 days) and daily housekeeping.
import { now, tx } from './db.js';
import { pruneClients, revokeDeadGrants } from './oauth.js';
import { cleanMediaFiles } from './media.js';
import { pruneSync } from './sync.js';

export const AUDIT_DAYS = 30;

export function audit(db, event, { ok = true, ip = null, ua = null, detail = null } = {}) {
  db.prepare('INSERT INTO audit_log (at, event, ok, ip, user_agent, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(now(), event, ok ? 1 : 0, ip, ua ? String(ua).slice(0, 200) : null,
      detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500));
}

export function listAudit(db, days = AUDIT_DAYS) {
  const d = Math.max(1, Math.min(AUDIT_DAYS, Number(days) || AUDIT_DAYS));
  const since = now() - d * 86400;
  // failures (which strangers can create) get their own allowance, so a flood of wrong passwords can
  // never push real security events (sign-ins, new phones, settings changes) out of the list
  const cols = 'id, at, event, ok, ip, user_agent, detail';
  // Claude's reads over MCP (one row per tool or prompt call) get their own allowance too, so a busy
  // day of reading can't push them out either
  const good = db.prepare(`SELECT ${cols} FROM audit_log WHERE at >= ? AND ok = 1 AND event != 'mcp_call' ORDER BY at DESC, id DESC LIMIT 2000`).all(since);
  const reads = db.prepare(`SELECT ${cols} FROM audit_log WHERE at >= ? AND ok = 1 AND event = 'mcp_call' ORDER BY at DESC, id DESC LIMIT 300`).all(since);
  const bad = db.prepare(`SELECT ${cols} FROM audit_log WHERE at >= ? AND ok = 0 ORDER BY at DESC, id DESC LIMIT 500`).all(since);
  return [...good, ...reads, ...bad].sort((a, b) => b.at - a.at || b.id - a.id).map(({ id, ...r }) => r);
}

// Runs at start-up and then daily. mediaDir: the kept-images folder (media.js), when there is one.
export function housekeeping(db, { mediaDir = null } = {}) {
  const t = now();
  const r = {
    audit: Number(db.prepare('DELETE FROM audit_log WHERE at < ?').run(t - AUDIT_DAYS * 86400).changes),
    sessions: Number(db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t).changes),
    trusted: Number(db.prepare('DELETE FROM trusted_browsers WHERE expires_at < ?').run(t).changes),
    pair: Number(db.prepare('DELETE FROM pair_codes WHERE expires_at < ? OR used = 1').run(t).changes),
  };
  // OAuth (claude.ai connectors): connections with no usable refresh token left are ended first; expired
  // codes; tokens a day after they expired or were revoked (a spent refresh token is kept until then, so a
  // replay is still recognised); removed connections after 30 days (their codes and tokens go with them);
  // registrations nobody used within 24 hours, and ones with nothing live left after 30 idle days.
  r.oauth = tx(db, () => ({
    dead: revokeDeadGrants(db, t, (id) => {
      const g = db.prepare('SELECT c.name FROM oauth_grants g LEFT JOIN oauth_clients c ON c.client_id = g.client_id WHERE g.id = ?').get(id);
      audit(db, 'oauth_grant_expired', { detail: `${(g && g.name) || 'An app'} (no usable sign-in left)` });
    }),
    codes: Number(db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(t).changes),
    tokens: Number(db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)').run(t - 86400, t - 86400).changes),
    grants: Number(db.prepare('DELETE FROM oauth_grants WHERE revoked_at IS NOT NULL AND revoked_at < ?').run(t - 30 * 86400).changes),
    clients: pruneClients(db, t),
  }));
  // Trashed for 30+ days and not in any merge. One write transaction, and every statement re-checks the
  // condition: the CLI runs this beside the live server, and a phone re-share (which brings the item back to
  // the inbox) or a merge landing between the candidate list and the delete must never lose that item or
  // stop housekeeping halfway.
  const purgeable = `state = 'trashed' AND trashed_at < ? AND saved = 1
      AND id NOT IN (SELECT item_id FROM bundle_items)`;
  const cutoff = t - 30 * 86400;
  const purged = tx(db, () => {
    const old = db.prepare(`SELECT id FROM items WHERE ${purgeable}`).all(cutoff).map((x) => x.id);
    let n = 0;
    for (const id of old) {
      const it = db.prepare(`SELECT tweet_id FROM items WHERE id = ? AND ${purgeable}`).get(id, cutoff);
      if (!it) continue;   // saved again or merged since the list was made
      // keep the row as context if other items still reply to it
      const hasChildren = it.tweet_id && db.prepare('SELECT 1 FROM items WHERE parent_tweet_id = ? LIMIT 1').get(it.tweet_id);
      db.prepare('UPDATE captures SET item_id = NULL WHERE item_id = ?').run(id);
      const done = hasChildren
        ? db.prepare(`UPDATE items SET saved = 0, state = 'inbox', trashed_at = NULL WHERE id = ? AND ${purgeable}`).run(id, cutoff)
        : db.prepare(`DELETE FROM items WHERE id = ? AND ${purgeable}`).run(id, cutoff);
      if (Number(done.changes)) n++;
    }
    return n;
  });
  // context rows nobody points at any more (leaf context rows, repeated until stable)
  let orphans = 0;
  for (let i = 0; i < 12; i++) {
    const n = Number(db.prepare(`DELETE FROM items WHERE saved = 0 AND tweet_id IS NOT NULL
        AND tweet_id NOT IN (SELECT parent_tweet_id FROM items WHERE parent_tweet_id IS NOT NULL)
        AND id NOT IN (SELECT item_id FROM bundle_items)`).run().changes);
    orphans += n;
    if (!n) break;
  }
  r.purged = purged;
  r.orphans = orphans;
  // tags nothing uses any more
  r.tags = Number(db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM item_tags) AND id NOT IN (SELECT tag_id FROM bundle_tags)').run().changes);
  // image files whose posts are all gone (their media rows went with the items above)
  if (mediaDir) r.media_files = cleanMediaFiles(db, mediaDir);
  // the phone app's sync: old deleted ids and old answered changes (sync.js)
  r.sync = pruneSync(db, t);
  return r;
}
