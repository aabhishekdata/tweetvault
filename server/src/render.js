// The one formatter: merged text for Claude, used by the merge preview, both copy buttons, export and the CLI.
import { groupKey, byTweetId } from './items.js';
import { storedTranslation } from './translate.js';
import { MAX_DEPTH } from './tree.js';
import { videoSection, videoSourceLine } from './youtube.js';
import { bookOf, bookLine } from './kindle.js';

const fmtDate = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null);
const fmtNum = (n) => Number(n).toLocaleString('en-US');
const plural = (n, w) => `${fmtNum(n)} ${w}${n === 1 ? '' : 's'}`;
const oneLine = (s, max = 200) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const who = (it) => (it.author_handle ? `@${it.author_handle}` : 'someone');

// thread parts in reply order (depth below the root), time as a tie-break
function sortThreadDb(db, list) {
  const depth = (m) => {
    let d = 0;
    let p = m.parent_tweet_id && byTweetId(db, m.parent_tweet_id);
    while (p && d < MAX_DEPTH) { d++; p = p.parent_tweet_id && byTweetId(db, p.parent_tweet_id); }
    return d;
  };
  return list.map((m) => [m, depth(m)])
    .sort((a, b) => a[1] - b[1] || (a[0].posted_at || 0) - (b[0].posted_at || 0) || a[0].id - b[0].id)
    .map(([m]) => m);
}

// ---- web articles (phase 3.2): a link whose page text was read (web.js) ----
// Text from an earlier read still counts while the page is read again (pending) or when that failed.
const ARTICLE_STATUS = new Set(['ok', 'pending', 'failed']);
export const hasArticle = (it) => it.kind === 'link' && it.link_type === 'web' && !!it.link_md && ARTICLE_STATUS.has(it.fetch_status);
// A read YouTube video: its details (title or transcript) still count while it is read again (pending) or
// when that failed, as for web text. A video that reads 'ok' always shows its section.
export const hasVideo = (it) => it.kind === 'link' && it.link_type === 'youtube' && ARTICLE_STATUS.has(it.fetch_status)
  && (it.fetch_status === 'ok' || !!it.link_title || !!it.link_md);
// The one rule for "this link's saved content renders" (web text or video details), whatever the read
// status: the merged text shows that content instead of a "still loading" / "failed" placeholder.
// tree.js mirrors this rule for the page.
export const hasSavedLinkContent = (it) => hasArticle(it) || hasVideo(it);
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return null; } };
export function articleHeading(it) {
  const title = oneLine(it.link_title || '', 300) || hostOf(it.url) || 'Untitled';
  const site = oneLine(it.link_site || '', 120) || hostOf(it.url);
  return site && site !== title ? `Article: ${title} (${site})` : `Article: ${title}`;
}
// The page's own headings sit under the "## Article" heading: # becomes ###, #### becomes ######, also
// when indented by up to three spaces. A setext underline ("===" or "---" right under a line of text) is
// escaped, so it stays text. Lines inside code fences are left alone, and a fence the page never closed is
// closed at the end, so the rest of the merge can't end up inside it. (Page text is someone else's: it must
// not be able to pass for the merge's own "## Post N" or "## Sources" headings.) As in CommonMark, a
// backtick run opens a fence only when the rest of the line (its info string) has no backtick, so "```x`"
// is paragraph text, not a fence that would shield the lines after it from demotion.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const opensFence = (f, l) => f[1][0] !== '`' || !l.includes('`', f[0].length);
const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
export function demoteHeadings(md) {
  let fence = null;
  let prev = '';
  const out = String(md || '').split('\n').map((l) => {
    const f = FENCE.exec(l);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !l.slice(f[0].length).trim()) fence = null;
      prev = '';
      return l;
    }
    if (f && opensFence(f, l)) { fence = f[1]; prev = ''; return l; }
    const h = ATX.exec(l);
    let o = l;
    if (h && h[1].length <= 4) o = `${'#'.repeat(h[1].length + 2)}${l.slice(h[0].length)}`;
    else if (!h && SETEXT.test(l) && prev.trim()) o = `\\${l.trimStart()}`;
    prev = l;
    return o;
  });
  if (fence) out.push(fence);
  return out.join('\n');
}

