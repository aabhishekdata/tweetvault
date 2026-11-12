// Kindle highlights (kindle.js): Kindle's share text becomes the passage with its book beside it, at capture
// and for shares saved before this existed (openDb heal); the book shows in the item data, search, copies.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { capture, byId } from '../src/items.js';
import { parseKindleShare, bookOf, healKindleQuotes } from '../src/kindle.js';
import { itemDto, buildInbox } from '../src/tree.js';
import { renderItems } from '../src/render.js';

// exactly what Kindle for Android sent on 2026-11-08 (Share → Copy text)
const SHARE = 'I thought of you when I read this quote from "Financial Freedom: A Proven Path to All the Money You Will Ever Need" by Grant Sabatier, Vicki Robin -\n\n'
  + '"If you want to reach financial independence as quickly as possible, you need to go all out. You need to find ways to make as much money, save as much money, and invest as much money as possible."\n\n'
  + 'Start reading this book for free: https://read.amazon.in/kp/kshare?asin=B07DH8XKGP&id=m3djiit2bfavjav23z5o4zpzzq';
const QUOTE = 'If you want to reach financial independence as quickly as possible, you need to go all out. You need to find ways to make as much money, save as much money, and invest as much money as possible.';
const TITLE = 'Financial Freedom: A Proven Path to All the Money You Will Ever Need';
const URL = 'https://read.amazon.in/kp/kshare?asin=B07DH8XKGP&id=m3djiit2bfavjav23z5o4zpzzq';

let n = 0;
const cid = () => `kindle-test-${++n}-${Date.now()}`;

