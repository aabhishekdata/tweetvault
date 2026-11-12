// Phase 3 web fixes: the extractor stays small on hostile 3 MB pages and a crash while reading one counts
// as an attempt (WEB0), a failed re-read never takes away text saved before (WEB1), the DNS lookup is
// inside the 15 s deadline (WEB3), no deflate is asked for (WEB4), and page headings, setext underlines
// and unclosed code fences can't take over the merged text (WEB5).
// Nothing here touches the network: page fetchers, resolvers and connections are fakes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { openDb } from '../src/db.js';
import { byId } from '../src/items.js';
import { BACKOFF } from '../src/fetcher.js';
import { readWebPage } from '../src/web.js';
import { safeFetch, resolvePublic, WebFetchError } from '../src/webfetch.js';
import {
  parseHtml, toMarkdown, extractArticle, CUT_NOTE, MAX_MD, MAX_ELEMENTS, MAX_TEXT,
} from '../src/htmltext.js';
import { renderItems, loadItemsInOrder, demoteHeadings } from '../src/render.js';

const HTMLTEXT = new URL('../src/htmltext.js', import.meta.url).href;

// Runs extractArticle on a generated 3 MB page in a child process with a small heap, and reports how
// far the process's peak memory rose above where it was just before.
function runIsolated(kind) {
  const script = `
    const { extractArticle } = await import(${JSON.stringify(HTMLTEXT)});
    const N = 3 * 1024 * 1024;
    const fill = (u) => u.repeat(Math.floor(N / u.length));
    const ent = '&amp;'.repeat(50);
    const pages = {
      paras: () => '<html><body>' + fill('<p>' + 'word '.repeat(10) + '</p>') + '</body></html>',
      br: () => '<html><body><article>' + fill('a<br>') + '</article></body></html>',
      nested: () => '<html><body>' + fill('<div><span>') + '</body></html>',
      attrs: () => '<html><body>' + fill('<p class="c' + ent + '" id="i' + ent + '" style="s' + ent + '" title="t' + ent + '" data-a="x" data-b="y">w</p>') + '</body></html>',
      text: () => '<html><body><article><p>' + fill('word ') + '</p></article></body></html>',
      inline: () => '<html><body><article><p>' + fill('x<b>y</b><i>z</i><a href="/q">l</a>') + '</p></article></body></html>',
      list: () => '<html><body><ul>' + fill('<li>item text</li>') + '</ul></body></html>',
    };
    const html = pages[${JSON.stringify(kind)}]();
    /\\u0000/.test(html);   // flattens the string before measuring
    globalThis.gc();
    const before = Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
    const a = extractArticle(html, 'https://big.example/');
    const peak = process.resourceUsage().maxRSS * 1024;
    console.log(JSON.stringify({ extraMB: (peak - before) / 1048576, md: a.md ? a.md.length : 0 }));
  `;
  const r = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=48', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

describe('WEB0: the extractor stays small on hostile pages', () => {
  for (const kind of ['paras', 'br', 'nested', 'attrs', 'text', 'inline', 'list']) {
    test(`a 3 MB "${kind}" page extracts with a 48 MB heap and little extra memory`, () => {
      const r = runIsolated(kind);
      assert.equal(r.status, 0, `the child process failed: ${r.err.slice(-600)}`);
      const { extraMB, md } = JSON.parse(r.out.trim().split('\n').pop());
      assert.ok(extraMB < 40, `peak memory rose by ${extraMB.toFixed(1)} MB`);
      assert.ok(md <= MAX_MD);
    });
  }

  test('parsing stops at the element cap and the text cap, and keeps what came before', () => {
    const doc = parseHtml(`<div><p>First words.</p>${'<span>x</span>'.repeat(MAX_ELEMENTS * 2)}<p>never reached</p></div>`);
    let n = 0;
    const todo = [doc.root];
    while (todo.length) {
      const e = todo.pop();
      n++;
      for (const k of e.kids) if (typeof k !== 'string') todo.push(k);
    }
    assert.ok(n <= MAX_ELEMENTS + 1, `${n} elements`);
    const out = toMarkdown(doc.root, 'https://h.example/');
    assert.match(out, /^First words\./);
    assert.ok(!out.includes('never reached'));

    const big = parseHtml(`<p>${'a'.repeat(MAX_TEXT * 2)}</p><p>after</p>`);
    let chars = 0;
    const walkText = (e) => { for (const k of e.kids) if (typeof k === 'string') chars += k.length; else walkText(k); };
    walkText(big.root);
    assert.ok(chars <= MAX_TEXT, `${chars} characters kept`);
  });

  test('only the attributes the extractor reads are kept, and elements carry no per-node cache objects', () => {
    const doc = parseHtml('<p class="c" id="i" style="s" data-x="1" onclick="y" lang="en" title="t">w</p><img src="a.png" alt="x"><br>');
    const p = doc.root.kids[0];
    assert.deepEqual(Object.keys(p.attrs).sort(), ['class', 'id', 'style', 'title']);
    assert.equal(doc.root.kids.length, 2, 'an <img> is never text, so it is not kept');
    assert.equal(doc.root.kids[1].tag, 'br');
    const d2 = parseHtml(`<form><article><p>${'Words. '.repeat(10)}</p></article></form>`);
    toMarkdown(d2.root, 'https://h.example/');   // works out the paragraph counts (for the <form>)
    for (const e of [d2.root, d2.root.kids[0], d2.root.kids[0].kids[0]]) {
      assert.deepEqual(Object.keys(e), ['tag', 'attrs', 'kids', 'parent', 'sp', 'st'], e.tag);
    }
    assert.equal(d2.root.kids[0].sp, 1);
  });

  test('the Markdown writer stops past the saved size and says the text was cut', () => {
    const doc = parseHtml(`<article>${`<p>${'Paragraph words go here. '.repeat(8)}</p>`.repeat(5000)}</article>`);
    const md = toMarkdown(doc.root, 'https://h.example/');
    assert.ok(md.length < MAX_MD + 10_000, `${md.length} characters`);
    const a = extractArticle(`<html><body><article>${'a<br>'.repeat(200_000)}</article></body></html>`, 'https://h.example/');
    assert.ok(a.md.length <= MAX_MD);
    assert.ok(a.md.endsWith(CUT_NOTE));
  });

  test('end tags with no ">" left are read in linear time', () => {
    const t0 = Date.now();
    const doc = parseHtml(`<p>start</p>${'</a'.repeat(200_000)}`);
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
    assert.ok(doc.root.kids.length >= 1);
  });

  test('the attempt is counted before the page is fetched, so a crash while reading it is not forgotten', async () => {
    const db = openDb(':memory:');
    const id = linkItem(db, { fetch_status: 'pending', link_type: null, link_md: null });
    const T = 1_794_000_000;
    let during = null;
    await readWebPage(db, byId(db, id), {
      now: () => T,
      webFetch: async () => { during = byId(db, id); throw new WebFetchError('gone', "The page wasn't found"); },
    });
    assert.equal(during.fetch_attempts, 1);
    assert.equal(during.next_fetch_at, T + BACKOFF[0]);
    assert.equal(during.fetch_status, 'pending');
    assert.equal(byId(db, id).fetch_attempts, 0, 'a finished read resets the count');
  });

  test('a temporary failure is counted once (by the worker), not twice', async () => {
    const db = openDb(':memory:');
    const id = linkItem(db, { fetch_status: 'pending', link_type: null, link_md: null, fetch_attempts: 2 });
    await assert.rejects(readWebPage(db, byId(db, id), {
      now: () => 1, webFetch: async () => { throw new WebFetchError('status', 'The site answered 503', { retry: true }); },
    }), (e) => e.retry === true);
    assert.equal(byId(db, id).fetch_attempts, 2);
  });

  test('after the last backoff step a page that keeps crashing the reader ends failed without being fetched', async () => {
    const db = openDb(':memory:');
    const id = linkItem(db, { fetch_status: 'pending', link_type: null, link_md: null, fetch_attempts: BACKOFF.length + 1 });
    let fetched = false;
    await readWebPage(db, byId(db, id), { now: () => 1, webFetch: async () => { fetched = true; } });
    assert.equal(fetched, false);
    const it = byId(db, id);
    assert.equal(it.fetch_status, 'failed');
    assert.equal(it.next_fetch_at, null);
    assert.equal(it.fetch_error, 'Reading this page kept failing');
  });
});

// a link item; defaults to one read before, with article text
function linkItem(db, f = {}) {
  const t = 1773477000;
  const row = {
    kind: 'link', url: 'https://www.dailyledger.example/story', text: 'Share title', fetch_status: 'ok', saved: 1, state: 'inbox',
    first_saved_at: t, last_saved_at: t, link_type: 'web', link_title: 'Cycle lanes approved', link_site: 'The Daily Ledger',
    link_author: 'Priya Raman', link_published_at: t, link_md: 'First paragraph of the saved article.\n\nSecond paragraph.',
    link_meta: JSON.stringify({ final_url: 'https://www.dailyledger.example/story', words: 9 }), link_fetched_at: t, ...f,
  };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c])).lastInsertRowid);
}
const requeue = (db, id) => db.prepare("UPDATE items SET fetch_status = 'pending', fetch_attempts = 0, next_fetch_at = NULL, fetch_error = NULL WHERE id = ?").run(id);