// en(it) gives the stored English translation of an item, or null (used for "copy in English")
function bodyOf(it, en = () => null) {
  if (it.fetch_status === 'pending' && !hasSavedLinkContent(it)) return `(Still loading this ${it.kind === 'link' ? 'page' : 'post'}. Refresh in a moment.) ${it.url || ''}`.trim();
  if (it.fetch_status === 'unavailable') return `(This post couldn't be loaded: ${it.fetch_error || 'unavailable'}.) ${it.url || ''}`.trim();
  if (it.fetch_status === 'failed' && !hasSavedLinkContent(it)) return `(Loading this post failed. Try Refetch.) ${it.url || ''}`.trim();
  const parts = [];
  const tr = it.kind === 'link' ? null : en(it);
  if (tr) {
    parts.push(tr.text);
  } else if (it.kind === 'article') {
    if (it.text && it.text.trim()) parts.push(it.text.trim());
    parts.push((it.article_md || '').trim());
  } else if (hasArticle(it)) {
    parts.push(demoteHeadings(it.link_md.trim()));
  } else if (it.kind === 'link') {
    if (it.text) parts.push(it.text.trim());
    parts.push(it.url || '');
    if (it.note) parts.push(`(${it.note})`);
  } else {
    parts.push((it.text || '').trim());
  }
  // a Kindle highlight names its book under the passage (also under an English translation)
  const book = bookOf(it);
  if (book) parts.push(`— ${bookLine(book)}`);
  if (it.quote_json) {
    try {
      const q = JSON.parse(it.quote_json);
      const qt = String(q.text || '').trim().split('\n').map((l) => `> ${l}`).join('\n');
      parts.push(`> Quoting ${q.handle ? `@${q.handle}` : 'a post'}:\n${qt}`);
    } catch { /* ignore */ }
  }
  return parts.filter(Boolean).join('\n\n');
}

// The owner's own "why I saved this" note (items.my_note), quoted right after the item's body.
// It is never translated, so in English mode it still follows the translated body as written.
// (items.note is a different, internal field and is never shown here.)
export function myNoteBlock(it) {
  const n = typeof it.my_note === 'string' ? it.my_note.trim() : '';
  if (!n) return '';
  const lines = n.split(/\r?\n/);
  return [`> My note: ${lines[0]}`, ...lines.slice(1).map((l) => (l.trim() ? `> ${l}` : '>'))].join('\n');
}

function sourceLine(label, it, en = () => null) {
  const tr = it.kind === 'link' ? null : en(it);
  return sourceLineBase(label, it) + (tr ? ` · English translation${tr.lang ? ` from ${tr.lang}` : ''}` : '');
}

function sourceLineBase(label, it) {
  const book = bookOf(it);
  if (book) {
    return `[${label}] Kindle highlight · ${oneLine(bookLine(book), 300)}${book.url ? ` · ${book.url}` : ''} · saved ${fmtDate(it.first_saved_at) || ''}`.trim();
  }
  if (it.kind === 'text' && it.voice_id) return `[${label}] Voice note · ${fmtDate(it.first_saved_at) || ''}`.trim();
  // a note the owner typed (sync.js createNote): its title, if it has one
  if (it.kind === 'text' && it.source_app === 'note') {
    return `[${label}] My note${it.article_title ? ` · ${oneLine(it.article_title, 200)}` : ''} · ${fmtDate(it.first_saved_at) || ''}`.trim();
  }
  if (it.kind === 'text') {
    const from = it.source_app ? ` from ${it.source_app}` : '';
    return `[${label}] Saved text${from} · ${fmtDate(it.first_saved_at) || ''}`.trim();
  }
  if (hasArticle(it)) {
    const site = it.link_site || hostOf(it.url);
    return `[${label}] ${[site, it.link_author, fmtDate(it.link_published_at), it.url].filter(Boolean).join(' · ')}`;
  }
  if (it.kind === 'link') return `[${label}] ${it.url}`;
  const bits = [];
  bits.push(`${it.author_handle ? `@${it.author_handle}` : 'Unknown author'}${it.author_name ? ` (${it.author_name})` : ''}`);
  if (it.posted_at) bits.push(fmtDate(it.posted_at));
  if (it.likes != null) bits.push(plural(it.likes, 'like'));
  if (it.replies != null && /(^|· )(Post|Article)$/.test(label)) bits.push(plural(it.replies, 'reply').replace('replys', 'replies'));
  if (it.url) bits.push(it.url);
  return `[${label}] ${bits.join(' · ')}`;
}

