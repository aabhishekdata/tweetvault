// Turning a fetched web page into its readable article text, as simple Markdown (phase 3.2).
// No dependencies: a small forgiving HTML parser, a pick of the block that holds the article, and a
// Markdown writer. Everything here is hostile third-party input, so:
//   - parsing is linear (sticky regexes, no backtracking over the whole page) and has hard caps
//     (nesting depth, element count, text pieces and characters, attribute size), so 10,000 nested <div>s,
//     a 2 MB attribute or 3 MB of tiny tags can't overflow the stack or the 128 MB container: parsing stops
//     at a cap and the text comes from what was parsed (an article sits near the top of its page)
//   - only the attributes the extractor reads are kept, elements carry no per-node caches, and the
//     Markdown writer stops once it has more than the saved text can hold
//   - scripts, styles, forms, navigation and hidden parts are never part of the text
//   - links keep only http(s) targets; javascript:, data: and the like become plain text; images are dropped
//   - the result is plain text the page always shows with textContent (never as HTML)

export const MAX_MD = 60_000;
export const MIN_READABLE = 300;
export const CUT_NOTE = '(Cut here: the article is longer.)';
const MAX_DEPTH = 200;          // deeper elements are flattened into their ancestor
export const MAX_ELEMENTS = 20_000;    // parsing stops here (a long real article page has a few thousand)
export const MAX_TEXTS = 40_000;       // text pieces kept
export const MAX_TEXT = 600_000;       // characters of text kept in total
const MAX_ATTR = 4096;
const MAX_DECODED_ATTRS = 512 * 1024;  // attribute characters entity-decoded into new strings, in total
const MAX_LD = 512 * 1024;      // JSON-LD text kept in total
const MAX_TITLE = 4096;
const WRITE_LIMIT = MAX_MD + 5000;     // a Markdown writer stops past this (the saved text is cut at MAX_MD)

// ---- entities ----
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
  deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', dagger: '†', Dagger: '‡', prime: '′', Prime: '″',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', minus: '−', le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞',
  iexcl: '¡', iquest: '¿', shy: '­', zwj: '‍', zwnj: '‌', lrm: '‎', rlm: '‏',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  agrave: 'à', egrave: 'è', igrave: 'ì', ograve: 'ò', ugrave: 'ù', Agrave: 'À', Egrave: 'È',
  acirc: 'â', ecirc: 'ê', icirc: 'î', ocirc: 'ô', ucirc: 'û', auml: 'ä', euml: 'ë', iuml: 'ï', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', ccedil: 'ç', Ccedil: 'Ç', ntilde: 'ñ', Ntilde: 'Ñ', atilde: 'ã', otilde: 'õ',
  aring: 'å', Aring: 'Å', aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', yacute: 'ý', yuml: 'ÿ', eth: 'ð', thorn: 'þ',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', sigma: 'σ', mu: 'μ', lambda: 'λ', omega: 'ω', Omega: 'Ω',
};
// the few that browsers also accept without the closing semicolon
const LEGACY = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg']);
// &#128; to &#159; mean the windows-1252 characters, as in browsers
const W1252 = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹',
  0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™',
  0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};
