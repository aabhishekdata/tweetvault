// SQLite storage (built-in node:sqlite). Tweet IDs are always TEXT.
import { DatabaseSync } from 'node:sqlite';
import { healKindleQuotes, KINDLE_HEAL_KEY } from './kindle.js';

const KINDLE_HEALED = 'SELECT 1 FROM kv WHERE key = ?';

const MIGRATIONS = [
  // v1
  `
  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('tweet','article','text','link')),
    tweet_id TEXT UNIQUE,
    url TEXT,
    parent_tweet_id TEXT,
    root_tweet_id TEXT,
    is_self_thread INTEGER NOT NULL DEFAULT 0,
    quote_tweet_id TEXT,
    quote_json TEXT,
    author_handle TEXT,
    author_name TEXT,
    posted_at INTEGER,
    text TEXT,
    article_title TEXT,
    article_md TEXT,
    likes INTEGER, replies INTEGER, reposts INTEGER, views INTEGER, stats_at INTEGER,
    fetch_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (fetch_status IN ('pending','ok','oembed','link_only','unavailable','failed','n/a')),
    fetch_attempts INTEGER NOT NULL DEFAULT 0,
    next_fetch_at INTEGER,
    fetch_error TEXT,
    render_version INTEGER,
    saved INTEGER NOT NULL DEFAULT 1,
    ctx_depth INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'inbox' CHECK (state IN ('inbox','archived','trashed')),
    text_hash TEXT,
    source_app TEXT,
    note TEXT,
    first_saved_at INTEGER,
    last_saved_at INTEGER,
    trashed_at INTEGER
  );
  CREATE INDEX items_root ON items(root_tweet_id);
  CREATE INDEX items_parent ON items(parent_tweet_id);
  CREATE INDEX items_fetch ON items(fetch_status, next_fetch_at);
  CREATE INDEX items_state ON items(saved, state, last_saved_at);
  CREATE INDEX items_text_hash ON items(text_hash);

  CREATE TABLE captures (
    id INTEGER PRIMARY KEY,
    client_id TEXT NOT NULL UNIQUE,
    item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
    raw_input TEXT NOT NULL,
    source_app TEXT,
    device_id INTEGER,
    captured_at INTEGER,
    received_at INTEGER
  );
  CREATE INDEX captures_device ON captures(device_id, received_at);

  CREATE TABLE raw_fetches (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('fxtwitter','oembed')),
    fetched_at INTEGER NOT NULL,
    http_status INTEGER,
    body TEXT NOT NULL,
    PRIMARY KEY (item_id, source)
  );

  CREATE TABLE bundles (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    note TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE bundle_items (
    bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL,
    PRIMARY KEY (bundle_id, item_id)
  );

  CREATE TABLE devices (
    id INTEGER PRIMARY KEY,
    name TEXT,
    token_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    created_at INTEGER,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE TABLE pair_codes (
    code_hash TEXT PRIMARY KEY,
    scopes TEXT NOT NULL,
    created_at INTEGER,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    created_at INTEGER,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    ip TEXT,
    user_agent TEXT,
    mfa_ok INTEGER NOT NULL DEFAULT 0,
    trusted INTEGER NOT NULL DEFAULT 0,
    via_recovery INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE trusted_browsers (
    id_hash TEXT PRIMARY KEY,
    created_at INTEGER,
    expires_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE TABLE mfa (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    secret_enc TEXT,
    pending_secret_enc TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,
    last_step INTEGER NOT NULL DEFAULT 0,
    recovery_json TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    event TEXT NOT NULL,
    ok INTEGER NOT NULL DEFAULT 1,
    ip TEXT,
    user_agent TEXT,
    detail TEXT
  );
  CREATE INDEX audit_at ON audit_log(at);
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
  `,
  // v2: organizing (categories, tags, priority) for items and merged bundles
  `
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER
  );
  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE item_tags (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, tag_id)
  );
  CREATE TABLE bundle_tags (
    bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (bundle_id, tag_id)
  );
  ALTER TABLE items ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
  ALTER TABLE items ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE bundles ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
  ALTER TABLE bundles ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX item_tags_tag ON item_tags(tag_id);
  CREATE INDEX bundle_tags_tag ON bundle_tags(tag_id);
  `,
  // English translations made by Claude, one per item; source_hash ties it to the text it was made from
  `
  CREATE TABLE translations (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    source_hash TEXT NOT NULL,
    text TEXT NOT NULL,
    lang TEXT,
    model TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // v4: tags get a case-folded key with a unique index. The name column's COLLATE NOCASE folds ASCII
  // only, so 'Émoji' and 'émoji' used to become two tags. This step runs in JS because SQLite's lower()
  // is ASCII-only too; tags that now share a key are merged into the oldest one instead of failing.
  addTagKeys,
  // v5 (enhancement pass 1, phase 1): the owner's own notes, "get the full thread" jobs, prompt recipes.
  // raw_fetches is rebuilt only to widen its source list (thread fetches now, web pages and YouTube later);
  // nothing references it, and its rows are copied over unchanged.
  `
  ALTER TABLE items ADD COLUMN my_note TEXT;
  ALTER TABLE items ADD COLUMN thread_status TEXT CHECK (thread_status IN ('queued','done','failed'));
  ALTER TABLE items ADD COLUMN thread_error TEXT;
  ALTER TABLE items ADD COLUMN thread_at INTEGER;
  CREATE INDEX items_thread ON items(thread_status);

  CREATE TABLE raw_fetches_v5 (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('fxtwitter','oembed','fxthread','web','youtube')),
    fetched_at INTEGER NOT NULL,
    http_status INTEGER,
    body TEXT NOT NULL,
    PRIMARY KEY (item_id, source)
  );
  INSERT INTO raw_fetches_v5 SELECT item_id, source, fetched_at, http_status, body FROM raw_fetches;
  DROP TABLE raw_fetches;
  ALTER TABLE raw_fetches_v5 RENAME TO raw_fetches;

  CREATE TABLE recipes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    prompt TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER
  );
  INSERT INTO recipes (name, prompt, position, created_at, updated_at) VALUES
  ('Hook angles', 'Read the source material below (posts, replies and notes I saved about "{{title}}").

Find 5 distinct hook angles for a YouTube video on this topic. For each one give:
- the hook as I would say it in the first 10 seconds (one or two sentences)
- the tension or question it opens, and why a viewer would keep watching
- which saved item(s) it comes from (use the section labels, for example "Reply 3")

Prefer angles that are surprising, specific and true to the material. Do not invent facts that are not in it.', 0, strftime('%s','now'), strftime('%s','now')),
  ('10-minute outline', 'Using the source material below about "{{title}}", outline a 10-minute YouTube script.

Give: a working title, a hook (first 30 seconds), 4 to 6 sections with timings, the key point and the best supporting example from the material for each, transitions between sections, and a closing payoff with a call to action.
Cite the saved items by their section labels. Flag anything that needs fact-checking before I record.', 1, strftime('%s','now'), strftime('%s','now')),
  ('Counter-arguments', 'From the source material below about "{{title}}", pull out the strongest counter-arguments and objections, especially from the replies.

For each: state it in its strongest form, say who made it (label and handle), rate how convincing it is (high, medium or low) with one line on why, and suggest how a video could address it honestly.
End with the one objection a sceptical viewer is most likely to raise.', 2, strftime('%s','now'), strftime('%s','now'));
  `,
  // v6 (enhancement pass 1, phase 2 step B): OAuth 2.1 so claude.ai can connect to /mcp as a custom connector.
  // A client is one dynamic registration; a grant is one consent (one connected app on the Security page).
  // Codes and tokens are stored only as SHA-256 hashes.
  `
  CREATE TABLE oauth_clients (
    client_id TEXT PRIMARY KEY,
    name TEXT,
    redirect_uris TEXT NOT NULL,
    grant_types TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE INDEX oauth_clients_age ON oauth_clients(last_used_at, created_at);

  CREATE TABLE oauth_grants (
    id INTEGER PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX oauth_grants_client ON oauth_grants(client_id);
  CREATE INDEX oauth_grants_revoked ON oauth_grants(revoked_at);

  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    grant_id INTEGER NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX oauth_codes_grant ON oauth_codes(grant_id);
  CREATE INDEX oauth_codes_expiry ON oauth_codes(expires_at);

  CREATE TABLE oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    grant_id INTEGER NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
  CREATE INDEX oauth_tokens_expiry ON oauth_tokens(expires_at);
  `,
  // v7 (OAuth review fixes): when a registration last reached the consent page (shown, or Deny chosen), so
  // pruning never removes one the owner is using; and which redirect each consent actually went to
  // ('claude' or 'loopback'), so Connected apps names it correctly. Additive only.
  `
  ALTER TABLE oauth_clients ADD COLUMN seen_at INTEGER;
  ALTER TABLE oauth_grants ADD COLUMN redirect_kind TEXT;
  `,
  // v8 (enhancement pass 1, phase 3): local copies of post images, and readable content for normal links
  // (web articles) and YouTube videos. Links stay kind = 'link'; link_type says which reader filled them.
  `
  CREATE TABLE media (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    source_url TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'image' CHECK (kind IN ('image','poster')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','failed','skipped')),
    sha256 TEXT,
    mime TEXT,
    bytes INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL,
    fetched_at INTEGER,
    UNIQUE (item_id, source_url)
  );
  CREATE INDEX media_status ON media(status, next_at);
  CREATE INDEX media_sha ON media(sha256);

  ALTER TABLE items ADD COLUMN link_type TEXT CHECK (link_type IN ('web','youtube'));
  ALTER TABLE items ADD COLUMN link_title TEXT;
  ALTER TABLE items ADD COLUMN link_site TEXT;
  ALTER TABLE items ADD COLUMN link_author TEXT;
  ALTER TABLE items ADD COLUMN link_published_at INTEGER;
  ALTER TABLE items ADD COLUMN link_md TEXT;
  ALTER TABLE items ADD COLUMN link_meta TEXT;
  ALTER TABLE items ADD COLUMN link_fetched_at INTEGER;
  CREATE INDEX items_link_type ON items(link_type);
  `,
  // v9 (voice notes, PLAN-VOICE.md): recordings, their transcripts and notes, and extra passes with the
  // owner's own prompt. A voice note is also a kind = 'text' item (items.voice_id), so it shows in the
  // inbox, merges and search with no new paths. Additive only.
  `
  CREATE TABLE voice_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,   -- never reused: audio files, cached audio and Drive copies are named by id
    item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
    source TEXT NOT NULL CHECK (source IN ('phone','web','share')),
    device_id INTEGER,
    client_id TEXT,
    title TEXT,
    mime TEXT NOT NULL,
    ext TEXT NOT NULL CHECK (ext IN ('ogg','webm','m4a')),
    bytes INTEGER NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    duration_s INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading','transcribing','writing','ready','failed')),
    failed_stage TEXT CHECK (failed_stage IN ('transcript','notes')),
    attempts INTEGER NOT NULL DEFAULT 0,
    busy_waits INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER,
    error TEXT,
    transcript_json TEXT,
    transcript_text TEXT,
    transcript_model TEXT,
    language TEXT,
    audio_seconds REAL,
    notes_json TEXT,
    notes_md TEXT,
    notes_model TEXT,
    action_done TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    transcribed_at INTEGER,
    notes_at INTEGER,
    updated_at INTEGER
  );
  CREATE INDEX voice_status ON voice_notes(status, next_at);
  CREATE UNIQUE INDEX voice_client ON voice_notes(COALESCE(device_id, 0), client_id) WHERE client_id IS NOT NULL;

  CREATE TABLE voice_passes (
    id INTEGER PRIMARY KEY,
    voice_id INTEGER NOT NULL REFERENCES voice_notes(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
    output_md TEXT,
    model TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    done_at INTEGER
  );
  CREATE INDEX voice_passes_note ON voice_passes(voice_id);
  CREATE INDEX voice_passes_status ON voice_passes(status);

  ALTER TABLE items ADD COLUMN voice_id INTEGER;
  CREATE INDEX items_voice ON items(voice_id) WHERE voice_id IS NOT NULL;
  `,
  // v10 (sync for the phone app, PLAN-APP-2.md phase A1): one counter for the whole vault. Every insert or
  // update of an item or a merged item stamps the next number on that row (items.rev, bundles.rev), and so
  // does a change to its tags or, for a merge, its list of items. A deleted row leaves its id in
  // sync_deleted. The phone asks for "everything after number N" (sync.js). Triggers do the stamping, so
  // the website, the CLI and the background workers are all covered without touching their code.
  // ops_seen: answers already given to a phone's change, so a resend is answered again and not run twice.
  // Additive only; existing rows are numbered by id (items first, then merges), so every number is unique.
  `
  CREATE TABLE sync_counter (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL);
  ALTER TABLE items ADD COLUMN rev INTEGER;
  ALTER TABLE bundles ADD COLUMN rev INTEGER;
  UPDATE items SET rev = id;
  UPDATE bundles SET rev = id + COALESCE((SELECT MAX(id) FROM items), 0);
  INSERT INTO sync_counter (id, rev) VALUES (1,
    COALESCE((SELECT MAX(id) FROM items), 0) + COALESCE((SELECT MAX(id) FROM bundles), 0));
  CREATE INDEX items_rev ON items(rev);
  CREATE INDEX bundles_rev ON bundles(rev);

  CREATE TABLE sync_deleted (
    kind TEXT NOT NULL CHECK (kind IN ('item','bundle')),
    id INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (kind, id)
  );
  CREATE INDEX sync_deleted_rev ON sync_deleted(rev);

  CREATE TABLE ops_seen (
    device_id INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    status INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (device_id, client_id)
  );
  CREATE INDEX ops_seen_at ON ops_seen(at);

  CREATE TRIGGER items_rev_ins AFTER INSERT ON items BEGIN
    UPDATE sync_counter SET rev = rev + 1 WHERE id = 1;
    UPDATE items SET rev = (SELECT rev FROM sync_counter WHERE id = 1) WHERE id = NEW.id;
    DELETE FROM sync_deleted WHERE kind = 'item' AND id = NEW.id;
  END;
  CREATE TRIGGER items_rev_upd AFTER UPDATE ON items WHEN NEW.rev IS OLD.rev BEGIN
    UPDATE sync_counter SET rev = rev + 1 WHERE id = 1;
    UPDATE items SET rev = (SELECT rev FROM sync_counter WHERE id = 1) WHERE id = NEW.id;
  END;
  CREATE TRIGGER items_rev_del AFTER DELETE ON items BEGIN
    UPDATE sync_counter SET rev = rev + 1 WHERE id = 1;
    INSERT OR REPLACE INTO sync_deleted (kind, id, rev, at)
      VALUES ('item', OLD.id, (SELECT rev FROM sync_counter WHERE id = 1), CAST(strftime('%s','now') AS INTEGER));
  END;
  CREATE TRIGGER item_tags_rev_ins AFTER INSERT ON item_tags BEGIN
    UPDATE sync_counter SET rev = rev + 1 WHERE id = 1;
    UPDATE items SET rev = (SELECT rev FROM sync_counter WHERE id = 1) WHERE id = NEW.item_id;
  END;
  CREATE TRIGGER item_tags_rev_del AFTER DELETE ON item_tags BEGIN
    UPDATE sync_counter SET rev = rev + 1 WHERE id = 1;
    UPDATE items SET rev = (SELECT rev FROM sync_counter WHERE id = 1) WHERE id = OLD.item_id;
  END;

  CREATE TRIGGER bundles_rev_ins AFTER INSERT ON bundles BEGIN
    UPDATE sync_counter SET rev = rev + 1 WHERE id = 1;
    UPDATE bundles SET rev = (SELECT rev FROM sync_counter WHERE id = 1) WHERE id = NEW.id;
    DELETE FROM sync_deleted WHERE kind = 'bundle' AND id = NEW.id;
  END;
  CREATE TRIGGER bundles_rev_upd AFTER UPDATE ON bundles WHEN NEW.rev IS OLD.rev BEGIN
    UPDATE sync_counter SET rev = rev + 1 WHERE id = 1;
    UPDATE bundles SET rev = (SELECT rev FROM sync_counter WHERE id = 1) WHERE id = NEW.id;
  END;
  CREATE TRIGGER bundles_rev_del AFTER DELETE ON bundles BEGIN
    UPDATE sync_counter SET rev = rev + 1 WHERE id = 1;
    INSERT OR REPLACE INTO sync_deleted (kind, id, rev, at)
      VALUES ('bundle', OLD.id, (SELECT rev FROM sync_counter WHERE id = 1), CAST(strftime('%s','now') AS INTEGER));
  END;
  CREATE TRIGGER bundle_items_rev_ins AFTER INSERT ON bundle_items BEGIN
    UPDATE sync_counter SET rev = rev + 1 WHERE id = 1;
    UPDATE bundles SET rev = (SELECT rev FROM sync_counter WHERE id = 1) WHERE id = NEW.bundle_id;
  END;
  CREATE TRIGGER bundle_items_rev_upd AFTER UPDATE ON bundle_items BEGIN
    UPDATE sync_counter SET rev = rev + 1 WHERE id = 1;
    UPDATE bundles SET rev = (SELECT rev FROM sync_counter WHERE id = 1) WHERE id = NEW.bundle_id;
  END;
  CREATE TRIGGER bundle_items_rev_del AFTER DELETE ON bundle_items BEGIN
    UPDATE sync_counter SET rev = rev + 1 WHERE id = 1;
    UPDATE bundles SET rev = (SELECT rev FROM sync_counter WHERE id = 1) WHERE id = OLD.bundle_id;
  END;
  CREATE TRIGGER bundle_tags_rev_ins AFTER INSERT ON bundle_tags BEGIN
    UPDATE sync_counter SET rev = rev + 1 WHERE id = 1;
    UPDATE bundles SET rev = (SELECT rev FROM sync_counter WHERE id = 1) WHERE id = NEW.bundle_id;
  END;
  CREATE TRIGGER bundle_tags_rev_del AFTER DELETE ON bundle_tags BEGIN
    UPDATE sync_counter SET rev = rev + 1 WHERE id = 1;
    UPDATE bundles SET rev = (SELECT rev FROM sync_counter WHERE id = 1) WHERE id = OLD.bundle_id;
  END;
  `,
  // v11: a merged item's text is made from its items, so when what an item says changes (its text, title,
  // author, quote, the owner's note, or whether it could be fetched), every merge that holds it gets a new
  // number too. A phone that keeps a merge's text then knows to read it again. Those merges share one
  // number; sync.js never ends a page in the middle of a number.
  `
  CREATE TRIGGER items_rev_merges AFTER UPDATE OF text, article_title, article_md, link_title, link_md, link_meta,
      link_author, author_name, author_handle, quote_json, my_note, fetch_status, posted_at, url ON items
  WHEN (OLD.text IS NOT NEW.text OR OLD.article_title IS NOT NEW.article_title OR OLD.article_md IS NOT NEW.article_md
      OR OLD.link_title IS NOT NEW.link_title OR OLD.link_md IS NOT NEW.link_md OR OLD.link_meta IS NOT NEW.link_meta
      OR OLD.link_author IS NOT NEW.link_author OR OLD.author_name IS NOT NEW.author_name
      OR OLD.author_handle IS NOT NEW.author_handle OR OLD.quote_json IS NOT NEW.quote_json
      OR OLD.my_note IS NOT NEW.my_note OR OLD.fetch_status IS NOT NEW.fetch_status
      OR OLD.posted_at IS NOT NEW.posted_at OR OLD.url IS NOT NEW.url)
    AND EXISTS (SELECT 1 FROM bundle_items WHERE item_id = NEW.id)
  BEGIN
    UPDATE sync_counter SET rev = rev + 1 WHERE id = 1;
    UPDATE bundles SET rev = (SELECT rev FROM sync_counter WHERE id = 1)
      WHERE id IN (SELECT bundle_id FROM bundle_items WHERE item_id = NEW.id);
  END;
  `,
  // v12 (daily categorizing, categorize.js): subcategories (two levels: a category may sit under a top-level
  // one; names stay unique across the whole list) and marks for what the daily AI run did, so the owner can
  // tell and the run never repeats itself or overrides a choice made by hand. Additive only.
  //   categories.by_ai     the run made this category
  //   items.category_by    'ai' while the item's category is the run's choice (cleared when the owner sets one)
  //   items.ai_checked_at  when the run last gave an answer for the item
  //   bundles.by_ai        the run made this merge (the only merges it ever adds items to)
  `
  ALTER TABLE categories ADD COLUMN parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
  ALTER TABLE categories ADD COLUMN by_ai INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX categories_parent ON categories(parent_id);
  ALTER TABLE items ADD COLUMN category_by TEXT CHECK (category_by IN ('ai'));
  ALTER TABLE items ADD COLUMN ai_checked_at INTEGER;
  ALTER TABLE bundles ADD COLUMN by_ai INTEGER NOT NULL DEFAULT 0;
  `,
];

// One canonical spelling per tag for lookups and dedupe: Unicode-normalised, then fully lower-cased.
export function tagKey(name) {
  return String(name ?? '').normalize('NFC').toLowerCase();
}

function addTagKeys(db) {
  db.exec('ALTER TABLE tags ADD COLUMN key TEXT');
  healTagKeys(db);
  db.exec('CREATE UNIQUE INDEX tags_key ON tags(key)');
  backfillBundleMeta(db);
}

// Give every tag without a key its key, merging it into an existing tag that already has that key.
// Runs inside the v4 migration, and again on every start if any key is missing: an older release
// (after a rollback) inserts tags without one.
function healTagKeys(db) {
  const keep = new Map(db.prepare('SELECT id, key FROM tags WHERE key IS NOT NULL').all().map((r) => [r.key, r.id]));
  for (const r of db.prepare('SELECT id, name FROM tags WHERE key IS NULL ORDER BY id').all()) {
    const k = tagKey(r.name);
    const into = keep.get(k);
    if (into === undefined) {
      keep.set(k, r.id);
      db.prepare('UPDATE tags SET key = ? WHERE id = ?').run(k, r.id);
      continue;
    }
    // re-point the duplicate's links at the kept tag, then drop the duplicate
    db.prepare('INSERT OR IGNORE INTO item_tags (item_id, tag_id) SELECT item_id, ? FROM item_tags WHERE tag_id = ?').run(into, r.id);
    db.prepare('INSERT OR IGNORE INTO bundle_tags (bundle_id, tag_id) SELECT bundle_id, ? FROM bundle_tags WHERE tag_id = ?').run(into, r.id);
    db.prepare('DELETE FROM item_tags WHERE tag_id = ?').run(r.id);
    db.prepare('DELETE FROM bundle_tags WHERE tag_id = ?').run(r.id);
    db.prepare('DELETE FROM tags WHERE id = ?').run(r.id);
  }
}

// Merged items are filtered on their own tags, category and priority. Merges made before that (by the
// CLI, or ones that never got organizing data) start from what their items have, once.
function backfillBundleMeta(db) {
  const bare = db.prepare(`SELECT b.id FROM bundles b WHERE b.category_id IS NULL AND b.priority = 0
      AND NOT EXISTS (SELECT 1 FROM bundle_tags bt WHERE bt.bundle_id = b.id)`).all();
  for (const { id } of bare) {
    db.prepare(`INSERT OR IGNORE INTO bundle_tags (bundle_id, tag_id)
        SELECT ?, it.tag_id FROM bundle_items bi JOIN item_tags it ON it.item_id = bi.item_id WHERE bi.bundle_id = ?`).run(id, id);
    db.prepare(`UPDATE bundles SET
        priority = COALESCE((SELECT MAX(i.priority) FROM bundle_items bi JOIN items i ON i.id = bi.item_id WHERE bi.bundle_id = ?), 0),
        category_id = (SELECT i.category_id FROM bundle_items bi JOIN items i ON i.id = bi.item_id
                       WHERE bi.bundle_id = ? AND i.category_id IS NOT NULL ORDER BY bi.position LIMIT 1)
      WHERE id = ?`).run(id, id, id);
  }
}

// Plain links an older worker marked 'n/a' (see openDb). The probe uses items_fetch, so it is cheap.
const STRANDED_LINK = `kind = 'link' AND fetch_status = 'n/a' AND (note IS NULL OR note = '') AND link_type IS NULL AND state != 'trashed'`;
const STRANDED_LINKS_PROBE = `SELECT 1 FROM items WHERE ${STRANDED_LINK} LIMIT 1`;
const HEAL_STRANDED_LINKS = `UPDATE items SET fetch_status = 'pending', fetch_attempts = 0, next_fetch_at = NULL, fetch_error = NULL
    WHERE ${STRANDED_LINK}`;

// upTo (tests only): stop after that schema version, to build an older database the real way
export function openDb(path, { upTo = MIGRATIONS.length } = {}) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  const { user_version: v } = db.prepare('PRAGMA user_version').get();
  // before upgrading a database that already holds data, keep a full copy next to it
  if (v >= 1 && v < Math.min(upTo, MIGRATIONS.length) && path !== ':memory:') {
    const copy = `${path}.before-v${MIGRATIONS.length}-${Date.now()}.db`.replace(/'/g, '');
    db.exec(`VACUUM INTO '${copy}'`);
  }
  for (let i = v; i < Math.min(upTo, MIGRATIONS.length); i++) {
    // IMMEDIATE + re-check: if another process (the CLI) is upgrading at the same moment, wait and skip
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('PRAGMA user_version').get().user_version > i) { db.exec('COMMIT'); continue; }
      // a migration is plain SQL, or a function when it needs JS (such as full Unicode case folding)
      if (typeof MIGRATIONS[i] === 'function') MIGRATIONS[i](db);
      else db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  // repair tags an older release added without a key (see healTagKeys)
  if (db.prepare('PRAGMA user_version').get().user_version >= 4
      && db.prepare('SELECT 1 FROM tags WHERE key IS NULL LIMIT 1').get()) {
    db.exec('BEGIN IMMEDIATE');
    try { healTagKeys(db); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  // after a rollback to a release before v8, its worker marks every queued plain link 'n/a' (it only knew
  // t.co links and posts). v8 never sets a link 'n/a', so those go back to 'pending' and get read.
  if (db.prepare('PRAGMA user_version').get().user_version >= 8 && db.prepare(STRANDED_LINKS_PROBE).get()) {
    db.exec('BEGIN IMMEDIATE');
    try { db.exec(HEAL_STRANDED_LINKS); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  // Kindle highlights saved as one block of share text before kindle.js existed: split out the book (v8
  // has link_title/link_author/link_site on every item). Runs once: kv remembers it, so later starts only
  // read that one row (new shares are split when they arrive, items.js capture).
  if (db.prepare('PRAGMA user_version').get().user_version >= 8 && !db.prepare(KINDLE_HEALED).get(KINDLE_HEAL_KEY)) {
    db.exec('BEGIN IMMEDIATE');
    try { healKindleQuotes(db); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
}

// Run fn inside one write transaction. Not re-entrant: never call tx() inside tx().
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

export const now = () => Math.floor(Date.now() / 1000);
