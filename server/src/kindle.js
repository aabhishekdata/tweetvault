// Kindle highlights shared as text (Kindle: Share → Copy text, or Share → Vault). Kindle sends exactly:
//
//   I thought of you when I read this quote from "Financial Freedom: A Proven Path…" by Grant Sabatier, Vicki Robin -
//
//   "If you want to reach financial independence as quickly as possible, …"
//
//   Start reading this book for free: https://read.amazon.in/kp/kshare?asin=B07DH8XKGP&id=…
//
// Such a save becomes a text item holding just the passage, with the book kept beside it: link_title (book),
// link_author (authors), url (Kindle's link to the book) and link_site = 'Kindle'. A text item's link_type stays
// NULL, so the link readers never touch it. The original share text stays in captures.raw_input.
//
// Only Kindle's own text counts: the header must be the first line and the link the last one. Anything the
// owner wrote around it (before the header, after the link) makes it an ordinary note, so nothing is dropped.
// The parser works line by line on bounded lines, so its time grows linearly with the input.
import { createHash } from 'node:crypto';

export const KINDLE_SITE = 'Kindle';

// Kindle shares are short; a longer text is never one (and is never scanned further)
const MAX_SHARE = 20_000;
const MAX_LINE = 1_000;
// Amazon's Kindle reader domains
const HOSTS = 'com|in|co\\.uk|de|fr|es|it|nl|co\\.jp|ca|com\\.au|com\\.br|com\\.mx|ae|sa|sg|se|pl|com\\.tr|eg|com\\.be|cn';
// first line: "… from "TITLE" by AUTHORS -" (the intro wording varies; a quoted title and "by" are what count)
const HEADER = /^(.{0,200}?)\bfrom[ \t]+[“"](.{1,300}?)[”"][ \t]+by[ \t]+(.{1,300}?)[ \t]*[-–—:]?[ \t]*$/u;
// last line: the link, alone or after "Start reading this book for free:"
const FOOTER = new RegExp(`^(?:Start reading (?:this book|it) for free:?[ \\t]*)?(https://read\\.amazon\\.(?:${HOSTS})/kp/(?:kshare|embed)\\?[^\\s"'<>]*)$`, 'i');
const ASIN = /[?&]asin=([A-Z0-9]{10})(?:&|$)/i;
const PAIRS = { '"': '"', '“': '”', '«': '»' };

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Kindle wraps the passage in quote marks. Remove them only when they plainly wrap the whole passage: the
// opening mark starts it, its partner ends it, and neither appears inside (so '"Hi," she said. "Bye."' stays).
function unwrap(s) {
  const close = PAIRS[s[0]];
  if (!close || s.length < 2 || s[s.length - 1] !== close) return s;
  const inner = s.slice(1, -1);
  if (inner.includes(s[0]) || inner.includes(close)) return s;
  return inner.trim();
}

// The parts of a Kindle share, or null when the text isn't exactly one.
export function parseKindleShare(raw) {
  const text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text || text.length > MAX_SHARE) return null;
  const lines = text.split('\n');
  const first = lines[0].trim();
  const last = lines[lines.length - 1].trim();
  if (lines.length < 3 || first.length > MAX_LINE || last.length > MAX_LINE) return null;
  const head = HEADER.exec(first);
  const foot = FOOTER.exec(last);
  if (!head || !foot) return null;
  const asin = ASIN.exec(foot[1]);
  if (!asin) return null;
  const title = clean(head[2]).slice(0, 300);
  const author = clean(head[3]).slice(0, 300);
  const quote = unwrap(lines.slice(1, -1).join('\n').trim());
  if (!title || !quote) return null;
  return { quote, title, author: author || null, url: foot[1], asin: asin[1].toUpperCase() };
}

// The book a saved text came from, for the page, copies and MCP; null for ordinary notes.
export function bookOf(it) {
  if (!it || it.kind !== 'text' || it.link_site !== KINDLE_SITE || !it.link_title) return null;
  return { title: it.link_title, author: it.link_author || null, url: it.url || null, site: KINDLE_SITE };
}

// One line naming the book: “Financial Freedom” by Grant Sabatier
export const bookLine = (b) => `“${b.title}”${b.author ? ` by ${b.author}` : ''}`;

// The hash a saved text is found by (a repeat save within a day folds into the first): case and spacing
// don't count. The one copy: items.js and sync.js use it too.
export const textHash = (s) => createHash('sha256').update(String(s).replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');

// Put the book on a text item that has none yet (a share of a passage that was first saved by copying it).
export function addBook(db, id, k) {
  db.prepare(`UPDATE items SET url = ?, link_title = ?, link_author = ?, link_site = ?
      WHERE id = ? AND kind = 'text' AND link_title IS NULL`).run(k.url, k.title, k.author, KINDLE_SITE, id);
}

// Kindle shares saved before this existed (as one block of text): turn each into the passage plus its book.
// Runs once (db.js openDb, remembered in kv); shares saved later are split when they arrive.
export const KINDLE_HEAL_KEY = 'kindle_quotes_healed';
export function healKindleQuotes(db) {
  const rows = db.prepare(`SELECT id, text FROM items WHERE kind = 'text' AND link_title IS NULL
      AND length(text) <= ${MAX_SHARE} AND text LIKE '%read.amazon.%/kp/%'`).all();
  const upd = db.prepare(`UPDATE items SET text = ?, text_hash = ?, link_title = ?, link_author = ?, link_site = ?, url = ?
      WHERE id = ? AND kind = 'text' AND link_title IS NULL`);
  let n = 0;
  for (const r of rows) {
    const k = parseKindleShare(r.text);
    if (k) n += Number(upd.run(k.quote, textHash(k.quote), k.title, k.author, KINDLE_SITE, k.url, r.id).changes);
  }
  db.prepare("INSERT INTO kv (key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING").run(KINDLE_HEAL_KEY);
  return n;
}