describe('WEB1: a failed re-read keeps the text saved before', () => {
  const SAVED = 'First paragraph of the saved article.\n\nSecond paragraph.';
  const keptAsBefore = (it, why) => {
    assert.equal(it.fetch_status, 'ok');
    assert.equal(it.fetch_error, why);
    assert.equal(it.link_md, SAVED);
    assert.equal(it.link_title, 'Cycle lanes approved');
    assert.equal(it.link_site, 'The Daily Ledger');
    assert.equal(it.link_author, 'Priya Raman');
    assert.equal(it.link_published_at, 1773477000);
    assert.equal(it.fetch_attempts, 0);
    assert.equal(it.next_fetch_at, null);
  };

  test('read ok, then the re-read answers 404: the text, title and site stay, the reason is in fetch_error', async () => {
    const db = openDb(':memory:');
    const id = linkItem(db);
    requeue(db, id);
    await readWebPage(db, byId(db, id), { now: () => 5, webFetch: async () => { throw new WebFetchError('gone', "The page wasn't found"); } });
    keptAsBefore(byId(db, id), "The page wasn't found");
  });

  test('a re-read that is now a paywall (no readable text) keeps the old text too', async () => {
    const db = openDb(':memory:');
    const id = linkItem(db);
    requeue(db, id);
    const html = '<html><head><title>Subscribe</title></head><body><p>Subscribe to read.</p></body></html>';
    await readWebPage(db, byId(db, id), { now: () => 5, webFetch: async (u) => ({ status: 200, finalUrl: u, html, bytes: html.length }) });
    keptAsBefore(byId(db, id), 'No readable article text');
  });

  test('the last temporary failure keeps the old text instead of ending failed', async () => {
    const db = openDb(':memory:');
    const id = linkItem(db);
    requeue(db, id);
    db.prepare('UPDATE items SET fetch_attempts = ? WHERE id = ?').run(BACKOFF.length, id);
    await readWebPage(db, byId(db, id), {
      now: () => 5, webFetch: async () => { throw new WebFetchError('network', "Couldn't connect to the site", { retry: true }); },
    });
    keptAsBefore(byId(db, id), "Couldn't connect to the site");
  });

  test('a link never read before still ends link_only', async () => {
    const db = openDb(':memory:');
    const id = linkItem(db, { fetch_status: 'pending', link_type: null, link_md: null, link_title: null });
    await readWebPage(db, byId(db, id), { now: () => 5, webFetch: async () => { throw new WebFetchError('gone', "The page wasn't found"); } });
    assert.equal(byId(db, id).fetch_status, 'link_only');
  });

  test('while the page is read again (or after that failed) the merge still shows the saved text', () => {
    const db = openDb(':memory:');
    const a = linkItem(db, { fetch_status: 'pending' });
    const b = linkItem(db, { fetch_status: 'failed' });
    const r = renderItems(db, loadItemsInOrder(db, [a, b]));
    assert.ok(!r.text.includes('Still loading') && !r.text.includes('Loading this post failed'), r.text);
    assert.equal(r.text.split('First paragraph of the saved article.').length, 3);
    assert.match(r.text, /^## Article: Cycle lanes approved \(The Daily Ledger\)/);
  });
});

describe('WEB3: the DNS lookup is inside the deadline', () => {
  const never = () => new Promise(() => {});

  test('resolvePublic gives up at the deadline with a retryable "slow"', async () => {
    const t0 = Date.now();
    await assert.rejects(resolvePublic('slow.example', never, Date.now() + 50),
      (e) => e instanceof WebFetchError && e.code === 'slow' && e.retry === true);
    assert.ok(Date.now() - t0 < 2000);
  });

  test('safeFetch with a resolver that never answers ends within its timeout', async () => {
    const t0 = Date.now();
    await assert.rejects(safeFetch('https://slow.example/', { lookup: never, timeoutMs: 80, request: () => { throw new Error('not reached'); } }),
      (e) => e instanceof WebFetchError && e.code === 'slow' && e.retry === true);
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  });

  test('a lookup that answers in time still works, and a missing name is still final', async () => {
    const ok = async () => [{ address: '93.184.216.34', family: 4 }];
    assert.deepEqual(await resolvePublic('fine.example', ok, Date.now() + 5000), { address: '93.184.216.34', family: 4 });
    const missing = async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }); };
    await assert.rejects(resolvePublic('gone.example', missing, Date.now() + 5000), (e) => e.code === 'dns' && !e.retry);
  });
});

