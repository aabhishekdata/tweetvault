// Core pure-logic tests: urls.js, draftjs.js, fx.js, totp.js. No network, no DB writes needed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { normHost, isTweetHost, parseTweetUrl, isTcoUrl, extractUrls, canonicalTweetUrl, classifyInput } from '../src/urls.js';
import { draftToMarkdown, RENDER_VERSION } from '../src/draftjs.js';
import { interpretFx, fxTweetToFields, oembedToFields, decodeEntities } from '../src/fx.js';
import { base32Encode, base32Decode, hotp, totp, verifyTotp, newSecret, otpauthUrl, seal, unseal } from '../src/totp.js';
import { openDb } from '../src/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');
const articleText = fixture('article.json');
const articleJson = JSON.parse(articleText);

// ---------------------------------------------------------------- urls.js
describe('urls.js', () => {
  const ID = '2117512471930167377';
  const tweetCases = [
    ['https://x.com/addyosmani/status/' + ID, 'addyosmani'],
    ['https://twitter.com/addyosmani/status/' + ID, 'addyosmani'],
    ['https://mobile.twitter.com/addyosmani/status/' + ID, 'addyosmani'],
    ['https://mobile.x.com/addyosmani/status/' + ID, 'addyosmani'],
    ['https://www.x.com/addyosmani/status/' + ID, 'addyosmani'],
    ['https://www.twitter.com/addyosmani/status/' + ID, 'addyosmani'],
    ['https://m.twitter.com/addyosmani/status/' + ID, 'addyosmani'],
    ['https://fxtwitter.com/addyosmani/status/' + ID, 'addyosmani'],
    ['https://vxtwitter.com/addyosmani/status/' + ID, 'addyosmani'],
    ['https://fixupx.com/addyosmani/status/' + ID, 'addyosmani'],
    ['https://fixvx.com/addyosmani/status/' + ID, 'addyosmani'],
    ['https://nitter.net/addyosmani/status/' + ID, 'addyosmani'],
    ['https://nitter.privacydev.net/addyosmani/status/' + ID + '#m', 'addyosmani'],
    ['https://xcancel.com/addyosmani/status/' + ID, 'addyosmani'],
    ['http://x.com/addyosmani/status/' + ID, 'addyosmani'],
    ['HTTPS://X.COM/addyosmani/status/' + ID, 'addyosmani'],
    ['https://x.com/i/web/status/' + ID, null],
    ['https://twitter.com/i/web/status/' + ID, null],
    ['https://x.com/i/status/' + ID, null],
    ['https://x.com/addyosmani/status/' + ID + '/photo/1', 'addyosmani'],
    ['https://x.com/addyosmani/status/' + ID + '/video/1', 'addyosmani'],
    ['https://x.com/addyosmani/status/' + ID + '?s=46&t=AbCdEfGh123', 'addyosmani'],
    ['https://x.com/addyosmani/status/' + ID + '/photo/2?s=20', 'addyosmani'],
    ['https://twitter.com/addyosmani/statuses/' + ID, 'addyosmani'],
    ['https://x.com/addyosmani/status/' + ID + '/', 'addyosmani'],
    ['https://x.com/Some_User_15/status/' + ID, 'Some_User_15'],
  ];

  for (const [url, handle] of tweetCases) {
    test(`parseTweetUrl + classifyInput: ${url}`, () => {
      assert.deepEqual(parseTweetUrl(url), { tweetId: ID, handle });
      const c = classifyInput(url);
      assert.equal(c.type, 'tweet');
      assert.equal(c.tweetId, ID);
      assert.equal(typeof c.tweetId, 'string');
      assert.equal(c.handle, handle);
      assert.equal(c.url, `https://x.com/${handle || 'i'}/status/${ID}`);
    });
  }

  test('normHost / isTweetHost', () => {
    assert.equal(normHost('WWW.Twitter.com'), 'twitter.com');
    assert.equal(normHost('mobile.x.com'), 'x.com');
    assert.equal(normHost('m.x.com'), 'x.com');
    assert.equal(normHost(undefined), '');
    assert.equal(isTweetHost('x.com'), true);
    assert.equal(isTweetHost('nitter.example.org'), true);
    assert.equal(isTweetHost('example.com'), false);
    assert.equal(isTweetHost('x.com.evil.com'), false);
    assert.equal(isTweetHost('notx.com'), false);
  });

  test('parseTweetUrl rejects non-X, bad schemes and non-status paths', () => {
    assert.equal(parseTweetUrl('https://example.com/a/status/' + ID), null);
    assert.equal(parseTweetUrl('ftp://x.com/a/status/' + ID), null);
    assert.equal(parseTweetUrl('javascript:alert(1)'), null);
    assert.equal(parseTweetUrl('not a url'), null);
    assert.equal(parseTweetUrl('https://x.com/addyosmani'), null);
    assert.equal(parseTweetUrl('https://x.com/addyosmani/status/abc'), null);
    assert.equal(parseTweetUrl('https://x.com/addyosmani/status/123'), null); // too short to be an id
    assert.equal(parseTweetUrl('https://x.com/home'), null);
  });

  test('handle that is not a valid handle becomes null', () => {
    assert.deepEqual(parseTweetUrl('https://x.com/this-is-not-valid/status/' + ID), { tweetId: ID, handle: null });
    assert.deepEqual(parseTweetUrl('https://x.com/abcdefghijklmnop/status/' + ID), { tweetId: ID, handle: null }); // 16 chars
  });

  test('/i/article/<id>', () => {
    assert.deepEqual(parseTweetUrl('https://x.com/i/article/2116367635365695488'), { articleId: '2116367635365695488' });
    const c = classifyInput('https://x.com/i/article/2116367635365695488?s=46');
    assert.deepEqual(c, { type: 'article_link', articleId: '2116367635365695488', url: 'https://x.com/i/article/2116367635365695488' });
  });

  test('t.co links', () => {
    assert.equal(isTcoUrl('https://t.co/2gyp2Erpxx'), true);
    assert.equal(isTcoUrl('http://t.co/2gyp2Erpxx'), true);
    assert.equal(isTcoUrl('https://t.co/'), false);
    assert.equal(isTcoUrl('https://t.co/a/b'), false);
    assert.equal(isTcoUrl('https://tco.com/abc'), false);
    assert.equal(isTcoUrl('nope'), false);
    assert.deepEqual(classifyInput('https://t.co/2gyp2Erpxx'), { type: 'tco', url: 'https://t.co/2gyp2Erpxx' });
    assert.deepEqual(classifyInput('look https://t.co/2gyp2Erpxx.'), { type: 'tco', url: 'https://t.co/2gyp2Erpxx' });
  });

  test('a tweet link wins over a t.co link and over an article link', () => {
    const c = classifyInput(`https://t.co/abc https://x.com/i/article/999999 https://x.com/jack/status/${ID}`);
    assert.equal(c.type, 'tweet');
    assert.equal(c.tweetId, ID);
  });

  test('trailing punctuation and parentheses are trimmed', () => {
    for (const tail of ['.', ',', '!', '?', ')', ').', '",', '”', '’', ';', ':', ']', '>', '»', '...']) {
      const [u] = extractUrls(`see https://x.com/jack/status/${ID}${tail} next`);
      assert.equal(u, `https://x.com/jack/status/${ID}`, `tail ${tail}`);
    }
    assert.deepEqual(extractUrls(`(https://x.com/jack/status/${ID})`), [`https://x.com/jack/status/${ID}`]);
    assert.equal(classifyInput(`(see https://x.com/jack/status/${ID}).`).tweetId, ID);
  });

  test('balanced parentheses inside a URL are kept', () => {
    assert.deepEqual(extractUrls('https://en.wikipedia.org/wiki/Foo_(bar)'), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
    assert.deepEqual(extractUrls('see https://en.wikipedia.org/wiki/Foo_(bar)). ok'), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
  });

  test('extractUrls finds several and stops at quotes and angle brackets', () => {
    assert.deepEqual(extractUrls('a https://a.com/1 b "https://b.com/2" <https://c.com/3>'), ['https://a.com/1', 'https://b.com/2', 'https://c.com/3']);
    assert.deepEqual(extractUrls(''), []);
    assert.deepEqual(extractUrls(null), []);
  });

  test('non-X link is a link item', () => {
    assert.deepEqual(classifyInput('https://example.com/post?a=1'), { type: 'link', url: 'https://example.com/post?a=1', title: null });
    assert.deepEqual(classifyInput('  https://example.com/  '), { type: 'link', url: 'https://example.com/', title: null });
  });

  test('link plus page title (share sheet form) is a link with a title', () => {
    assert.deepEqual(classifyInput('How Draft.js works - Example Blog\nhttps://example.com/draft'), {
      type: 'link', url: 'https://example.com/draft', title: 'How Draft.js works - Example Blog',
    });
    assert.deepEqual(classifyInput('https://example.com/draft How Draft.js works'), {
      type: 'link', url: 'https://example.com/draft', title: 'How Draft.js works',
    });
  });

  test('link title should not keep the trimmed punctuation', () => {
    assert.equal(classifyInput('Great read (https://example.com/post)').title, 'Great read');
  });

  test('tweet link followed by CJK punctuation is still a tweet', () => {
    const c = classifyInput(`見て https://x.com/jack/status/${ID}。`);
    assert.equal(c.type, 'tweet');
    assert.equal(c.tweetId, ID);
  });

  test('plain text is a note', () => {
    assert.deepEqual(classifyInput('Just some highlighted words.'), { type: 'text', text: 'Just some highlighted words.' });
    assert.deepEqual(classifyInput(''), { type: 'text', text: '' });
    assert.deepEqual(classifyInput(null), { type: 'text', text: '' });
  });

  test('long text containing a non-X link stays a note', () => {
    const long = 'Lorem ipsum dolor sit amet. '.repeat(12) + 'https://example.com/ref ' + 'more words here.';
    const c = classifyInput(long);
    assert.equal(c.type, 'text');
    assert.equal(c.text, long.trim());
  });

  test('text with a blank line plus a link stays a note', () => {
    assert.equal(classifyInput('para one\n\npara two https://example.com').type, 'text');
  });

  test('two non-X links stay a note', () => {
    assert.equal(classifyInput('https://a.com https://b.com').type, 'text');
  });

  test('long text containing a tweet link captures the tweet', () => {
    const long = 'Some long paragraph about agents. '.repeat(10) + `Source: https://x.com/addyosmani/status/${ID}?s=46&t=xyz.`;
    const c = classifyInput(long);
    assert.equal(c.type, 'tweet');
    assert.equal(c.tweetId, ID);
    assert.equal(c.handle, 'addyosmani');
  });

  test('canonicalTweetUrl', () => {
    assert.equal(canonicalTweetUrl('jack', '20'), 'https://x.com/jack/status/20');
    assert.equal(canonicalTweetUrl(null, '20'), 'https://x.com/i/status/20');
  });
});

// ---------------------------------------------------------------- draftjs.js
describe('draftjs.js', () => {
  const article = articleJson.tweet.article;
  const md = draftToMarkdown(article.content, article.media_entities);
  const em = Object.fromEntries(article.content.entityMap.map((e) => [e.key, e.value]));

  test('RENDER_VERSION is a positive integer', () => {
    assert.ok(Number.isInteger(RENDER_VERSION) && RENDER_VERSION >= 1);
  });

  test('article fixture: bold inline range', () => {
    const b = article.content.blocks[0];
    const r = b.inlineStyleRanges[0];
    const bold = b.text.slice(r.offset, r.offset + r.length);
    assert.ok(md.includes(`**${bold}**`), 'bold span of block 0');
  });

  test('article fixture: header-two blocks become ### headings without bold', () => {
    assert.ok(md.includes('\n\n### Offloading, deferral and surrender\n\n'));
    assert.ok(md.includes('### The questions I ask myself'));
    assert.ok(!md.includes('### **'));
    const headers = article.content.blocks.filter((b) => b.type === 'header-two').length;
    assert.equal((md.match(/^### /gm) || []).length, headers);
  });

  test('article fixture: links resolve by entityMap[].key, not array index', () => {
    const b = article.content.blocks[8];
    const r = b.entityRanges[0];
    assert.equal(r.key, 0);
    const label = b.text.slice(r.offset, r.offset + r.length);
    const right = em[String(r.key)].data.url;
    const wrong = article.content.entityMap[r.key].value.data.url;
    assert.notEqual(right, wrong);
    assert.ok(md.includes(`[${label}](${right})`), `expected [${label}](${right})`);
    assert.ok(!md.includes(`[${label}](${wrong})`));
    // every link range in the fixture appears with its keyed URL
    for (const blk of article.content.blocks) {
      for (const er of blk.entityRanges || []) {
        const ent = em[String(er.key)];
        if (ent.type !== 'LINK') continue;
        assert.ok(md.includes(`](${ent.data.url})`), `missing link ${ent.data.url}`);
      }
    }
  });

  test('article fixture: atomic image resolves through media_entities', () => {
    assert.ok(md.includes('[Image: https://pbs.twimg.com/media/HWLT4glawAA6egZ.png]'));
    assert.ok(md.trimEnd().endsWith('[Image: https://pbs.twimg.com/media/HWLT4glawAA6egZ.png]'));
  });

  test('article fixture: unordered list items are joined with single newlines', () => {
    assert.ok(md.includes('- **Be intentional.** An agent'));
    assert.ok(/- \*\*Be intentional\.\*\*[^\n]*\n- \*\*Be honest about your place on the spectrum\.\*\*/.test(md));
  });

  test('atomic without media match is [Image]; other atomic kinds', () => {
    const em2 = {
      1: { type: 'MEDIA', data: { mediaItems: [{ mediaId: '42' }] } },
      2: { type: 'TWEET', data: { tweetId: '2117512471930167377' } },
      3: { type: 'DIVIDER', data: {} },
    };
    const out = draftToMarkdown({
      blocks: [
        { type: 'atomic', text: ' ', entityRanges: [{ key: 1, offset: 0, length: 1 }] },
        { type: 'atomic', text: ' ', entityRanges: [{ key: 2, offset: 0, length: 1 }] },
        { type: 'atomic', text: ' ', entityRanges: [{ key: 3, offset: 0, length: 1 }] },
      ],
      entityMap: em2,
    }, []);
    assert.equal(out, '[Image]\n\n[Embedded post: https://x.com/i/status/2117512471930167377]\n\n* * *');
  });

  test('emoji before a bold range uses UTF-16 offsets', () => {
    const text = '🚀🔥 hello bold world';
    const off = text.indexOf('bold'); // UTF-16 index (emoji are 2 units each)
    assert.equal(off, 11);
    const out = draftToMarkdown({ blocks: [{ type: 'unstyled', text, inlineStyleRanges: [{ offset: off, length: 4, style: 'BOLD' }] }], entityMap: {} });
    assert.equal(out, '🚀🔥 hello **bold** world');
  });

  test('emoji before a link uses UTF-16 offsets', () => {
    const text = '👍🏽 read my post now';
    const off = text.indexOf('my post');
    const out = draftToMarkdown({
      blocks: [{ type: 'unstyled', text, entityRanges: [{ key: 7, offset: off, length: 7 }] }],
      entityMap: [{ key: '7', value: { type: 'LINK', data: { url: 'https://example.com/p' } } }],
    });
    assert.equal(out, '👍🏽 read [my post](https://example.com/p) now');
  });

  test('italic, strikethrough, code and overlapping bold+italic', () => {
    const out = draftToMarkdown({
      blocks: [{
        type: 'unstyled', text: 'a b c d',
        inlineStyleRanges: [
          { offset: 0, length: 1, style: 'ITALIC' },
          { offset: 2, length: 1, style: 'STRIKETHROUGH' },
          { offset: 4, length: 1, style: 'CODE' },
          { offset: 6, length: 1, style: 'BOLD' },
          { offset: 6, length: 1, style: 'ITALIC' },
          { offset: 0, length: 1, style: 'UNDERLINE' }, // unknown style ignored
        ],
      }],
      entityMap: {},
    });
    assert.equal(out, '_a_ ~~b~~ `c` _**d**_');
  });

  test('bold range with trailing space keeps the space outside the marks', () => {
    const out = draftToMarkdown({ blocks: [{ type: 'unstyled', text: 'Bold then text', inlineStyleRanges: [{ offset: 0, length: 5, style: 'BOLD' }] }], entityMap: {} });
    assert.equal(out, '**Bold** then text');
  });

  test('link range with a leading space keeps the space', () => {
    const out = draftToMarkdown({
      blocks: [{ type: 'unstyled', text: 'see this link', entityRanges: [{ key: 1, offset: 3, length: 5 }] }],
      entityMap: { 1: { type: 'LINK', data: { url: 'https://a.b/' } } },
    });
    assert.equal(out, 'see [this](https://a.b/) link');
  });

  test('nested unordered and ordered lists with depth', () => {
    const out = draftToMarkdown({
      blocks: [
        { type: 'unstyled', text: 'Intro' },
        { type: 'unordered-list-item', text: 'one', depth: 0 },
        { type: 'unordered-list-item', text: 'one.a', depth: 1 },
        { type: 'unordered-list-item', text: 'one.a.i', depth: 2 },
        { type: 'unordered-list-item', text: 'two', depth: 0 },
        { type: 'unstyled', text: 'Middle' },
        { type: 'ordered-list-item', text: 'first', depth: 0 },
        { type: 'ordered-list-item', text: 'sub one', depth: 1 },
        { type: 'ordered-list-item', text: 'sub two', depth: 1 },
        { type: 'ordered-list-item', text: 'second', depth: 0 },
        { type: 'ordered-list-item', text: 'new sub', depth: 1 },
        { type: 'unstyled', text: 'After' },
        { type: 'ordered-list-item', text: 'restart', depth: 0 },
      ],
      entityMap: {},
    });
    assert.equal(out, [
      'Intro',
      '',
      '- one\n  - one.a\n    - one.a.i\n- two',
      '',
      'Middle',
      '',
      '1. first\n   1. sub one\n   2. sub two\n2. second\n   1. new sub',
      '',
      'After',
      '',
      '1. restart',
    ].join('\n'));
  });

  test('depth is clamped to 0..6', () => {
    const out = draftToMarkdown({ blocks: [{ type: 'unstyled', text: 'x' }, { type: 'unordered-list-item', text: 'deep', depth: 99 }, { type: 'unordered-list-item', text: 'neg', depth: -3 }], entityMap: {} });
    assert.equal(out, `x\n\n${'  '.repeat(6)}- deep\n- neg`);
  });

  test('a nested list item as the first block keeps its indent', () => {
    const out = draftToMarkdown({ blocks: [{ type: 'unordered-list-item', text: 'deep', depth: 1 }], entityMap: {} });
    assert.equal(out, '  - deep');
  });

  test('ordered list numbering continues after a nested bullet', () => {
    const out = draftToMarkdown({
      blocks: [
        { type: 'ordered-list-item', text: 'a', depth: 0 },
        { type: 'unordered-list-item', text: 'sub', depth: 1 },
        { type: 'ordered-list-item', text: 'b', depth: 0 },
      ],
      entityMap: {},
    });
    assert.match(out, /\n2\. b$/);
  });

  test('consecutive code blocks are grouped into one fence', () => {
    const out = draftToMarkdown({
      blocks: [
        { type: 'unstyled', text: 'Code:' },
        { type: 'code-block', text: 'const a = 1;', inlineStyleRanges: [{ offset: 0, length: 5, style: 'BOLD' }] },
        { type: 'code-block', text: '' },
        { type: 'code-block', text: 'console.log(a);' },
        { type: 'unstyled', text: 'Done' },
        { type: 'code-block', text: 'second()' },
      ],
      entityMap: {},
    });
    assert.equal(out, 'Code:\n\n```\nconst a = 1;\n\nconsole.log(a);\n```\n\nDone\n\n```\nsecond()\n```');
  });

  test('blockquote, including multi-line', () => {
    const out = draftToMarkdown({ blocks: [{ type: 'blockquote', text: 'line one\nline two' }, { type: 'unstyled', text: 'after' }], entityMap: {} });
    assert.equal(out, '> line one\n> line two\n\nafter');
  });

  test('header levels map to ### and ####', () => {
    const out = draftToMarkdown({
      blocks: [
        { type: 'header-one', text: 'H1' }, { type: 'header-two', text: 'H2' },
        { type: 'header-three', text: 'H3' }, { type: 'header-six', text: 'H6' },
      ],
      entityMap: {},
    });
    assert.equal(out, '### H1\n\n### H2\n\n#### H3\n\n#### H6');
  });

  test('unknown block types render as paragraphs; empty blocks are skipped', () => {
    const out = draftToMarkdown({
      blocks: [
        { type: 'mystery-block', text: 'still here', inlineStyleRanges: [{ offset: 0, length: 5, style: 'BOLD' }] },
        { type: 'unstyled', text: '' },
        { type: 'unstyled', text: '   ' },
        { text: 'no type' },
      ],
      entityMap: {},
    });
    assert.equal(out, '**still** here\n\nno type');
  });

  test('empty / missing content', () => {
    assert.equal(draftToMarkdown(null), '');
    assert.equal(draftToMarkdown({}), '');
    assert.equal(draftToMarkdown({ blocks: [] }), '');
  });

  test('non-LINK entities in a text block are ignored; missing entity ignored', () => {
    const out = draftToMarkdown({
      blocks: [{ type: 'unstyled', text: 'hi @jack there', entityRanges: [{ key: 0, offset: 3, length: 5 }, { key: 9, offset: 0, length: 2 }] }],
      entityMap: [{ key: '0', value: { type: 'MENTION', data: { screen_name: 'jack' } } }],
    });
    assert.equal(out, 'hi @jack there');
  });
});

// ---------------------------------------------------------------- fx.js
describe('fx.js', () => {
  test('interpretFx: 200 JSON article -> ok with fields', () => {
    const v = interpretFx(200, articleText);
    assert.equal(v.status, 'ok');
    assert.equal(v.fields.tweet_id, '2117512471930167377');
    assert.equal(v.fields.kind, 'article');
  });

  test('interpretFx: 401 / 404 / 429 / 5xx JSON', () => {
    assert.deepEqual(interpretFx(401, JSON.stringify({ code: 401, message: 'PRIVATE_TWEET' })), { status: 'private', code: 401 });
    assert.deepEqual(interpretFx(404, JSON.stringify({ code: 404, message: 'NOT_FOUND' })), { status: 'not_found', code: 404 });
    assert.deepEqual(interpretFx(200, JSON.stringify({ code: 404, message: 'NOT_FOUND' })), { status: 'not_found', code: 404 });
    assert.deepEqual(interpretFx(404, fixture('iarticle.json')), { status: 'not_found', code: 404 });
    assert.deepEqual(interpretFx(429, JSON.stringify({ code: 429 })), { status: 'retry', code: 429 });
    assert.deepEqual(interpretFx(500, JSON.stringify({ code: 500, message: 'API_FAIL' })), { status: 'retry', code: 500 });
    assert.deepEqual(interpretFx(503, JSON.stringify({ message: 'down' })), { status: 'retry', code: 503 });
  });

  test('interpretFx: non-JSON bodies', () => {
    const html = fixture('missing.json');
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.deepEqual(interpretFx(200, html), { status: 'not_found', code: 200 });
    assert.deepEqual(interpretFx(404, 'Not Found'), { status: 'not_found', code: 404 });
    assert.deepEqual(interpretFx(429, 'Too Many Requests'), { status: 'retry', code: 429 });
    assert.deepEqual(interpretFx(502, '<html>Bad gateway</html>'), { status: 'retry', code: 502 });
    assert.deepEqual(interpretFx(504, ''), { status: 'retry', code: 504 });
  });

  test('interpretFx: non-JSON 401 is private', () => {
    assert.equal(interpretFx(401, 'Unauthorized').status, 'private');
  });

  test('fxTweetToFields: article fixture', () => {
    const f = fxTweetToFields(articleJson.tweet);
    assert.equal(f.tweet_id, '2117512471930167377');
    assert.equal(typeof f.tweet_id, 'string');
    assert.equal(f.kind, 'article');
    assert.equal(f.text, '');
    assert.equal(f.article_title, 'Critical thinking when agents do the work');
    assert.ok(f.article_md.length > 5000);
    assert.ok(f.article_md.includes('### Offloading, deferral and surrender'));
    assert.equal(f.url, 'https://x.com/addyosmani/status/2117512471930167377');
    assert.equal(f.author_handle, 'addyosmani');
    assert.equal(f.author_name, 'Addy Osmani');
    assert.equal(f.likes, 18930);
    assert.equal(f.replies, 555);
    assert.equal(f.reposts, 2925);
    assert.equal(f.views, 4737957);
    assert.equal(f.posted_at, articleJson.tweet.created_timestamp);
    assert.equal(f.parent_tweet_id, null);
    assert.equal(f.quote_tweet_id, null);
    assert.equal(f.quote_json, null);
    assert.equal(f.render_version, RENDER_VERSION);
  });

  test('fxTweetToFields: article-istatus fixture (fetched via /i/status/) agrees', () => {
    const j = JSON.parse(fixture('article-istatus.json'));
    const f = fxTweetToFields(j.tweet);
    assert.equal(f.kind, 'article');
    assert.equal(f.tweet_id, '2117512471930167377');
    assert.ok(f.article_md.length > 0);
  });

  test('fxTweetToFields: article with no blocks falls back to preview text', () => {
    const f = fxTweetToFields({ id: '1', text: 'https://x.com/i/article/5', author: { screen_name: 'a' }, article: { title: '', preview_text: 'Preview here', content: { blocks: [] } } });
    assert.equal(f.article_title, 'Untitled article');
    assert.equal(f.article_md, 'Preview here\n\n(Only the preview was available.)');
    assert.equal(f.text, '');
  });

  test('fxTweetToFields: plain tweet with reply, quote, photos and videos', () => {
    const t = {
      id: '1900000000000000001',
      text: 'Look at this',
      author: { screen_name: 'jack', name: 'Jack' },
      created_timestamp: 1700000000,
      replying_to_status: '1900000000000000000',
      likes: '12', replies: 3, reposts: 4, views: null,
      quote: { id: '1800000000000000009', text: 'quoted text', author: { screen_name: 'q', name: 'Q Person' } },
      media: {
        photos: [{ url: 'https://pbs.twimg.com/media/a.jpg' }, { url: '' }],
        videos: [{ url: 'https://video.twimg.com/v.mp4' }],
      },
    };
    const f = fxTweetToFields(t);
    assert.equal(f.kind, 'tweet');
    assert.equal(f.tweet_id, '1900000000000000001');
    assert.equal(f.parent_tweet_id, '1900000000000000000');
    assert.equal(f.quote_tweet_id, '1800000000000000009');
    assert.deepEqual(JSON.parse(f.quote_json), { handle: 'q', name: 'Q Person', text: 'quoted text', url: 'https://x.com/q/status/1800000000000000009' });
    assert.equal(f.text, 'Look at this\n[Image: https://pbs.twimg.com/media/a.jpg]\n[Video: https://video.twimg.com/v.mp4]');
    assert.equal(f.likes, 12);
    assert.equal(f.reposts, 4);
    assert.equal(f.views, 0); // Number(null) is 0
    assert.equal(f.article_md, null);
  });

  test('fxTweetToFields: retweets preferred over reposts; missing author', () => {
    const f = fxTweetToFields({ id: '123456', text: '', retweets: 9, reposts: 1 });
    assert.equal(f.reposts, 9);
    assert.equal(f.author_handle, null);
    assert.equal(f.url, 'https://x.com/i/status/123456');
    assert.equal(f.likes, null);
  });

  test('fxTweetToFields: media-only tweet text is just the media lines', () => {
    const f = fxTweetToFields({ id: '123456', text: '', author: { screen_name: 'a' }, media: { photos: [{ url: 'https://p/1.jpg' }] } });
    assert.equal(f.text, '[Image: https://p/1.jpg]');
  });

  test('oembedToFields: real fixture', () => {
    const f = oembedToFields(fixture('oembed.json'), '2117512471930167377');
    assert.deepEqual(f, {
      kind: 'tweet',
      text: 'https://t.co/2gyp2Erpxx',
      author_handle: 'addyosmani',
      author_name: 'Addy Osmani',
      url: 'https://x.com/addyosmani/status/2117512471930167377',
      render_version: RENDER_VERSION,
    });
  });

  test('oembedToFields: entity decoding and <br>', () => {
    const body = JSON.stringify({
      author_name: 'A &amp; B',
      author_url: 'https://twitter.com/ab_c',
      html: '<blockquote><p lang="en">Tom &amp; Jerry &lt;3 &quot;hi&quot; &#39;x&#39; &#x1F600; caf&eacute;<br>line2<br/>&hellip;</p>&mdash; A</blockquote>',
    });
    const f = oembedToFields(body, '1234567');
    assert.equal(f.text, 'Tom & Jerry <3 "hi" \'x\' 😀 caf&eacute;\nline2\n…');
    assert.equal(f.author_handle, 'ab_c');
    assert.equal(f.author_name, 'A &amp; B'); // author_name is not decoded
    assert.equal(f.url, 'https://x.com/ab_c/status/1234567');
  });

  test('oembedToFields: bad input', () => {
    assert.equal(oembedToFields('not json', '1'), null);
    assert.equal(oembedToFields('{}', '1'), null);
    assert.equal(oembedToFields('null', '1'), null);
    const f = oembedToFields(JSON.stringify({ html: '<blockquote>no p</blockquote>' }), '99999');
    assert.equal(f.text, '');
    assert.equal(f.author_handle, null);
    assert.equal(f.url, 'https://x.com/i/status/99999');
  });

  test('decodeEntities', () => {
    assert.equal(decodeEntities('&amp;lt;'), '&lt;'); // single pass
    assert.equal(decodeEntities('&#65;&#x42;&#X43;'), 'ABC');
    assert.equal(decodeEntities('&#0; &#x110000; &bogus;'), '&#0; &#x110000; &bogus;');
    assert.equal(decodeEntities('&RSQUO;&ldquo;&rdquo;'), '’“”');
  });
});

// ---------------------------------------------------------------- totp.js
describe('totp.js', () => {
  const rfcSecret = Buffer.from('12345678901234567890', 'ascii');
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  for (const [t, code] of vectors) {
    test(`RFC 6238 SHA1 vector at T=${t}`, () => {
      assert.equal(hotp(rfcSecret, Math.floor(t / 30), 8), code);
      assert.equal(totp(rfcSecret, t, { digits: 8 }), code);
      assert.equal(totp(rfcSecret, t), code.slice(2)); // 6-digit code is the low 6 digits
    });
  }

  test('RFC 4226 HOTP vectors (6 digits)', () => {
    const expect = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expect.forEach((c, i) => assert.equal(hotp(rfcSecret, i), c));
  });

  test('verifyTotp: window ±1 and format checks', () => {
    const now = 1111111111;
    const cur = Math.floor(now / 30);
    assert.equal(verifyTotp(rfcSecret, hotp(rfcSecret, cur), now), cur);
    assert.equal(verifyTotp(rfcSecret, hotp(rfcSecret, cur - 1), now), cur - 1);
    assert.equal(verifyTotp(rfcSecret, hotp(rfcSecret, cur + 1), now), cur + 1);
    assert.equal(verifyTotp(rfcSecret, hotp(rfcSecret, cur - 2), now), null);
    assert.equal(verifyTotp(rfcSecret, hotp(rfcSecret, cur + 2), now), null);
    const c = hotp(rfcSecret, cur);
    assert.equal(verifyTotp(rfcSecret, `${c.slice(0, 3)} ${c.slice(3)}`, now), cur);
    assert.equal(verifyTotp(rfcSecret, '12345', now), null);
    assert.equal(verifyTotp(rfcSecret, '1234567', now), null);
    assert.equal(verifyTotp(rfcSecret, 'abcdef', now), null);
    assert.equal(verifyTotp(rfcSecret, '', now), null);
    assert.equal(verifyTotp(rfcSecret, null, now), null);
    assert.equal(verifyTotp(rfcSecret, totp(rfcSecret, now, { digits: 8 }), now), null);
  });

  test('verifyTotp: window 0 accepts only the current step', () => {
    const now = 1234567890;
    const cur = Math.floor(now / 30);
    assert.equal(verifyTotp(rfcSecret, hotp(rfcSecret, cur - 1), now, { window: 0 }), null);
    assert.equal(verifyTotp(rfcSecret, hotp(rfcSecret, cur), now, { window: 0 }), cur);
  });

  test('verifyTotp: replay refused with lastStep', () => {
    const now = 2000000000;
    const cur = Math.floor(now / 30);
    const code = hotp(rfcSecret, cur);
    const used = verifyTotp(rfcSecret, code, now, { lastStep: 0 });
    assert.equal(used, cur);
    assert.equal(verifyTotp(rfcSecret, code, now, { lastStep: used }), null);
    assert.equal(verifyTotp(rfcSecret, code, now + 15, { lastStep: used }), null);
    assert.equal(verifyTotp(rfcSecret, hotp(rfcSecret, cur - 1), now, { lastStep: used }), null);
    assert.equal(verifyTotp(rfcSecret, hotp(rfcSecret, cur + 1), now + 30, { lastStep: used }), cur + 1);
  });

  test('base32 round trip and RFC 4648 vectors', () => {
    assert.equal(base32Encode(Buffer.from('')), '');
    assert.equal(base32Encode(Buffer.from('f')), 'MY');
    assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
    assert.equal(base32Encode(rfcSecret), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.deepEqual(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), rfcSecret);
    assert.deepEqual(base32Decode('mzxw 6ytb-oi=='), Buffer.from('foobar'));
    for (let n = 0; n < 40; n++) {
      const b = newSecret().subarray(0, n);
      assert.deepEqual(base32Decode(base32Encode(b)), b);
    }
    assert.throws(() => base32Decode('ABC1'), /bad base32/);
  });

  test('newSecret is 20 random bytes; otpauthUrl format', () => {
    const a = newSecret();
    assert.equal(a.length, 20);
    assert.notDeepEqual(a, newSecret());
    const u = otpauthUrl('ABCDEF', { account: 'me@x', issuer: 'Tweet Vault' });
    assert.equal(u, 'otpauth://totp/Tweet%20Vault:me%40x?secret=ABCDEF&issuer=Tweet%20Vault&algorithm=SHA1&digits=6&period=30');
  });

  test('seal / unseal round trip', () => {
    const secret = newSecret();
    const s = seal(secret, 'master-1');
    assert.match(s, /^v1:[^:]+:[^:]+:[^:]+$/);
    assert.notEqual(seal(secret, 'master-1'), s); // random IV
    assert.deepEqual(unseal(s, 'master-1'), secret);
  });

  test('unseal detects tampering, wrong key and bad version', () => {
    const s = seal(Buffer.from('top secret value'), 'k');
    const [v, iv, tag, enc] = s.split(':');
    const flip = (b64) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 1; return b.toString('base64'); };
    assert.throws(() => unseal([v, iv, tag, flip(enc)].join(':'), 'k'));
    assert.throws(() => unseal([v, iv, flip(tag), enc].join(':'), 'k'));
    assert.throws(() => unseal([v, flip(iv), tag, enc].join(':'), 'k'));
    assert.throws(() => unseal(s, 'other'));
    assert.throws(() => unseal(['v2', iv, tag, enc].join(':'), 'k'), /unknown seal version/);
    assert.throws(() => unseal('garbage', 'k'));
  });

  test('unseal rejects a truncated auth tag', () => {
    const s = seal(Buffer.from('hello'), 'k');
    const p = s.split(':');
    p[2] = Buffer.from(p[2], 'base64').subarray(0, 4).toString('base64');
    assert.throws(() => unseal(p.join(':'), 'k'));
  });
});

// ---------------------------------------------------------------- db smoke (in-memory)
test('openDb(":memory:") opens and tweet_id round-trips as a string', () => {
  const db = openDb(':memory:');
  const cols = db.prepare("SELECT name, type FROM pragma_table_info('items')").all();
  const tid = cols.find((c) => c.name === 'tweet_id');
  assert.ok(tid, 'items.tweet_id exists');
  assert.equal(String(tid.type).toUpperCase(), 'TEXT');
});
