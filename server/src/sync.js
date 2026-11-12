// Sync for the phone app (PLAN-APP-2.md phase A1). The server is the single source of truth: the phone
// keeps a copy and asks "what changed after number N". Database v10 stamps a number from one counter on
// every changed item and merged item (items.rev, bundles.rev) and keeps the ids of deleted rows in
// sync_deleted. This module reads those pages, notices a restored database, answers a phone's resent
// change from ops_seen, and creates and edits the owner's own typed notes.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { now, tx } from './db.js';
import { isOwnNote, noteVersion } from './items.js';
import { textHash } from './kindle.js';
import { itemDto } from './tree.js';
import { tagsByItem, tagsByBundle } from './organize.js';

export { isOwnNote, noteVersion };

export const SYNC_LIMIT = 200;          // rows of each kind per page, at most
export const DELETED_KEEP = 90 * 86400; // how long a deleted id is remembered
export const OPS_KEEP = 30 * 86400;     // how long an answered change is remembered
const FLOOR_KEY = 'sync_floor';         // deletions at or below this number have been forgotten
const EPOCH_KEY = 'sync_epoch';         // names this history of the vault; a restore gets a new one
const LINK_MD_CUT = 4000;               // list rows are previews: a read page or transcript is cut in SQL

export const currentRev = (db) => db.prepare('SELECT rev FROM sync_counter WHERE id = 1').get().rev;
const kvGet = (db, key) => db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null;
const kvSet = (db, key, value) => db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
const floorOf = (db) => Number(kvGet(db, FLOOR_KEY)) || 0;

// ---- which history of the vault this is ----
// The numbers only mean something within one history. After a restore from a backup (or a rollback to a
// pre-deploy snapshot) the counter goes back and then hands the same numbers out again for different
// changes, so a phone that had seen the lost ones would keep rows that no longer exist and miss new ones.
// Every sync answer therefore carries an epoch, and a phone that sends another epoch starts its copy again.
// A restore is noticed without anyone running a command: the highest number ever sent to a phone is kept
// in a small file beside the database (not inside it, so a restore does not take it back too). If the
// database's counter is below that number, the database went back in time and gets a new epoch.
export function syncEpoch(db) {
  let e = kvGet(db, EPOCH_KEY);
  if (!e) { e = randomBytes(9).toString('base64url'); kvSet(db, EPOCH_KEY, e); }
  return e;
}
export function newSyncEpoch(db) {
  const e = randomBytes(9).toString('base64url');
  kvSet(db, EPOCH_KEY, e);
  return e;
}

// file: where the highest sent number is kept (null: in memory only, for tests and :memory: databases).
export function createSyncGuard(db, { file = null, log = () => {} } = {}) {
  let served = 0;
  if (file) {
    try { served = Number(JSON.parse(readFileSync(file, 'utf8')).served) || 0; } catch { served = 0; }
  }
  const save = () => {
    if (!file) return;
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify({ served }));
      renameSync(`${file}.tmp`, file);
    } catch (e) { log(`sync guard: ${e.message}`); }
  };
  // Run at start-up and before every sync answer.
  function check() {
    const head = currentRev(db);
    if (head < served) {
      const e = newSyncEpoch(db);
      log(`sync: the database is behind what phones were sent (${head} < ${served}); new epoch ${e}, phones will copy again`);
      served = head;
      save();
      return true;
    }
    return false;
  }
  function sent(rev) {
    if (rev > served) { served = rev; save(); }
  }
  return { check, sent, get served() { return served; } };
}