describe('parseKindleShare', () => {
  test('the real share: passage, book, authors, link, ASIN', () => {
    assert.deepEqual(parseKindleShare(SHARE), { quote: QUOTE, title: TITLE, author: 'Grant Sabatier, Vicki Robin', url: URL, asin: 'B07DH8XKGP' });
  });

  test('Windows line endings, curly quotes, other wording and domains', () => {
    const s = 'Look at this quote from “Deep Work” by Cal Newport —\r\n\r\n“Clarity about what matters provides clarity about what does not.”\r\n\r\n'
      + 'Start reading it for free: https://read.amazon.com/kp/kshare?asin=b00x47zvmo';
    const k = parseKindleShare(s);
    assert.equal(k.quote, 'Clarity about what matters provides clarity about what does not.');
    assert.equal(k.title, 'Deep Work');
    assert.equal(k.author, 'Cal Newport');
    assert.equal(k.asin, 'B00X47ZVMO');
  });

  test('a passage over several paragraphs keeps them', () => {
    const s = 'I thought of you when I read this quote from "Book" by A -\n\n"First paragraph.\n\nSecond paragraph."\n\nStart reading this book for free: https://read.amazon.in/kp/kshare?asin=B07DH8XKGP';
    assert.equal(parseKindleShare(s).quote, 'First paragraph.\n\nSecond paragraph.');
  });

  test('your own words around a share make it an ordinary note (nothing is dropped)', () => {
    assert.equal(parseKindleShare(`My take: this changed how I save.\n\n${SHARE}`), null);
    assert.equal(parseKindleShare(`${SHARE}\n\nMust reread chapter 3.`), null);
    assert.ok(parseKindleShare(`\n  ${SHARE}  \n\n`));   // surrounding blank space is fine
  });

  test('only real Amazon reader addresses count as the book link', () => {
    const at = (u) => parseKindleShare(`I thought of you when I read this quote from "B" by A -\n\n"Q."\n\nStart reading this book for free: ${u}`);
    assert.ok(at('https://read.amazon.co.uk/kp/kshare?asin=B07DH8XKGP&id=1'));
    for (const u of ['https://read.amazon.com.evil.io/kp/kshare?asin=B07DH8XKGP', 'http://read.amazon.in/kp/kshare?asin=B07DH8XKGP',
      'https://read.amazon.in/kp/kshare?asinX=B07DH8XKGP', 'https://read.amazon.in/kp/kshare?asin=B07DH8XKGPX']) assert.equal(at(u), null, u);
  });

  test('quote marks are removed only when they wrap the whole passage', () => {
    const q = (p) => parseKindleShare(`I thought of you when I read this quote from "B" by A -\n\n${p}\n\nStart reading this book for free: https://read.amazon.in/kp/kshare?asin=B07DH8XKGP`).quote;
    assert.equal(q('"Plain passage."'), 'Plain passage.');
    assert.equal(q('“Curly passage.”'), 'Curly passage.');
    assert.equal(q('"Hi," she said. "Bye."'), '"Hi," she said. "Bye."');
    assert.equal(q('No quote marks.'), 'No quote marks.');
  });

  test('large or hostile input is rejected quickly', () => {
    const t0 = Date.now();
    const blanks = `I thought of you when I read this quote from "B" by A -${'\n'.repeat(199_000)}Start reading this book for free: https://read.amazon.in/kp/kshare?asin=B07DH8XKGP`;
    assert.equal(parseKindleShare(blanks), null);
    const lines = `${'from "aaaaa" by '.repeat(800)}${' '.repeat(200)}\n"q"\nhttps://read.amazon.in/kp/kshare?asin=B07DH8XKGP`;
    assert.equal(parseKindleShare(lines), null);
    const many = `I thought of you when I read this quote from "B" by A -\n${'\n \n'.repeat(5_000)}x\nhttps://read.amazon.in/kp/kshare?asin=B07DH8XKGP`;
    assert.ok(parseKindleShare(many));
    assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
  });

  test('anything else is not a Kindle share', () => {
    for (const s of [
      '', 'just a note', QUOTE, 'https://read.amazon.in/kp/kshare?asin=B07DH8XKGP',
      'from "Book" by Someone -\n\n"quote"\n\nhttps://example.com/kp/kshare?asin=B07DH8XKGP',      // not Amazon
      'from "Book" by Someone -\n\n"quote"\n\nhttps://read.amazon.in/kp/kshare?id=nothing',       // no ASIN
      'https://read.amazon.in/kp/kshare?asin=B07DH8XKGP\n\nfrom "Book" by Someone -\n\n"quote"',  // header after the link
      'I thought of you when I read this quote from "Book" by A -\n\n""\n\nStart reading this book for free: https://read.amazon.in/kp/kshare?asin=B07DH8XKGP',
    ]) assert.equal(parseKindleShare(s), null, JSON.stringify(s));
  });
});