describe('WEB4: compression', () => {
  test('the request asks for gzip and brotli only, not deflate', async () => {
    let headers = null;
    const request = (o) => { headers = o.headers; throw new Error('stop here'); };
    await assert.rejects(safeFetch('https://93.184.216.34/', { request }));
    assert.equal(headers['Accept-Encoding'], 'gzip, br');
  });
});

describe('WEB5: page text cannot pass for the merge structure', () => {
  test('indented ATX headings are demoted', () => {
    assert.equal(demoteHeadings('   # Post 9\n  ## Sources\n #### Four'), '### Post 9\n#### Sources\n###### Four');
    assert.equal(demoteHeadings('#\n##\tTab'), '###\n####\tTab');
    assert.equal(demoteHeadings('    # four spaces is code'), '    # four spaces is code');
  });

  test('setext underlines under a line of text are escaped; a "---" rule after a blank line stays', () => {
    assert.equal(demoteHeadings('Post 2\n==='), 'Post 2\n\\===');
    assert.equal(demoteHeadings('Sources\n  ---  '), 'Sources\n\\---  ');
    assert.equal(demoteHeadings('Fake\n-'), 'Fake\n\\-');
    assert.equal(demoteHeadings('Para.\n\n---\n\nMore.'), 'Para.\n\n---\n\nMore.');
  });

  test('an unclosed fence is closed at the end of the item; fences of either kind keep their content', () => {
    assert.equal(demoteHeadings('Text\n```\ncode\n## Post 3'), 'Text\n```\ncode\n## Post 3\n```');
    assert.equal(demoteHeadings('~~~~\n# x\n~~~\n~~~~\n# y'), '~~~~\n# x\n~~~\n~~~~\n### y');
    assert.equal(demoteHeadings('  ```js\nText\n===\n  ```'), '  ```js\nText\n===\n  ```');
    // the old behaviour stays
    assert.equal(demoteHeadings('# A\n```\n# b\n```\n#### C\n##### D'), '### A\n```\n# b\n```\n###### C\n##### D');
  });

  test('in the merge, a page with an unclosed fence does not swallow the next item', () => {
    const db = openDb(':memory:');
    const a = linkItem(db, { link_md: 'Intro text.\n\n```\nnever closed' });
    const b = linkItem(db, { link_title: 'Second', link_md: 'Second article.' });
    const r = renderItems(db, loadItemsInOrder(db, [a, b]));
    const fences = r.text.split('\n').filter((l) => l.startsWith('```')).length;
    assert.equal(fences % 2, 0, r.text);
    assert.match(r.text, /```\n\n## Article: Second/);
  });
});