// One page of changes after `since`.
//   { epoch, rev, more, reset, items, bundles, deleted: { items, bundles }, categories, tags }
// Lists carry previews (tree.js itemDto); full text comes from GET /api/items/:id when an item is opened.
// `rev` is what to send as `since` next time, together with `epoch`; `more` says another page is waiting.
// `reset` means the phone must drop its copy and take this answer as the start of a new one: its epoch
// is not this vault's, or its number is older than the deletions still remembered, or ahead of the vault.
// Categories and tags are short lists and always sent whole.
export function syncPage(db, { since = 0, limit = SYNC_LIMIT, epoch = null } = {}) {
  let from = Number(since);
  if (!Number.isSafeInteger(from) || from < 0) from = 0;
  const lim = Math.max(1, Math.min(SYNC_LIMIT, Number(limit) || SYNC_LIMIT));
  return tx(db, () => {
    const head = currentRev(db);
    const mine = syncEpoch(db);
    const reset = from > head || (from > 0 && from < floorOf(db)) || (from > 0 && epoch != null && String(epoch) !== mine);
    if (reset) from = 0;
    // everything but the long text of a read page or transcript, which a list row only previews
    const cols = db.prepare('PRAGMA table_info(items)').all()
      .map((c) => (c.name === 'link_md' ? `substr(link_md, 1, ${LINK_MD_CUT}) AS link_md` : c.name)).join(', ');
    const probe = (table) => db.prepare(`SELECT rev FROM ${table} WHERE rev > ? ORDER BY rev LIMIT 1 OFFSET ?`).get(from, lim - 1);
    // A page ends at a number, never in the middle of one: several merges can share a number (one item
    // that sits in all of them changed), and they must arrive together. So find where the longer list
    // reaches its limit, then take every row up to that number.
    const cutItems = probe('items');
    const cutBundles = probe('bundles');
    const upto = Math.min(head, cutItems ? cutItems.rev : head, cutBundles ? cutBundles.rev : head);
    const items = db.prepare(`SELECT ${cols} FROM items WHERE rev > ? AND rev <= ? ORDER BY rev`).all(from, upto);
    const bundles = db.prepare('SELECT * FROM bundles WHERE rev > ? AND rev <= ? ORDER BY rev, id').all(from, upto);
    // a first copy (or a reset) starts from nothing, so it has nothing to delete
    const gone = from === 0 ? [] : db.prepare('SELECT kind, id FROM sync_deleted WHERE rev > ? AND rev <= ? ORDER BY rev').all(from, upto);

    const itemTags = items.length ? tagsByItem(db) : new Map();
    const bundleTags = bundles.length ? tagsByBundle(db) : new Map();
    const members = db.prepare('SELECT item_id FROM bundle_items WHERE bundle_id = ? ORDER BY position');
    return {
      epoch: mine,
      rev: upto,
      more: upto < head,
      reset,
      items: items.map((it) => ({ ...itemDto(it), tags: itemTags.get(it.id) || [], rev: it.rev })),
      bundles: bundles.map((b) => ({
        id: b.id, slug: b.slug, title: b.title, created_at: b.created_at, updated_at: b.updated_at, version: b.version,
        category_id: b.category_id ?? null, priority: b.priority || 0, tags: bundleTags.get(b.id) || [],
        item_ids: members.all(b.id).map((r) => r.item_id), rev: b.rev,
      })),
      deleted: {
        items: gone.filter((g) => g.kind === 'item').map((g) => g.id),
        bundles: gone.filter((g) => g.kind === 'bundle').map((g) => g.id),
      },
      categories: db.prepare('SELECT id, name, position, parent_id FROM categories ORDER BY position, name COLLATE NOCASE').all(),
      tags: db.prepare('SELECT name FROM tags ORDER BY name COLLATE NOCASE').all().map((r) => r.name),
    };
  });
}

// Daily housekeeping: forget old deletions (remembering up to which number, so a phone that was away
// longer is told to start again), old answered changes, and claims that never finished.
export function pruneSync(db, t = now()) {
  return tx(db, () => {
    const top = db.prepare('SELECT MAX(rev) AS m FROM sync_deleted WHERE at < ?').get(t - DELETED_KEEP).m;
    let deleted = 0;
    if (top) {
      deleted = Number(db.prepare('DELETE FROM sync_deleted WHERE rev <= ?').run(top).changes);
      kvSet(db, FLOOR_KEY, Math.max(top, floorOf(db)));
    }
    const ops = Number(db.prepare('DELETE FROM ops_seen WHERE at < ? OR (status = 0 AND at < ?)').run(t - OPS_KEEP, t - CLAIM_SECONDS).changes);
    return { deleted, ops };
  });
}

// ---- a phone's change, sent again ----
// The app gives every change an id and sends it in the X-Op-Id header. If the answer got lost on the way
// (no signal), it sends the same change again and gets the stored answer; the change is not run twice.
// The id is claimed before the change runs (status 0), so two copies arriving together can't both run:
// the second is told to try again in a moment. A claim whose request died is given up after a minute.
export const OP_ID = /^[A-Za-z0-9._:-]{8,80}$/;
export const CLAIM_SECONDS = 60;
const ANSWER_MAX = 20_000;

// 'new': claimed for this request, run the change. { busy: true }: the same change is running right now.
// { status, body }: it was already answered.
export function claimOp(db, deviceId, opId) {
  const t = now();
  const r = db.prepare('SELECT status, body, at FROM ops_seen WHERE device_id = ? AND client_id = ?').get(deviceId, opId);
  if (r && r.status === 0) {
    if (t - r.at < CLAIM_SECONDS) return { busy: true };
    db.prepare('UPDATE ops_seen SET at = ? WHERE device_id = ? AND client_id = ?').run(t, deviceId, opId);
    return 'new';
  }
  if (r) {
    let body;
    try { body = JSON.parse(r.body); } catch { body = { ok: true, repeated: true }; }
    return { status: r.status, body };
  }
  db.prepare("INSERT INTO ops_seen (device_id, client_id, at, status, body) VALUES (?, ?, ?, 0, '')").run(deviceId, opId, t);
  return 'new';
}

