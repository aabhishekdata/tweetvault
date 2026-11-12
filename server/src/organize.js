// Categories (one per item or merged item), tags (any number) and priority (0 none, 1 low, 2 medium, 3 high).
import { now, tagKey } from './db.js';

export { tagKey };

export const PRIORITIES = [0, 1, 2, 3];

const bad = (msg) => Object.assign(new Error(msg), { status: 400, expose: true });

export function normTag(s) {
  return String(s ?? '').replace(/^\s*#+/, '').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
}

export function cleanTagList(list) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || list.length > 50) throw bad('tags must be a list');
  const seen = new Map();
  for (const t of list) {
    const n = normTag(t);
    if (n && !seen.has(tagKey(n))) seen.set(tagKey(n), n);
  }
  return [...seen.values()];
}

// Look a tag up by its case-folded key, not by name: the name column's NOCASE folds ASCII only.
export function findTagId(db, name) {
  const r = db.prepare('SELECT id FROM tags WHERE key = ?').get(tagKey(normTag(name)));
  return r ? r.id : null;
}

function tagId(db, name) {
  const id = findTagId(db, name);
  if (id !== null) return id;
  // belt and braces: a row without a key (written by an older release) still owns its name
  const old = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
  if (old) { db.prepare('UPDATE tags SET key = ? WHERE id = ? AND key IS NULL').run(tagKey(name), old.id); return old.id; }
  return Number(db.prepare('INSERT INTO tags (name, key) VALUES (?, ?)').run(name, tagKey(name)).lastInsertRowid);
}

export function checkCategory(db, v) {
  if (v === undefined) return undefined;
  if (v === null || v === '' || v === 'none') return null;
  const id = Number(v);
  if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id)) throw bad('No such category');
  return id;
}

export function checkPriority(v) {
  if (v === undefined) return undefined;
  const p = Number(v);
  if (!PRIORITIES.includes(p)) throw bad('priority must be 0, 1, 2 or 3');
  return p;
}

// item_id -> [tag names], bundle_id -> [tag names]
export function tagsByItem(db) {
  const m = new Map();
  for (const r of db.prepare('SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id ORDER BY t.name COLLATE NOCASE').all()) {
    if (!m.has(r.item_id)) m.set(r.item_id, []);
    m.get(r.item_id).push(r.name);
  }
  return m;
}
export function tagsByBundle(db) {
  const m = new Map();
  for (const r of db.prepare('SELECT bt.bundle_id, t.name FROM bundle_tags bt JOIN tags t ON t.id = bt.tag_id ORDER BY t.name COLLATE NOCASE').all()) {
    if (!m.has(r.bundle_id)) m.set(r.bundle_id, []);
    m.get(r.bundle_id).push(r.name);
  }
  return m;
}

// Change category / priority / tags on many items at once (call inside a transaction).
export function applyItemMeta(db, ids, { category_id, priority, add_tags, remove_tags }) {
  const cat = checkCategory(db, category_id);
  const pri = checkPriority(priority);
  const add = cleanTagList(add_tags) || [];
  const rem = cleanTagList(remove_tags) || [];
  let n = 0;
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM items WHERE id = ?').get(id)) continue;
    n++;
    if (cat !== undefined) db.prepare('UPDATE items SET category_id = ?, category_by = NULL WHERE id = ?').run(cat, id);   // the owner's choice now, not the AI run's
    if (pri !== undefined) db.prepare('UPDATE items SET priority = ? WHERE id = ?').run(pri, id);
    for (const t of add) db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)').run(id, tagId(db, t));
    for (const t of rem) {
      const tid = findTagId(db, t);
      if (tid !== null) db.prepare('DELETE FROM item_tags WHERE item_id = ? AND tag_id = ?').run(id, tid);
    }
  }
  pruneTags(db);
  return n;
}