describe('capture and display', () => {
  test('a Kindle share is saved as the passage with its book; a repeat finds it', () => {
    const db = openDb(':memory:');
    const r = capture(db, { input: SHARE, source_app: 'com.amazon.kindle (guessed)', client_id: cid() });
    const it = byId(db, r.item_id);
    assert.equal(it.kind, 'text');
    assert.equal(it.text, QUOTE);
    assert.equal(it.link_title, TITLE);
    assert.equal(it.link_author, 'Grant Sabatier, Vicki Robin');
    assert.equal(it.link_site, 'Kindle');
    assert.equal(it.url, URL);
    assert.equal(it.link_type, null);
    assert.equal(it.fetch_status, 'n/a');
    assert.equal(db.prepare('SELECT raw_input FROM captures WHERE item_id = ?').get(it.id).raw_input, SHARE);
    // copied again later the same day (same passage, Copy only): the same item
    assert.equal(capture(db, { input: SHARE, client_id: cid() }).item_id, it.id);
    assert.equal(capture(db, { input: QUOTE, client_id: cid() }).item_id, it.id);
  });

  test('a passage copied first, then shared, gets its book', () => {
    const db = openDb(':memory:');
    const id = capture(db, { input: QUOTE, source_app: 'clipboard', client_id: cid() }).item_id;
    assert.equal(byId(db, id).link_title, null);
    assert.equal(capture(db, { input: SHARE, client_id: cid() }).item_id, id);
    const it = byId(db, id);
    assert.equal(it.link_title, TITLE);
    assert.equal(it.link_site, 'Kindle');
    assert.equal(it.url, URL);
    assert.equal(it.text, QUOTE);
  });

  test('item data, search by book or author, copy text and sources', () => {
    const db = openDb(':memory:');
    const id = capture(db, { input: SHARE, client_id: cid() }).item_id;
    const it = byId(db, id);
    assert.deepEqual(itemDto(it).book, { title: TITLE, author: 'Grant Sabatier, Vicki Robin', url: URL, site: 'Kindle' });
    assert.equal(itemDto(it).preview, QUOTE);
    for (const q of ['Proven Path', 'Sabatier', 'go all out']) {
      const found = JSON.stringify(buildInbox(db, { q }));
      assert.ok(found.includes(`"id":${id},`), q);
    }
    const r = renderItems(db, [it]);
    assert.match(r.text, new RegExp(`${QUOTE.slice(0, 40)}[\\s\\S]*\\n\\n— “Financial Freedom: A Proven Path to All the Money You Will Ever Need” by Grant Sabatier, Vicki Robin`));
    assert.ok(!r.text.includes('I thought of you'));
    assert.ok(!r.text.includes('Start reading'));
    assert.match(r.text_sources, /\[Note 1\] Kindle highlight · “Financial Freedom: [^”]+” by Grant Sabatier, Vicki Robin · https:\/\/read\.amazon\.in\/kp\/kshare\?asin=B07DH8XKGP/);
  });

  test('ordinary notes and links have no book', () => {
    const db = openDb(':memory:');
    const note = byId(db, capture(db, { input: 'a plain note', client_id: cid() }).item_id);
    assert.equal(bookOf(note), null);
    assert.equal(itemDto(note).book, null);
    assert.match(renderItems(db, [note]).text_sources, /Saved text/);
    // a web page with a title and author is a link, never a book
    assert.equal(bookOf({ kind: 'link', link_site: 'Kindle', link_title: 'x' }), null);
  });
});

describe('earlier Kindle shares', () => {
  test('openDb splits a share saved before as one block of text; others are left alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-kindle-'));
    try {
      const path = join(dir, 'v.db');
      let db = openDb(path);
      const ins = (text) => Number(db.prepare(`INSERT INTO items (kind, text, saved, state, fetch_status, first_saved_at, last_saved_at)
          VALUES ('text', ?, 1, 'inbox', 'n/a', 1, 1)`).run(text).lastInsertRowid);
      const old = ins(SHARE);
      const plain = ins('mentions read.amazon.in/kp/kshare but is not a share');
      const other = ins('a note');
      // a database from before this release: the one-time split has not run yet
      db.prepare("DELETE FROM kv WHERE key = 'kindle_quotes_healed'").run();
      db.close();
      db = openDb(path);
      const it = byId(db, old);
      assert.equal(it.text, QUOTE);
      assert.equal(it.link_title, TITLE);
      assert.equal(it.url, URL);
      assert.equal(byId(db, plain).text, 'mentions read.amazon.in/kp/kshare but is not a share');
      assert.equal(byId(db, plain).link_title, null);
      assert.equal(byId(db, other).text, 'a note');
      // a second run changes nothing
      assert.equal(healKindleQuotes(db), 0);
      // it runs once: a share stored the old way after that is left for capture-time splitting only
      assert.ok(db.prepare("SELECT 1 FROM kv WHERE key = 'kindle_quotes_healed'").get());
      const later = ins(SHARE);
      db.close();
      db = openDb(path);
      assert.equal(byId(db, later).text, SHARE);
      db.close();
    } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may still hold the WAL file */ } }
  });
});
