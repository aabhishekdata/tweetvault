// Inbox: saved items grouped under their conversation root, replies nested under their parents.
import { groupKey, isOwnNote, noteVersion } from './items.js';
import { tagsByItem, matches, tagKey } from './organize.js';
import { attachImages } from './media.js';
import { videoDto } from './youtube.js';
import { bookOf } from './kindle.js';

// How far up a reply chain the Inbox and the thread sort walk. A fetched full thread can be 100 parts
// deep (thread.js MAX_PARTS), so this stays comfortably above that.
export const MAX_DEPTH = 150;

const PREVIEW = 600;

export function itemDto(it, extra = {}) {
  let quote = null;
  try { quote = it.quote_json ? JSON.parse(it.quote_json) : null; } catch { quote = null; }
  const body = it.kind === 'article' ? (it.article_md || '') : (it.text || '');
  return {
    id: it.id,
    group_key: it.kind === 'text' || it.kind === 'link' ? `item:${it.id}` : groupKey(it),
    kind: it.kind,
    tweet_id: it.tweet_id || null,          // always a string
    url: it.url || null,
    author_handle: it.author_handle || null,
    author_name: it.author_name || null,
    posted_at: it.posted_at || null,
    title: it.article_title || (it.voice_id ? it.link_title || null : null),
    voice_id: it.voice_id || null,             // a voice note (voice.js): its page is #/voice/<id>
    preview: body.length > PREVIEW ? `${body.slice(0, PREVIEW)}…` : body,
    words: body ? body.split(/\s+/).filter(Boolean).length : 0,
    quote,
    likes: it.likes ?? null,
    replies: it.replies ?? null,
    fetch_status: it.fetch_status,
    fetch_error: it.fetch_error || null,
    note: it.note && it.note !== 'tco' ? it.note : null,
    my_note: it.my_note || null,             // the owner's own note (not the internal `note` above)
    saved: !!it.saved,
    state: it.state,
    is_self_thread: !!it.is_self_thread,
    parent_tweet_id: it.parent_tweet_id || null,
    thread_status: it.thread_status || null,   // "Get full thread" job: queued, done or failed
    source_app: it.source_app || null,
    // a note the owner typed (sync.js): the only kind whose text can be edited. note_version is sent back
    // with an edit (as base_version), so a change made somewhere else in the meantime is noticed.
    own_note: isOwnNote(it),
    note_version: isOwnNote(it) ? noteVersion(it) : null,
    category_id: it.category_id ?? null,
    category_by: it.category_id && it.category_by ? it.category_by : null,   // 'ai': set by the daily run (categorize.js)
    priority: it.priority || 0,
    first_saved_at: it.first_saved_at || null,
    last_saved_at: it.last_saved_at || null,
    ...linkDto(it),
    // saved pictures [{url, original, kind}]: filled in for a whole list at once by media.js attachImages
    images: [],
    video: videoDto(it),                       // YouTube: title, channel, length, chapters, transcript state
    book: bookOf(it),                          // a Kindle highlight's book: title, author, url (kindle.js)
    ...extra,
  };
}

// What the page needs to show a read web page (phase 3.2): its title, site, author, date and length,
// and a preview of the article text instead of the share-sheet title.
// The saved text from an earlier read still counts while the page is read again (pending) or when that
// failed, so the card keeps its article (title, preview, reader) and agrees with Copy and merges.
// Same rule as render.js hasSavedLinkContent: a read web page with link_md, or a YouTube video with its
// saved details, whose status is ok, pending or failed. fetch_error (sent above) says a re-read failed.
const SAVED_STATUS = new Set(['ok', 'pending', 'failed']);
export const savedLinkContent = (it) => !!it && it.kind === 'link' && SAVED_STATUS.has(it.fetch_status)
  && (it.link_type === 'web' ? !!it.link_md
    : it.link_type === 'youtube' ? (it.fetch_status === 'ok' || !!(it.link_title || it.link_md)) : false);   // = render.js hasVideo
function linkDto(it) {
  if (it.kind !== 'link') return {};
  const md = it.link_type === 'web' && savedLinkContent(it) ? String(it.link_md || '') : '';
  let words = 0;
  try { words = Number(JSON.parse(it.link_meta || '{}').words) || 0; } catch { words = 0; }
  const out = {
    link_type: it.link_type || null,
    link_title: it.link_title || null,
    link_site: it.link_site || null,
    link_author: it.link_author || null,
    link_published_at: it.link_published_at || null,
    link_has_text: !!md,
  };
  if (md) {
    out.preview = md.length > PREVIEW ? `${md.slice(0, PREVIEW)}…` : md;
    out.words = words || md.split(/\s+/).filter(Boolean).length;
  }
  return out;
}