// Replace a merged item's category / priority / tags (call inside a transaction).
export function setBundleMeta(db, bundleId, { category_id, priority, tags }) {
  const cat = checkCategory(db, category_id);
  const pri = checkPriority(priority);
  const list = cleanTagList(tags);
  if (cat !== undefined) db.prepare('UPDATE bundles SET category_id = ? WHERE id = ?').run(cat, bundleId);
  if (pri !== undefined) db.prepare('UPDATE bundles SET priority = ? WHERE id = ?').run(pri, bundleId);
  if (list !== undefined) {
    db.prepare('DELETE FROM bundle_tags WHERE bundle_id = ?').run(bundleId);
    for (const t of list) db.prepare('INSERT OR IGNORE INTO bundle_tags (bundle_id, tag_id) VALUES (?, ?)').run(bundleId, tagId(db, t));
    pruneTags(db);
  }
}

// A new merge starts with the tags of its items, the first item's category and the highest priority.
export function inheritBundleMeta(db, bundleId, itemIds) {
  if (!itemIds.length) return;
  const ph = itemIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, category_id, priority FROM items WHERE id IN (${ph})`).all(...itemIds);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const firstCat = itemIds.map((i) => byId.get(i)).find((r) => r && r.category_id);
  const pri = Math.max(0, ...rows.map((r) => r.priority || 0));
  db.prepare('UPDATE bundles SET category_id = ?, priority = ? WHERE id = ?').run(firstCat ? firstCat.category_id : null, pri, bundleId);
  db.prepare(`INSERT OR IGNORE INTO bundle_tags (bundle_id, tag_id) SELECT ?, tag_id FROM item_tags WHERE item_id IN (${ph})`).run(bundleId, ...itemIds);
}

// Items that join an existing merge ("Add to merged…", a short link turning into its tweet) bring their
// tags, raise the merge's priority to theirs, and fill its category if it has none. Nothing is taken away.
export function addItemsToBundleMeta(db, bundleId, itemIds) {
  if (!itemIds.length) return;
  const ph = itemIds.map(() => '?').join(',');
  db.prepare(`INSERT OR IGNORE INTO bundle_tags (bundle_id, tag_id) SELECT ?, tag_id FROM item_tags WHERE item_id IN (${ph})`).run(bundleId, ...itemIds);
  const rows = db.prepare(`SELECT id, category_id, priority FROM items WHERE id IN (${ph})`).all(...itemIds);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const firstCat = itemIds.map((i) => byId.get(i)).find((r) => r && r.category_id);
  db.prepare('UPDATE bundles SET priority = MAX(priority, ?), category_id = COALESCE(category_id, ?) WHERE id = ?')
    .run(Math.max(0, ...rows.map((r) => r.priority || 0)), firstCat ? firstCat.category_id : null, bundleId);
}

// Unmerging hands the merged item's organizing to its items: tags are added, the category fills in
// where an item has none, and priority goes up to the merged item's level (never down).
export function passMetaToItems(db, bundleId) {
  const b = db.prepare('SELECT category_id, priority FROM bundles WHERE id = ?').get(bundleId);
  if (!b) return;
  const ids = db.prepare('SELECT item_id FROM bundle_items WHERE bundle_id = ?').all(bundleId).map((r) => r.item_id);
  for (const id of ids) {
    db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id) SELECT ?, tag_id FROM bundle_tags WHERE bundle_id = ?').run(id, bundleId);
    if (b.category_id) db.prepare('UPDATE items SET category_id = ? WHERE id = ? AND category_id IS NULL').run(b.category_id, id);
    if (b.priority) db.prepare('UPDATE items SET priority = ? WHERE id = ? AND priority < ?').run(b.priority, id, b.priority);
  }
}

// Add one tag to a merged item, keeping the ones it has (call inside a transaction).
export function addBundleTag(db, bundleId, name) {
  const n = normTag(name);
  if (n) db.prepare('INSERT OR IGNORE INTO bundle_tags (bundle_id, tag_id) VALUES (?, ?)').run(bundleId, tagId(db, n));
}

export function pruneTags(db) {
  db.prepare(`DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM item_tags) AND id NOT IN (SELECT tag_id FROM bundle_tags)`).run();
}

// ---- categories ----
// Two levels: a top-level category, and subcategories under it (parent_id). Names are unique across the
// whole list, whatever the level, so a name always means one category.
export const cleanCategoryName = (name) => String(name ?? '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ')
  .trim().replace(/\s+/g, ' ').slice(0, 40).trim();

// undefined: not given. null: top level. Otherwise the id of an existing top-level category.
function checkParent(db, v, selfId = null) {
  if (v === undefined) return undefined;
  if (v === null || v === '' || v === 'none') return null;
  const id = Number(v);
  const p = Number.isInteger(id) ? db.prepare('SELECT id, parent_id FROM categories WHERE id = ?').get(id) : null;
  if (!p) throw bad('No such category');
  if (p.parent_id) throw bad("A subcategory can't have subcategories of its own");
  if (selfId !== null && p.id === selfId) throw bad("A category can't go under itself");
  return p.id;
}

export function createCategory(db, name, parentId = null, { byAi = false } = {}) {
  const n = cleanCategoryName(name);
  if (!n) throw bad('Give the category a name');
  if (db.prepare('SELECT 1 FROM categories WHERE name = ?').get(n)) throw bad('That category already exists');
  const parent = checkParent(db, parentId) ?? null;
  const pos = (db.prepare('SELECT MAX(position) AS m FROM categories').get().m ?? -1) + 1;
  return Number(db.prepare('INSERT INTO categories (name, position, created_at, parent_id, by_ai) VALUES (?, ?, ?, ?, ?)')
    .run(n, pos, now(), parent, byAi ? 1 : 0).lastInsertRowid);
}

export function renameCategory(db, id, name) {
  const n = cleanCategoryName(name);
  if (!n) throw bad('Give the category a name');
  const clash = db.prepare('SELECT id FROM categories WHERE name = ?').get(n);
  if (clash && clash.id !== Number(id)) throw bad('That category already exists');
  return Number(db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(n, Number(id)).changes);
}

// Move a category under a top-level one, or (parentId null) back to the top level.
export function moveCategory(db, id, parentId) {
  const cid = Number(id);
  if (!Number.isInteger(cid) || !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(cid)) return 0;
  const parent = checkParent(db, parentId, cid) ?? null;
  if (parent !== null && db.prepare('SELECT 1 FROM categories WHERE parent_id = ?').get(cid)) {
    throw bad('Move its subcategories out first: a category with subcategories stays at the top level');
  }
  db.prepare('UPDATE categories SET parent_id = ? WHERE id = ?').run(parent, cid);
  return 1;
}

export function deleteCategory(db, id) {
  // items and merged items in it simply become uncategorised; its subcategories move to the top level
  db.prepare('UPDATE items SET category_id = NULL, category_by = NULL WHERE category_id = ?').run(Number(id));
  db.prepare('UPDATE bundles SET category_id = NULL WHERE category_id = ?').run(Number(id));
  db.prepare('UPDATE categories SET parent_id = NULL WHERE parent_id = ?').run(Number(id));
  return Number(db.prepare('DELETE FROM categories WHERE id = ?').run(Number(id)).changes);
}

// A category and its subcategories: what a filter on that category shows.
export function categoryFamily(db, id) {
  return [id, ...db.prepare('SELECT id FROM categories WHERE parent_id = ? ORDER BY id').all(id).map((r) => r.id)];
}

// Sidebar numbers. "Loose" items = saved, in the given state, not inside any merge.
export function organizeSummary(db) {
  const loose = "saved = 1 AND id NOT IN (SELECT item_id FROM bundle_items)";
  const count = (sql, ...a) => db.prepare(sql).get(...a).n;
  return {
    counts: {
      inbox: count(`SELECT COUNT(*) AS n FROM items WHERE ${loose} AND state = 'inbox'`),
      archived: count(`SELECT COUNT(*) AS n FROM items WHERE ${loose} AND state = 'archived'`),
      trashed: count(`SELECT COUNT(*) AS n FROM items WHERE ${loose} AND state = 'trashed'`),
      merged: count('SELECT COUNT(*) AS n FROM bundles'),
      high_items: count(`SELECT COUNT(*) AS n FROM items WHERE ${loose} AND state = 'inbox' AND priority = 3`),
      high_merged: count('SELECT COUNT(*) AS n FROM bundles WHERE priority = 3'),
    },
    categories: rollUp(db.prepare(`SELECT c.id, c.name, c.position, c.parent_id, c.by_ai,
        (SELECT COUNT(*) FROM items i WHERE i.category_id = c.id AND i.saved = 1 AND i.state = 'inbox'
          AND i.id NOT IN (SELECT item_id FROM bundle_items)) AS items,
        (SELECT COUNT(*) FROM bundles b WHERE b.category_id = c.id) AS merged
        FROM categories c ORDER BY c.position, c.name COLLATE NOCASE`).all()),
    tags: db.prepare(`SELECT t.id, t.name,
        (SELECT COUNT(*) FROM item_tags it JOIN items i ON i.id = it.item_id WHERE it.tag_id = t.id AND i.saved = 1 AND i.state = 'inbox' AND i.id NOT IN (SELECT item_id FROM bundle_items)) AS items,
        (SELECT COUNT(*) FROM bundle_tags bt WHERE bt.tag_id = t.id) AS merged
        FROM tags t ORDER BY t.name COLLATE NOCASE`).all(),
  };
}

// A top-level category's numbers include its subcategories (a filter on it shows them too); own_items and
// own_merged are what sits directly in it.
function rollUp(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) { r.own_items = r.items; r.own_merged = r.merged; r.parent_id = r.parent_id ?? null; r.by_ai = r.by_ai ? 1 : 0; }
  for (const r of rows) {
    const p = r.parent_id ? byId.get(r.parent_id) : null;
    if (p) { p.items += r.own_items; p.merged += r.own_merged; }
  }
  return rows;
}

// Shared filter for list views: {category: id|'none', tag: name, priority: min level}
// With db, `cats` lists the category and its subcategories, so a top-level category shows everything under it.
export function parseFilter(sp, db = null) {
  const cat = sp.get('category');
  const tag = sp.get('tag');
  const pri = Number(sp.get('priority') || 0);
  const category = cat === 'none' ? 'none' : (cat && /^\d+$/.test(cat) ? Number(cat) : null);
  return {
    category,
    cats: typeof category === 'number' ? (db ? categoryFamily(db, category) : [category]) : null,
    tag: tag ? tagKey(normTag(tag)) : null,
    priority: PRIORITIES.includes(pri) ? pri : 0,
  };
}

export function matches(row, tags, f) {
  if (f.category === 'none' && row.category_id) return false;
  if (typeof f.category === 'number' && !(f.cats || [f.category]).includes(row.category_id)) return false;
  if (f.tag && !(tags || []).some((t) => tagKey(t) === tagKey(f.tag))) return false;
  if (f.priority && (row.priority || 0) < f.priority) return false;
  return true;
}

export const SORTS = ['saved_desc', 'saved_asc', 'posted_desc', 'priority', 'likes'];

// A deleted merge's slug can be reused. A tab still open on the old merge holds its slug and version, so
// a new merge with that slug starts above the last version the old one reached (see DELETE /api/bundles).
const slugFloorKey = (slug) => `bundle_slug_floor:${slug}`;
export function rememberSlugVersion(db, slug, version) {
  db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER))`)
    .run(slugFloorKey(slug), String(version));
}
export function firstBundleVersion(db, slug) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(slugFloorKey(slug));
  return (Number(row && row.value) || 0) + 1;
}