// items: full rows in the user's order. Returns {text, text_sources, sections}
// notes: false leaves the owner's own notes out of the text.
export function renderItems(db, items, { title = '', english = false, notes = true } = {}) {
  const en = english ? (it) => storedTranslation(db, it) : () => null;
  // body plus, when wanted, the owner's note under it
  const withNote = (it) => {
    const b = bodyOf(it, en);
    const n = notes ? myNoteBlock(it) : '';
    return n ? (b ? `${b}\n\n${n}` : n) : b;
  };
  // groups in order of first appearance
  const groups = [];
  const gmap = new Map();
  for (const it of items) {
    const key = it.kind === 'text' || it.kind === 'link' ? `item:${it.id}` : groupKey(it);
    if (!gmap.has(key)) { gmap.set(key, { key, members: [] }); groups.push(gmap.get(key)); }
    gmap.get(key).members.push(it);
  }
  const out = [];
  const sources = [];
  const sections = [];
  let noteN = 0;
  let linkN = 0;
  if (title && title.trim()) out.push(`# ${title.trim()}`);
  const convoCount = groups.filter((g) => !g.key.startsWith('item:')).length;
  let partN = 0;
  const failed = (it) => it && (it.fetch_status === 'unavailable' || it.fetch_status === 'failed');

  for (const g of groups) {
    const ms = g.members;
    if (g.key.startsWith('item:')) {
      const it = ms[0];
      if (it.kind === 'text') {
        noteN++;
        const head = it.source_app === 'note' && it.article_title ? `: ${oneLine(it.article_title, 200)}` : '';
        out.push(`## Note ${noteN}${head}\n${withNote(it)}`);
        sources.push(sourceLine(`Note ${noteN}`, it, en));
      } else if (hasVideo(it)) {
        // a read YouTube video: its own heading, chapters and transcript (youtube.js), also while it is
        // read again or after that failed
        linkN++;
        const n = notes ? myNoteBlock(it) : '';
        out.push(n ? `${videoSection(it)}\n\n${n}` : videoSection(it));
        sources.push(videoSourceLine(`Link ${linkN}`, it));
      } else {
        linkN++;
        out.push(`## ${hasArticle(it) ? articleHeading(it) : `Link ${linkN}`}\n${withNote(it)}`);
        sources.push(sourceLine(`Link ${linkN}`, it, en));
      }
      sections.push({ item_id: it.id, label: it.kind === 'text' ? `Note ${noteN}` : `Link ${linkN}` });
      continue;
    }
    const root = ms.find((m) => m.tweet_id === g.key) || null;
    const rootRow = root || byTweetId(db, g.key);
    const thread = sortThreadDb(db, ms.filter((m) => m !== root && m.is_self_thread));
    const replies = ms.filter((m) => m !== root && !m.is_self_thread); // the user's order
    const rootAuthor = rootRow && rootRow.author_handle ? rootRow.author_handle.toLowerCase() : null;
    partN++;
    const multi = convoCount > 1;
    const part = multi ? `Part ${partN}: ` : '';
    const lab = (s) => (multi ? `Part ${partN} · ${s}` : s);

    // heading + root body
    if (root) {
      const label = root.kind === 'article' ? 'Article' : 'Post';
      const head = root.kind === 'article' ? (root.article_title || 'Article') : `Post by ${who(root)}${failed(root) ? ' (unavailable)' : ''}`;
      out.push(`## ${part}${head}\n${withNote(root)}`);
      sources.push(sourceLine(lab(label), root, en));
      sections.push({ item_id: root.id, label: lab(label) });
    } else {
      let head = rootRow
        ? (rootRow.kind === 'article' ? `Replies to the article "${rootRow.article_title || 'Untitled'}" by ${who(rootRow)}` : `Replies to a post by ${who(rootRow)}`)
        : 'Replies';
      let ctx = '';
      if (rootRow && failed(rootRow)) head += ' (original post unavailable)';
      else if (rootRow && rootRow.fetch_status !== 'pending') {
        const summary = oneLine(rootRow.kind === 'article' ? (rootRow.article_title || rootRow.article_md) : rootRow.text);
        if (summary) ctx = `\n> Original post (not included): ${summary}`;
      }
      out.push(`## ${part}${head}${ctx}`);
    }
    thread.forEach((t, i) => {
      out.push(`### Thread, part ${i + 2}\n${withNote(t)}`);
      sources.push(sourceLine(lab(`Thread ${i + 2}`), t, en));
      sections.push({ item_id: t.id, label: lab(`Thread ${i + 2}`) });
    });

    const labelOf = new Map();
    replies.forEach((r, i) => labelOf.set(r.tweet_id || `id:${r.id}`, `Reply ${i + 1}`));
    const inBundle = new Set(ms.map((m) => m.tweet_id).filter(Boolean));
    replies.forEach((r, i) => {
      const label = `Reply ${i + 1}`;
      let head = `### ${label}`;
      if (rootAuthor && r.author_handle && r.author_handle.toLowerCase() === rootAuthor) head += ' (author)';
      let ctx = '';
      const parentLabel = r.parent_tweet_id && labelOf.get(r.parent_tweet_id);
      if (parentLabel) head += ` (replying to ${parentLabel})`;
      else if (r.parent_tweet_id && r.parent_tweet_id !== g.key && !inBundle.has(r.parent_tweet_id)) {
        const p = byTweetId(db, r.parent_tweet_id);
        if (p && failed(p)) ctx = `> In reply to ${who(p)} (post unavailable)\n`;
        else if (p && p.fetch_status !== 'pending' && oneLine(p.text)) ctx = `> In reply to ${who(p)}: ${oneLine(p.text)}\n`;
      }
      out.push(`${head}\n${ctx}${withNote(r)}`);
      sources.push(sourceLine(lab(label), r, en));
      sections.push({ item_id: r.id, label: lab(label) });
    });
  }

  const text = out.join('\n\n').trim();
  const statsAt = Math.max(0, ...items.map((i) => i.stats_at || 0));
  const srcBlock = sources.length
    ? `\n\n---\n## Sources\n${sources.join('\n')}${statsAt ? `\nStats as of ${fmtDate(statsAt)}.` : ''}`
    : '';
  return { text, text_sources: text + srcBlock, sections };
}