// The change failed: free the id, so the app can fix what was wrong and send it again.
export function releaseOp(db, deviceId, opId) {
  db.prepare('DELETE FROM ops_seen WHERE device_id = ? AND client_id = ? AND status = 0').run(deviceId, opId);
}

// A long answer is kept without its long text, never without its ids: the app ties its own copy to the
// server's row by item.id, and reads the text again with the next sync.
function slimAnswer(body) {
  const text = JSON.stringify(body ?? { ok: true });
  if (text.length <= ANSWER_MAX) return text;
  if (body && body.item && typeof body.item === 'object') {
    const { text: _t, preview, article_md: _a, link_md: _l, ...item } = body.item;
    const slim = JSON.stringify({ ...body, item: { ...item, preview: String(preview || '').slice(0, 200) }, repeated: true });
    if (slim.length <= ANSWER_MAX) return slim;
    return JSON.stringify({ ok: true, repeated: true, item: { id: body.item.id, note_version: body.item.note_version ?? null } });
  }
  return JSON.stringify({ ok: true, repeated: true, ...(body && body.slug ? { slug: body.slug } : {}), ...(body && body.version ? { version: body.version } : {}) });
}

export function finishOp(db, deviceId, opId, status, body) {
  db.prepare(`INSERT INTO ops_seen (device_id, client_id, at, status, body) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_id, client_id) DO UPDATE SET at = excluded.at, status = excluded.status, body = excluded.body`)
    .run(deviceId, opId, now(), status, slimAnswer(body));
}

// ---- the owner's own typed notes ----
// A note is a kind = 'text' item with source_app = 'note' and an optional title (items.article_title).
// It is saved exactly as written: no link, post or Kindle detection, and no "same text within a day"
// folding. Only these items can be edited; a saved post or highlight never can.
export const NOTE_APP = 'note';
export const NOTE_TITLE_MAX = 200;
export const NOTE_TEXT_MAX = 100_000;

const fail = (status, message, extra) => Object.assign(new Error(message), { status, expose: true, extra });

function cleanNote({ title, text }, { maxText = NOTE_TEXT_MAX } = {}) {
  if (typeof text !== 'string') throw fail(400, 'Write something first');
  if (title != null && typeof title !== 'string') throw fail(400, 'A title must be text');
  const body = text.replace(/\r\n?/g, '\n').trim();
  if (!body) throw fail(400, 'Write something first');
  if (body.length > maxText) throw fail(413, `A note can be up to ${maxText.toLocaleString('en-US')} characters here`);
  const head = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (head.length > NOTE_TITLE_MAX) throw fail(400, `A title can be up to ${NOTE_TITLE_MAX} characters`);
  return { title: head || null, text: body };
}

// Returns the new item's id. opts.maxText: a smaller cap for a caller that must be held to one (a phone).
export function createNote(db, input, opts = {}) {
  const n = cleanNote(input, opts);
  const t = now();
  const r = db.prepare(`INSERT INTO items (kind, text, text_hash, article_title, fetch_status, saved, state, source_app, first_saved_at, last_saved_at)
      VALUES ('text', ?, ?, ?, 'n/a', 1, 'inbox', ?, ?, ?)`).run(n.text, textHash(n.text), n.title, NOTE_APP, t, t);
  return Number(r.lastInsertRowid);
}

// Change a note's title and text. base_version (optional) is the note_version of the note the editor
// started from, an exact fingerprint of its title and text. If the note changed in any way somewhere
// else since, nothing is written and the caller gets 409 with the current note, so no edit is lost
// without the owner seeing it.
export function editNote(db, id, input, opts = {}) {
  const n = cleanNote(input, opts);
  if (input.base_version != null && typeof input.base_version !== 'string') throw fail(400, 'Bad base_version');
  return tx(db, () => {
    const it = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(id));
    if (!it || !it.saved) throw fail(404, 'No such note');
    if (!isOwnNote(it)) throw fail(400, 'Only notes you wrote can be edited');
    if (input.base_version != null && input.base_version !== noteVersion(it)) {
      throw fail(409, 'This note changed somewhere else.', { error: 'stale', current: { title: it.article_title || null, text: it.text, note_version: noteVersion(it) } });
    }
    db.prepare('UPDATE items SET text = ?, text_hash = ?, article_title = ?, last_saved_at = ? WHERE id = ?')
      .run(n.text, textHash(n.text), n.title, now(), it.id);
    return it.id;
  });
}