// The author's own thread reads in reply order (each part answers the one before), with time as a tie-break.
export function sortThread(items, byTid) {
  const depth = (m) => {
    let d = 0;
    let p = m.parent_tweet_id && byTid.get(m.parent_tweet_id);
    while (p && d < MAX_DEPTH) { d++; p = p.parent_tweet_id && byTid.get(p.parent_tweet_id); }
    return d;
  };
  return items.map((m) => [m, depth(m)])
    .sort((a, b) => a[1] - b[1] || (a[0].posted_at || 0) - (b[0].posted_at || 0) || a[0].id - b[0].id)
    .map(([m]) => m);
}

// Order a group's members: root, then the author's own thread, then replies depth-first by time.
export function arrangeGroup(key, members) {
  const byTid = new Map(members.filter((m) => m.tweet_id).map((m) => [m.tweet_id, m]));
  const root = key.startsWith('item:') ? (members[0] || null) : (members.find((m) => m.tweet_id === key) || null);
  const rest = members.filter((m) => m !== root);
  const thread = sortThread(rest.filter((m) => m.is_self_thread), byTid);
  const replies = rest.filter((m) => !m.is_self_thread);
  const replySet = new Set(replies);
  const children = new Map();
  const tops = [];
  for (const r of replies) {
    const p = r.parent_tweet_id && byTid.get(r.parent_tweet_id);
    if (p && replySet.has(p)) {
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(r);
    } else tops.push(r);
  }
  const byTime = (a, b) => (a.posted_at || a.first_saved_at || 0) - (b.posted_at || b.first_saved_at || 0) || a.id - b.id;
  const ordered = [];
  const walk = (list, depth) => {
    for (const r of list.sort(byTime)) {
      ordered.push({ item: r, depth });
      walk(children.get(r) || [], depth + 1);
    }
  };
  walk(tops, 1);
  return { root, thread, replies: ordered };
}

// The list is capped, so the category / tag / priority filter, the "not in a merge" rule and the
// requested order all have to run in SQL before the LIMIT. Filtering in JS afterwards hid older
// matching items once a state held more rows than the cap.
const INBOX_LIMIT = 2000;
const SQL_ORDER = {
  saved_desc: 'last_saved_at DESC',
  saved_asc: 'COALESCE(first_saved_at, last_saved_at, 0) ASC',
  posted_desc: 'posted_at DESC, last_saved_at DESC',
  priority: 'priority DESC, last_saved_at DESC',
  likes: 'likes DESC, last_saved_at DESC',
};

function filterSql(filter) {
  const where = [];
  const args = [];
  if (!filter) return { where, args };
  if (filter.category === 'none') where.push('category_id IS NULL');
  else if (typeof filter.category === 'number') {
    const cats = filter.cats && filter.cats.length ? filter.cats : [filter.category];   // the category and its subcategories
    where.push(`category_id IN (${cats.map(() => '?').join(',')})`);
    args.push(...cats);
  }
  if (filter.tag) {
    where.push('EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = items.id AND t.key = ?)');
    args.push(tagKey(filter.tag));
  }
  if (filter.priority) { where.push('priority >= ?'); args.push(filter.priority); }
  return { where, args };
}