export function loadItemsInOrder(db, ids) {
  if (!Array.isArray(ids)) throw Object.assign(new Error('item_ids must be a list'), { status: 400, expose: true });
  if (ids.length > 2000) throw Object.assign(new Error('Too many items'), { status: 400, expose: true });
  const get = db.prepare('SELECT * FROM items WHERE id = ?');
  const seen = new Set();
  const rows = [];
  for (const id of ids || []) {
    const n = Number(id);
    if (!Number.isInteger(n) || seen.has(n)) continue;
    seen.add(n);
    const r = get.get(n);
    if (r) rows.push(r);
  }
  return rows;
}

// Normalise an order the way the renderer reads it: groups by first appearance; inside a group the root, then thread, then replies in given order.
export function normaliseOrder(rows, db = null) {
  const groups = [];
  const gmap = new Map();
  for (const it of rows) {
    const key = it.kind === 'text' || it.kind === 'link' ? `item:${it.id}` : groupKey(it);
    if (!gmap.has(key)) { gmap.set(key, []); groups.push(key); }
    gmap.get(key).push(it);
  }
  const out = [];
  for (const k of groups) {
    const ms = gmap.get(k);
    const root = ms.filter((m) => m.tweet_id === k);
    const t0 = ms.filter((m) => m.tweet_id !== k && m.is_self_thread);
    const thread = db ? sortThreadDb(db, t0) : t0.sort((a, b) => (a.posted_at || 0) - (b.posted_at || 0));
    const rest = ms.filter((m) => m.tweet_id !== k && !m.is_self_thread);
    out.push(...root, ...thread, ...rest);
  }
  return out.map((r) => r.id);
}

export function renderBundle(db, bundle, { notes = true } = {}) {
  const ids = db.prepare('SELECT item_id FROM bundle_items WHERE bundle_id = ? ORDER BY position').all(bundle.id).map((r) => r.item_id);
  return renderItems(db, loadItemsInOrder(db, ids), { title: bundle.title, notes });
}

// One copy / preview / export / MCP read at most (the container has 128 MB).
export const MAX_RENDER_CHARS = 5_000_000;
// How much text a set of rows would put together, counted before building it.
export function renderChars(rows) {
  let n = 0;
  for (const x of rows) n += (x.text || '').length + (x.article_md || '').length + (x.quote_json || '').length + (x.my_note || '').length
    + (x.link_md || '').length;
  return n;
}
