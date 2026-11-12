// Review fixes that crossed group lines: the CLI's make-bundle honours the slug floor, deleting a tag
// matches non-ASCII case, and an older overlapping translation never overwrites a newer one.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.js';
import { byId } from '../src/items.js';
import { main } from '../src/cli.js';
import * as O from '../src/organize.js';
import { createTranslator, storedTranslation } from '../src/translate.js';

// Windows can hold the WAL file open for a moment after close; a leftover temp folder is harmless
const cleanup = (dir) => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };

function ins(db, f) {
  const row = { kind: 'tweet', saved: 1, state: 'inbox', fetch_status: 'ok', ...f };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => row[c])).lastInsertRowid);
}

describe('make-bundle (CLI) and the slug floor', () => {
  test('a CLI merge reusing an unmerged slug starts above the old version', () => {
    const db = openDb(':memory:');
    const id = ins(db, { kind: 'text', text: 'hello', fetch_status: 'n/a' });
    O.rememberSlugVersion(db, 'ideas', 7);
    const out = [];
    assert.equal(main(['make-bundle', 'Ideas', String(id)], { db, out: (s) => out.push(s) }), 0);
    assert.equal(out[0], 'ideas');
    assert.equal(db.prepare("SELECT version FROM bundles WHERE slug = 'ideas'").get().version, 8);
  });

  test('a fresh slug from the CLI still starts at 1', () => {
    const db = openDb(':memory:');
    const id = ins(db, { kind: 'text', text: 'hello', fetch_status: 'n/a' });
    main(['make-bundle', 'Fresh', String(id)], { db, out: () => {} });
    assert.equal(db.prepare("SELECT version FROM bundles WHERE slug = 'fresh'").get().version, 1);
  });
});

describe('tag lookup by canonical key', () => {
  test('findTagId matches a tag typed in a different non-ASCII case', () => {
    const db = openDb(':memory:');
    const id = ins(db, { tweet_id: '1', text: 'x' });
    O.applyItemMeta(db, [id], { add_tags: ['Émoji'] });
    assert.ok(O.findTagId(db, 'émoji'), 'lower-case é finds Émoji');
    assert.equal(O.findTagId(db, 'émoji'), O.findTagId(db, 'ÉMOJI'));
  });
});

describe('tag keys after a rollback to an older release', () => {
  test('tags written without a key are repaired (and duplicates merged) on the next start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tv-heal-'));
    const path = join(dir, 'v.db');
    let db = openDb(path);
    const a = ins(db, { tweet_id: '1', text: 'x' });
    const b = ins(db, { tweet_id: '2', text: 'y' });
    O.applyItemMeta(db, [a], { add_tags: ['Émoji'] });
    // what the previous release does: INSERT INTO tags (name) with no key
    const dup = Number(db.prepare('INSERT INTO tags (name) VALUES (?)').run('émoji').lastInsertRowid);
    db.prepare('INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?)').run(b, dup);
    db.prepare('INSERT INTO tags (name) VALUES (?)').run('Rollback');
    db.close();
    db = openDb(path);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tags WHERE key IS NULL').get().n, 0);
    const emoji = O.findTagId(db, 'émoji');
    assert.ok(emoji && O.findTagId(db, 'Rollback'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tags WHERE key = ?').get('émoji').n, 1, 'the duplicate was merged');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_tags WHERE tag_id = ?').get(emoji).n, 2, 'both items keep the tag');
    // and re-adding the name no longer hits the unique name index
    O.applyItemMeta(db, [a], { add_tags: ['rollback'] });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tags').get().n, 2);
    db.close();
    cleanup(dir);
  });

  test('a keyless tag that slipped in is still found by name when adding', () => {
    const db = openDb(':memory:');
    const a = ins(db, { tweet_id: '1', text: 'x' });
    db.prepare('INSERT INTO tags (name) VALUES (?)').run('Legacy');
    O.applyItemMeta(db, [a], { add_tags: ['legacy'] });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tags').get().n, 1);
    assert.equal(db.prepare('SELECT key FROM tags').get().key, 'legacy');
  });
});