export function buildInbox(db, { state = 'inbox', q = '', filter = null, sort = 'saved_desc' } = {}) {
  if (!['inbox', 'archived', 'trashed'].includes(state)) state = 'inbox';
  const like = q ? `%${String(q).replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  const f = filterSql(filter);
  const saved = db.prepare(`SELECT * FROM items WHERE saved = 1 AND state = ?
      AND id NOT IN (SELECT item_id FROM bundle_items)
      ${like ? "AND (text LIKE ?1 ESCAPE '\\' OR article_title LIKE ?1 ESCAPE '\\' OR article_md LIKE ?1 ESCAPE '\\' OR author_handle LIKE ?1 ESCAPE '\\' OR author_name LIKE ?1 ESCAPE '\\' OR url LIKE ?1 ESCAPE '\\' OR link_title LIKE ?1 ESCAPE '\\' OR link_author LIKE ?1 ESCAPE '\\')".replace(/\?1/g, '?') : ''}
      ${f.where.map((w) => `AND ${w}`).join(' ')}
      ORDER BY ${SQL_ORDER[sort] || SQL_ORDER.saved_desc}, id DESC LIMIT ${INBOX_LIMIT}`)
    .all(state, ...(like ? Array(8).fill(like) : []), ...f.args);
  // Items that are already in a merge (bundle) leave the Inbox and Archived lists; they come back
  // automatically when they are removed from the merge or the merge is undone.
  const mergedIn = new Map();
  for (const r of db.prepare(`SELECT bi.item_id, b.slug, b.title FROM bundle_items bi
      JOIN bundles b ON b.id = bi.bundle_id ORDER BY b.updated_at DESC`).all()) {
    if (!mergedIn.has(r.item_id)) mergedIn.set(r.item_id, []);
    mergedIn.get(r.item_id).push({ slug: r.slug, title: r.title });
  }
  const tagMap = tagsByItem(db);
  const visible = (m) => !!(m.saved && m.state === state && !mergedIn.has(m.id)
    && (!filter || matches(m, tagMap.get(m.id), filter)));

  const groups = new Map();
  for (const it of saved) {
    if (!visible(it)) continue;
    const key = groupKey(it);
    if (!groups.has(key)) groups.set(key, { key, members: new Map(), latest: 0, earliest: Infinity, priority: 0, likes: 0, posted: 0 });
    const g = groups.get(key);
    g.members.set(it.id, it);
    g.latest = Math.max(g.latest, it.last_saved_at || 0);
    g.earliest = Math.min(g.earliest, it.first_saved_at || it.last_saved_at || 0);
    g.priority = Math.max(g.priority, it.priority || 0);
    g.likes = Math.max(g.likes, it.likes || 0);
    g.posted = Math.max(g.posted, it.posted_at || 0);
  }
  // pull in the rest of each conversation so the chain from every visible reply up to its root is complete
  const convo = db.prepare('SELECT * FROM items WHERE root_tweet_id = ?');
  const rootRow = db.prepare('SELECT * FROM items WHERE tweet_id = ?');
  for (const g of groups.values()) {
    if (g.key.startsWith('item:')) continue;
    for (const c of convo.all(g.key)) if (!g.members.has(c.id)) g.members.set(c.id, c);
    if (![...g.members.values()].some((m) => m.tweet_id === g.key)) {
      const r = rootRow.get(g.key);
      if (r) g.members.set(r.id, r);
    }
  }
  // keep the visible items plus their ancestors (shown as context)
  const out = [];
  const order = {
    saved_desc: (a, b) => b.latest - a.latest,
    saved_asc: (a, b) => a.earliest - b.earliest,
    posted_desc: (a, b) => b.posted - a.posted || b.latest - a.latest,
    priority: (a, b) => b.priority - a.priority || b.latest - a.latest,
    likes: (a, b) => b.likes - a.likes || b.latest - a.latest,
  }[sort] || ((a, b) => b.latest - a.latest);
  for (const g of [...groups.values()].sort(order)) {
    const all = [...g.members.values()];
    const byTid = new Map(all.filter((m) => m.tweet_id).map((m) => [m.tweet_id, m]));
    const needed = new Set();
    for (const m of all) {
      if (!visible(m)) continue;
      needed.add(m.id);
      let p = m.parent_tweet_id && byTid.get(m.parent_tweet_id);
      let guard = 0;
      while (p && guard++ < MAX_DEPTH) { needed.add(p.id); p = p.parent_tweet_id && byTid.get(p.parent_tweet_id); }
    }
    if (![...needed].some((id) => visible(g.members.get(id)))) continue;
    const members = all.filter((m) => needed.has(m.id));
    const { root, thread, replies } = arrangeGroup(g.key, members);
    const dto = (it, extra) => itemDto(it, {
      in_bundles: (mergedIn.get(it.id) || []).length,
      merged_in: mergedIn.get(it.id) || [],
      context: !visible(it),
      tags: tagMap.get(it.id) || [],
      ...extra,
    });
    out.push({
      key: g.key,
      root: root ? dto(root) : null,
      thread: thread.map((t) => dto(t)),
      replies: replies.map(({ item, depth }) => dto(item, { depth })),
      latest_saved_at: g.latest,
    });
  }
  // the pictures of every item on the page in one go (a few IN queries, not one per item)
  attachImages(db, out.flatMap((g) => [g.root, ...g.thread, ...g.replies]));
  return out;
}
