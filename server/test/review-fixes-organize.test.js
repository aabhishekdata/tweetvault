// Regression tests for review findings in the organizing code:
// - the Inbox filters and sort must run before the 2000-row cap, not after it
// - tags that differ only in non-ASCII letter case are one tag (SQLite NOCASE folds ASCII only)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { buildInbox } from '../src/tree.js';
import * as O from '../src/organize.js';

const addNote = (db, i) => Number(db.prepare(`INSERT INTO items (kind, text, fetch_status, saved, state, first_saved_at, last_saved_at)
  VALUES ('text', ?, 'n/a', 1, 'inbox', ?, ?)`).run(`note ${i}`, 1000 + i, 1000 + i).lastInsertRowid);

const tagNames = (db) => db.prepare('SELECT name FROM tags ORDER BY id').all().map((r) => r.name);
const itemTags = (db, id) => O.tagsByItem(db).get(id) || [];

describe('Inbox filters run before the list cap', () => {
  let db;
  let ids;
  before(() => {
    db = openDb(':memory:');
    ids = [];
    for (let i = 0; i < 2500; i++) ids.push(addNote(db, i));
    // the 600 oldest saves carry a tag, a category and high priority; none of them is in the newest 2000
    const cat = O.createCategory(db, 'Reading');
    O.applyItemMeta(db, ids.slice(0, 600), { add_tags: ['research'], category_id: cat, priority: 3 });
    // newest 300 are in a merge: they must not use up rows under the cap
    db.prepare("INSERT INTO bundles (slug, title, created_at, updated_at) VALUES ('m', 'M', 1, 1)").run();
    const ins = db.prepare('INSERT INTO bundle_items (bundle_id, item_id, position) VALUES (1, ?, ?)');
    ids.slice(-300).forEach((id, i) => ins.run(id, i));
  });
  after(() => db.close());

  test('a tag filter finds older matching items', () => {
    const groups = buildInbox(db, { filter: O.parseFilter(new URLSearchParams('tag=Research')) });
    assert.equal(groups.length, 600);
  });

  test('category, Uncategorized and priority filters are not cut short', () => {
    const cat = db.prepare("SELECT id FROM categories WHERE name = 'Reading'").get().id;
    assert.equal(buildInbox(db, { filter: { category: cat, tag: null, priority: 0 } }).length, 600);
    assert.equal(buildInbox(db, { filter: { category: null, tag: null, priority: 3 } }).length, 600);
    // 2500 - 600 categorised - 300 merged = 1600 uncategorised loose items
    assert.equal(buildInbox(db, { filter: { category: 'none', tag: null, priority: 0 } }).length, 1600);
  });

  test('oldest-first starts at the real oldest save', () => {
    const groups = buildInbox(db, { sort: 'saved_asc' });
    assert.equal(groups[0].root.first_saved_at, 1000);
    assert.equal(groups.length, 2000);
  });

  test('merged items do not take rows under the cap', () => {
    const groups = buildInbox(db, {});
    assert.equal(groups.length, 2000);
    assert.equal(groups[0].root.first_saved_at, 1000 + 2199);   // newest loose item
  });
});

describe('tags fold non-ASCII case', () => {
  test('Émoji and émoji in separate requests are one tag', () => {
    const db = openDb(':memory:');
    const a = addNote(db, 1);
    const b = addNote(db, 2);
    O.applyItemMeta(db, [a], { add_tags: ['Émoji'] });
    O.applyItemMeta(db, [b], { add_tags: ['émoji'] });
    assert.deepEqual(tagNames(db), ['Émoji']);
    assert.deepEqual(itemTags(db, b), ['Émoji']);
    // composed and decomposed forms are the same tag too
    O.applyItemMeta(db, [b], { add_tags: ['Émoji'] });
    assert.deepEqual(tagNames(db), ['Émoji']);
    // removing with the other case works
    O.applyItemMeta(db, [b], { remove_tags: ['ÉMOJI'] });
    assert.deepEqual(itemTags(db, b), []);
    assert.equal(O.findTagId(db, 'émoji'), db.prepare('SELECT id FROM tags').get().id);
    const sum = O.organizeSummary(db);
    assert.deepEqual(sum.tags.map((t) => [t.name, t.items]), [['Émoji', 1]]);
    db.close();
  });

  test('merged item tags dedupe the same way', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO bundles (slug, title, created_at, updated_at) VALUES ('m', 'M', 1, 1)").run();
    O.setBundleMeta(db, 1, { tags: ['Ärger'] });
    O.setBundleMeta(db, 1, { tags: ['ärger', 'Ärger'] });
    assert.deepEqual(tagNames(db), ['Ärger']);
    assert.deepEqual(O.tagsByBundle(db).get(1), ['Ärger']);
    db.close();
  });
});

describe('v4 migration merges tags that share a key', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'tv-v4-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('duplicates collapse, links are re-pointed, and a copy is kept', () => {
    const path = join(dir, 'v3.db');
    // build a v3 database through the real migrations, then roll the tag-key step back by hand
    const seed = openDb(path, { upTo: 3 });
    const a = addNote(seed, 1);
    const b = addNote(seed, 2);
    seed.prepare("INSERT INTO tags (id, name) VALUES (1, 'Émoji'), (2, 'émoji'), (3, 'plain')").run();
    seed.prepare('INSERT INTO item_tags (item_id, tag_id) VALUES (?, 1), (?, 2), (?, 2), (?, 3)').run(a, a, b, b);
    seed.prepare("INSERT INTO bundles (slug, title, created_at, updated_at) VALUES ('m', 'M', 1, 1)").run();
    seed.prepare('INSERT INTO bundle_tags (bundle_id, tag_id) VALUES (1, 2)').run();
    seed.close();
    const before = new DatabaseSync(path);
    assert.equal(before.prepare('SELECT COUNT(*) AS n FROM tags').get().n, 3);
    before.close();

    const db = openDb(path);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12, 'upgraded through v4 to the latest');
      assert.deepEqual(db.prepare('SELECT id, name, key FROM tags ORDER BY id').all().map((r) => ({ ...r })),
        [{ id: 1, name: 'Émoji', key: 'émoji' }, { id: 3, name: 'plain', key: 'plain' }]);
      assert.deepEqual(itemTags(db, a), ['Émoji']);
      assert.deepEqual(itemTags(db, b).sort(), ['plain', 'Émoji'].sort());
      assert.deepEqual(O.tagsByBundle(db).get(1), ['Émoji']);
      // the unique key now stops a new duplicate at the database level
      assert.throws(() => db.prepare("INSERT INTO tags (name, key) VALUES ('ÉMOJI', 'émoji')").run());
    } finally { db.close(); }
    assert.ok(readdirSync(dir).some((f) => f.startsWith('v3.db.before-v')), 'kept a copy before upgrading');
  });
});