describe('merges carry their own organizing data', () => {
  test('a CLI merge inherits its items\' tags, category and priority', () => {
    const db = openDb(':memory:');
    const id = ins(db, { tweet_id: '1', text: 'x', priority: 3 });
    O.applyItemMeta(db, [id], { add_tags: ['ai'] });
    main(['make-bundle', 'Agents', String(id)], { db, out: () => {} });
    const b = db.prepare("SELECT id, priority FROM bundles WHERE slug = 'agents'").get();
    assert.equal(b.priority, 3);
    assert.deepEqual(O.tagsByBundle(db).get(b.id), ['ai']);
  });

  test('items added to a merge raise its priority and fill an empty category, never lower them', () => {
    const db = openDb(':memory:');
    const cat = O.createCategory(db, 'Research');
    const a = ins(db, { tweet_id: '1', text: 'x', priority: 1 });
    const c = ins(db, { tweet_id: '2', text: 'y', priority: 3, category_id: cat });
    const bid = Number(db.prepare("INSERT INTO bundles (slug, title, priority) VALUES ('m', 'M', 2)").run().lastInsertRowid);
    O.addItemsToBundleMeta(db, bid, [a]);
    assert.equal(db.prepare('SELECT priority FROM bundles WHERE id = ?').get(bid).priority, 2, 'not lowered');
    O.addItemsToBundleMeta(db, bid, [c]);
    const row = db.prepare('SELECT priority, category_id FROM bundles WHERE id = ?').get(bid);
    assert.equal(row.priority, 3);
    assert.equal(row.category_id, cat);
  });

  test('the v4 upgrade gives merges with no organizing data their items\' values, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tv-v3-'));
    const path = join(dir, 'v.db');
    // build a v3 database by hand: the current schema minus the v4 step
    let db = openDb(path, { upTo: 3 });
    const id = ins(db, { tweet_id: '1', text: 'x', priority: 2 });
    db.prepare('INSERT INTO tags (name) VALUES (?)').run('ai');
    db.prepare('INSERT INTO item_tags (item_id, tag_id) VALUES (?, 1)').run(id);
    const bare = Number(db.prepare("INSERT INTO bundles (slug, title) VALUES ('cli', 'Made by CLI')").run().lastInsertRowid);
    db.prepare('INSERT INTO bundle_items (bundle_id, item_id, position) VALUES (?, ?, 0)').run(bare, id);
    const set = Number(db.prepare("INSERT INTO bundles (slug, title, priority) VALUES ('web', 'Web', 1)").run().lastInsertRowid);
    db.prepare('INSERT INTO bundle_items (bundle_id, item_id, position) VALUES (?, ?, 0)').run(set, id);
    db.close();
    db = openDb(path);
    assert.equal(db.prepare('SELECT priority FROM bundles WHERE id = ?').get(bare).priority, 2);
    assert.deepEqual(O.tagsByBundle(db).get(bare), ['ai']);
    assert.equal(db.prepare('SELECT priority FROM bundles WHERE id = ?').get(set).priority, 1, 'organized merges are left alone');
    assert.equal(O.tagsByBundle(db).get(set), undefined);
    db.close();
    cleanup(dir);
  });
});

describe('overlapping translations of one item', () => {
  test('the call for the old text finishing last does not overwrite the new translation', async () => {
    const db = openDb(':memory:');
    const id = ins(db, { tweet_id: '9', text: '旧的文字' });
    const pending = [];
    const client = { messages: { create: (p) => new Promise((resolve) => pending.push({ p, resolve })) } };
    const t = createTranslator(db, { client });
    const oldCall = t.translate(byId(db, id));
    await new Promise((r) => setImmediate(r));
    db.prepare('UPDATE items SET text = ? WHERE id = ?').run('新的文字', id);
    const newCall = t.translate(byId(db, id));
    await new Promise((r) => setImmediate(r));
    assert.equal(pending.length, 2, 'two different texts, two calls');
    // the new text's call finishes first, then the old one
    pending[1].resolve({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'new words' }] });
    assert.equal((await newCall).text, 'new words');
    pending[0].resolve({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'old words' }] });
    assert.equal((await oldCall).text, 'old words', 'the old caller still gets its answer');
    const stored = storedTranslation(db, byId(db, id));
    assert.ok(stored, 'the stored translation still matches the current text');
    assert.equal(stored.text, 'new words');
  });
});