const ENT = /&(?:#(\d{1,8});?|#[xX]([0-9a-fA-F]{1,7});?|([a-zA-Z][a-zA-Z0-9]{1,31})(;?))/g;

function codePoint(n) {
  if (!Number.isFinite(n) || n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '�';
  if (n >= 0x80 && n <= 0x9f) return W1252[n] || '�';
  return String.fromCodePoint(n);
}

const entity = (m, dec, hex, name, semi) => {
  if (dec) return codePoint(Number(dec));
  if (hex) return codePoint(parseInt(hex, 16));
  if (Object.prototype.hasOwnProperty.call(NAMED, name) && (semi || LEGACY.has(name))) return NAMED[name];
  return m;
};
const ENT_CHUNK = 32 * 1024;

export function decodeEntities(s) {
  const str = String(s ?? '');
  if (!str.includes('&')) return str;
  if (str.length <= ENT_CHUNK) return str.replace(ENT, entity);
  // long text is decoded a piece at a time (one replace over a megabyte of entities holds every piece of
  // the result at once); pieces are cut just before an '&', so no entity is ever split
  let out = '';
  for (let at = 0; at < str.length;) {
    let end = Math.min(str.length, at + ENT_CHUNK);
    if (end < str.length) { const amp = str.lastIndexOf('&', end); if (amp > at) end = amp; }
    out += str.slice(at, end).replace(ENT, entity);
    at = end;
  }
  return out;
}

// C0 controls (except tab and newline) never belong in saved text
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// bidi overrides can make a title read differently from what it says, so metadata drops them
const BIDI = /[‪-‮⁦-⁩]/g;

// ---- parsing ----
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen']);
// their content is raw text up to the matching end tag (so "<b>" inside a script is not markup)
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
const SCOPE = new Set(['td', 'th', 'table', 'caption', 'button', 'html', 'template', 'object', 'marquee', 'applet']);
const HEADS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const TAG_NAME = /[a-zA-Z][^\s/>\u0000]*/y;
const ATTR = /[\s/]*([^\s"'>/=][^\s"'>/=]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/y;
const TAG_END = /[\s/]*>/y;
const END_TAG = /<\/([a-zA-Z][^\s/>\u0000]*)[^>]*>/y;
const SPACES = /[\s/]*/y;

// The attributes the extractor reads, with how much of each is kept; every other attribute is dropped.
const KEEP_ATTR = { class: 400, id: 400, style: 1024, hidden: 16, 'aria-hidden': 16, href: MAX_ATTR, type: 200, title: MAX_ATTR };
const META_ATTR = { property: 400, name: 400, itemprop: 400, content: MAX_ATTR, charset: 64 };
const NO_ATTRS = Object.freeze({});
const NO_KIDS = Object.freeze([]);
const SKIP_VOID = new Set([...VOID].filter((t) => t !== 'br' && t !== 'hr'));   // never text, so never kept
const NO_SCOPE = new Set();
const LI_SCOPE = new Set([...SCOPE, 'ul', 'ol']);
const DL_SCOPE = new Set([...SCOPE, 'dl']);
const DTDD = new Set(['dt', 'dd']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// sp/st: the paragraph count and text length under the element, filled in by stats() (sp -1: not yet)
const el = (tag, attrs, parent, kids = []) => ({ tag, attrs, kids, parent, sp: -1, st: 0 });

// Parse a whole page. Returns { root, meta, title, ld, cut } where meta maps lower-cased meta name/property
// to its content (first one wins), ld holds the JSON-LD script texts and cut is true when parsing stopped
// at a cap (the page went on).
export function parseHtml(html) {
  const s = String(html ?? '');   // not copied: control characters are replaced in the text that is kept
  const root = el('#root', NO_ATTRS, null);
  const stack = [root];
  const meta = new Map();
  const ld = [];
  let ldSize = 0;
  let title = null;
  let count = 0;
  let texts = 0;
  let textChars = 0;
  let decoded = 0;
  let full = false;     // a cap was reached: parsing stops
  let i = 0;
  // the first '>' at or after a position, cached (-1: none left), so many '</' never rescan the rest of the page
  let nextGt = -2;
  const gtFrom = (at) => { if (nextGt !== -1 && nextGt < at) nextGt = s.indexOf('>', at); return nextGt; };
  const top = () => stack[stack.length - 1];
  const text = (t) => {
    if (!t || full) return;
    if (texts >= MAX_TEXTS || textChars >= MAX_TEXT) { full = true; return; }
    const piece = t.length > MAX_TEXT - textChars ? t.slice(0, MAX_TEXT - textChars) : t;
    texts++;
    textChars += piece.length;
    if (piece.length < t.length) full = true;
    top().kids.push(decodeEntities(piece.replace(CONTROLS, ' ')));
  };
  const add = (e) => { top().kids.push(e); if (++count >= MAX_ELEMENTS) full = true; };
  const popTo = (idx) => { stack.length = idx; };
  // find an open element by name, looking no further than a scope boundary
  const findOpen = (names, stopAt = SCOPE) => {
    for (let k = stack.length - 1; k > 0; k--) {
      const t = stack[k].tag;
      if (names.has ? names.has(t) : names === t) return k;
      if (stopAt.has(t)) return -1;
    }
    return -1;
  };

  while (i < s.length && !full) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { text(s.slice(i)); break; }
    if (lt > i) text(s.slice(i, lt));
    i = lt;
    const c = s[i + 1];
    if (s.startsWith('<!--', i)) {
      // a comment ends at the first "-->"; comments don't nest, so "<!-- <!-- x --> y -->" leaves " y -->" as text
      const e = s.indexOf('-->', i + 4);
      i = e < 0 ? s.length : e + 3;
      continue;
    }
    if (c === '!' || c === '?') {             // doctype, CDATA, processing instruction: skipped
      const e = s.indexOf('>', i + 2);
      i = e < 0 ? s.length : e + 1;
      continue;
    }
    if (c === '/') {
      // with no ">" left, no end tag can finish: the rest is text (and END_TAG never rescans to the end)
      if (gtFrom(i) < 0) { text(s.slice(i)); break; }
      END_TAG.lastIndex = i;
      const m = END_TAG.exec(s);
      if (!m) { text('<'); i++; continue; }
      i = END_TAG.lastIndex;
      const name = m[1].toLowerCase();
      if (name === 'br') { add(el('br', NO_ATTRS, top(), NO_KIDS)); continue; }
      const k = findOpen(name, NO_SCOPE);
      if (k > 0) popTo(k);
      continue;
    }
    TAG_NAME.lastIndex = i + 1;
    const nm = TAG_NAME.exec(s);
    if (!nm) { text('<'); i++; continue; }
    const name = nm[0].toLowerCase();
    let j = TAG_NAME.lastIndex;
    const keep = name === 'meta' ? META_ATTR : KEEP_ATTR;
    let attrs = NO_ATTRS;
    let closed = false;
    for (let guard = 0; guard < 1000 && j < s.length; guard++) {
      TAG_END.lastIndex = j;
      if (TAG_END.exec(s)) { j = TAG_END.lastIndex; closed = true; break; }
      ATTR.lastIndex = j;
      const a = ATTR.exec(s);
      if (!a || ATTR.lastIndex === j) {
        // a stray character such as a lone quote: the spaces before it are skipped too, so a long run of
        // spaces is not scanned again from each of its characters
        SPACES.lastIndex = j;
        SPACES.exec(s);
        j = Math.max(j, SPACES.lastIndex) + 1;
        continue;
      }
      j = ATTR.lastIndex;
      const an = a[1].toLowerCase();
      const cap = own(keep, an) ? keep[an] : 0;
      if (cap && !own(attrs, an)) {
        const v = a[2] ?? a[3] ?? a[4] ?? '';
        let val = v.length > cap ? v.slice(0, cap) : v;
        if (val.includes('&') && decoded < MAX_DECODED_ATTRS) { val = decodeEntities(val); decoded += val.length; }
        if (attrs === NO_ATTRS) attrs = {};
        attrs[an] = val;
      }
    }
    if (!closed) {
      // too many attributes or junk: skip to the end of the tag; an unfinished tag at the end is dropped
      const gt = s.indexOf('>', j);
      if (gt < 0) break;
      j = gt + 1;
    }
    i = j;

    if (name === 'meta') {
      const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase().trim();
      if (key && attrs.content !== undefined && !meta.has(key)) meta.set(key, attrs.content);
      if (attrs.charset !== undefined && !meta.has('charset')) meta.set('charset', attrs.charset);
    }
    if (RAW.has(name)) {
      // everything up to </name> is raw text; with no end tag the rest of the page is (as in browsers)
      const close = new RegExp(`</${name}[\\s/>]`, 'ig');
      close.lastIndex = i;
      const m = close.exec(s);
      const end = m ? m.index : s.length;
      const body = s.slice(i, end);
      const gt = m ? s.indexOf('>', m.index) : -1;
      i = m ? (gt < 0 ? s.length : gt + 1) : s.length;
      if (name === 'title' && title === null) title = decodeEntities(body.slice(0, MAX_TITLE).replace(CONTROLS, ' '));
      else if (name === 'script' && /ld\+json/i.test(attrs.type || '') && ldSize + body.length <= MAX_LD) {
        ld.push(body.replace(CONTROLS, ' '));
        ldSize += body.length;
      }
      // a <textarea> is form text, which is never article text: nothing is kept
      continue;
    }
    // implied end tags: a new block closes an open <p>, a new <li> closes the previous one, and so on
    if (CLOSES_P.has(name)) { const k = findOpen('p'); if (k > 0) popTo(k); }
    if (name === 'li') { const k = findOpen('li', LI_SCOPE); if (k > 0) popTo(k); }
    if (name === 'dt' || name === 'dd') { const k = findOpen(DTDD, DL_SCOPE); if (k > 0) popTo(k); }
    if (HEADS.has(name) && HEADS.has(top().tag)) popTo(stack.length - 1);
    if (SKIP_VOID.has(name)) continue;
    if (VOID.has(name)) { add(el(name, attrs, top(), NO_KIDS)); continue; }
    // past the depth cap, tags are ignored and their content joins the deepest element (no deep trees)
    if (stack.length >= MAX_DEPTH) continue;
    const e = el(name, attrs, top());
    add(e);
    stack.push(e);
  }
  return { root, meta, title, ld, cut: full };
}

// ---- what is not article text ----
const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'embed', 'canvas', 'form',
  'nav', 'footer', 'header', 'aside', 'button', 'select', 'option', 'textarea', 'input', 'label', 'dialog', 'video', 'audio',
  'picture', 'img', 'map', 'head', 'link', 'meta', 'title']);
// share bars, comment threads, newsletters, ads and "related" boxes, by their class or id
const BOILER = /(^|[\s_-])(comments?|share|sharing|social|related|newsletter|subscribe|subscription|promo|advert|advertisement|ads?|sponsored|sidebar|cookie|consent|popup|modal|breadcrumbs?|recirc|outbrain|taboola|paywall-prompt|signup)($|[\s_-])/i;
const BOILER_TAGS = new Set(['div', 'section', 'ul', 'ol', 'span', 'figure', 'table', 'p']);

function hidden(e) {
  const a = e.attrs;
  if ('hidden' in a) return true;
  if (String(a['aria-hidden'] || '').toLowerCase() === 'true') return true;
  const st = String(a.style || '').toLowerCase().replace(/\s+/g, '');
  return st.includes('display:none') || st.includes('visibility:hidden');
}

// A <form> is dropped, except when a whole page is wrapped in one (old ASP.NET sites do that).
function skipped(e, isRoot = false) {
  if (typeof e === 'string') return false;
  if (hidden(e)) return true;
  if (e.tag === 'form') return !(stats(e).sp >= 3);
  if (DROP.has(e.tag)) return true;
  if (!isRoot && BOILER_TAGS.has(e.tag) && e.tag !== 'p') {
    const cls = `${e.attrs.class || ''} ${e.attrs.id || ''}`;
    if (cls.length < 400 && BOILER.test(cls)) return true;
  }
  return false;
}

// paragraph count (sp) and text length (st) under an element, kept on the element itself (no extra
// object per element; the tree depth is capped, so recursion is safe)
function stats(e) {
  if (e.sp >= 0) return e;
  let p = 0;
  let text = 0;
  e.sp = 0;
  for (const k of e.kids) {
    if (typeof k === 'string') { text += k.trim().length; continue; }
    if (k.tag !== 'form' && skipped(k)) continue;
    stats(k);
    p += k.sp + (k.tag === 'p' ? 1 : 0);
    text += k.st;
  }
  e.sp = p;
  e.st = text;
  return e;
}

function* elements(root) {
  const todo = [root];
  while (todo.length) {
    const e = todo.pop();
    yield e;
    for (let k = e.kids.length - 1; k >= 0; k--) if (typeof e.kids[k] !== 'string') todo.push(e.kids[k]);
  }
}
const textLen = (e) => stats(e).st;

// The element with the densest <p> text: each paragraph counts fully for its parent and half for the grandparent.
function densest(root) {
  const score = new Map();
  for (const e of elements(root)) {
    if (e.tag !== 'p' || skipped(e)) continue;
    let up = e.parent;
    for (let k = up; k; k = k.parent) if (skipped(k)) { up = null; break; }
    if (!up) continue;
    const n = textLen(e);
    if (n < 25) continue;
    score.set(up, (score.get(up) || 0) + n);
    if (up.parent) score.set(up.parent, (score.get(up.parent) || 0) + n / 2);
  }
  let best = null;
  let bestScore = 0;
  for (const [e, v] of score) if (v > bestScore && e.tag !== '#root') { best = e; bestScore = v; }
  return best;
}

// ---- Markdown ----
const URL_ESC = { '(': '%28', ')': '%29', ' ': '%20', '<': '%3C', '>': '%3E', '\n': '', '\t': '' };
function safeLink(href, base) {
  const h = String(href || '').trim();
  if (!h || h.startsWith('#')) return null;
  let u;
  try { u = new URL(h, base); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;   // javascript:, data:, mailto: ... stay text
  if (u.username || u.password) return null;
  const s = u.href;
  if (s.length > 2048) return null;
  return s.replace(/[()<>\s]/g, (c) => URL_ESC[c] ?? '');
}

const collapse = (s) => s.replace(/\s+/g, ' ');

// Paragraph text is the page's prose, never structure: a line that would start an ATX heading ("## Sources"),
// open a code fence ("```", "~~~") or underline the line above into a setext heading ("===", "---") gets a
// backslash in front, so it stays text in the merge (render.js demoteHeadings is the second line of defence).
const STRUCTURAL = /^ {0,3}(?:#{1,6}(?=[ \t]|$)|`{3,}|~{3,}|=+[ \t]*$|-+[ \t]*$)/;
function escapeLine(l) {
  if (!STRUCTURAL.test(l)) return l;
  const lead = l.length - l.trimStart().length;
  return `${l.slice(0, lead)}\\${l.slice(lead)}`;
}
const escapeLines = (t) => (t.includes('\n') ? t.split('\n').map(escapeLine).join('\n') : escapeLine(t));

// Collects Markdown blocks. Once it holds more than WRITE_LIMIT characters it is full: it takes nothing
// more and walk() stops, so a huge page never becomes a huge string that is cut afterwards.
class Writer {
  constructor() { this.blocks = []; this.line = ''; this.size = 0; this.full = false; }
  text(s) {
    if (this.full) return;
    const room = WRITE_LIMIT - this.size - this.line.length;
    if (s.length > room) { s = s.slice(0, Math.max(0, room)); this.full = true; }
    this.line += s;
  }
  push(t) {
    this.blocks.push(t);
    this.size += t.length + 2;
    if (this.size > WRITE_LIMIT) this.full = true;
  }
  flush() {
    const t = escapeLines(this.line.replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim());
    if (t) this.push(t);
    this.line = '';
  }
  block(s) { this.flush(); if (!this.full && s && s.trim()) this.push(s); }
  result() { this.flush(); return this.blocks.join('\n\n'); }
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'main', 'figure', 'figcaption', 'address', 'details', 'summary',
  'center', 'dl', 'dt', 'dd', 'body', 'html', '#root', 'hgroup', 'caption', 'form', 'fieldset', 'tbody', 'thead', 'tfoot']);

function inline(e, base) {
  const w = new Writer();
  for (const k of e.kids) walk(k, w, base, false);
  return oneLine(w.result());
}
function rawText(e) {
  let out = '';
  for (const k of e.kids) {
    if (out.length > WRITE_LIMIT) break;
    if (typeof k === 'string') out += k;
    else if (k.tag === 'br') out += '\n';
    else if (!skipped(k)) out += rawText(k);
  }
  return out.length > WRITE_LIMIT ? out.slice(0, WRITE_LIMIT) : out;
}
function listBlock(e, base, ordered) {
  const lines = [];
  let n = 0;
  let size = 0;
  for (const k of e.kids) {
    if (size > WRITE_LIMIT) break;
    if (typeof k === 'string') { if (k.trim()) { lines.push(`- ${oneLine(k)}`); size += k.length; } continue; }
    if (skipped(k)) continue;
    const w = new Writer();
    if (k.tag === 'li') for (const kk of k.kids) walk(kk, w, base, false);
    else walk(k, w, base, false);
    const body = w.result();
    if (!body) continue;
    n++;
    const mark = ordered ? `${n}. ` : '- ';
    const pad = ' '.repeat(mark.length);
    lines.push(body.split('\n').map((l, idx) => (idx === 0 ? mark + l : l ? pad + l : '')).join('\n'));
    size += body.length;
  }
  return lines.join('\n');
}
function tableBlock(e, base) {
  const rows = [];
  let size = 0;
  for (const x of elements(e)) {
    if (x.tag !== 'tr' || skipped(x)) continue;
    const cells = x.kids.filter((k) => typeof k !== 'string' && (k.tag === 'td' || k.tag === 'th') && !skipped(k)).map((k) => inline(k, base));
    if (cells.some(Boolean)) { const row = cells.join(' | '); rows.push(row); size += row.length + 1; }
    if (rows.length >= 500 || size > WRITE_LIMIT) break;
  }
  return rows.join('\n');
}

// Leading newlines and trailing whitespace off a <pre>, with a loop and trimEnd (a /\s+$/ regex is
// quadratic on a long run of spaces followed by a letter).
function trimPre(s) {
  let a = 0;
  while (a < s.length && s.charCodeAt(a) === 10) a++;
  return (a ? s.slice(a) : s).trimEnd();
}
// The longest run of one character (by code) in s, in one pass.
function longestRun(s, code) {
  let best = 0;
  let run = 0;
  for (let k = 0; k < s.length; k++) {
    if (s.charCodeAt(k) === code) { if (++run > best) best = run; } else run = 0;
  }
  return best;
}

function walk(node, w, base, isRoot) {
  if (w.full) return;
  if (typeof node === 'string') { w.text(collapse(node.length > 2 * WRITE_LIMIT ? node.slice(0, 2 * WRITE_LIMIT) : node)); return; }
  if (skipped(node, isRoot)) return;
  const t = node.tag;
  if (HEADS.has(t)) {
    const txt = inline(node, base);
    if (txt) w.block(`${'#'.repeat(Math.min(4, Number(t[1])))} ${txt}`);
    return;
  }
  switch (t) {
    case 'br': w.text('\n'); return;
    case 'hr': w.block('---'); return;
    case 'ul': case 'ol': case 'menu': w.block(listBlock(node, base, t === 'ol')); return;
    case 'li': w.block(listBlock({ kids: [node] }, base, false)); return;
    case 'blockquote': {
      const sub = new Writer();
      for (const k of node.kids) walk(k, sub, base, false);
      const body = sub.result();
      if (body) w.block(body.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
      return;
    }
    case 'pre': {
      const code = trimPre(rawText(node));
      if (!code) return;
      const fence = '`'.repeat(Math.max(3, longestRun(code, 96) + 1));   // longer than any backtick run inside
      w.block(`${fence}\n${code}\n${fence}`);
      return;
    }
    case 'code': case 'kbd': case 'samp': {
      const c = oneLine(rawText(node));
      if (c) { const tick = c.includes('`') ? '``' : '`'; w.text(`${tick}${c}${tick}`); }
      return;
    }
    case 'a': {
      const txt = inline(node, base);
      if (!txt) return;   // image-only links: images are dropped
      const href = safeLink(node.attrs.href, base);
      w.text(href ? `[${txt.replace(/[[\]]/g, '\\$&')}](${href})` : txt);
      return;
    }
    case 'strong': case 'b': { const x = inline(node, base); if (x) w.text(`**${x}**`); return; }
    case 'em': case 'i': { const x = inline(node, base); if (x) w.text(`*${x}*`); return; }
    case 'table': w.block(tableBlock(node, base)); return;
    default: break;
  }
  const block = BLOCKS.has(t) || t === 'td' || t === 'th' || t === 'tr';
  if (block) w.flush();
  for (const k of node.kids) { if (w.full) break; walk(k, w, base, false); }
  if (block) w.flush();
}

// A full writer means the text went on: when what it holds still fits, it says it was cut (capMarkdown
// cuts and says so for anything longer).
export function toMarkdown(root, base) {
  const w = new Writer();
  walk(root, w, base, true);
  const md = w.result().replace(/\n{3,}/g, '\n\n').trim();
  return w.full && md.length <= MAX_MD ? `${md}\n\n${CUT_NOTE}` : md;
}

// Cut long text on a paragraph boundary and say so.
export function capMarkdown(md, max = MAX_MD) {
  if (md.length <= max) return md;
  const room = max - CUT_NOTE.length - 2;
  let cut = md.lastIndexOf('\n\n', room);
  if (cut < room / 2) cut = md.lastIndexOf('\n', room);
  if (cut < room / 2) cut = room;
  return `${md.slice(0, cut).trimEnd()}\n\n${CUT_NOTE}`;
}

// The length of what a reader would actually read (link targets and Markdown marks don't count).
// "](target)" becomes "]", with an indexOf scan (a /\]\([^)\s]*\)/ regex rescans to the end of a long run of "](").
const WS = /\s/;
function stripLinkTargets(s) {
  let out = '';
  let from = 0;
  let at = s.indexOf('](');
  while (at >= 0) {
    let k = at + 2;
    while (k < s.length && s[k] !== ')' && !WS.test(s[k])) k++;
    if (k < s.length && s[k] === ')') { out += s.slice(from, at + 1); from = k + 1; at = s.indexOf('](', from); }
    // no ")" before a space or the end: no "](" in between can find one either, so the scan goes on from there
    else at = k < s.length ? s.indexOf('](', k) : -1;
  }
  return from ? out + s.slice(from) : s;
}
export function readableLength(md) {
  return stripLinkTargets(String(md || '')).replace(/[#*>`[\]|-]/g, '').replace(/\s+/g, ' ').trim().length;
}

// ---- JSON-LD ----
const ART_TYPE = /Article|BlogPosting|Posting|Report|NewsArticle|WebPage/i;
const typeOf = (o) => (Array.isArray(o['@type']) ? o['@type'].join(' ') : String(o['@type'] || ''));
const nameOf = (v) => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(nameOf).filter(Boolean).slice(0, 3).join(', ');
  if (v && typeof v === 'object' && typeof v.name === 'string') return v.name;
  return '';
};

const MAX_LD_CONTAINERS = 20_000;
function containers(raw) {
  const t = String(raw);
  let n = 0;
  for (let k = 0; k < t.length; k++) { const c = t.charCodeAt(k); if (c === 123 || c === 91) n++; }   // { and [
  return n;
}

// The article object from the page's JSON-LD (the one with the longest articleBody, else the first
// Article-like one). Walked without recursion and with a node budget: it is someone else's JSON.
export function jsonLdArticle(scripts) {
  let best = null;
  let first = null;
  let budget = 5000;
  for (const raw of scripts || []) {
    // a JSON-LD block is a handful of objects; tens of thousands of them is a trick to fill the memory
    if (containers(raw) > MAX_LD_CONTAINERS) continue;
    let data;
    try { data = JSON.parse(String(raw).trim().replace(/^<!--|-->$/g, '')); } catch { continue; }
    const todo = [data];
    while (todo.length && budget-- > 0) {
      const o = todo.pop();
      if (Array.isArray(o)) { for (const x of o.slice(0, 200)) todo.push(x); continue; }
      if (!o || typeof o !== 'object') continue;
      if (typeof o.articleBody === 'string' && (!best || o.articleBody.length > best.articleBody.length)) best = o;
      if (!first && ART_TYPE.test(typeOf(o)) && !/^WebPage$/i.test(typeOf(o))) first = o;
      if (o['@graph']) todo.push(o['@graph']);
      if (o.mainEntity && typeof o.mainEntity === 'object') todo.push(o.mainEntity);
      if (Array.isArray(o.hasPart)) todo.push(o.hasPart);
    }
  }
  return best || first;
}

// ---- metadata ----
const clean = (s, max) => {
  const t = oneLine(decodeEntities(String(s ?? '')).replace(CONTROLS, ' ').replace(BIDI, ''));
  return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : null;
};
const isUrlish = (s) => /^https?:\/\//i.test(String(s || '').trim());

export function toEpoch(v, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof v !== 'string' || v.length > 64) return null;
  const t = Date.parse(v.trim());
  if (!Number.isFinite(t)) return null;
  const sec = Math.floor(t / 1000);
  // nothing before the web, nothing more than two days ahead
  return sec >= 631152000 && sec <= nowSec + 2 * 86400 ? sec : null;
}

// Does the text hold an HTML tag ("<x" or "</x" with a ">" later)? One forward scan: the earliest tag start
// has the most text after it, so only it needs a ">" search (a /<\/?[a-z][^>]*>/ regex is quadratic on "<a<a<a...").
function looksLikeHtml(s) {
  for (let i = s.indexOf('<'); i >= 0; i = s.indexOf('<', i + 1)) {
    let k = i + 1;
    if (s[k] === '/') k++;
    const c = s.charCodeAt(k) | 32;
    if (c >= 97 && c <= 122) return s.indexOf('>', k + 1) >= 0;
  }
  return false;
}

function bodyFromLd(text, base) {
  const s = String(text);
  if (looksLikeHtml(s)) return toMarkdown(parseHtml(s).root, base);
  return s.replace(CONTROLS, ' ').split(/\n\s*\n|\r?\n/).map((p) => escapeLine(oneLine(decodeEntities(p)))).filter(Boolean).join('\n\n');
}

// The readable article from a page. Returns
//   { title, site, author, published_at, md, words, readable } where readable is false when the text is
//   too short to be an article (a paywall stub, an app shell): the caller keeps the title but not the text.
export function extractArticle(html, pageUrl, { nowSec } = {}) {
  let base;
  try { base = new URL(pageUrl); } catch { base = null; }
  const host = base ? base.hostname.replace(/^www\./i, '') : null;
  const doc = parseHtml(html);
  const m = (k) => doc.meta.get(k);
  const art = jsonLdArticle(doc.ld) || {};

  const title = clean(m('og:title'), 300) || clean(doc.title, 300) || clean(m('twitter:title'), 300) || clean(art.headline, 300);
  const site = clean(m('og:site_name'), 120) || clean(nameOf(art.publisher), 120) || host;
  const metaAuthor = [m('author'), nameOf(art.author), m('article:author'), m('parsely-author'), m('sailthru.author')]
    .find((x) => x && !isUrlish(x));
  const author = clean(metaAuthor, 200);
  const published = toEpoch(m('article:published_time'), nowSec) ?? toEpoch(typeof art.datePublished === 'string' ? art.datePublished : null, nowSec)
    ?? toEpoch(m('date'), nowSec) ?? toEpoch(m('parsely-pub-date'), nowSec);

  // the body: the longest of <article>, then <main>, then the block with the densest paragraphs
  const candidates = [];
  const articles = [];
  let mainEl = null;
  for (const e of elements(doc.root)) {
    if (e.tag === 'article') articles.push(e);
    else if (e.tag === 'main' && !mainEl) mainEl = e;
  }
  const visible = (e) => { for (let k = e; k; k = k.parent) if (skipped(k, k === e)) return false; return true; };
  const bestArticle = articles.filter(visible).sort((a, b) => textLen(b) - textLen(a))[0];
  if (bestArticle) candidates.push(bestArticle);
  if (mainEl && visible(mainEl)) candidates.push(mainEl);
  const dense = densest(doc.root);
  if (dense) candidates.push(dense);
  // last resort: the whole page minus its chrome (plain pages with no <p>, or text past the depth cap)
  candidates.push(doc.root);

  let md = '';
  let fromPage = true;
  for (const c of candidates) {
    const x = toMarkdown(c, base);
    if (readableLength(x) >= MIN_READABLE) { md = x; break; }
    if (readableLength(x) > readableLength(md)) md = x;
  }
  // JSON-LD articleBody first, when it is a real article and not a shortened teaser of the page's own text
  if (typeof art.articleBody === 'string') {
    const ldMd = bodyFromLd(art.articleBody, base);
    const n = readableLength(ldMd);
    if (n >= MIN_READABLE && n >= readableLength(md) * 0.8) { md = ldMd; fromPage = false; }
  }
  md = capMarkdown(md.replace(CONTROLS, ' '));
  const readable = readableLength(md) >= MIN_READABLE;
  // parsing stopped at a cap, so the page went on past the text taken from it: say so
  if (readable && fromPage && doc.cut && !md.endsWith(CUT_NOTE)) md = capMarkdown(`${md}\n\n${CUT_NOTE}`);
  const words = readable ? md.split(/\s+/).filter(Boolean).length : 0;
  return { title, site, author, published_at: published, md: readable ? md : null, words, readable };
}
