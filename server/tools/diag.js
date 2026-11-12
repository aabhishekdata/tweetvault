// Read-only look at recent captures and items. Run on the server:
//   docker exec -i tweet-vault node - < diag.js
const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync('/data/vault.db', { readOnly: true });
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').slice(0, 100);
console.log('--- captures');
for (const r of d.prepare(`SELECT c.id, c.source_app, c.raw_input, c.item_id, datetime(c.received_at, 'unixepoch') AS at
    FROM captures c ORDER BY c.id`).all()) console.log(r.id, r.at, r.source_app, '->', r.item_id, '|', one(r.raw_input));
console.log('--- items');
for (const r of d.prepare(`SELECT id, kind, saved, state, fetch_status, fetch_error, tweet_id, parent_tweet_id, root_tweet_id,
    is_self_thread, author_handle, article_title, text FROM items ORDER BY id`).all()) {
  console.log(r.id, r.kind, `saved=${r.saved}`, r.state, r.fetch_status, r.fetch_error || '', `tid=${r.tweet_id || '-'}`,
    `parent=${r.parent_tweet_id || '-'}`, `root=${r.root_tweet_id || '-'}`, `self=${r.is_self_thread}`,
    `@${r.author_handle || '?'}`, '|', one(r.article_title || r.text));
}
